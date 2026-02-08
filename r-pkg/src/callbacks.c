#include "callbacks.h"
#include "device.h"
#include "display_list.h"
#include "color.h"
#include "metrics.h"
#include "png_encoder.h"
#include "json_writer.h"

#include <R.h>
#include <Rinternals.h>
#include <string.h>
#include <stdlib.h>

static void check_incoming(jgd_state_t *st, pDevDesc dd);
static void apply_pending_resize(jgd_state_t *st, pDevDesc dd);

static jgd_state_t *get_state(pDevDesc dd) {
    return (jgd_state_t *)dd->deviceSpecific;
}

static void flush_frame(jgd_state_t *st, int incremental) {
    page_serialize_frame(&st->page, st->session_id, &st->frame_buf, incremental);
    transport_send(&st->transport, jw_result(&st->frame_buf), jw_length(&st->frame_buf));
}

/* --- Device callbacks --- */

static void cb_activate(const pDevDesc dd) { (void)dd; }
static void cb_deactivate(const pDevDesc dd) { (void)dd; }

static void cb_newPage(const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);

    if (st->page_count > 0 && st->page.op_count > 0 && !st->replaying) {
        flush_frame(st, 0);
    }

    if (st->page_count > 0) {
        page_free(&st->page);
    }

    check_incoming(st, dd);
    apply_pending_resize(st, dd);

    double w_px = st->width * st->dpi;
    double h_px = st->height * st->dpi;
    page_init(&st->page, w_px, h_px, st->dpi, gc->fill);
    st->page_count++;
    st->last_flushed_ops = 0;
}

static void cb_close(pDevDesc dd) {
    jgd_state_t *st = get_state(dd);

    if (st->page.op_count > st->last_flushed_ops) {
        flush_frame(st, 0);
    }

    /* Notify renderer that device is closing */
    const char *close_msg = "{\"type\":\"close\"}";
    transport_send(&st->transport, close_msg, strlen(close_msg));

    page_free(&st->page);
    jw_free(&st->frame_buf);
    transport_close(&st->transport);
    free(st);
    dd->deviceSpecific = NULL;
}

static void cb_clip(double x0, double x1, double y0, double y1, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *w = page_writer(&st->page);

    jw_obj_start(w);
    jw_kv_str(w, "op", "clip");
    jw_kv_dbl(w, "x0", x0);
    jw_kv_dbl(w, "y0", y0);
    jw_kv_dbl(w, "x1", x1);
    jw_kv_dbl(w, "y1", y1);
    jw_obj_end(w);
    st->page.op_count++;

    dd->clipLeft = x0;
    dd->clipRight = x1;
    dd->clipBottom = y0;
    dd->clipTop = y1;
}

static void cb_line(double x1, double y1, double x2, double y2,
                    const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *w = page_writer(&st->page);

    jw_obj_start(w);
    jw_kv_str(w, "op", "line");
    jw_kv_dbl(w, "x1", x1);
    jw_kv_dbl(w, "y1", y1);
    jw_kv_dbl(w, "x2", x2);
    jw_kv_dbl(w, "y2", y2);
    gc_write_json(w, gc);
    jw_obj_end(w);
    st->page.op_count++;
}

static void cb_polyline(int n, double *x, double *y,
                        const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *w = page_writer(&st->page);

    jw_obj_start(w);
    jw_kv_str(w, "op", "polyline");
    jw_kv_dbl_arr(w, "x", x, n);
    jw_kv_dbl_arr(w, "y", y, n);
    gc_write_json(w, gc);
    jw_obj_end(w);
    st->page.op_count++;
}

static void cb_polygon(int n, double *x, double *y,
                       const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *w = page_writer(&st->page);

    jw_obj_start(w);
    jw_kv_str(w, "op", "polygon");
    jw_kv_dbl_arr(w, "x", x, n);
    jw_kv_dbl_arr(w, "y", y, n);
    gc_write_json(w, gc);
    jw_obj_end(w);
    st->page.op_count++;
}

