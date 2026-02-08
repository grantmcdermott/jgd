#include "metrics.h"
#include <string.h>
#include <math.h>

/*
 * Approximation-based font metrics, modeled after R's pdf() device.
 * Uses average character width ratios for sans-serif, serif, mono.
 * These are rough but sufficient for layout in MVP.
 *
 * Reference: 10pt font at 72 DPI. Scale by (cex * ps / 10) * (dpi / 72).
 */

/* Average character width as fraction of font size for common families */
static double avg_char_width(const char *family, int face) {
    /* Monospace: all chars same width, ~0.6 of font size */
    if (family[0] == 'm' || family[0] == 'M' ||
        strcmp(family, "Courier") == 0 || strcmp(family, "mono") == 0) {
        return 0.6;
    }
    /* Serif: slightly narrower than sans */
    if (strcmp(family, "serif") == 0 || strcmp(family, "Times") == 0) {
        /* Bold is wider */
        if (face == 2 || face == 4) return 0.52;
        return 0.48;
    }
    /* Default: sans-serif */
    if (face == 2 || face == 4) return 0.56;
    return 0.53;
}

/* Ascent as fraction of font size */
static double char_ascent_frac(void) { return 0.75; }

/* Descent as fraction of font size */
static double char_descent_frac(void) { return 0.25; }

static double font_size_device(const pGEcontext gc, double dpi) {
    return gc->cex * gc->ps * (dpi / 72.0);
}

double metrics_str_width(const char *str, const pGEcontext gc, double dpi) {
    if (!str) return 0.0;
    double sz = font_size_device(gc, dpi);
    double cw = avg_char_width(gc->fontfamily, gc->fontface);

    /* Count UTF-8 characters (not bytes) */
    int nchars = 0;
    const unsigned char *p = (const unsigned char *)str;
    while (*p) {
        if ((*p & 0xC0) != 0x80) nchars++; /* count lead bytes */
        p++;
    }
    return nchars * cw * sz;
}

void metrics_char_info(int c, const pGEcontext gc, double dpi,
                       double *ascent, double *descent, double *width) {
    double sz = font_size_device(gc, dpi);
    double cw = avg_char_width(gc->fontfamily, gc->fontface);

    *ascent = char_ascent_frac() * sz;
    *descent = char_descent_frac() * sz;
    *width = cw * sz;

    /* Space is narrower */
    if (c == ' ' || c == 32) {
        *width = 0.25 * sz;
    }
}
