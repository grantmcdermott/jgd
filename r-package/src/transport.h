#ifndef VSCGD_TRANSPORT_H
#define VSCGD_TRANSPORT_H

#include <stddef.h>

typedef struct {
    int fd;
    char socket_path[512];
    int connected;
} vscgd_transport_t;

/* Initialize transport (does not connect yet) */
void transport_init(vscgd_transport_t *t);

/* Discover socket path from env var or discovery file, then connect.
   Returns 0 on success, -1 on failure. */
int transport_connect(vscgd_transport_t *t);

/* Send a complete NDJSON message (appends \n). Returns 0 on success. */
int transport_send(vscgd_transport_t *t, const char *data, size_t len);

/* Non-blocking check for pending data. Returns 1 if data available, 0 if not. */
int transport_has_data(vscgd_transport_t *t);

/* Read a line (up to \n) into buf. Blocks with timeout_ms.
   Returns bytes read (excluding \n), or -1 on error/timeout. */
int transport_recv_line(vscgd_transport_t *t, char *buf, size_t bufsize, int timeout_ms);

/* Close the connection */
void transport_close(vscgd_transport_t *t);

/* Attempt reconnection. Returns 0 on success. */
int transport_reconnect(vscgd_transport_t *t);

#endif
