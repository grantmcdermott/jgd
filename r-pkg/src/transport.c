#include "transport.h"

#include <R.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
typedef SOCKET sock_t;
#define SOCK_INVALID INVALID_SOCKET
#define SOCK_CLOSE closesocket
#define SOCK_ERR WSAGetLastError()
static int wsa_initialized = 0;
static void ensure_wsa(void) {
    if (!wsa_initialized) {
        WSADATA wsa;
        WSAStartup(MAKEWORD(2, 2), &wsa);
        wsa_initialized = 1;
    }
}
#else
#include <sys/socket.h>
#include <sys/un.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
typedef int sock_t;
#define SOCK_INVALID (-1)
#define SOCK_CLOSE close
#define SOCK_ERR errno
#define ensure_wsa()
#endif

/*
 * Parse a TCP address from socket_path into a sockaddr_in.
 * Format: "tcp://host:port" (host may be IP or "localhost")
 * Returns 0 on success, -1 on failure.
 */
static int parse_tcp(const char *path, struct sockaddr_in *out) {
    memset(out, 0, sizeof(*out));
    out->sin_family = AF_INET;

    if (strncmp(path, "tcp://", 6) == 0) {
        const char *hp = path + 6;
        const char *colon = strrchr(hp, ':');
        if (!colon) return -1;

        char host[256];
        size_t hlen = (size_t)(colon - hp);
        if (hlen == 0 || hlen >= sizeof(host)) return -1;
        memcpy(host, hp, hlen);
        host[hlen] = '\0';

        int port = atoi(colon + 1);
        if (port <= 0 || port > 65535) return -1;
        out->sin_port = htons((unsigned short)port);

        if (strcmp(host, "localhost") == 0) {
            out->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        } else {
            unsigned long ip = inet_addr(host);
            if (ip == INADDR_NONE) return -1;
            out->sin_addr.s_addr = ip;
        }
        return 0;
    }

    return -1;
}

void transport_init(jgd_transport_t *t) {
    t->fd = (int)SOCK_INVALID;
    t->socket_path[0] = '\0';
    t->connected = 0;
}

static int discover_socket_path(char *out, size_t outsize) {
    /* Scan discovery files in temp directories */
    const char *tmpdirs[] = {
        getenv("TMPDIR"),
        getenv("TMP"),
        getenv("TEMP"),
#ifdef _WIN32
        getenv("USERPROFILE"),
#endif
        "/tmp",
    };
    int n_tmpdirs = (int)(sizeof(tmpdirs) / sizeof(tmpdirs[0]));

    for (int t = 0; t < n_tmpdirs; t++) {
        if (!tmpdirs[t] || !tmpdirs[t][0]) continue;
        char discovery[1024];
        snprintf(discovery, sizeof(discovery), "%s/jgd-discovery.json", tmpdirs[t]);

        FILE *f = fopen(discovery, "r");
        if (!f) continue;

        char line[2048];
        char *path_start = NULL;
        while (fgets(line, sizeof(line), f)) {
            path_start = strstr(line, "\"socketPath\"");
            if (path_start) break;
        }
        fclose(f);

        if (!path_start) continue;

        char *colon = strchr(path_start, ':');
        if (!colon) continue;
        char *quote1 = strchr(colon, '"');
        if (!quote1) continue;
        quote1++;
        char *quote2 = strchr(quote1, '"');
        if (!quote2) continue;

        size_t plen = (size_t)(quote2 - quote1);
        if (plen >= outsize) continue;
        memcpy(out, quote1, plen);
        out[plen] = '\0';
        return 0;
    }

    return -1;
}

