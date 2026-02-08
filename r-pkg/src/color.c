#include "color.h"
#include <stdio.h>

void color_write_json(json_writer_t *w, int col) {
    if (col == NA_INTEGER || R_TRANSPARENT(col)) {
        jw_null(w);
    } else {
        char buf[48];
        int a = R_ALPHA(col);
        if (a == 255) {
            snprintf(buf, sizeof(buf), "rgba(%d,%d,%d,1)",
                     R_RED(col), R_GREEN(col), R_BLUE(col));
        } else {
            snprintf(buf, sizeof(buf), "rgba(%d,%d,%d,%.3f)",
                     R_RED(col), R_GREEN(col), R_BLUE(col), a / 255.0);
        }
        jw_str(w, buf);
    }
}

void color_write_json_kv(json_writer_t *w, const char *key, int col) {
    jw_key(w, key);
    color_write_json(w, col);
}
