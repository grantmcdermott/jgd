#ifndef VSCGD_DISPLAY_LIST_H
#define VSCGD_DISPLAY_LIST_H

#include "json_writer.h"
#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

/* A page is just a JSON writer accumulating ops into an array.
   We track page metadata separately. */
typedef struct {
    json_writer_t jw;     /* JSON being built: the ops array content */
    int op_count;
    double width;
    double height;
    double dpi;
    int bg;               /* background color (R integer) */
    int finalized;
} vscgd_page_t;

/* Initialize a new page */
void page_init(vscgd_page_t *p, double width, double height, double dpi, int bg);

/* Free page resources */
void page_free(vscgd_page_t *p);

/* Get the JSON writer for appending ops */
json_writer_t *page_writer(vscgd_page_t *p);

/* Serialize the complete page as a frame message.
   Caller must jw_free the returned writer. */
void page_serialize_frame(vscgd_page_t *p, const char *session_id, json_writer_t *out, int incremental);

/* Write the graphics context fields to the JSON writer */
void gc_write_json(json_writer_t *w, const pGEcontext gc);

/* Write lty as a dash array */
void lty_write_json(json_writer_t *w, int lty, double lwd);

#endif
