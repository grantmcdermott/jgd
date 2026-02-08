#ifndef JGD_PNG_ENCODER_H
#define JGD_PNG_ENCODER_H

#include <stddef.h>

unsigned char *png_encode_rgba(const unsigned char *rgba, int w, int h, size_t *out_len);
char *base64_encode(const unsigned char *data, size_t len, size_t *out_len);

#endif
