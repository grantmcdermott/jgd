#include "device.h"
#include "callbacks.h"
#include "png_encoder.h"

#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsDevice.h>
#include <R_ext/GraphicsEngine.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <R_ext/eventloop.h>
#endif

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>

/* Read server_info welcome message after connecting.
   The server defers the welcome until it receives R's first message,
   so we send a ping to trigger it, then read back with a short timeout. */
static void jgd_read_welcome(jgd_state_t *st) {
    const char *ping = "{\"type\":\"ping\"}";
    if (transport_send(&st->transport, ping, strlen(ping)) != 0)
        return;

    /* Read up to a few lines: the server sends server_info after receiving
       the ping, but message ordering may vary across implementations. */
    char buf[2048];
    for (int attempt = 0; attempt < 3; attempt++) {
        int n = transport_recv_line(&st->transport, buf, sizeof(buf), 200);
        if (n < 0) return;   /* timeout or error — no point retrying */
        if (n == 0) continue; /* empty line — skip */

        cJSON *msg = cJSON_Parse(buf);
        if (!msg) continue;

        cJSON *type = cJSON_GetObjectItem(msg, "type");
        if (!cJSON_IsString(type) || strcmp(type->valuestring, "server_info") != 0) {
            cJSON_Delete(msg);
            continue;
        }

        cJSON *name = cJSON_GetObjectItem(msg, "serverName");
        if (cJSON_IsString(name)) {
            snprintf(st->server_name, sizeof(st->server_name), "%s", name->valuestring);
        }

        cJSON *ver = cJSON_GetObjectItem(msg, "protocolVersion");
        if (cJSON_IsNumber(ver)) {
            st->protocol_version = (int)ver->valuedouble;
        }

        cJSON *tr = cJSON_GetObjectItem(msg, "transport");
        if (cJSON_IsString(tr)) {
            snprintf(st->server_transport, sizeof(st->server_transport), "%s", tr->valuestring);
        }

        cJSON *info = cJSON_GetObjectItem(msg, "serverInfo");
        if (cJSON_IsObject(info)) {
            cJSON *child = info->child;
            while (child && st->n_info_pairs < JGD_MAX_INFO_PAIRS) {
                if (cJSON_IsString(child) && child->string) {
                    jgd_info_pair_t *p = &st->server_info_pairs[st->n_info_pairs];
                    snprintf(p->key, sizeof(p->key), "%s", child->string);
                    snprintf(p->val, sizeof(p->val), "%s", child->valuestring);
                    st->n_info_pairs++;
                }
                child = child->next;
            }
        }

        st->server_info_received = 1;
        cJSON_Delete(msg);
        return;
    }
}

