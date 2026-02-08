#ifndef JGD_COLOR_H
#define JGD_COLOR_H

#include "json_writer.h"
#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

void color_write_json(json_writer_t *w, int col);
void color_write_json_kv(json_writer_t *w, const char *key, int col);

#endif
