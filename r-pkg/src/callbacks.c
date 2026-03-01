#include "callbacks.h"
#include "device.h"
#include "display_list.h"
#include "color.h"
#include "metrics.h"
#include "png_encoder.h"
#include "cJSON.h"

#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>
#include <string.h>
#include <stdlib.h>

static void check_incoming(jgd_state_t *st, pDevDesc dd);
static void apply_pending_resize(jgd_state_t *st, pDevDesc dd);

static jgd_state_t *get_state(pDevDesc dd) {
    return (jgd_state_t *)dd->deviceSpecific;
}

void jgd_flush_frame(jgd_state_t *st, int incremental) {
    int np = (!incremental && st->new_page && !st->replaying) ? 1 : 0;
    char *json = page_serialize_frame(&st->page, st->session_id, incremental, np);
    if (json) {
        transport_send(&st->transport, json, strlen(json));
        free(json);
    }
    if (np) st->new_page = 0;
}

/* --- Device callbacks --- */

static void cb_activate(const pDevDesc dd) { (void)dd; }
static void cb_deactivate(const pDevDesc dd) { (void)dd; }

static void cb_newPage(const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);

    if (st->page_count > 0 && st->page.op_count > st->last_flushed_ops && !st->replaying) {
        jgd_flush_frame(st, 0);
    }

    /* Move the last_snapshot (captured when the complete frame was flushed)
     * into the snapshot store.  R clears the display list before calling
     * newPage, so GEcreateSnapshot here would capture an empty DL. */
    if (st->page_count > 0 && !st->replaying && st->last_snapshot != R_NilValue) {
        if (st->snapshot_count >= JGD_MAX_SNAPSHOTS) {
            for (int i = 0; i < JGD_MAX_SNAPSHOTS - 1; i++)
                SET_VECTOR_ELT(st->snapshot_store, i,
                               VECTOR_ELT(st->snapshot_store, i + 1));
            SET_VECTOR_ELT(st->snapshot_store, JGD_MAX_SNAPSHOTS - 1,
                           st->last_snapshot);
            st->snapshot_base++;
        } else {
            SET_VECTOR_ELT(st->snapshot_store, st->snapshot_count,
                           st->last_snapshot);
            st->snapshot_count++;
        }
        R_ReleaseObject(st->last_snapshot);
        st->last_snapshot = R_NilValue;
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
    st->new_page = 1;
}

static void cb_close(pDevDesc dd) {
    jgd_state_t *st = get_state(dd);

    /* Remove R input handler before closing the transport fd */
    jgd_remove_input_handler(st);

    if (st->page.op_count > st->last_flushed_ops) {
        jgd_flush_frame(st, 0);
    }

    /* Notify renderer that device is closing */
    const char *close_msg = "{\"type\":\"close\"}";
    transport_send(&st->transport, close_msg, strlen(close_msg));

    page_free(&st->page);
    transport_close(&st->transport);
    if (st->last_snapshot != R_NilValue)
        R_ReleaseObject(st->last_snapshot);
    R_ReleaseObject(st->snapshot_store);
    free(st);
    dd->deviceSpecific = NULL;
}

static void cb_clip(double x0, double x1, double y0, double y1, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "clip");
    cJSON_AddNumberToObject(op, "x0", x0);
    cJSON_AddNumberToObject(op, "y0", y0);
    cJSON_AddNumberToObject(op, "x1", x1);
    cJSON_AddNumberToObject(op, "y1", y1);
    page_add_op(&st->page, op);

    dd->clipLeft = x0;
    dd->clipRight = x1;
    dd->clipBottom = y0;
    dd->clipTop = y1;
}

static void cb_line(double x1, double y1, double x2, double y2,
                    const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "line");
    cJSON_AddNumberToObject(op, "x1", x1);
    cJSON_AddNumberToObject(op, "y1", y1);
    cJSON_AddNumberToObject(op, "x2", x2);
    cJSON_AddNumberToObject(op, "y2", y2);
    cJSON_AddItemToObject(op, "gc", gc_to_cjson(gc));
    page_add_op(&st->page, op);
}

static void cb_polyline(int n, double *x, double *y,
                        const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "polyline");
    cJSON_AddItemToObject(op, "x", cJSON_CreateDoubleArray(x, n));
    cJSON_AddItemToObject(op, "y", cJSON_CreateDoubleArray(y, n));
    cJSON_AddItemToObject(op, "gc", gc_to_cjson(gc));
    page_add_op(&st->page, op);
}

