#ifndef JGD_TRANSPORT_H
#define JGD_TRANSPORT_H

#include <stddef.h>

typedef struct {
    int fd;
    char socket_path[512];  /* Unix path or "tcp:PORT" on Windows */
    int connected;
} jgd_transport_t;

void transport_init(jgd_transport_t *t);
int transport_connect(jgd_transport_t *t);
int transport_send(jgd_transport_t *t, const char *data, size_t len);
int transport_has_data(jgd_transport_t *t);
int transport_recv_line(jgd_transport_t *t, char *buf, size_t bufsize, int timeout_ms);
void transport_close(jgd_transport_t *t);
int transport_reconnect(jgd_transport_t *t);

#endif
