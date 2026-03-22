#include "device.h"
#include "callbacks.h"
#include "png_encoder.h"

#include <R.h>
#include <Rinternals.h>
#include <Rversion.h>
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
    st->flush_plot_index = -1;
    st->snapshot_count = 0;
    st->evicted_count = 0;
    st->snapshot_store = PROTECT(Rf_allocVector(VECSXP, JGD_MAX_SNAPSHOTS));
    R_PreserveObject(st->snapshot_store);
    UNPROTECT(1);
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

/* Called from R: .Call(C_jgd_set_ext, json_string_or_null) */
SEXP C_jgd_set_ext(SEXP s_json) {
    pGEDevDesc gdd = GEcurrentDevice();
    if (!gdd || !gdd->dev) Rf_error("no active graphics device");

    pDevDesc dd = gdd->dev;
    if (!jgd_is_jgd_device(dd)) Rf_error("current device is not a jgd device");

    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st) Rf_error("jgd device state is NULL");

    if (st->debug_frames)
        REprintf("[jgd] C_jgd_set_ext: json=%s replaying=%d\n",
                 (s_json != R_NilValue && TYPEOF(s_json) == STRSXP) ?
                     CHAR(STRING_ELT(s_json, 0)) : "NULL",
                 st->replaying);

    /* NULL from R means clear ext_json */
    if (s_json == R_NilValue) {
        free(st->ext_json);
        st->ext_json = NULL;
        return R_NilValue;
    }

    if (TYPEOF(s_json) != STRSXP || LENGTH(s_json) != 1)
        Rf_error("ext must be a single JSON string or NULL");

    const char *json = CHAR(STRING_ELT(s_json, 0));

    /* Empty string: treat as clearing ext_json */
    if (!json[0]) {
        free(st->ext_json);
        st->ext_json = NULL;
        return R_NilValue;
    }

    /* Validate JSON before replacing ext_json.  On failure the previous
     * ext_json is left unchanged (transactional semantics). */
    cJSON *parsed = cJSON_Parse(json);
    if (!parsed) {
        /* Return a descriptive error message string instead of
         * calling Rf_error so the caller can signal the condition
         * from R (avoids longjmp issues with device state in some
         * test harnesses).  The previous ext_json is preserved. */
        const char *err = cJSON_GetErrorPtr();
        if (err && err >= json) {
            long pos = (long)(err - json);
            char buf[128];
            snprintf(buf, sizeof(buf),
                     "invalid JSON in ext at position %ld", pos);
            return Rf_mkString(buf);
        }
        return Rf_mkString("invalid JSON in ext");
    }
    cJSON_Delete(parsed);

    size_t len = strlen(json);
    char *new_ext = (char *)malloc(len + 1);
    if (!new_ext) Rf_error("failed to allocate ext_json");
    memcpy(new_ext, json, len + 1);

    /* Validation and allocation succeeded — now replace ext_json */
    free(st->ext_json);
    st->ext_json = new_ext;

    return R_NilValue;
}

/* Called from R: .Call(C_jgd_set_frame_ext, json_string_or_null) */
SEXP C_jgd_set_frame_ext(SEXP s_json) {
    pGEDevDesc gdd = GEcurrentDevice();
    if (!gdd || !gdd->dev) Rf_error("no active graphics device");

    pDevDesc dd = gdd->dev;
    if (!jgd_is_jgd_device(dd)) Rf_error("current device is not a jgd device");

    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st) Rf_error("jgd device state is NULL");

    if (s_json == R_NilValue) {
        free(st->frame_ext_json);
        st->frame_ext_json = NULL;
        return R_NilValue;
    }

    if (TYPEOF(s_json) != STRSXP || LENGTH(s_json) != 1)
        Rf_error("frame_ext must be a single JSON string or NULL");

    const char *json = CHAR(STRING_ELT(s_json, 0));

    if (!json[0]) {
        free(st->frame_ext_json);
        st->frame_ext_json = NULL;
        return R_NilValue;
    }

    cJSON *parsed = cJSON_Parse(json);
    if (!parsed) {
        const char *err = cJSON_GetErrorPtr();
        if (err && err >= json) {
            long pos = (long)(err - json);
            char buf[128];
            snprintf(buf, sizeof(buf),
                     "invalid JSON in frame_ext at position %ld", pos);
            return Rf_mkString(buf);
        }
        return Rf_mkString("invalid JSON in frame_ext");
    }
    cJSON_Delete(parsed);

    char *new_ext = strdup(json);
    if (!new_ext) Rf_error("failed to allocate frame_ext_json");

    free(st->frame_ext_json);
    st->frame_ext_json = new_ext;

    return R_NilValue;
}

