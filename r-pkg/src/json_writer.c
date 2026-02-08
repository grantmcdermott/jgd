#include "json_writer.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>

#define JW_INIT_CAP 4096

static void jw_ensure(json_writer_t *w, size_t extra) {
    if (w->len + extra + 1 > w->cap) {
        size_t need = w->len + extra + 1;
        size_t newcap = w->cap * 2;
        if (newcap < need) newcap = need;
        w->buf = realloc(w->buf, newcap);
        w->cap = newcap;
    }
}

static void jw_putc(json_writer_t *w, char c) {
    jw_ensure(w, 1);
    w->buf[w->len++] = c;
    w->buf[w->len] = '\0';
}

static void jw_puts(json_writer_t *w, const char *s, size_t n) {
    jw_ensure(w, n);
    memcpy(w->buf + w->len, s, n);
    w->len += n;
    w->buf[w->len] = '\0';
}

static void jw_comma(json_writer_t *w) {
    if (w->needs_comma) jw_putc(w, ',');
    w->needs_comma = 1;
}

void jw_init(json_writer_t *w) {
    w->buf = malloc(JW_INIT_CAP);
    w->buf[0] = '\0';
    w->len = 0;
    w->cap = JW_INIT_CAP;
    w->depth = 0;
    w->needs_comma = 0;
}

void jw_free(json_writer_t *w) {
    free(w->buf);
    w->buf = NULL;
    w->len = w->cap = 0;
}

void jw_reset(json_writer_t *w) {
    w->len = 0;
    w->buf[0] = '\0';
    w->depth = 0;
    w->needs_comma = 0;
}

const char *jw_result(json_writer_t *w) { return w->buf; }
size_t jw_length(json_writer_t *w) { return w->len; }

void jw_obj_start(json_writer_t *w) {
    jw_comma(w);
    jw_putc(w, '{');
    w->depth++;
    w->needs_comma = 0;
}

void jw_obj_end(json_writer_t *w) {
    jw_putc(w, '}');
    w->depth--;
    w->needs_comma = 1;
}

void jw_arr_start(json_writer_t *w) {
    jw_comma(w);
    jw_putc(w, '[');
    w->depth++;
    w->needs_comma = 0;
}

void jw_arr_end(json_writer_t *w) {
    jw_putc(w, ']');
    w->depth--;
    w->needs_comma = 1;
}

void jw_key(json_writer_t *w, const char *key) {
    jw_comma(w);
    jw_putc(w, '"');
    /* keys are known safe ASCII, no escaping needed */
    size_t klen = strlen(key);
    jw_puts(w, key, klen);
    jw_putc(w, '"');
    jw_putc(w, ':');
    w->needs_comma = 0;
}

/* Escape a UTF-8 string value */
void jw_str(json_writer_t *w, const char *val) {
    jw_comma(w);
    jw_putc(w, '"');
    if (val) {
        const unsigned char *p = (const unsigned char *)val;
        while (*p) {
            if (*p == '"') { jw_puts(w, "\\\"", 2); }
            else if (*p == '\\') { jw_puts(w, "\\\\", 2); }
            else if (*p == '\n') { jw_puts(w, "\\n", 2); }
            else if (*p == '\r') { jw_puts(w, "\\r", 2); }
            else if (*p == '\t') { jw_puts(w, "\\t", 2); }
            else if (*p < 0x20) {
                char esc[8];
                int n = snprintf(esc, sizeof(esc), "\\u%04x", *p);
                jw_puts(w, esc, (size_t)n);
            } else {
                jw_putc(w, (char)*p);
            }
            p++;
        }
    }
    jw_putc(w, '"');
    w->needs_comma = 1;
}

void jw_int(json_writer_t *w, int val) {
    jw_comma(w);
    char tmp[32];
    int n = snprintf(tmp, sizeof(tmp), "%d", val);
    jw_puts(w, tmp, (size_t)n);
    w->needs_comma = 1;
}

void jw_dbl(json_writer_t *w, double val) {
    jw_comma(w);
    if (!isfinite(val)) {
        jw_puts(w, "null", 4);
    } else {
        char tmp[64];
        int n = snprintf(tmp, sizeof(tmp), "%.4f", val);
        /* strip trailing zeros after decimal point */
        if (strchr(tmp, '.')) {
            while (n > 1 && tmp[n - 1] == '0') n--;
            if (n > 0 && tmp[n - 1] == '.') n--;
        }
        jw_puts(w, tmp, (size_t)n);
    }
    w->needs_comma = 1;
}

void jw_bool(json_writer_t *w, int val) {
    jw_comma(w);
    if (val) jw_puts(w, "true", 4);
    else jw_puts(w, "false", 5);
    w->needs_comma = 1;
}

void jw_null(json_writer_t *w) {
    jw_comma(w);
    jw_puts(w, "null", 4);
    w->needs_comma = 1;
}

void jw_raw(json_writer_t *w, const char *raw, size_t len) {
    jw_comma(w);
    jw_puts(w, raw, len);
    w->needs_comma = 1;
}

void jw_kv_str(json_writer_t *w, const char *key, const char *val) {
    jw_key(w, key); jw_str(w, val);
}

void jw_kv_int(json_writer_t *w, const char *key, int val) {
    jw_key(w, key); jw_int(w, val);
}

void jw_kv_dbl(json_writer_t *w, const char *key, double val) {
    jw_key(w, key); jw_dbl(w, val);
}

void jw_kv_bool(json_writer_t *w, const char *key, int val) {
    jw_key(w, key); jw_bool(w, val);
}

void jw_kv_null(json_writer_t *w, const char *key) {
    jw_key(w, key); jw_null(w);
}

void jw_kv_dbl_arr(json_writer_t *w, const char *key, const double *vals, int n) {
    jw_key(w, key);
    jw_putc(w, '[');
    w->needs_comma = 0;
    for (int i = 0; i < n; i++) {
        jw_dbl(w, vals[i]);
    }
    jw_putc(w, ']');
    w->needs_comma = 1;
}
