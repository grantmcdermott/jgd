#ifndef JGD_DISPLAY_LIST_H
#define JGD_DISPLAY_LIST_H

#include "json_writer.h"
#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

typedef struct {
    json_writer_t jw;
    int op_count;
    double width;
    double height;
    double dpi;
    int bg;
    int finalized;
    size_t last_flush_offset; /* byte offset in jw.buf after last incremental flush */
} jgd_page_t;

void page_init(jgd_page_t *p, double width, double height, double dpi, int bg);
void page_free(jgd_page_t *p);
json_writer_t *page_writer(jgd_page_t *p);
void page_serialize_frame(jgd_page_t *p, const char *session_id, json_writer_t *out, int incremental);
void gc_write_json(json_writer_t *w, const pGEcontext gc);
void lty_write_json(json_writer_t *w, int lty, double lwd);

#endif