/* Called from R: .Call(C_jgd, width, height, dpi, socket) */
SEXP C_jgd(SEXP s_width, SEXP s_height, SEXP s_dpi, SEXP s_socket) {
    double width = Rf_asReal(s_width);
    double height = Rf_asReal(s_height);
    double dpi = Rf_asReal(s_dpi);

    if (width <= 0) width = 7.0;
    if (height <= 0) height = 7.0;
    if (dpi <= 0) dpi = 96.0;

    R_GE_checkVersionOrDie(R_GE_version);
    R_CheckDeviceAvailable();

    jgd_state_t *st = (jgd_state_t *)calloc(1, sizeof(jgd_state_t));
    if (!st) Rf_error("jgd: failed to allocate device state");

    st->width = width;
    st->height = height;
    st->dpi = dpi;
    st->page_count = 0;
    st->drawing = 0;
    st->pending_plot_index = -1;
    st->buffered_plot_index = -1;
    st->snapshot_count = 0;
    st->snapshot_store = Rf_allocVector(VECSXP, JGD_MAX_SNAPSHOTS);
    R_PreserveObject(st->snapshot_store);
    st->last_snapshot = R_NilValue;
    /* Check options(jgd.debug = TRUE) for frame-level debug output */
    {
        SEXP dbg = Rf_GetOption1(Rf_install("jgd.debug"));
        st->debug_frames = (dbg != R_NilValue && Rf_asLogical(dbg) == TRUE) ? 1 : 0;
    }
    /* Each device instance gets a unique sessionId so the browser can
     * separate plot histories across dev.off()/jgd() cycles within the
     * same R process.  PID alone is not sufficient — multiple devices
     * from the same process would collide. */
    {
        static int device_counter = 0;
        snprintf(st->session_id, sizeof(st->session_id),
                 "r-%d-%d", (int)getpid(), ++device_counter);
    }

    transport_init(&st->transport);

    /* If socket path provided from R, use it directly (skips C-side discovery) */
    if (s_socket != R_NilValue && TYPEOF(s_socket) == STRSXP && LENGTH(s_socket) > 0) {
        const char *sock = CHAR(STRING_ELT(s_socket, 0));
        if (sock && sock[0]) {
            if (strlen(sock) >= sizeof(st->transport.socket_path)) {
                R_ReleaseObject(st->snapshot_store);
                free(st);
                Rf_error("jgd: socket path too long (max %zu characters)",
                         sizeof(st->transport.socket_path) - 1);
            }
            snprintf(st->transport.socket_path, sizeof(st->transport.socket_path),
                     "%s", sock);
        }
    }

    page_init(&st->page, width * dpi, height * dpi, dpi, R_RGB(255, 255, 255));

    if (transport_connect(&st->transport) != 0) {
        Rf_warning("jgd: could not connect to renderer. "
                   "Plots will be recorded but not displayed until connection is established.");
    }

    if (st->transport.connected) {
        jgd_read_welcome(st);
    }

    pDevDesc dd = (pDevDesc)calloc(1, sizeof(DevDesc));
    if (!dd) {
        transport_close(&st->transport);
        page_free(&st->page);
        R_ReleaseObject(st->snapshot_store);
        free(st);
        Rf_error("jgd: failed to allocate DevDesc");
    }

    double w_px = width * dpi;
    double h_px = height * dpi;

    dd->left = 0;
    dd->right = w_px;
    dd->bottom = h_px;
    dd->top = 0;

    dd->clipLeft = 0;
    dd->clipRight = w_px;
    dd->clipBottom = h_px;
    dd->clipTop = 0;

    dd->xCharOffset = 0.4900;
    dd->yCharOffset = 0.3333;
    dd->yLineBias = 0.2;

    dd->ipr[0] = 1.0 / dpi;
    dd->ipr[1] = 1.0 / dpi;

    dd->cra[0] = 0.9 * 12.0 * (dpi / 72.0);
    dd->cra[1] = 1.2 * 12.0 * (dpi / 72.0);

    dd->gamma = 1.0;

    dd->canClip = TRUE;
    dd->canChangeGamma = FALSE;
    dd->canHAdj = 2;

    dd->startps = 12.0;
    dd->startcol = R_RGB(0, 0, 0);
    dd->startfill = R_RGB(255, 255, 255);
    dd->startlty = LTY_SOLID;
    dd->startfont = 1;
    dd->startgamma = 1.0;

    dd->deviceSpecific = st;
    dd->displayListOn = TRUE;

    dd->canGenMouseDown = FALSE;
    dd->canGenMouseMove = FALSE;
    dd->canGenMouseUp = FALSE;
    dd->canGenKeybd = FALSE;
    dd->canGenIdle = FALSE;
    dd->gettingEvent = FALSE;

    dd->hasTextUTF8 = TRUE;
    dd->wantSymbolUTF8 = TRUE;
    dd->useRotatedTextInContour = TRUE;

    dd->haveTransparency = 2;
    dd->haveTransparentBg = 2;
    dd->haveRaster = 2;
    dd->haveCapture = 1;
    dd->haveLocator = 1;

    dd->deviceVersion = 0;

#if R_GE_version >= 13
    dd->deviceClip = FALSE;
#endif

    jgd_set_callbacks(dd);

    pGEDevDesc gdd = GEcreateDevDesc(dd);
    GEaddDevice2(gdd, "jgd");
    GEinitDisplayList(gdd);
    st->ge_dev = gdd;

    jgd_register_input_handler(st);

    return R_NilValue;
}

/* ---- Resize polling (shared by R callable and input handler) ---- */

