#include "display_list.h"
#include "color.h"
#include <stdlib.h>

/* All floating-point values use cJSON_CreateNumber / cJSON_AddNumberToObject.
 * cJSON formats these with full double precision (up to 17 significant digits),
 * which may produce slightly longer JSON than the previous %.4f formatting.
 * This is intentional: coordinate precision beyond 4 decimal places is
 * sub-pixel and harmless, while keeping all DOM nodes as proper cJSON_Number
 * ensures cJSON_IsNumber() and cJSON_GetNumberValue() work correctly.
 *
 * Non-finite values (NaN, Inf): cJSON_CreateNumber stores them as cJSON_Number
 * and cJSON's print_number() serializes them as "null" (cJSON.c L607-609).
 * R's graphics engine should never pass non-finite coordinates to device
 * callbacks, but cJSON handles the edge case safely regardless. */

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
            cJSON_AddItemToArray(arr, cJSON_CreateNumber(nibble * lwd));
        }
    }
    return arr;
}

cJSON *gc_to_cjson(const pGEcontext gc) {
    cJSON *g = cJSON_CreateObject();
    cJSON_AddItemToObject(g, "col", color_to_cjson(gc->col));
    cJSON_AddItemToObject(g, "fill", color_to_cjson(gc->fill));
    cJSON_AddNumberToObject(g, "lwd", gc->lwd);
    cJSON_AddItemToObject(g, "lty", lty_to_cjson(gc->lty, gc->lwd));
    cJSON_AddStringToObject(g, "lend", lend_str((int)gc->lend));
    cJSON_AddStringToObject(g, "ljoin", ljoin_str((int)gc->ljoin));
    cJSON_AddNumberToObject(g, "lmitre", gc->lmitre);

    cJSON *font = cJSON_AddObjectToObject(g, "font");
    cJSON_AddStringToObject(font, "family", gc->fontfamily[0] ? gc->fontfamily : "");
    cJSON_AddNumberToObject(font, "face", gc->fontface);
    cJSON_AddNumberToObject(font, "size", gc->cex * gc->ps);
    cJSON_AddNumberToObject(font, "lineheight", gc->lineheight);

    return g;
}

char *page_serialize_frame(jgd_page_t *p, const char *session_id, int incremental,
                           int new_page) {
    cJSON *frame = cJSON_CreateObject();
    cJSON_AddStringToObject(frame, "type", "frame");
    cJSON_AddBoolToObject(frame, "incremental", incremental);
    if (new_page && !incremental)
        cJSON_AddBoolToObject(frame, "newPage", 1);

    cJSON *plot = cJSON_AddObjectToObject(frame, "plot");
    cJSON_AddNumberToObject(plot, "version", 1);
    cJSON_AddStringToObject(plot, "sessionId", session_id ? session_id : "default");

    cJSON *device = cJSON_AddObjectToObject(plot, "device");
    cJSON_AddNumberToObject(device, "width", p->width);
    cJSON_AddNumberToObject(device, "height", p->height);
    cJSON_AddNumberToObject(device, "dpi", p->dpi);
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