static void cb_rect(double x0, double y0, double x1, double y1,
                    const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *w = page_writer(&st->page);

    jw_obj_start(w);
    jw_kv_str(w, "op", "rect");
    jw_kv_dbl(w, "x0", x0);
    jw_kv_dbl(w, "y0", y0);
    jw_kv_dbl(w, "x1", x1);
    jw_kv_dbl(w, "y1", y1);
    gc_write_json(w, gc);
    jw_obj_end(w);
    st->page.op_count++;
}

static void cb_circle(double x, double y, double r,
                      const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *w = page_writer(&st->page);

    jw_obj_start(w);
    jw_kv_str(w, "op", "circle");
    jw_kv_dbl(w, "x", x);
    jw_kv_dbl(w, "y", y);
    jw_kv_dbl(w, "r", r);
    gc_write_json(w, gc);
    jw_obj_end(w);
    st->page.op_count++;
}

static void cb_text(double x, double y, const char *str,
                    double rot, double hadj,
                    const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *w = page_writer(&st->page);

    jw_obj_start(w);
    jw_kv_str(w, "op", "text");
    jw_kv_dbl(w, "x", x);
    jw_kv_dbl(w, "y", y);
    jw_kv_str(w, "str", str);
    jw_kv_dbl(w, "rot", rot);
    jw_kv_dbl(w, "hadj", hadj);
    gc_write_json(w, gc);
    jw_obj_end(w);
    st->page.op_count++;
}

/* Helper: write gc font info for metrics request */
static void metrics_gc_json(json_writer_t *w, const pGEcontext gc) {
    jw_key(w, "gc");
    jw_obj_start(w);
    jw_key(w, "font");
    jw_obj_start(w);
    jw_kv_str(w, "family", gc->fontfamily[0] ? gc->fontfamily : "");
    jw_kv_int(w, "face", gc->fontface);
    jw_kv_dbl(w, "size", gc->cex * gc->ps);
    jw_obj_end(w);
    jw_obj_end(w);
}

/* Parse a double value after "key": in a JSON string */
static double parse_json_dbl(const char *json, const char *key) {
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\"", key);
    const char *p = strstr(json, needle);
    if (!p) return 0.0;
    p = strchr(p, ':');
    if (!p) return 0.0;
    return strtod(p + 1, NULL);
}

static int metrics_id_counter = 0;

/* --- Simple metrics cache --- */
#define MCACHE_SIZE 512

typedef struct {
    unsigned int hash;
    double v1, v2, v3;  /* width (strWidth) or ascent/descent/width (metricInfo) */
    int occupied;
} mcache_entry_t;

static mcache_entry_t mcache[MCACHE_SIZE];

static unsigned int mcache_hash(const char *str, int len, const pGEcontext gc) {
    unsigned int h = 5381;
    for (int i = 0; i < len; i++)
        h = ((h << 5) + h) ^ (unsigned char)str[i];
    h = ((h << 5) + h) ^ gc->fontface;
    /* hash the font size bits */
    double sz = gc->cex * gc->ps;
    unsigned int sz_bits;
    memcpy(&sz_bits, &sz, sizeof(sz_bits));
    h = ((h << 5) + h) ^ sz_bits;
    const char *fam = gc->fontfamily;
    while (*fam) h = ((h << 5) + h) ^ (unsigned char)*fam++;
    return h;
}

static mcache_entry_t *mcache_lookup(unsigned int hash) {
    mcache_entry_t *e = &mcache[hash % MCACHE_SIZE];
    if (e->occupied && e->hash == hash) return e;
    return NULL;
}

static void mcache_store(unsigned int hash, double v1, double v2, double v3) {
    mcache_entry_t *e = &mcache[hash % MCACHE_SIZE];
    e->hash = hash;
    e->v1 = v1;
    e->v2 = v2;
    e->v3 = v3;
    e->occupied = 1;
}