/* Called from R: .Call(C_jgd_begin_group, ext_json_string_or_null) */
SEXP C_jgd_begin_group(SEXP s_ext) {
    pGEDevDesc gdd = GEcurrentDevice();
    if (!gdd || !gdd->dev) Rf_error("no active graphics device");

    pDevDesc dd = gdd->dev;
    if (!jgd_is_jgd_device(dd)) Rf_error("current device is not a jgd device");

    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st) Rf_error("jgd device state is NULL");

    if (s_ext != R_NilValue &&
        (TYPEOF(s_ext) != STRSXP || LENGTH(s_ext) != 1))
        Rf_error("group ext must be a single JSON string or NULL");

    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "beginGroup");

    if (s_ext != R_NilValue) {
        const char *json = CHAR(STRING_ELT(s_ext, 0));
        if (json[0]) {  /* empty string "" treated as no-ext, same as NULL */
            cJSON *ext = cJSON_Parse(json);
            if (!ext) {
                cJSON_Delete(op);
                const char *err = cJSON_GetErrorPtr();
                if (err && err >= json) {
                    long pos = (long)(err - json);
                    char buf[128];
                    snprintf(buf, sizeof(buf),
                             "invalid JSON in group ext at position %ld", pos);
                    return Rf_mkString(buf);
                }
                return Rf_mkString("invalid JSON in group ext");
            }
            cJSON_AddItemToObject(op, "ext", ext);
        }
    }

    page_add_op(&st->page, op);
    st->group_depth++;
    return R_NilValue;
}

/* Called from R: .Call(C_jgd_end_group) */
SEXP C_jgd_end_group(void) {
    pGEDevDesc gdd = GEcurrentDevice();
    if (!gdd || !gdd->dev) Rf_error("no active graphics device");

    pDevDesc dd = gdd->dev;
    if (!jgd_is_jgd_device(dd)) Rf_error("current device is not a jgd device");

    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st) Rf_error("jgd device state is NULL");

    if (st->group_depth <= 0)
        Rf_error("endGroup without matching beginGroup");

    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "endGroup");
    page_add_op(&st->page, op);
    st->group_depth--;

    /* recordGraphics() does not trigger cb_mode(0), so the endGroup op
     * would stay unflushed until the next graphics primitive or page
     * boundary.  Flush immediately so the renderer receives the complete
     * group sequence (beginGroup … endGroup) without delay. */
    if (!st->replaying && st->hold_level == 0 &&
        st->page.op_count > st->last_flushed_ops) {
        int incr = (st->last_flushed_ops > 0) ? 1 : 0;
        jgd_flush_frame(st, incr);
        st->last_flushed_ops = st->page.op_count;
    }

    return R_NilValue;
}

/* Called from R after recordGraphics(jgd_end_group) to update the
 * snapshot.  The snapshot captured by cb_mode(0) during the last
 * drawing primitive (before endGroup) does not include the endGroup
 * recordGraphics entry, because R adds it to the display list only
 * after the callback finishes.  This function re-captures the
 * snapshot so plotIndex resize replay includes the complete group. */
SEXP C_jgd_update_snapshot(void) {
    pGEDevDesc gdd = GEcurrentDevice();
    if (!gdd || !gdd->dev) return R_NilValue;

    pDevDesc dd = gdd->dev;
    if (!jgd_is_jgd_device(dd)) return R_NilValue;

    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st || st->replaying) return R_NilValue;

    jgd_capture_snapshot(st);
    return R_NilValue;
}

/* ---- Snapshot replay ---- */

/**
 * Replay a snapshot, handling both base and grid graphics.
 *
 * GEplaySnapshot restores both base and grid state, but only replays
 * the base graphics display list (via GEplayDisplayList).  For
 * grid/ggplot2 plots the base display list is empty — grid maintains
 * its own internal display list.  We detect this (very few ops after
 * GEplaySnapshot) and call grid::grid.refresh() to trigger a full
 * redraw from grid's internal display list.
 *
 * Both GEplaySnapshot and R_FindNamespace can longjmp on error.
 * We guard GEplaySnapshot with R_ToplevelExec and use the safe
 * R_NamespaceRegistry lookup instead of R_FindNamespace to ensure
 * st->replaying is always reset even on error.
 */

