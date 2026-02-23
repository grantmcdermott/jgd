#ifndef JGD_DISPLAY_LIST_H
#define JGD_DISPLAY_LIST_H

#include "cJSON.h"
#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

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
/* Returns a malloc'd JSON string (caller must free). */
char *page_serialize_frame(jgd_page_t *p, const char *session_id, int incremental);
cJSON *gc_to_cjson(const pGEcontext gc);
cJSON *lty_to_cjson(int lty, double lwd);

/* Format a double as %.4f with trailing-zero stripping (wire format compat). */
static inline cJSON *cjson_create_dbl(double val) {
    if (!isfinite(val)) return cJSON_CreateNull();
    char tmp[64];
    int n = snprintf(tmp, sizeof(tmp), "%.4f", val);
    if (strchr(tmp, '.')) {
        while (n > 1 && tmp[n - 1] == '0') n--;
        if (n > 0 && tmp[n - 1] == '.') n--;
    }
    tmp[n] = '\0';
    return cJSON_CreateRaw(tmp);
}

static inline void cjson_add_dbl(cJSON *obj, const char *name, double val) {
    cJSON_AddItemToObject(obj, name, cjson_create_dbl(val));
}

static inline cJSON *cjson_create_dbl_arr(const double *vals, int n) {
    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; i < n; i++) {
        cJSON_AddItemToArray(arr, cjson_create_dbl(vals[i]));
    }
    return arr;
}

#endif
