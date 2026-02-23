#include "display_list.h"
#include "color.h"
#include <stdlib.h>

void page_init(jgd_page_t *p, double width, double height, double dpi, int bg) {
    p->ops = cJSON_CreateArray();
    p->ops_tail = NULL;
    p->last_flush_tail = NULL;
    p->op_count = 0;
    p->width = width;
    p->height = height;
    p->dpi = dpi;
    p->bg = bg;
}

void page_free(jgd_page_t *p) {
    cJSON_Delete(p->ops);
    p->ops = NULL;
    p->ops_tail = NULL;
    p->last_flush_tail = NULL;
}

void page_add_op(jgd_page_t *p, cJSON *op) {
    cJSON_AddItemToArray(p->ops, op);
    p->ops_tail = op;
    p->op_count++;
}

static const char *lend_str(int lend) {
    switch (lend) {
        case GE_ROUND_CAP:  return "round";
        case GE_BUTT_CAP:   return "butt";
        case GE_SQUARE_CAP: return "square";
        default:             return "round";
    }
}

static const char *ljoin_str(int ljoin) {
    switch (ljoin) {
        case GE_ROUND_JOIN: return "round";
        case GE_MITRE_JOIN: return "miter";
        case GE_BEVEL_JOIN: return "bevel";
        default:             return "round";
    }
}

cJSON *lty_to_cjson(int lty, double lwd) {
    cJSON *arr = cJSON_CreateArray();
    if (lty != LTY_SOLID && lty != LTY_BLANK) {
        for (int i = 0; i < 8; i++) {
            int nibble = (lty >> (4 * i)) & 0xF;
            if (nibble == 0) break;
            cJSON_AddItemToArray(arr, cjson_create_dbl(nibble * lwd));
        }
    }
    return arr;
}

cJSON *gc_to_cjson(const pGEcontext gc) {
    cJSON *g = cJSON_CreateObject();
    cJSON_AddItemToObject(g, "col", color_to_cjson(gc->col));
    cJSON_AddItemToObject(g, "fill", color_to_cjson(gc->fill));
    cjson_add_dbl(g, "lwd", gc->lwd);
    cJSON_AddItemToObject(g, "lty", lty_to_cjson(gc->lty, gc->lwd));
    cJSON_AddStringToObject(g, "lend", lend_str((int)gc->lend));
    cJSON_AddStringToObject(g, "ljoin", ljoin_str((int)gc->ljoin));
    cjson_add_dbl(g, "lmitre", gc->lmitre);

    cJSON *font = cJSON_AddObjectToObject(g, "font");
    cJSON_AddStringToObject(font, "family", gc->fontfamily[0] ? gc->fontfamily : "");
    cJSON_AddNumberToObject(font, "face", gc->fontface);
    cjson_add_dbl(font, "size", gc->cex * gc->ps);
    cjson_add_dbl(font, "lineheight", gc->lineheight);

    return g;
}

char *page_serialize_frame(jgd_page_t *p, const char *session_id, int incremental) {
    cJSON *frame = cJSON_CreateObject();
    cJSON_AddStringToObject(frame, "type", "frame");
    cJSON_AddBoolToObject(frame, "incremental", incremental);

    cJSON *plot = cJSON_AddObjectToObject(frame, "plot");
    cJSON_AddNumberToObject(plot, "version", 1);
    cJSON_AddStringToObject(plot, "sessionId", session_id ? session_id : "default");

    cJSON *device = cJSON_AddObjectToObject(plot, "device");
    cjson_add_dbl(device, "width", p->width);
    cjson_add_dbl(device, "height", p->height);
    cjson_add_dbl(device, "dpi", p->dpi);
    cJSON_AddItemToObject(device, "bg", color_to_cjson(p->bg));

    /* Build ops array: delta (incremental) or full */
    cJSON *ops_arr = cJSON_CreateArray();
    cJSON *start;
    if (incremental && p->last_flush_tail) {
        start = p->last_flush_tail->next;
    } else {
        start = p->ops->child;
    }
    for (cJSON *cur = start; cur; cur = cur->next) {
        cJSON_AddItemReferenceToArray(ops_arr, cur);
    }
    cJSON_AddItemToObject(plot, "ops", ops_arr);

    char *json = cJSON_PrintUnformatted(frame);
    cJSON_Delete(frame); /* safe: ops are references, originals stay in p->ops */

    /* Track flush position for next delta */
    p->last_flush_tail = p->ops_tail;

    return json;
}