static int try_connect(jgd_transport_t *t) {
    ensure_wsa();

    /* Try TCP: tcp://host:port */
    struct sockaddr_in tcp_addr;
    if (parse_tcp(t->socket_path, &tcp_addr) == 0) {
        sock_t s = socket(AF_INET, SOCK_STREAM, 0);
        if (s == SOCK_INVALID) return -1;

        if (connect(s, (struct sockaddr *)&tcp_addr, sizeof(tcp_addr)) != 0) {
            SOCK_CLOSE(s);
            return -1;
        }

        t->fd = (int)s;
        t->connected = 1;
        return 0;
    }

#ifndef _WIN32
    /* Unix domain socket: unix:///path or raw /path */
    const char *upath = t->socket_path;
    if (strncmp(upath, "unix://", 7) == 0)
        upath += 7;
    if (*upath == '\0') return -1;

    sock_t s = socket(AF_UNIX, SOCK_STREAM, 0);
    if (s == SOCK_INVALID) return -1;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof(addr.sun_path), "%s", upath);

    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        SOCK_CLOSE(s);
        return -1;
    }

    t->fd = (int)s;
    t->connected = 1;
    return 0;
#else
    /* Windows: only TCP is supported */
    return -1;
#endif
}

int transport_connect(jgd_transport_t *t) {
    if (t->connected) return 0;

    if (t->socket_path[0] == '\0') {
        if (discover_socket_path(t->socket_path, sizeof(t->socket_path)) != 0) {
            REprintf("jgd: cannot find socket path. "
                     "Pass socket= to jgd() or start the rendering server.\n");
            return -1;
        }
    }

    if (try_connect(t) == 0) return 0;

    REprintf("jgd: connect(%s) failed: %d\n", t->socket_path, SOCK_ERR);
    return -1;
}

int transport_send(jgd_transport_t *t, const char *data, size_t len) {
    if (!t->connected) return -1;

    sock_t s = (sock_t)t->fd;
    size_t sent = 0;
    while (sent < len) {
        int n = (int)send(s, data + sent, (int)(len - sent), 0);
        if (n <= 0) {
            t->connected = 0;
            return -1;
        }
        sent += (size_t)n;
    }
    char nl = '\n';
    if (send(s, &nl, 1, 0) <= 0) {
        t->connected = 0;
        return -1;
    }
    return 0;
}

int transport_has_data(jgd_transport_t *t) {
    if (!t->connected) return 0;
    sock_t s = (sock_t)t->fd;
#ifndef _WIN32
    struct pollfd pfd;
    pfd.fd = s;
    pfd.events = POLLIN;
    return poll(&pfd, 1, 0) > 0 ? 1 : 0;
#else
    fd_set readfds;
    FD_ZERO(&readfds);
    FD_SET(s, &readfds);
    struct timeval tv = {0, 0};
    return select(0, &readfds, NULL, NULL, &tv) > 0 ? 1 : 0;
#endif
}

int transport_recv_line(jgd_transport_t *t, char *buf, size_t bufsize, int timeout_ms) {
    if (!t->connected) return -1;

    sock_t s = (sock_t)t->fd;

#ifndef _WIN32
    struct pollfd pfd;
    pfd.fd = s;
    pfd.events = POLLIN;
    int pr = poll(&pfd, 1, timeout_ms);
    if (pr <= 0) return -1;
#else
    fd_set readfds;
    FD_ZERO(&readfds);
    FD_SET(s, &readfds);
    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    int sr = select(0, &readfds, NULL, NULL, &tv);
    if (sr <= 0) return -1;
#endif

    size_t pos = 0;
    while (pos < bufsize - 1) {
        char c;
        int n = (int)recv(s, &c, 1, 0);
        if (n <= 0) { t->connected = 0; return -1; }
        if (c == '\n') break;
        buf[pos++] = c;
    }
    buf[pos] = '\0';
    return (int)pos;
}

void transport_close(jgd_transport_t *t) {
    if (t->fd != (int)SOCK_INVALID) {
        SOCK_CLOSE((sock_t)t->fd);
        t->fd = (int)SOCK_INVALID;
    }
    t->connected = 0;
}

int transport_reconnect(jgd_transport_t *t) {
    transport_close(t);
    t->socket_path[0] = '\0';
    for (int attempt = 0; attempt < 3; attempt++) {
        if (transport_connect(t) == 0) return 0;
#ifdef _WIN32
        Sleep(100);
#else
        usleep(100000);
#endif
    }
    return -1;
}