/* Read a metrics response, stashing any resize messages that arrive first */
static int recv_metrics_response(jgd_state_t *st, char *buf, size_t bufsize) {
    for (int attempts = 0; attempts < 5; attempts++) {
        int n = transport_recv_line(&st->transport, buf, bufsize, 500);
        if (n <= 0) return -1;
        if (strstr(buf, "\"metrics_response\"")) return n;
        /* Got a non-metrics message (e.g. resize) — stash and retry */
        if (strstr(buf, "\"resize\"")) {
            char *wp = strstr(buf, "\"width\"");
            char *hp = strstr(buf, "\"height\"");
            if (wp && hp) {
                double w = 0, h = 0;
                wp = strchr(wp, ':'); if (wp) w = strtod(wp + 1, NULL);
                hp = strchr(hp, ':'); if (hp) h = strtod(hp + 1, NULL);
                if (w > 0 && h > 0) {
                    st->pending_w = w;
                    st->pending_h = h;
                }
            }
        }
    }
    return -1;
}

static double cb_strWidth(const char *str, const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    if (!st->transport.connected)
        return metrics_str_width(str, gc, st->dpi);

    unsigned int h = mcache_hash(str, (int)strlen(str), gc);
    mcache_entry_t *cached = mcache_lookup(h);
    if (cached) return cached->v1;

    json_writer_t w;
    jw_init(&w);
    jw_obj_start(&w);
    jw_kv_str(&w, "type", "metrics_request");
    jw_kv_int(&w, "id", ++metrics_id_counter);
    jw_kv_str(&w, "kind", "strWidth");
    jw_kv_str(&w, "str", str);
    metrics_gc_json(&w, gc);
    jw_obj_end(&w);

    transport_send(&st->transport, jw_result(&w), jw_length(&w));
    jw_free(&w);

    char buf[1024];
    int n = recv_metrics_response(st, buf, sizeof(buf));
    if (n <= 0)
        return metrics_str_width(str, gc, st->dpi);

    double width = parse_json_dbl(buf, "width");
    if (width > 0) {
        mcache_store(h, width, 0, 0);
        return width;
    }
    return metrics_str_width(str, gc, st->dpi);
}

static void cb_metricInfo(int c, const pGEcontext gc,
                          double *ascent, double *descent, double *width,
                          pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    if (!st->transport.connected) {
        metrics_char_info(c, gc, st->dpi, ascent, descent, width);
        return;
    }

    int cc = c < 0 ? -c : c;
    char key[8];
    snprintf(key, sizeof(key), "c%d", cc);
    unsigned int h = mcache_hash(key, (int)strlen(key), gc);
    mcache_entry_t *cached = mcache_lookup(h);
    if (cached) {
        *ascent = cached->v1;
        *descent = cached->v2;
        *width = cached->v3;
        return;
    }

    json_writer_t w;
    jw_init(&w);
    jw_obj_start(&w);
    jw_kv_str(&w, "type", "metrics_request");
    jw_kv_int(&w, "id", ++metrics_id_counter);
    jw_kv_str(&w, "kind", "metricInfo");
    jw_kv_int(&w, "c", cc);
    metrics_gc_json(&w, gc);
    jw_obj_end(&w);

    transport_send(&st->transport, jw_result(&w), jw_length(&w));
    jw_free(&w);

    char buf[1024];
    int n = recv_metrics_response(st, buf, sizeof(buf));
    if (n <= 0) {
        metrics_char_info(c, gc, st->dpi, ascent, descent, width);
        return;
    }

    double a = parse_json_dbl(buf, "ascent");
    double d = parse_json_dbl(buf, "descent");
    double ww = parse_json_dbl(buf, "width");
    if (a > 0 || d > 0 || ww > 0) {
        *ascent = a;
        *descent = d;
        *width = ww;
        mcache_store(h, a, d, ww);
    } else {
        metrics_char_info(c, gc, st->dpi, ascent, descent, width);
    }
}

