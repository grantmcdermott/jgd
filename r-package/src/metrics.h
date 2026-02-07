#ifndef VSCGD_METRICS_H
#define VSCGD_METRICS_H

#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

/* Approximate string width in device units using built-in font metrics.
   This is the Phase 1 approach — no round-trip to the webview. */
double metrics_str_width(const char *str, const pGEcontext gc, double dpi);

/* Approximate character metrics (ascent, descent, width) in device units. */
void metrics_char_info(int c, const pGEcontext gc, double dpi,
                       double *ascent, double *descent, double *width);

#endif