/* Drain resize messages from the transport socket into pending_w/pending_h.
   Returns 1 if a resize was applied and the display list replayed, 0 otherwise. */
static int poll_resize_impl(jgd_state_t *st, pDevDesc dd, pGEDevDesc gdd) {
    /* Drain at most ONE resize into pending_w/pending_h per call.
     * The caller invokes us repeatedly (via C_jgd_poll_resize or the R
     * input handler), so each resize produces its own frame.  This keeps
     * the server's per-session queue in sync — the server pushes one
     * queue entry per resize sent and shifts one entry per frame received.
     *
     * check_incoming may have buffered a plotIndex resize that it read
     * during drawing but could not process (plotIndex resizes require
     * snapshot replay, which is only safe when R is idle).  Drain the
     * buffer before reading from the transport. */
    if (st->has_buffered_resize) {
        st->pending_w = st->buffered_w;
        st->pending_h = st->buffered_h;
        st->pending_plot_index = st->buffered_plot_index;
        st->has_buffered_resize = 0;
    } else if (transport_has_data(&st->transport)) {
        char buf[1024];
        int plot_index = -1;
        int n = transport_recv_line(&st->transport, buf, sizeof(buf), 0);
        if (n > 0) {
            jgd_try_parse_resize(buf, &st->pending_w, &st->pending_h, &plot_index);
            if (plot_index >= 0)
                st->pending_plot_index = plot_index;
        }
    }

    if (st->pending_w <= 0 || st->pending_h <= 0)
        return 0;

    /* Apply the resize */
    st->width = st->pending_w / st->dpi;
    st->height = st->pending_h / st->dpi;
    dd->right = st->pending_w;
    dd->bottom = st->pending_h;
    dd->clipRight = st->pending_w;
    dd->clipBottom = st->pending_h;
    st->pending_w = 0;
    st->pending_h = 0;

    int pi = st->pending_plot_index;
    st->pending_plot_index = -1;

    /* plotIndex from the browser is 0-based into the current retained
     * history (after eviction).  Both sides evict the same way (shift
     * from front, same max size), so plotIndex maps directly to our
     * snapshot_store index — no snapshot_base offset needed. */
    if (pi >= 0 && pi < st->snapshot_count) {
        /* Historical plot resize: replay the snapshot at new dimensions,
         * flush its frame, then restore the current display list.
         *
         * GEplaySnapshot restores the display list from the snapshot
         * and replays it through device callbacks.  We use hold_level
         * to suppress intermediate flushes and replaying=1 to prevent
         * snapshot saving in cb_newPage during the replay. */
        SEXP snap = VECTOR_ELT(st->snapshot_store, pi);
        SEXP current = PROTECT(GEcreateSnapshot(gdd));

        st->replaying = 1;
        st->hold_level = 100;
        GEplaySnapshot(snap, gdd);
        st->hold_level = 0;
        st->replaying = 0;

        if (st->page.op_count > st->last_flushed_ops) {
            jgd_flush_frame(st, 0);
            st->last_flushed_ops = st->page.op_count;
        }

        /* Restore the current plot state */
        st->replaying = 1;
        st->hold_level = 100;
        GEplaySnapshot(current, gdd);
        st->hold_level = 0;
        st->replaying = 0;

        /* Suppress re-flushing the restored current plot */
        st->last_flushed_ops = st->page.op_count;

        UNPROTECT(1);
    } else {
        /* Current plot resize (normal path) */

        if (st->debug_frames)
            REprintf("[jgd] poll_resize: current plot replay at %.0fx%.0f\n",
                     st->width * st->dpi, st->height * st->dpi);

        /* Replay the display list at new dimensions.
         * All intermediate flushes (cb_holdflush, cb_mode) are suppressed while
         * replaying=1 so that we emit exactly one complete frame afterwards.
         * This prevents the browser from receiving untagged incremental frames
         * that would be misrouted (appendOps to the wrong history slot). */
        st->replaying = 1;
        GEplayDisplayList(gdd);
        st->replaying = 0;

        /* Send the complete replayed frame as a single flush.  The server will
         * tag this frame with resize:true so the browser does replaceLatest
         * instead of addPlot.
         *
         * When the display list is empty (no plots drawn yet), GEplayDisplayList
         * is a no-op: cb_newPage never fires, so the page is NOT re-initialized
         * and op_count == last_flushed_ops.  We intentionally skip the flush in
         * that case — sending the stale page would emit incorrect old data.
         * The server's resizePending flag stays armed and will tag the next real
         * frame.  This is safe: replaceLatest on an empty browser session falls
         * through to addPlot, and on a non-empty session the plot that consumed
         * the flag would have been the first draw after an empty display list,
         * which correctly replaces the "latest" blank state. */
        if (st->page.op_count > st->last_flushed_ops) {
            if (st->debug_frames)
                REprintf("[jgd] poll_resize: flushing replay frame "
                         "(ops=%d, last_flushed=%d)\n",
                         st->page.op_count, st->last_flushed_ops);
            jgd_flush_frame(st, 0);
            st->last_flushed_ops = st->page.op_count;
        }
    }

    return 1;
}