typedef struct {
    SEXP snap;
    pGEDevDesc gdd;
} replay_snapshot_args_t;

static void do_play_snapshot(void *data) {
    replay_snapshot_args_t *args = (replay_snapshot_args_t *)data;
    GEplaySnapshot(args->snap, args->gdd);
}

static void do_play_display_list(void *data) {
    pGEDevDesc gdd = (pGEDevDesc)data;
    GEplayDisplayList(gdd);
}

/* Find grid state in a snapshot SEXP by looking for the pkgName="grid"
 * attribute.  Returns the grid state VECSXP (with LENGTH >= 2) or
 * R_NilValue if not found or malformed. */
SEXP find_grid_state(SEXP snap) {
    if (snap == R_NilValue || TYPEOF(snap) != VECSXP)
        return R_NilValue;
    for (int i = 1; i < LENGTH(snap); i++) {
        SEXP st_i = VECTOR_ELT(snap, i);
        if (st_i != R_NilValue && TYPEOF(st_i) == VECSXP &&
            LENGTH(st_i) >= 2) {
            SEXP pn = Rf_getAttrib(st_i, Rf_install("pkgName"));
            if (pn != R_NilValue && TYPEOF(pn) == STRSXP &&
                LENGTH(pn) >= 1 &&
                strcmp(CHAR(STRING_ELT(pn, 0)), "grid") == 0)
                return st_i;
        }
    }
    return R_NilValue;
}

/* After GEplaySnapshot, force-restore grid's display list from the
 * snapshot.  GE_RestoreSnapshotState skips the restore when the
 * snapshot's grid DL index <= 1 (only root viewport).  This happens
 * when the snapshot was captured before ggplot2/grid finished writing
 * its DL entries.  We bypass that check by setting grid's DL and
 * DL index directly via grid:::grid.Call(C_setDisplayList, ...). */
static void restore_grid_dl_from_snapshot(jgd_state_t *st, SEXP snap,
                                          SEXP grid_ns) {
    SEXP grid_state = find_grid_state(snap);
    if (grid_state == R_NilValue) return;
    SEXP snap_dl  = VECTOR_ELT(grid_state, 0);
    SEXP snap_idx = VECTOR_ELT(grid_state, 1);
    if (snap_dl == R_NilValue) return;

    int err = 0;
    /* grid:::grid.Call(C_setDisplayList, snap_dl) */
    SEXP set_dl_call = PROTECT(Rf_lang3(
        Rf_install("grid.Call"),
        Rf_install("C_setDisplayList"), snap_dl));
    R_tryEval(set_dl_call, grid_ns, &err);
    UNPROTECT(1);

    if (!err && snap_idx != R_NilValue) {
        /* grid:::grid.Call(C_setDLindex, snap_idx) */
        SEXP set_idx_call = PROTECT(Rf_lang3(
            Rf_install("grid.Call"),
            Rf_install("C_setDLindex"), snap_idx));
        R_tryEval(set_idx_call, grid_ns, &err);
        UNPROTECT(1);
    }

    if (st->debug_frames)
        REprintf("[jgd] restore_grid_dl_from_snapshot: dl=%p idx=%d err=%d\n",
                 (void*)snap_dl,
                 (snap_idx != R_NilValue && TYPEOF(snap_idx) == INTSXP)
                     ? INTEGER(snap_idx)[0] : -1,
                 err);
}

