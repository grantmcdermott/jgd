#include "device.h"
#include "callbacks.h"
#include "png_encoder.h"

#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsDevice.h>
#include <R_ext/GraphicsEngine.h>

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

    return R_NilValue;
}

/* Called from R task callback: check for pending resize and replay if needed.
   Returns TRUE if a resize was applied, FALSE otherwise. */
SEXP C_jgd_poll_resize(void) {
    pGEDevDesc gdd = GEcurrentDevice();
    if (!gdd || !gdd->dev) return Rf_ScalarLogical(FALSE);

    pDevDesc dd = gdd->dev;
    jgd_state_t *st = (jgd_state_t *)dd->deviceSpecific;
    if (!st || st->replaying) return Rf_ScalarLogical(FALSE);

    /* Check socket for incoming resize messages */
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
        return Rf_ScalarLogical(FALSE);

    /* Apply the resize */
    st->width = st->pending_w / st->dpi;
    st->height = st->pending_h / st->dpi;
    dd->right = st->pending_w;
    dd->bottom = st->pending_h;
    dd->clipRight = st->pending_w;
    dd->clipBottom = st->pending_h;
    st->pending_w = 0;
    st->pending_h = 0;

    /* Replay the display list at new dimensions */
    st->replaying = 1;
    GEplayDisplayList(gdd);
    st->replaying = 0;

    return Rf_ScalarLogical(TRUE);
}
