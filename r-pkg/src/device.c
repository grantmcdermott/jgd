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
    snprintf(st->session_id, sizeof(st->session_id), "r-%d", (int)getpid());

    transport_init(&st->transport);

    /* If socket path provided from R, use it directly (skips C-side discovery) */
    if (s_socket != R_NilValue && TYPEOF(s_socket) == STRSXP && LENGTH(s_socket) > 0) {
        const char *sock = CHAR(STRING_ELT(s_socket, 0));
        if (sock && sock[0]) {
            if (strlen(sock) >= sizeof(st->transport.socket_path)) {
                free(st);
                Rf_error("jgd: socket path too long (max %zu characters)",
                         sizeof(st->transport.socket_path) - 1);
            }
            snprintf(st->transport.socket_path, sizeof(st->transport.socket_path),
                     "%s", sock);
        }
    }

    jw_init(&st->frame_buf);
    page_init(&st->page, width * dpi, height * dpi, dpi, R_RGB(255, 255, 255));

    if (transport_connect(&st->transport) != 0) {
        Rf_warning("jgd: could not connect to renderer. "
                   "Plots will be recorded but not displayed until connection is established.");
    }

    pDevDesc dd = (pDevDesc)calloc(1, sizeof(DevDesc));
    if (!dd) {
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
    /* Read all available resize messages */
    while (transport_has_data(&st->transport)) {
        char buf[1024];
        int n = transport_recv_line(&st->transport, buf, sizeof(buf), 0);
        if (n <= 0) break;

        if (strstr(buf, "\"resize\"")) {
            char *wp = strstr(buf, "\"width\"");
            char *hp = strstr(buf, "\"height\"");
            if (wp && hp) {
                double w = 0, h = 0;
                wp = strchr(wp, ':'); if (wp) w = strtod(wp + 1, NULL);
                hp = strchr(hp, ':'); if (hp) h = strtod(hp + 1, NULL);
                if (w > 0 && h > 0) {
                    st->pending_w = w;
                    st->pending_h = h;
                }
            }
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
        jgd_flush_frame(st, 0);
        st->last_flushed_ops = st->page.op_count;
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