/* Called from R: .Call(C_jgd_poll_resize) — manual / fallback poll. */
SEXP C_jgd_poll_resize(void) {
    pGEDevDesc gdd = GEcurrentDevice();
    if (!gdd || !gdd->dev) return Rf_ScalarLogical(FALSE);

    pDevDesc dd = gdd->dev;
    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st || st->replaying || st->drawing) return Rf_ScalarLogical(FALSE);

    return Rf_ScalarLogical(poll_resize_impl(st, dd, gdd));
}

/* Called from R: .Call(C_jgd_server_info) */
SEXP C_jgd_server_info(void) {
    pGEDevDesc gdd = GEcurrentDevice();
    if (!gdd || !gdd->dev) return R_NilValue;

    pDevDesc dd = gdd->dev;
    if (!jgd_is_jgd_device(dd)) return R_NilValue;

    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st || !st->server_info_received) return R_NilValue;

    /* Build the result: list(server_name, protocol_version, transport, server_info) */
    SEXP result = PROTECT(Rf_allocVector(VECSXP, 4));
    SEXP names = PROTECT(Rf_allocVector(STRSXP, 4));

    SET_STRING_ELT(names, 0, Rf_mkChar("server_name"));
    SET_STRING_ELT(names, 1, Rf_mkChar("protocol_version"));
    SET_STRING_ELT(names, 2, Rf_mkChar("transport"));
    SET_STRING_ELT(names, 3, Rf_mkChar("server_info"));
    Rf_setAttrib(result, R_NamesSymbol, names);

    SET_VECTOR_ELT(result, 0, Rf_mkString(st->server_name));
    SET_VECTOR_ELT(result, 1, Rf_ScalarInteger(st->protocol_version));
    SET_VECTOR_ELT(result, 2, Rf_mkString(st->server_transport));

    /* Build named character vector from kv pairs */
    int np = st->n_info_pairs;
    SEXP info = PROTECT(Rf_allocVector(STRSXP, np));
    SEXP info_names = PROTECT(Rf_allocVector(STRSXP, np));
    for (int i = 0; i < np; i++) {
        SET_STRING_ELT(info_names, i, Rf_mkChar(st->server_info_pairs[i].key));
        SET_STRING_ELT(info, i, Rf_mkChar(st->server_info_pairs[i].val));
    }
    Rf_setAttrib(info, R_NamesSymbol, info_names);
    SET_VECTOR_ELT(result, 3, info);

    UNPROTECT(4);
    return result;
}

/* ---- R input handler (POSIX) ---- */

#ifndef _WIN32

#define JGD_INPUT_HANDLER_ACTIVITY 42

/* Callback invoked by R's event loop when data arrives on the transport fd. */
static void jgd_input_handler_cb(void *data) {
    jgd_state_t *st = (jgd_state_t *)data;
    if (!st || st->replaying || st->drawing) return;

    /* If transport disconnected (server died), just bail out.
       The handler stays registered but returns immediately until
       the device is closed and cb_close removes it. */
    if (!st->transport.connected) return;

    pGEDevDesc gdd = (pGEDevDesc)st->ge_dev;
    if (!gdd || !gdd->dev) return;

    poll_resize_impl(st, gdd->dev, gdd);
}

