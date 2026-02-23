#include "color.h"
#include <stdio.h>

cJSON *color_to_cjson(int col) {
    if (col == NA_INTEGER || R_TRANSPARENT(col)) {
        return cJSON_CreateNull();
    }
    char buf[48];
    int a = R_ALPHA(col);
    if (a == 255) {
        snprintf(buf, sizeof(buf), "rgba(%d,%d,%d,1)",
                 R_RED(col), R_GREEN(col), R_BLUE(col));
    } else {
        snprintf(buf, sizeof(buf), "rgba(%d,%d,%d,%.3f)",
                 R_RED(col), R_GREEN(col), R_BLUE(col), a / 255.0);
    }
    return cJSON_CreateString(buf);
}
