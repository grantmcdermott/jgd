#include "display_list.h"
#include "color.h"
#include <assert.h>
#include <string.h>
#include <stdio.h>

void page_init(jgd_page_t *p, double width, double height, double dpi, int bg) {
    jw_init(&p->jw);
    jw_arr_start(&p->jw);
    p->op_count = 0;
    p->width = width;
    p->height = height;
    p->dpi = dpi;
    p->bg = bg;
    p->finalized = 0;
    p->last_flush_offset = p->jw.len;  /* right after '[' */
}

void page_free(jgd_page_t *p) {
    jw_free(&p->jw);
}

json_writer_t *page_writer(jgd_page_t *p) {
    return &p->jw;
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

void lty_write_json(json_writer_t *w, int lty, double lwd) {
    jw_key(w, "lty");
    jw_arr_start(w);
    if (lty != LTY_SOLID && lty != LTY_BLANK) {
        for (int i = 0; i < 8; i++) {
            int nibble = (lty >> (4 * i)) & 0xF;
            if (nibble == 0) break;
            jw_dbl(w, nibble * lwd);
        }
    }
    jw_arr_end(w);
}

void gc_write_json(json_writer_t *w, const pGEcontext gc) {
    jw_key(w, "gc");
    jw_obj_start(w);

    color_write_json_kv(w, "col", gc->col);
    color_write_json_kv(w, "fill", gc->fill);
    jw_kv_dbl(w, "lwd", gc->lwd);
    lty_write_json(w, gc->lty, gc->lwd);
    jw_kv_str(w, "lend", lend_str((int)gc->lend));
    jw_kv_str(w, "ljoin", ljoin_str((int)gc->ljoin));
    jw_kv_dbl(w, "lmitre", gc->lmitre);

    jw_key(w, "font");
    jw_obj_start(w);
    jw_kv_str(w, "family", gc->fontfamily[0] ? gc->fontfamily : "");
    jw_kv_int(w, "face", gc->fontface);
    jw_kv_dbl(w, "size", gc->cex * gc->ps);
    jw_kv_dbl(w, "lineheight", gc->lineheight);
    jw_obj_end(w);

    jw_obj_end(w);
}

void page_serialize_frame(jgd_page_t *p, const char *session_id, json_writer_t *out, int incremental) {
    int was_comma = p->jw.needs_comma;

    jw_arr_end(&p->jw);

    jw_reset(out);
    jw_obj_start(out);

    jw_kv_str(out, "type", "frame");
    jw_kv_bool(out, "incremental", incremental);

    jw_key(out, "plot");
    jw_obj_start(out);

    jw_kv_int(out, "version", 1);
    jw_kv_str(out, "sessionId", session_id ? session_id : "default");

    jw_key(out, "device");
    jw_obj_start(out);
    jw_kv_dbl(out, "width", p->width);
    jw_kv_dbl(out, "height", p->height);
    jw_kv_dbl(out, "dpi", p->dpi);
    jw_key(out, "bg");
    color_write_json(out, p->bg);
    jw_obj_end(out);

    /* p->jw buffer must end with ']' from jw_arr_end above */
    assert(p->jw.buf[p->jw.len - 1] == ']');

    jw_key(out, "ops");
    if (incremental && p->last_flush_offset > 1 &&
        p->last_flush_offset < p->jw.len) {
        /* Delta encoding: send only ops added since last flush */
        size_t arr_end = p->jw.len - 1;  /* exclude trailing ']' */
        const char *delta = p->jw.buf + p->last_flush_offset;
        size_t dlen = arr_end - p->last_flush_offset;

        /* Skip leading comma between ops */
        if (dlen > 0 && delta[0] == ',') {
            delta++;
            dlen--;
        }

        if (dlen > 0) {
            /* Write "[" + delta_ops + "]" directly without allocation */
            jw_raw(out, "[", 1);
            out->needs_comma = 0;
            jw_raw(out, delta, dlen);
            out->needs_comma = 0;
            jw_raw(out, "]", 1);
        } else {
            jw_raw(out, "[]", 2);
        }
    } else {
        /* Full frame: send all ops */
        jw_raw(out, jw_result(&p->jw), jw_length(&p->jw));
    }

    jw_obj_end(out);
    jw_obj_end(out);

    /* Reopen: remove trailing ']' so more ops can be appended */
    p->jw.len--;
    p->jw.buf[p->jw.len] = '\0';
    p->jw.needs_comma = was_comma;

    /* Track flush position for next delta */
    p->last_flush_offset = p->jw.len;
}
