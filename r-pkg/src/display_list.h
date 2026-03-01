#ifndef JGD_DISPLAY_LIST_H
#define JGD_DISPLAY_LIST_H

#include "cJSON.h"
#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

typedef struct {
    cJSON *ops;             /* cJSON array of drawing operations */
    cJSON *ops_tail;        /* last item in ops (O(1) append tracking) */
    cJSON *last_flush_tail; /* tail at time of last flush (delta starts at ->next) */
    int op_count;
    double width;
    double height;
    double dpi;
    int bg;
} jgd_page_t;

void page_init(jgd_page_t *p, double width, double height, double dpi, int bg);
void page_free(jgd_page_t *p);
void page_add_op(jgd_page_t *p, cJSON *op);
/* Returns a malloc'd JSON string (caller must free).
 * new_page: if 1, adds "newPage":true so the server knows this is a
 * new plot, not a resize replay. */
char *page_serialize_frame(jgd_page_t *p, const char *session_id, int incremental,
                           int new_page);
cJSON *gc_to_cjson(const pGEcontext gc);
cJSON *lty_to_cjson(int lty, double lwd);

#endif