void jgd_register_input_handler(jgd_state_t *st) {
    if (!st->transport.connected || st->transport.fd < 0) return;

    InputHandler *ih = addInputHandler(R_InputHandlers, st->transport.fd,
                                       jgd_input_handler_cb,
                                       JGD_INPUT_HANDLER_ACTIVITY);
    if (ih) {
        ih->userData = (void *)st;
        st->input_handler = ih;
    }
}

void jgd_remove_input_handler(jgd_state_t *st) {
    if (!st->input_handler) return;

    removeInputHandler(&R_InputHandlers, (InputHandler *)st->input_handler);
    st->input_handler = NULL;
}

#else /* _WIN32 */

#define JGD_TIMER_ID 1
#define JGD_POLL_INTERVAL_MS 200

static const char *JGD_WND_CLASS = "jgd_resize_poll";
static int jgd_wnd_class_registered = 0;

static LRESULT CALLBACK jgd_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_TIMER && wp == JGD_TIMER_ID) {
        jgd_state_t *st = (jgd_state_t *)GetWindowLongPtr(hwnd, GWLP_USERDATA);
        if (!st || st->replaying || st->drawing || !st->transport.connected) return 0;

        pGEDevDesc gdd = (pGEDevDesc)st->ge_dev;
        if (!gdd || !gdd->dev) return 0;

        poll_resize_impl(st, gdd->dev, gdd);
        return 0;
    }
    return DefWindowProc(hwnd, msg, wp, lp);
}

void jgd_register_input_handler(jgd_state_t *st) {
    if (!st->transport.connected) return;

    if (!jgd_wnd_class_registered) {
        WNDCLASSEXA wc = {0};
        wc.cbSize = sizeof(WNDCLASSEXA);
        wc.lpfnWndProc = jgd_wndproc;
        wc.hInstance = NULL;
        wc.lpszClassName = JGD_WND_CLASS;
        if (!RegisterClassExA(&wc)) {
            /* After devtools::load_all() the class persists from the
               previous DLL — treat that as success. */
            if (GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return;
        }
        jgd_wnd_class_registered = 1;
    }

    HWND hwnd = CreateWindowExA(0, JGD_WND_CLASS, "jgd", 0,
                                0, 0, 0, 0, HWND_MESSAGE, NULL, NULL, NULL);
    if (!hwnd) return;

    SetWindowLongPtr(hwnd, GWLP_USERDATA, (LONG_PTR)st);

    if (!SetTimer(hwnd, JGD_TIMER_ID, JGD_POLL_INTERVAL_MS, NULL)) {
        DestroyWindow(hwnd);
        return;
    }

    st->hwnd = hwnd;
    st->timer_active = 1;
}

void jgd_remove_input_handler(jgd_state_t *st) {
    if (!st->timer_active || !st->hwnd) return;

    KillTimer((HWND)st->hwnd, JGD_TIMER_ID);
    DestroyWindow((HWND)st->hwnd);
    st->hwnd = NULL;
    st->timer_active = 0;
}

#endif

/* ---- Shared resize message parser ---- */

int jgd_try_parse_resize(const char *buf, double *w, double *h, int *plot_index) {
    cJSON *msg = cJSON_Parse(buf);
    if (!msg) return 0;
    cJSON *type = cJSON_GetObjectItem(msg, "type");
    if (!cJSON_IsString(type) || strcmp(type->valuestring, "resize") != 0) {
        cJSON_Delete(msg);
        return 0;
    }
    cJSON *wj = cJSON_GetObjectItem(msg, "width");
    cJSON *hj = cJSON_GetObjectItem(msg, "height");
    int ok = 0;
    if (cJSON_IsNumber(wj) && cJSON_IsNumber(hj) &&
        wj->valuedouble > 0 && hj->valuedouble > 0) {
        *w = wj->valuedouble;
        *h = hj->valuedouble;
        ok = 1;
    }
    if (plot_index) {
        cJSON *pi = cJSON_GetObjectItem(msg, "plotIndex");
        *plot_index = cJSON_IsNumber(pi) ? (int)pi->valuedouble : -1;
    }
    cJSON_Delete(msg);
    return ok;
}
