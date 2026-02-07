#ifndef VSCGD_PNG_ENCODER_H
#define VSCGD_PNG_ENCODER_H

#include <stddef.h>

/* Encode RGBA pixels to an uncompressed PNG.
   Returns malloc'd buffer (caller must free). Sets *out_len.
   Returns NULL on failure. */
unsigned char *png_encode_rgba(const unsigned char *rgba, int w, int h, size_t *out_len);

/* Base64-encode binary data. Returns malloc'd string (caller must free). */
char *base64_encode(const unsigned char *data, size_t len, size_t *out_len);

#endif
