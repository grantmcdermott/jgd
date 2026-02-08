#include "png_encoder.h"
#include <stdlib.h>
#include <string.h>

/*
 * Minimal uncompressed PNG encoder.
 * Produces valid PNG with filter=none and zlib stored blocks (no compression).
 * This avoids any dependency on zlib/libpng.
 * Output is larger than compressed PNG but correct and simple.
 */

/* CRC32 for PNG chunks */
static unsigned int crc_table[256];
static int crc_table_init = 0;

static void make_crc_table(void) {
    for (unsigned int n = 0; n < 256; n++) {
        unsigned int c = n;
        for (int k = 0; k < 8; k++) {
            if (c & 1) c = 0xEDB88320u ^ (c >> 1);
            else c = c >> 1;
        }
        crc_table[n] = c;
    }
    crc_table_init = 1;
}

static unsigned int crc32_update(unsigned int crc, const unsigned char *buf, size_t len) {
    if (!crc_table_init) make_crc_table();
    unsigned int c = crc ^ 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++)
        c = crc_table[(c ^ buf[i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

static void put32be(unsigned char *p, unsigned int v) {
    p[0] = (v >> 24) & 0xFF;
    p[1] = (v >> 16) & 0xFF;
    p[2] = (v >> 8) & 0xFF;
    p[3] = v & 0xFF;
}

static unsigned int adler32(const unsigned char *data, size_t len) {
    unsigned int a = 1, b = 0;
    for (size_t i = 0; i < len; i++) {
        a = (a + data[i]) % 65521;
        b = (b + a) % 65521;
    }
    return (b << 16) | a;
}

unsigned char *png_encode_rgba(const unsigned char *rgba, int w, int h, size_t *out_len) {
    /* Each row: filter byte (0) + w*4 RGBA bytes */
    size_t raw_row = 1 + (size_t)w * 4;
    size_t raw_size = raw_row * (size_t)h;

    /* Build raw filtered data */
    unsigned char *raw = malloc(raw_size);
    if (!raw) return NULL;
    for (int y = 0; y < h; y++) {
        raw[y * raw_row] = 0; /* filter: none */
        memcpy(raw + y * raw_row + 1, rgba + y * w * 4, (size_t)w * 4);
    }

    /* Zlib stored block wrapping:
       header (2 bytes) + stored blocks + adler32 (4 bytes)
       Each stored block: 1 byte (final flag) + 2 bytes len + 2 bytes ~len + data
       Max block size = 65535 */
    size_t nblocks = (raw_size + 65534) / 65535;
    size_t zlib_size = 2 + raw_size + nblocks * 5 + 4;

    unsigned char *zlib = malloc(zlib_size);
    if (!zlib) { free(raw); return NULL; }

    size_t zp = 0;
    zlib[zp++] = 0x78; /* CMF: deflate, window=32768 */
    zlib[zp++] = 0x01; /* FLG: check bits */

    size_t remaining = raw_size;
    size_t rp = 0;
    while (remaining > 0) {
        size_t blen = remaining > 65535 ? 65535 : remaining;
        zlib[zp++] = (remaining <= 65535) ? 1 : 0; /* final flag */
        zlib[zp++] = blen & 0xFF;
        zlib[zp++] = (blen >> 8) & 0xFF;
        zlib[zp++] = ~blen & 0xFF;
        zlib[zp++] = (~blen >> 8) & 0xFF;
        memcpy(zlib + zp, raw + rp, blen);
        zp += blen;
        rp += blen;
        remaining -= blen;
    }

    unsigned int adler = adler32(raw, raw_size);
    put32be(zlib + zp, adler);
    zp += 4;
    free(raw);

    /* PNG file: signature + IHDR + IDAT + IEND */
    size_t png_size = 8 + (12 + 13) + (12 + zp) + 12;
    unsigned char *png = malloc(png_size);
    if (!png) { free(zlib); return NULL; }

    size_t pp = 0;

    /* Signature */
    static const unsigned char sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    memcpy(png + pp, sig, 8); pp += 8;

    /* IHDR */
    put32be(png + pp, 13); pp += 4;
    memcpy(png + pp, "IHDR", 4);
    put32be(png + pp + 4, (unsigned int)w);
    put32be(png + pp + 8, (unsigned int)h);
    png[pp + 12] = 8;  /* bit depth */
    png[pp + 13] = 6;  /* color type: RGBA */
    png[pp + 14] = 0;  /* compression */
    png[pp + 15] = 0;  /* filter */
    png[pp + 16] = 0;  /* interlace */
    unsigned int ihdr_crc = crc32_update(0, png + pp, 17);
    pp += 17;
    put32be(png + pp, ihdr_crc); pp += 4;

    /* IDAT */
    put32be(png + pp, (unsigned int)zp); pp += 4;
    memcpy(png + pp, "IDAT", 4);
    memcpy(png + pp + 4, zlib, zp);
    unsigned int idat_crc = crc32_update(0, png + pp, 4 + zp);
    pp += 4 + zp;
    put32be(png + pp, idat_crc); pp += 4;
    free(zlib);

    /* IEND */
    put32be(png + pp, 0); pp += 4;
    memcpy(png + pp, "IEND", 4);
    unsigned int iend_crc = crc32_update(0, png + pp, 4);
    pp += 4;
    put32be(png + pp, iend_crc); pp += 4;

    *out_len = pp;
    return png;
}

static const char b64_table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

char *base64_encode(const unsigned char *data, size_t len, size_t *out_len) {
    size_t olen = 4 * ((len + 2) / 3);
    char *out = malloc(olen + 1);
    if (!out) return NULL;

    size_t i, j;
    for (i = 0, j = 0; i + 2 < len; i += 3, j += 4) {
        unsigned int v = ((unsigned int)data[i] << 16) | ((unsigned int)data[i+1] << 8) | data[i+2];
        out[j]   = b64_table[(v >> 18) & 0x3F];
        out[j+1] = b64_table[(v >> 12) & 0x3F];
        out[j+2] = b64_table[(v >> 6) & 0x3F];
        out[j+3] = b64_table[v & 0x3F];
    }
    if (i < len) {
        unsigned int v = (unsigned int)data[i] << 16;
        if (i + 1 < len) v |= (unsigned int)data[i+1] << 8;
        out[j]   = b64_table[(v >> 18) & 0x3F];
        out[j+1] = b64_table[(v >> 12) & 0x3F];
        out[j+2] = (i + 1 < len) ? b64_table[(v >> 6) & 0x3F] : '=';
        out[j+3] = '=';
        j += 4;
    }
    out[j] = '\0';
    if (out_len) *out_len = j;
    return out;
}
