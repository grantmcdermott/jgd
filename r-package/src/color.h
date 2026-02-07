#ifndef VSCGD_COLOR_H
#define VSCGD_COLOR_H

#include "json_writer.h"
#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

/* Write an R color as "rgba(r,g,b,a)" string value, or null for NA/transparent */
void color_write_json(json_writer_t *w, int col);

/* Write color with a key */
void color_write_json_kv(json_writer_t *w, const char *key, int col);

#endif
