#ifndef VSCGD_JSON_WRITER_H
#define VSCGD_JSON_WRITER_H

#include <stddef.h>

typedef struct {
    char *buf;
    size_t len;
    size_t cap;
    int depth;       /* nesting depth for comma logic */
    int needs_comma; /* whether next value needs a leading comma */
} json_writer_t;

void jw_init(json_writer_t *w);
void jw_free(json_writer_t *w);
void jw_reset(json_writer_t *w);

/* Returns pointer to null-terminated JSON string. Valid until next jw_ call. */
const char *jw_result(json_writer_t *w);
size_t jw_length(json_writer_t *w);

void jw_obj_start(json_writer_t *w);
void jw_obj_end(json_writer_t *w);
void jw_arr_start(json_writer_t *w);
void jw_arr_end(json_writer_t *w);

void jw_key(json_writer_t *w, const char *key);

void jw_str(json_writer_t *w, const char *val);
void jw_int(json_writer_t *w, int val);
void jw_dbl(json_writer_t *w, double val);
void jw_bool(json_writer_t *w, int val);
void jw_null(json_writer_t *w);
void jw_raw(json_writer_t *w, const char *raw, size_t len);

/* Convenience: key + value in one call */
void jw_kv_str(json_writer_t *w, const char *key, const char *val);
void jw_kv_int(json_writer_t *w, const char *key, int val);
void jw_kv_dbl(json_writer_t *w, const char *key, double val);
void jw_kv_bool(json_writer_t *w, const char *key, int val);
void jw_kv_null(json_writer_t *w, const char *key);

/* Write a double array compactly: [1.0,2.0,3.0] */
void jw_kv_dbl_arr(json_writer_t *w, const char *key, const double *vals, int n);

#endif
