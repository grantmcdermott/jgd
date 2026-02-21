#ifndef JGD_TRANSPORT_H
#define JGD_TRANSPORT_H

#include <stddef.h>

typedef struct {
    int fd;
    char socket_path[512];  /* URI (tcp://host:port, unix:///path, npipe:///name; localhost variant accepted) or raw path */
    int connected;
#ifdef _WIN32
    int use_pipe;       /* 1 = named pipe, 0 = TCP socket */
    void *pipe_handle;  /* HANDLE; INVALID_HANDLE_VALUE when unused */
#endif
} jgd_transport_t;

void transport_init(jgd_transport_t *t);
int transport_connect(jgd_transport_t *t);
int transport_send(jgd_transport_t *t, const char *data, size_t len);
int transport_has_data(jgd_transport_t *t);
int transport_recv_line(jgd_transport_t *t, char *buf, size_t bufsize, int timeout_ms);
void transport_close(jgd_transport_t *t);
int transport_reconnect(jgd_transport_t *t);

#endif