static void check_incoming(jgd_state_t *st, pDevDesc dd) {
    while (transport_has_data(&st->transport)) {
        char buf[1024];
        int n = transport_recv_line(&st->transport, buf, sizeof(buf), 0);
        if (n <= 0) break;

        if (strstr(buf, "\"resize\"")) {
            char *wp = strstr(buf, "\"width\"");
            char *hp = strstr(buf, "\"height\"");
            if (wp && hp) {
                double w = 0, h = 0;
                wp = strchr(wp, ':'); if (wp) w = strtod(wp + 1, NULL);
                hp = strchr(hp, ':'); if (hp) h = strtod(hp + 1, NULL);
                if (w > 0 && h > 0) {
                    st->pending_w = w;
                    st->pending_h = h;
                }
            }
        }
    }
}

static void apply_pending_resize(jgd_state_t *st, pDevDesc dd) {
    if (st->pending_w > 0 && st->pending_h > 0) {
        st->width = st->pending_w / st->dpi;
        st->height = st->pending_h / st->dpi;
        dd->right = st->pending_w;
        dd->bottom = st->pending_h;
        dd->clipRight = st->pending_w;
        dd->clipBottom = st->pending_h;
        st->pending_w = 0;
        st->pending_h = 0;
    }
}

static void cb_mode(int mode, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    if (mode == 1) {
        st->drawing = 1;
    } else if (mode == 0) {
        st->drawing = 0;
        if (st->page.op_count > st->last_flushed_ops) {
            flush_frame(st, 1);
            st->last_flushed_ops = st->page.op_count;
        }
    }
}

static void cb_size(double *left, double *right, double *bottom, double *top,
                    pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    *left = 0.0;
    *right = st->width * st->dpi;
    *bottom = st->height * st->dpi;
    *top = 0.0;
}

static void cb_path(double *x, double *y, int npoly, int *nper,
                    Rboolean winding, const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *w = page_writer(&st->page);

    jw_obj_start(w);
    jw_kv_str(w, "op", "path");
    jw_kv_str(w, "winding", winding ? "nonzero" : "evenodd");

    jw_key(w, "subpaths");
    jw_arr_start(w);
    int offset = 0;
    for (int i = 0; i < npoly; i++) {
        jw_arr_start(w);
        for (int j = 0; j < nper[i]; j++) {
            jw_arr_start(w);
            jw_dbl(w, x[offset + j]);
            jw_dbl(w, y[offset + j]);
            jw_arr_end(w);
        }
        jw_arr_end(w);
        offset += nper[i];
    }
    jw_arr_end(w);

    gc_write_json(w, gc);
    jw_obj_end(w);
    st->page.op_count++;
}

static void cb_raster(unsigned int *raster, int w, int h,
                      double x, double y, double width, double height,
                      double rot, Rboolean interpolate,
                      const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    json_writer_t *jw = page_writer(&st->page);

    size_t npix = (size_t)w * (size_t)h;
    unsigned char *rgba = (unsigned char *)malloc(npix * 4);
    if (!rgba) return;
    for (size_t i = 0; i < npix; i++) {
        unsigned int c = raster[i];
        rgba[i * 4 + 0] = R_RED(c);
        rgba[i * 4 + 1] = R_GREEN(c);
        rgba[i * 4 + 2] = R_BLUE(c);
        rgba[i * 4 + 3] = R_ALPHA(c);
    }

    size_t png_len = 0;
    unsigned char *png = png_encode_rgba(rgba, w, h, &png_len);
    free(rgba);
    if (!png) return;

    size_t b64_len = 0;
    char *b64 = base64_encode(png, png_len, &b64_len);
    free(png);
    if (!b64) return;

    jw_obj_start(jw);
    jw_kv_str(jw, "op", "raster");
    jw_kv_dbl(jw, "x", x);
    jw_kv_dbl(jw, "y", y);
    jw_kv_dbl(jw, "w", width);
    jw_kv_dbl(jw, "h", height);
    jw_kv_dbl(jw, "rot", rot);
    jw_kv_bool(jw, "interpolate", interpolate);
    jw_kv_int(jw, "pw", w);
    jw_kv_int(jw, "ph", h);

    jw_key(jw, "data");
    size_t uri_len = 22 + b64_len;
    char *uri = (char *)malloc(uri_len + 1);
    if (uri) {
        memcpy(uri, "data:image/png;base64,", 22);
        memcpy(uri + 22, b64, b64_len);
        uri[uri_len] = '\0';
        jw_str(jw, uri);
        free(uri);
    } else {
        jw_null(jw);
    }
    free(b64);

    jw_obj_end(jw);
    st->page.op_count++;
}

