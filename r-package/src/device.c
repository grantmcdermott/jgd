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

/* Called from R: .Call(C_vscgd, width, height, dpi) */
SEXP C_vscgd(SEXP s_width, SEXP s_height, SEXP s_dpi) {
    double width = Rf_asReal(s_width);    /* inches */
    double height = Rf_asReal(s_height);  /* inches */
    double dpi = Rf_asReal(s_dpi);

    if (width <= 0) width = 7.0;
    if (height <= 0) height = 7.0;
    if (dpi <= 0) dpi = 96.0;

    R_GE_checkVersionOrDie(R_GE_version);
    R_CheckDeviceAvailable();

    /* Allocate device state */
    vscgd_state_t *st = (vscgd_state_t *)calloc(1, sizeof(vscgd_state_t));
    if (!st) Rf_error("vscgd: failed to allocate device state");

    st->width = width;
    st->height = height;
    st->dpi = dpi;
    st->page_count = 0;
    st->drawing = 0;
    snprintf(st->session_id, sizeof(st->session_id), "r-%d", (int)getpid());

    /* Initialize transport */
    transport_init(&st->transport);
    jw_init(&st->frame_buf);

    /* Initialize first page (will be re-initialized on newPage) */
    page_init(&st->page, width * dpi, height * dpi, dpi, R_RGB(255, 255, 255));

    /* Try to connect — warn but don't fail if extension isn't running */
    if (transport_connect(&st->transport) != 0) {
        Rf_warning("vscgd: could not connect to VS Code extension. "
                   "Plots will be recorded but not displayed until connection is established.");
    }

    /* Create the device descriptor */
    pDevDesc dd = (pDevDesc)calloc(1, sizeof(DevDesc));
    if (!dd) {
        free(st);
        Rf_error("vscgd: failed to allocate DevDesc");
    }

    double w_px = width * dpi;
    double h_px = height * dpi;

    /* Device physical characteristics */
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

    /* Character size in device units (pixels) at default 12pt */
    dd->cra[0] = 0.9 * 12.0 * (dpi / 72.0);
    dd->cra[1] = 1.2 * 12.0 * (dpi / 72.0);

    dd->gamma = 1.0;

    /* Capabilities */
    dd->canClip = TRUE;
    dd->canChangeGamma = FALSE;
    dd->canHAdj = 2; /* full horizontal adjustment [0,1] */

    /* Initial settings */
    dd->startps = 12.0;
    dd->startcol = R_RGB(0, 0, 0);
    dd->startfill = R_RGB(255, 255, 255);
    dd->startlty = LTY_SOLID;
    dd->startfont = 1;
    dd->startgamma = 1.0;

    dd->deviceSpecific = st;
    dd->displayListOn = TRUE;

    /* Event capabilities */
    dd->canGenMouseDown = FALSE;
    dd->canGenMouseMove = FALSE;
    dd->canGenMouseUp = FALSE;
    dd->canGenKeybd = FALSE;
    dd->canGenIdle = FALSE;
    dd->gettingEvent = FALSE;

    /* UTF-8 support */
    dd->hasTextUTF8 = TRUE;
    dd->wantSymbolUTF8 = TRUE;
    dd->useRotatedTextInContour = TRUE;

    /* Transparency and raster support */
    dd->haveTransparency = 2;  /* yes */
    dd->haveTransparentBg = 2; /* fully */
    dd->haveRaster = 2;        /* yes */
    dd->haveCapture = 1;       /* no (Phase 3) */
    dd->haveLocator = 1;       /* no (Phase 3) */

    dd->deviceVersion = 0;  /* Basic device — R uses fallbacks for advanced features */

#if R_GE_version >= 13
    dd->deviceClip = FALSE;
#endif

    /* Install callbacks */
    vscgd_set_callbacks(dd);

    /* Register with the graphics engine */
    pGEDevDesc gdd = GEcreateDevDesc(dd);
    GEaddDevice2(gdd, "vscgd");
    GEinitDisplayList(gdd);

    return R_NilValue;
}
