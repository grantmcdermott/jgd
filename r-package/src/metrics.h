#ifndef JGD_METRICS_H
#define JGD_METRICS_H

#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

double metrics_str_width(const char *str, const pGEcontext gc, double dpi);
void metrics_char_info(int c, const pGEcontext gc, double dpi,
                       double *ascent, double *descent, double *width);

#endif