static void cb_polygon(int n, double *x, double *y,
                       const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "polygon");
    cJSON_AddItemToObject(op, "x", cJSON_CreateDoubleArray(x, n));
    cJSON_AddItemToObject(op, "y", cJSON_CreateDoubleArray(y, n));
    cJSON_AddItemToObject(op, "gc", gc_to_cjson(gc));
    page_add_op(&st->page, op);
}

static void cb_rect(double x0, double y0, double x1, double y1,
                    const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "rect");
    cJSON_AddNumberToObject(op, "x0", x0);
    cJSON_AddNumberToObject(op, "y0", y0);
    cJSON_AddNumberToObject(op, "x1", x1);
    cJSON_AddNumberToObject(op, "y1", y1);
    cJSON_AddItemToObject(op, "gc", gc_to_cjson(gc));
    page_add_op(&st->page, op);
}

static void cb_circle(double x, double y, double r,
                      const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "circle");
    cJSON_AddNumberToObject(op, "x", x);
    cJSON_AddNumberToObject(op, "y", y);
    cJSON_AddNumberToObject(op, "r", r);
    cJSON_AddItemToObject(op, "gc", gc_to_cjson(gc));
    page_add_op(&st->page, op);
}

static void cb_text(double x, double y, const char *str,
                    double rot, double hadj,
                    const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);
    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "text");
    cJSON_AddNumberToObject(op, "x", x);
    cJSON_AddNumberToObject(op, "y", y);
    cJSON_AddStringToObject(op, "str", str);
    cJSON_AddNumberToObject(op, "rot", rot);
    cJSON_AddNumberToObject(op, "hadj", hadj);
    cJSON_AddItemToObject(op, "gc", gc_to_cjson(gc));
    page_add_op(&st->page, op);
}