static void replay_snapshot(jgd_state_t *st, SEXP snap, pGEDevDesc gdd) {
    st->replaying = 1;

    /* PROTECT snap during R_ToplevelExec: although snap is typically
     * reachable via snapshot_store or the caller's PROTECT frame,
     * R_ToplevelExec may trigger GC in a new top-level context. */
    PROTECT(snap);

    if (st->debug_frames) {
        SEXP gs = find_grid_state(snap);
        if (gs != R_NilValue) {
            SEXP gs_idx = VECTOR_ELT(gs, 1);
            int idx = (gs_idx != R_NilValue && TYPEOF(gs_idx) == INTSXP)
                      ? INTEGER(gs_idx)[0] : -1;
            REprintf("[jgd] replay_snapshot: snap grid DL=%p index=%d\n",
                     (void*)VECTOR_ELT(gs, 0), idx);
        }
    }

    /* Record op count before GEplaySnapshot so we can detect whether
     * it actually produced drawing ops (base DL replay) or not. */
    int ops_before = st->page.op_count;

    replay_snapshot_args_t args = { snap, gdd };
    Rboolean ok = R_ToplevelExec(do_play_snapshot, &args);
    if (!ok) {
        REprintf("[jgd] replay_snapshot: GEplaySnapshot failed (longjmp caught)\n");
        UNPROTECT(1);
        st->replaying = 0;
        return;
    }

    /* GEplaySnapshot replays the base display list.  For grid/ggplot2
     * plots the base DL is empty, so GEplaySnapshot produces only a
     * clip op (~0-2 ops) and does NOT call GE_RestoreState (which
     * would trigger grid.newpage + initVP).  We detect this case and
     * call grid::grid.refresh() to redraw from grid's internal DL.
     *
     * We also force-restore grid's DL from the snapshot, because
     * GE_RestoreSnapshotState skips the restore when the snapshot's
     * grid DL index <= 1 (only root viewport recorded).
     *
     * Compare against ops_before (not last_flushed_ops) to detect
     * the empty-base-DL case correctly even when called mid-page
     * (e.g. plotIndex resize where op_count is already high). */
    int new_ops = st->page.op_count - ops_before;
    if (st->debug_frames)
        REprintf("[jgd] replay_snapshot: after GEplaySnapshot ops=%d ops_before=%d "
                 "new_ops=%d\n",
                 st->page.op_count, ops_before, new_ops);

    /* If GEplaySnapshot produced very few NEW ops, the base DL was empty
     * (grid/ggplot2 case) — need grid.refresh() to redraw.
     * A negative new_ops means cb_newPage reset op_count during replay
     * (base graphics path via GE_RestoreState → GENewPage), which is
     * normal for base-graphics plots — no grid.refresh() needed. */
    if (new_ops >= 0 && new_ops <= 2) {
#if defined(R_VERSION) && R_VERSION >= R_Version(4, 5, 0)
        SEXP grid_ns = R_getVarEx(Rf_install("grid"), R_NamespaceRegistry, FALSE, R_UnboundValue);
#else
        SEXP grid_ns = Rf_findVarInFrame(R_NamespaceRegistry,
                                         Rf_install("grid"));
#endif
        if (grid_ns != R_UnboundValue && grid_ns != R_NilValue) {
            /* Force-restore grid DL from snapshot (bypasses the
             * dlIndex > 1 gate in GE_RestoreSnapshotState). */
            restore_grid_dl_from_snapshot(st, snap, grid_ns);

            SEXP refresh_sym = Rf_install("grid.refresh");
            SEXP call = PROTECT(Rf_lang1(refresh_sym));
            int err = 0;
            R_tryEval(call, grid_ns, &err);
            UNPROTECT(1);
            if (st->debug_frames)
                REprintf("[jgd] replay_snapshot: grid.refresh() -> ops=%d err=%d\n",
                         st->page.op_count, err);
        }
    }

    UNPROTECT(1);
    st->replaying = 0;
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

    /* plotIndex from the browser is an absolute plot number (plotNumber)
     * that R assigned.  Convert to a snapshot_store index by subtracting
     * the number of evicted snapshots. */
    int store_idx = pi - st->evicted_count;
    if (pi >= 0 && store_idx >= 0 && store_idx < st->snapshot_count) {
        /* Historical plot resize: replay the snapshot at new dimensions,
         * flush its frame, then restore the current display list.
         *
         * GEplaySnapshot restores the display list from the snapshot
         * and replays it through device callbacks.  replaying=1 suppresses
         * intermediate flushes (cb_mode) and snapshot saving (cb_newPage)
         * during the replay. */
        SEXP snap = VECTOR_ELT(st->snapshot_store, store_idx);
        SEXP current = PROTECT(GEcreateSnapshot(gdd));

        /* Always log snapshot DL size for debugging plotIndex replay */
        {
            REprintf("[jgd] poll_resize: plotIndex replay pi=%d store_idx=%d "
                     "snap_count=%d at %.0fx%.0f\n",
                     pi, store_idx, st->snapshot_count,
                     st->width * st->dpi, st->height * st->dpi);
            if (TYPEOF(snap) == VECSXP && LENGTH(snap) >= 1) {
                SEXP dl = VECTOR_ELT(snap, 0);
                if (dl != R_NilValue && TYPEOF(dl) == LISTSXP) {
                    int dl_len = 0;
                    for (SEXP p = dl; p != R_NilValue; p = CDR(p)) dl_len++;
                    REprintf("[jgd] poll_resize: snapshot DL pairlist entries=%d\n",
                             dl_len);
                } else {
                    REprintf("[jgd] poll_resize: snapshot DL is NULL or type=%d\n",
                             dl == R_NilValue ? 0 : TYPEOF(dl));
                }
            } else {
                REprintf("[jgd] poll_resize: snap type=%d len=%d\n",
                         TYPEOF(snap), LENGTH(snap));
            }
        }

        /* Save current page ext before the historical replay overwrites
         * page_ext_json.  We need this to restore the current plot's ext
         * when replaying the current snapshot afterwards. */
        char *saved_ext = st->ext_json;
        char *current_page_ext = st->page_ext_json
                                     ? strdup(st->page_ext_json) : NULL;
        char *saved_frame_ext = st->frame_ext_json;
        char *current_page_frame_ext = st->page_frame_ext_json
                                           ? strdup(st->page_frame_ext_json) : NULL;

        /* Set ext_json/frame_ext_json to the historical snapshot's ext so that
         * cb_newPage (during replay) captures the correct page_ext_json. */
        st->ext_json = st->snapshot_ext[store_idx]
                           ? strdup(st->snapshot_ext[store_idx]) : NULL;
        st->frame_ext_json = st->snapshot_frame_ext[store_idx]
                                 ? strdup(st->snapshot_frame_ext[store_idx]) : NULL;

        replay_snapshot(st, snap, gdd);

        if (st->debug_frames)
            REprintf("[jgd] poll_resize: after plotIndex replay ops=%d "
                     "last_flushed=%d\n",
                     st->page.op_count, st->last_flushed_ops);

        if (st->page.op_count > st->last_flushed_ops) {
            if (st->debug_frames)
                REprintf("[jgd] poll_resize: flushing plotIndex replay frame "
                         "(ops=%d, last_flushed=%d)\n",
                         st->page.op_count, st->last_flushed_ops);
            st->resize_replay = 1;
            st->flush_plot_index = pi;
            jgd_flush_frame(st, 0);
            st->last_flushed_ops = st->page.op_count;
        }

        /* Restore the current plot state.  Set ext_json to the current
         * page's ext (not saved_ext, which may be NULL after with_jgd_ext
         * cleanup) so cb_newPage captures the correct page_ext_json. */
        free(st->ext_json);
        st->ext_json = current_page_ext;
        free(st->frame_ext_json);
        st->frame_ext_json = current_page_frame_ext;

        if (current != R_NilValue) {
            replay_snapshot(st, current, gdd);
        }

        /* Now restore ext_json/frame_ext_json to their real values. */
        free(st->ext_json);
        st->ext_json = saved_ext;
        free(st->frame_ext_json);
        st->frame_ext_json = saved_frame_ext;

        /* Suppress re-flushing the restored current plot */
        st->last_flushed_ops = st->page.op_count;

        UNPROTECT(1);
    } else {
        /* Current plot resize (normal path) */

        if (st->debug_frames)
            REprintf("[jgd] poll_resize: current plot replay at %.0fx%.0f\n",
                     st->width * st->dpi, st->height * st->dpi);

        /* Temporarily restore ext_json/frame_ext_json from page copies so that
         * cb_newPage (during replay) captures the correct ext. */
        char *saved_ext = st->ext_json;
        st->ext_json = st->page_ext_json ? strdup(st->page_ext_json) : NULL;
        char *saved_frame_ext = st->frame_ext_json;
        st->frame_ext_json = st->page_frame_ext_json
                                 ? strdup(st->page_frame_ext_json) : NULL;

        /* Replay the display list at new dimensions.
         * All intermediate flushes (cb_holdflush, cb_mode) are suppressed while
         * replaying=1 so that we emit exactly one complete frame afterwards.
         * This prevents the browser from receiving untagged incremental frames
         * that would be misrouted (appendOps to the wrong history slot). */
        st->replaying = 1;
        Rboolean ok = R_ToplevelExec(do_play_display_list, gdd);
        st->replaying = 0;

        /* Restore ext_json/frame_ext_json to what they were before the replay. */
        free(st->ext_json);
        st->ext_json = saved_ext;
        free(st->frame_ext_json);
        st->frame_ext_json = saved_frame_ext;

        if (!ok) {
            REprintf("[jgd] poll_resize: GEplayDisplayList failed (longjmp caught)\n");
            return 1;
        }

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
            st->resize_replay = 1;
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
    if (!jgd_is_jgd_device(dd)) return Rf_ScalarLogical(FALSE);

    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st || st->replaying || st->drawing) return Rf_ScalarLogical(FALSE);

    return Rf_ScalarLogical(poll_resize_impl(st, dd, gdd));
}