/* No-op stubs for R >= 4.1 pattern/mask/clip-path/group callbacks */
static SEXP cb_setPattern(SEXP pattern, pDevDesc dd) { return R_NilValue; }
static void cb_releasePattern(SEXP ref, pDevDesc dd) { }
static SEXP cb_setClipPath(SEXP path, SEXP ref, pDevDesc dd) { return R_NilValue; }
static void cb_releaseClipPath(SEXP ref, pDevDesc dd) { }
static SEXP cb_setMask(SEXP path, SEXP ref, pDevDesc dd) { return R_NilValue; }
static void cb_releaseMask(SEXP ref, pDevDesc dd) { }

#if R_GE_version >= 15
static SEXP cb_defineGroup(SEXP source, int op, SEXP destination, pDevDesc dd) { return R_NilValue; }
static void cb_useGroup(SEXP ref, SEXP trans, pDevDesc dd) { }
static void cb_releaseGroup(SEXP ref, pDevDesc dd) { }
static void cb_stroke(SEXP path, const pGEcontext gc, pDevDesc dd) { }
static void cb_fill_path(SEXP path, int rule, const pGEcontext gc, pDevDesc dd) { }
static void cb_fillStroke(SEXP path, int rule, const pGEcontext gc, pDevDesc dd) { }
static SEXP cb_capabilities(SEXP cap) { return cap; }
#endif

#if R_GE_version >= 16
static void cb_glyph(int n, int *glyphs, double *x, double *y,
                     SEXP font, double size, int colour, double rot, pDevDesc dd) { }
#endif

void jgd_set_callbacks(pDevDesc dd) {
    dd->activate = cb_activate;
    dd->deactivate = cb_deactivate;
    dd->newPage = cb_newPage;
    dd->close = cb_close;
    dd->clip = cb_clip;
    dd->line = cb_line;
    dd->polyline = cb_polyline;
    dd->polygon = cb_polygon;
    dd->rect = cb_rect;
    dd->circle = cb_circle;
    dd->text = cb_text;
    dd->textUTF8 = cb_text;
    dd->strWidth = cb_strWidth;
    dd->strWidthUTF8 = cb_strWidth;
    dd->metricInfo = cb_metricInfo;
    dd->mode = cb_mode;
    dd->size = cb_size;
    dd->path = cb_path;
    dd->raster = cb_raster;

    dd->locator = NULL;
    dd->onExit = NULL;
    dd->getEvent = NULL;
    dd->newFrameConfirm = NULL;
    dd->eventHelper = NULL;
    dd->holdflush = NULL;
    dd->cap = NULL;

    dd->setPattern = cb_setPattern;
    dd->releasePattern = cb_releasePattern;
    dd->setClipPath = cb_setClipPath;
    dd->releaseClipPath = cb_releaseClipPath;
    dd->setMask = cb_setMask;
    dd->releaseMask = cb_releaseMask;

#if R_GE_version >= 15
    dd->defineGroup = cb_defineGroup;
    dd->useGroup = cb_useGroup;
    dd->releaseGroup = cb_releaseGroup;
    dd->stroke = cb_stroke;
    dd->fill = cb_fill_path;
    dd->fillStroke = cb_fillStroke;
    dd->capabilities = cb_capabilities;
#endif

#if R_GE_version >= 16
    dd->glyph = cb_glyph;
#endif
}