/* Helper: build gc font info for metrics request */
static cJSON *metrics_gc_cjson(const pGEcontext gc) {
    cJSON *g = cJSON_CreateObject();
    cJSON *font = cJSON_AddObjectToObject(g, "font");
    cJSON_AddStringToObject(font, "family", gc->fontfamily[0] ? gc->fontfamily : "");
    cJSON_AddNumberToObject(font, "face", gc->fontface);
    cJSON_AddNumberToObject(font, "size", gc->cex * gc->ps);
    return g;
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

/* Lookup by hash only — no key comparison.  Two distinct (str, gc) pairs
   that collide on the 32-bit hash will return a false hit.  This is an
   intentional simplicity/performance tradeoff; collision probability is
   negligible for typical plot workloads. */
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

/* Read a metrics response, stashing any resize messages that arrive first.
 *
 * NOTE: This loop can consume multiple normal resize messages while
 * searching for the metrics_response.  Each consumed normal resize
 * overwrites pending_w/pending_h, so earlier dimensions are lost.
 * This is acceptable in practice: metrics requests are brief (< 500ms
 * timeout), and the server's queue can tolerate a small mismatch because
 * R's display list replay (via poll_resize_impl) will produce frames for
 * any resizes that arrive after the metrics exchange completes.
 *
 * plotIndex resizes are routed to the single-entry buffer (same as
 * check_incoming) so they are not applied to the current page. */
static int recv_metrics_response(jgd_state_t *st, char *buf, size_t bufsize) {
    for (int attempts = 0; attempts < 5; attempts++) {
        int n = transport_recv_line(&st->transport, buf, bufsize, 500);
        if (n <= 0) return -1;

        cJSON *msg = cJSON_Parse(buf);
        if (!msg) continue;

        cJSON *type = cJSON_GetObjectItem(msg, "type");
        if (cJSON_IsString(type)) {
            if (strcmp(type->valuestring, "metrics_response") == 0) {
                cJSON_Delete(msg);
                return n;
            }
            if (strcmp(type->valuestring, "resize") == 0) {
                cJSON *w = cJSON_GetObjectItem(msg, "width");
                cJSON *h = cJSON_GetObjectItem(msg, "height");
                cJSON *pi = cJSON_GetObjectItem(msg, "plotIndex");
                if (cJSON_IsNumber(w) && cJSON_IsNumber(h) &&
                    w->valuedouble > 0 && h->valuedouble > 0) {
                    if (cJSON_IsNumber(pi)) {
                        /* plotIndex resize — buffer for poll_resize_impl,
                         * same as check_incoming does. */
                        st->has_buffered_resize = 1;
                        st->buffered_w = w->valuedouble;
                        st->buffered_h = h->valuedouble;
                        st->buffered_plot_index = (int)pi->valuedouble;
                    } else {
                        st->pending_w = w->valuedouble;
                        st->pending_h = h->valuedouble;
                    }
                }
            }
        }
        cJSON_Delete(msg);
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

    cJSON *req = cJSON_CreateObject();
    cJSON_AddStringToObject(req, "type", "metrics_request");
    cJSON_AddNumberToObject(req, "id", ++metrics_id_counter);
    cJSON_AddStringToObject(req, "kind", "strWidth");
    cJSON_AddStringToObject(req, "str", str);
    cJSON_AddItemToObject(req, "gc", metrics_gc_cjson(gc));

    char *json = cJSON_PrintUnformatted(req);
    cJSON_Delete(req);
    if (!json) return metrics_str_width(str, gc, st->dpi);
    transport_send(&st->transport, json, strlen(json));
    free(json);

    char buf[1024];
    int n = recv_metrics_response(st, buf, sizeof(buf));
    if (n <= 0)
        return metrics_str_width(str, gc, st->dpi);

    cJSON *resp = cJSON_Parse(buf);
    if (resp) {
        cJSON *wj = cJSON_GetObjectItem(resp, "width");
        double width = cJSON_IsNumber(wj) ? wj->valuedouble : 0.0;
        cJSON_Delete(resp);
        if (width > 0) {
            mcache_store(h, width, 0, 0);
            return width;
        }
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
    char key[16];
    snprintf(key, sizeof(key), "c%d", cc);
    unsigned int h = mcache_hash(key, (int)strlen(key), gc);
    mcache_entry_t *cached = mcache_lookup(h);
    if (cached) {
        *ascent = cached->v1;
        *descent = cached->v2;
        *width = cached->v3;
        return;
    }

    cJSON *req = cJSON_CreateObject();
    cJSON_AddStringToObject(req, "type", "metrics_request");
    cJSON_AddNumberToObject(req, "id", ++metrics_id_counter);
    cJSON_AddStringToObject(req, "kind", "metricInfo");
    cJSON_AddNumberToObject(req, "c", cc);
    cJSON_AddItemToObject(req, "gc", metrics_gc_cjson(gc));

    char *json = cJSON_PrintUnformatted(req);
    cJSON_Delete(req);
    if (!json) {
        metrics_char_info(c, gc, st->dpi, ascent, descent, width);
        return;
    }
    transport_send(&st->transport, json, strlen(json));
    free(json);

    char buf[1024];
    int n = recv_metrics_response(st, buf, sizeof(buf));
    if (n <= 0) {
        metrics_char_info(c, gc, st->dpi, ascent, descent, width);
        return;
    }

    cJSON *resp = cJSON_Parse(buf);
    if (resp) {
        cJSON *aj = cJSON_GetObjectItem(resp, "ascent");
        cJSON *dj = cJSON_GetObjectItem(resp, "descent");
        cJSON *wj = cJSON_GetObjectItem(resp, "width");
        double a = cJSON_IsNumber(aj) ? aj->valuedouble : 0.0;
        double d = cJSON_IsNumber(dj) ? dj->valuedouble : 0.0;
        double ww = cJSON_IsNumber(wj) ? wj->valuedouble : 0.0;
        cJSON_Delete(resp);
        if (a > 0 || d > 0 || ww > 0) {
            *ascent = a;
            *descent = d;
            *width = ww;
            mcache_store(h, a, d, ww);
            return;
        }
    }
    metrics_char_info(c, gc, st->dpi, ascent, descent, width);
}

static void check_incoming(jgd_state_t *st, pDevDesc dd) {
    /* Read at most ONE resize message, matching poll_resize_impl.
     * The while-loop that was here previously drained all available
     * messages, producing fewer frames than server queue entries when
     * multiple resizes arrived during drawing.
     *
     * If a plotIndex resize is already buffered from a previous call,
     * skip reading entirely — even normal resizes are deferred.  The
     * buffer is single-entry, so we cannot overwrite it.  Drawing is
     * typically fast, and poll_resize_impl will drain both the buffer
     * and any pending transport messages once R becomes idle. */
    if (st->has_buffered_resize)
        return;

    if (transport_has_data(&st->transport)) {
        char buf[1024];
        int plot_index = -1;
        double w = 0, h = 0;
        int n = transport_recv_line(&st->transport, buf, sizeof(buf), 0);
        if (n > 0 && jgd_try_parse_resize(buf, &w, &h, &plot_index)) {
            if (plot_index >= 0) {
                /* plotIndex resize targets a past plot — buffer it for
                 * poll_resize_impl instead of applying to current page. */
                st->has_buffered_resize = 1;
                st->buffered_w = w;
                st->buffered_h = h;
                st->buffered_plot_index = plot_index;
            } else {
                /* Normal resize — apply to current page via
                 * apply_pending_resize (called right after us). */
                st->pending_w = w;
                st->pending_h = h;
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
    if (st->replaying) return;
    if (mode == 1) {
        st->drawing = 1;
    } else if (mode == 0) {
        st->drawing = 0;
        /* Only flush when display is not held.  High-level plot functions
         * (plot, hist, …) bracket drawing with dev.hold/dev.flush, so
         * cb_holdflush handles the single flush at the end.  Without hold
         * (e.g. interactive lines()/points()), we flush immediately. */
        if (st->hold_level == 0 && st->page.op_count > st->last_flushed_ops) {
            /* First flush on a new page must be a complete frame so the
             * browser creates a new plot entry (addPlot) rather than
             * appending to the previous plot. */
            int incr = (st->last_flushed_ops > 0) ? 1 : 0;
            jgd_flush_frame(st, incr);
            st->last_flushed_ops = st->page.op_count;
            /* Capture a snapshot after each complete frame for historical
             * plot resizing.  The display list is valid at this point. */
            if (!incr) {
                pGEDevDesc gdd = (pGEDevDesc)st->ge_dev;
                SEXP snap = GEcreateSnapshot(gdd);
                if (snap != R_NilValue) {
                    if (st->last_snapshot != R_NilValue)
                        R_ReleaseObject(st->last_snapshot);
                    R_PreserveObject(snap);
                    st->last_snapshot = snap;
                }
            }
        }
    }
}

static int cb_holdflush(pDevDesc dd, int level) {
    jgd_state_t *st = get_state(dd);
    if (st->replaying) return st->hold_level;
    int old = st->hold_level;
    /* R passes level as a delta: dev.hold() passes +1, dev.flush() passes -1. */
    int new_level = old + level;
    if (new_level < 0) new_level = 0;
    st->hold_level = new_level;
    /* When transitioning from held to unheld, send accumulated frame. */
    if (old > 0 && new_level == 0) {
        if (st->page.op_count > st->last_flushed_ops) {
            jgd_flush_frame(st, 0);
            st->last_flushed_ops = st->page.op_count;
            /* Capture snapshot after complete frame flush */
            pGEDevDesc gdd = (pGEDevDesc)st->ge_dev;
            SEXP snap = GEcreateSnapshot(gdd);
            if (snap != R_NilValue) {
                if (st->last_snapshot != R_NilValue)
                    R_ReleaseObject(st->last_snapshot);
                R_PreserveObject(snap);
                st->last_snapshot = snap;
            }
        }
    }
    return old;
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
    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "path");
    cJSON_AddStringToObject(op, "winding", winding ? "nonzero" : "evenodd");

    cJSON *subpaths = cJSON_AddArrayToObject(op, "subpaths");
    int offset = 0;
    for (int i = 0; i < npoly; i++) {
        cJSON *subpath = cJSON_CreateArray();
        for (int j = 0; j < nper[i]; j++) {
            cJSON *pt = cJSON_CreateArray();
            cJSON_AddItemToArray(pt, cJSON_CreateNumber(x[offset + j]));
            cJSON_AddItemToArray(pt, cJSON_CreateNumber(y[offset + j]));
            cJSON_AddItemToArray(subpath, pt);
        }
        cJSON_AddItemToArray(subpaths, subpath);
        offset += nper[i];
    }

    cJSON_AddItemToObject(op, "gc", gc_to_cjson(gc));
    page_add_op(&st->page, op);
}

static void cb_raster(unsigned int *raster, int w, int h,
                      double x, double y, double width, double height,
                      double rot, Rboolean interpolate,
                      const pGEcontext gc, pDevDesc dd) {
    jgd_state_t *st = get_state(dd);

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

    size_t uri_len = 22 + b64_len;
    char *uri = (char *)malloc(uri_len + 1);
    if (!uri) { free(b64); return; }
    memcpy(uri, "data:image/png;base64,", 22);
    memcpy(uri + 22, b64, b64_len);
    uri[uri_len] = '\0';
    free(b64);

    cJSON *op = cJSON_CreateObject();
    cJSON_AddStringToObject(op, "op", "raster");
    cJSON_AddNumberToObject(op, "x", x);
    cJSON_AddNumberToObject(op, "y", y);
    cJSON_AddNumberToObject(op, "w", width);
    cJSON_AddNumberToObject(op, "h", height);
    cJSON_AddNumberToObject(op, "rot", rot);
    cJSON_AddBoolToObject(op, "interpolate", interpolate);
    cJSON_AddNumberToObject(op, "pw", w);
    cJSON_AddNumberToObject(op, "ph", h);
    cJSON_AddStringToObject(op, "data", uri);
    free(uri);

    page_add_op(&st->page, op);
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
    dd->holdflush = cb_holdflush;
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

int jgd_is_jgd_device(pDevDesc dd) {
    return dd && dd->close == cb_close;
}