/* Defined in transport.c */
SEXP C_jgd_discover(SEXP s_path);

/* Called from R: .Call(C_jgd_server_info, path) */
SEXP C_jgd_server_info(SEXP s_path) {
    pGEDevDesc gdd = GEcurrentDevice();
    int have_device = gdd && gdd->dev && jgd_is_jgd_device(gdd->dev);
    jgd_state_t *st = NULL;

    if (have_device) {
        st = (jgd_state_t *)gdd->dev->deviceSpecific;
        if (!st || !st->server_info_received) {
            have_device = 0;
        }
    }

    if (!have_device) {
        /* Fall back to discovery file, prepend connected=FALSE */
        SEXP disc = PROTECT(C_jgd_discover(s_path));
        if (disc == R_NilValue) {
            UNPROTECT(1);
            return R_NilValue;
        }
        /* Wrap: list(connected=FALSE, <discovery fields...>) */
        int disc_len = Rf_length(disc);
        SEXP result = PROTECT(Rf_allocVector(VECSXP, 1 + disc_len));
        SEXP rnames = PROTECT(Rf_allocVector(STRSXP, 1 + disc_len));
        SET_STRING_ELT(rnames, 0, Rf_mkChar("connected"));
        SET_VECTOR_ELT(result, 0, PROTECT(Rf_ScalarLogical(0)));
        SEXP disc_names = Rf_getAttrib(disc, R_NamesSymbol);
        for (int i = 0; i < disc_len; i++) {
            SET_VECTOR_ELT(result, 1 + i, VECTOR_ELT(disc, i));
            SET_STRING_ELT(rnames, 1 + i, STRING_ELT(disc_names, i));
        }
        Rf_setAttrib(result, R_NamesSymbol, rnames);
        UNPROTECT(4);
        return result;
    }

    /* Connected: build list(connected, server_name, protocol_version, transport, server_info) */
    SEXP result = PROTECT(Rf_allocVector(VECSXP, 5));
    SEXP names = PROTECT(Rf_allocVector(STRSXP, 5));

    SET_STRING_ELT(names, 0, Rf_mkChar("connected"));
    SET_STRING_ELT(names, 1, Rf_mkChar("server_name"));
    SET_STRING_ELT(names, 2, Rf_mkChar("protocol_version"));
    SET_STRING_ELT(names, 3, Rf_mkChar("transport"));
    SET_STRING_ELT(names, 4, Rf_mkChar("server_info"));
    Rf_setAttrib(result, R_NamesSymbol, names);

    SET_VECTOR_ELT(result, 0, PROTECT(Rf_ScalarLogical(1)));
    SET_VECTOR_ELT(result, 1, PROTECT(Rf_mkString(st->server_name)));
    SET_VECTOR_ELT(result, 2, PROTECT(Rf_ScalarInteger(st->protocol_version)));
    SET_VECTOR_ELT(result, 3, PROTECT(Rf_mkString(st->server_transport)));

    /* Build named character vector from kv pairs */
    int np = st->n_info_pairs;
    SEXP info = PROTECT(Rf_allocVector(STRSXP, np));
    SEXP info_names = PROTECT(Rf_allocVector(STRSXP, np));
    for (int i = 0; i < np; i++) {
        SET_STRING_ELT(info_names, i, Rf_mkChar(st->server_info_pairs[i].key));
        SET_STRING_ELT(info, i, Rf_mkChar(st->server_info_pairs[i].val));
    }
    Rf_setAttrib(info, R_NamesSymbol, info_names);
    SET_VECTOR_ELT(result, 4, info);

    UNPROTECT(8);
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
        wj->valuedouble > 0 && hj->valuedouble > 0 &&
        R_FINITE(wj->valuedouble) && R_FINITE(hj->valuedouble)) {
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
