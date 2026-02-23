#include "transport.h"
#include "cJSON.h"

#include <R.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
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
#include <strings.h>  /* strncasecmp */
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

#ifdef _WIN32
/* Parse npipe:///NAME or npipe://localhost/NAME → \\.\pipe\NAME.
 * Returns 0 on success, -1 if not an npipe URI. */
static int parse_npipe(const char *path, char *buf, size_t bufsize) {
    const char *name;
    if (_strnicmp(path, "npipe://localhost/", 18) == 0) {
        name = path + 18;
    } else if (strncmp(path, "npipe:///", 9) == 0) {
        name = path + 9;
    } else {
        return -1;
    }

    /* "\\\\.\\pipe\\" is 9 characters; plus 1 for the terminating NUL. */
    if (bufsize <= 10) return -1;

    {
        size_t name_len = strlen(name);
        if (name_len == 0 || name_len > bufsize - 10) return -1;
    }

    snprintf(buf, bufsize, "\\\\.\\pipe\\%s", name);
    return 0;
}
#endif

void transport_init(jgd_transport_t *t) {
    t->fd = (int)SOCK_INVALID;
    t->socket_path[0] = '\0';
    t->connected = 0;
    t->readbuf_len = 0;
#ifdef _WIN32
    t->pipe_handle = INVALID_HANDLE_VALUE;
    t->overlap_event = NULL;
#endif
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

        fseek(f, 0, SEEK_END);
        long fsize = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (fsize <= 0 || fsize > 65536) { fclose(f); continue; }

        char *content = (char *)malloc((size_t)fsize + 1);
        if (!content) { fclose(f); continue; }
        size_t nread = fread(content, 1, (size_t)fsize, f);
        fclose(f);
        content[nread] = '\0';

        cJSON *json = cJSON_Parse(content);
        free(content);
        if (!json) continue;

        cJSON *sp = cJSON_GetObjectItem(json, "socketPath");
        if (cJSON_IsString(sp) && sp->valuestring) {
            size_t plen = strlen(sp->valuestring);
            if (plen > 0 && plen < outsize) {
                memcpy(out, sp->valuestring, plen + 1);
                cJSON_Delete(json);
                return 0;
            }
        }
        cJSON_Delete(json);
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
    /* Unix domain socket: unix:///path, unix://localhost/path, or raw /path */
    const char *upath = t->socket_path;
    if (strncasecmp(upath, "unix://localhost/", 17) == 0)
        upath += 16;  /* keep leading "/" */
    else if (strncmp(upath, "unix:///", 8) == 0)
        upath += 7;
    else if (strncmp(upath, "unix://", 7) == 0)
        return -1;  /* reject non-empty, non-localhost authority */
    if (*upath == '\0') return -1;

    size_t pathlen = strlen(upath);
    if (pathlen >= sizeof(((struct sockaddr_un *)0)->sun_path))
        return -1;

    sock_t s = socket(AF_UNIX, SOCK_STREAM, 0);
    if (s == SOCK_INVALID) return -1;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    memcpy(addr.sun_path, upath, pathlen + 1);

    if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        SOCK_CLOSE(s);
        return -1;
    }

    t->fd = (int)s;
    t->connected = 1;
    return 0;
#else
    /* Windows: try named pipe, otherwise fail */
    {
        char pipe_buf[512];
        if (parse_npipe(t->socket_path, pipe_buf, sizeof(pipe_buf)) == 0) {
            HANDLE h = INVALID_HANDLE_VALUE;
            const int max_attempts = 5;
            int attempt;
            for (attempt = 0; attempt < max_attempts; ++attempt) {
                h = CreateFileA(
                    pipe_buf,
                    GENERIC_READ | GENERIC_WRITE,
                    0, NULL, OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED, NULL);
                if (h != INVALID_HANDLE_VALUE) break;
                if (GetLastError() != ERROR_PIPE_BUSY) return -1;
                if (!WaitNamedPipeA(pipe_buf, 500)) {
                    if (GetLastError() != ERROR_SEM_TIMEOUT) return -1;
                }
            }
            if (h == INVALID_HANDLE_VALUE) return -1;
            DWORD mode = PIPE_READMODE_BYTE;
            if (!SetNamedPipeHandleState(h, &mode, NULL, NULL)) {
                CloseHandle(h);
                return -1;
            }
            {
                HANDLE evt = CreateEvent(NULL, TRUE, FALSE, NULL);
                if (!evt) { CloseHandle(h); return -1; }
                t->overlap_event = evt;
            }
            t->pipe_handle = h;
            t->connected = 1;
            return 0;
        }
    }
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

#ifdef _WIN32
    if (t->pipe_handle != INVALID_HANDLE_VALUE) {
        HANDLE h = (HANDLE)t->pipe_handle;
        OVERLAPPED ov = {0};
        ov.hEvent = (HANDLE)t->overlap_event;
        size_t sent = 0;
        while (sent < len) {
            DWORD written = 0;
            ResetEvent(ov.hEvent);
            if (!WriteFile(h, data + sent, (DWORD)(len - sent), &written, &ov)) {
                if (GetLastError() != ERROR_IO_PENDING) {
                    t->connected = 0;
                    return -1;
                }
                WaitForSingleObject(ov.hEvent, INFINITE);
                if (!GetOverlappedResult(h, &ov, &written, FALSE)) {
                    t->connected = 0;
                    return -1;
                }
            }
            if (written == 0) {
                t->connected = 0;
                return -1;
            }
            sent += written;
        }
        {
            char nl = '\n';
            DWORD nw = 0;
            ResetEvent(ov.hEvent);
            if (!WriteFile(h, &nl, 1, &nw, &ov)) {
                if (GetLastError() != ERROR_IO_PENDING) {
                    t->connected = 0;
                    return -1;
                }
                WaitForSingleObject(ov.hEvent, INFINITE);
                if (!GetOverlappedResult(h, &ov, &nw, FALSE)) {
                    t->connected = 0;
                    return -1;
                }
            }
            if (nw == 0) {
                t->connected = 0;
                return -1;
            }
        }
        return 0;
    }
#endif

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
    /* A complete line already buffered? */
    if (memchr(t->readbuf, '\n', t->readbuf_len) != NULL) return 1;
#ifdef _WIN32
    if (t->pipe_handle != INVALID_HANDLE_VALUE) {
        DWORD avail = 0;
        if (!PeekNamedPipe((HANDLE)t->pipe_handle, NULL, 0, NULL, &avail, NULL)) {
            t->connected = 0;
            return 0;
        }
        return avail > 0 ? 1 : 0;
    }
#endif
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

/* Extract one newline-terminated line from the read buffer.
 * Returns line length (>= 0) on success, -1 if no complete line.
 *
 * TODO: When a line exceeds the caller's bufsize, the output is silently
 * truncated while the full line is consumed from the internal buffer.
 * The return value (truncated length) is indistinguishable from a normal
 * short line, so callers cannot detect truncation.  Consider returning
 * the original linelen or a distinct error code. */
static int readbuf_extract_line(jgd_transport_t *t, char *buf, size_t bufsize) {
    if (bufsize == 0) return -1;

    char *nl = (char *)memchr(t->readbuf, '\n', t->readbuf_len);
    if (!nl) return -1;

    size_t linelen = (size_t)(nl - t->readbuf);
    size_t copylen = linelen < bufsize - 1 ? linelen : bufsize - 1;
    memcpy(buf, t->readbuf, copylen);
    buf[copylen] = '\0';

    /* Consume the line + newline from the buffer */
    size_t consumed = linelen + 1;
    t->readbuf_len -= consumed;
    if (t->readbuf_len > 0) {
        memmove(t->readbuf, t->readbuf + consumed, t->readbuf_len);
    }
    return (int)copylen;
}

int transport_recv_line(jgd_transport_t *t, char *buf, size_t bufsize, int timeout_ms) {
    if (!t->connected) return -1;

    /* Fast path: a complete line is already buffered */
    int n = readbuf_extract_line(t, buf, bufsize);
    if (n >= 0) return n;

#ifdef _WIN32
    if (t->pipe_handle != INVALID_HANDLE_VALUE) {
        HANDLE h = (HANDLE)t->pipe_handle;
        OVERLAPPED ov = {0};
        ov.hEvent = (HANDLE)t->overlap_event;
        if (timeout_ms < 0) return -1;
        DWORD remaining_ms = (DWORD)timeout_ms;

        for (;;) {
            size_t space = sizeof(t->readbuf) - t->readbuf_len;
            if (space == 0) {
                /* Buffer full without newline — protocol violation, disconnect */
                t->readbuf_len = 0;
                t->connected = 0;
                return -1;
            }

            DWORD nread = 0;
            ResetEvent(ov.hEvent);
            if (!ReadFile(h, t->readbuf + t->readbuf_len, (DWORD)space, &nread, &ov)) {
                if (GetLastError() != ERROR_IO_PENDING) {
                    t->connected = 0;
                    return -1;
                }
                /* Wait for data with remaining timeout */
                DWORD t0 = GetTickCount();
                DWORD wr = WaitForSingleObject(ov.hEvent, remaining_ms);
                if (wr == WAIT_TIMEOUT) {
                    CancelIo(h);
                    /* Retrieve any partial bytes already read */
                    if (GetOverlappedResult(h, &ov, &nread, TRUE) && nread > 0) {
                        t->readbuf_len += nread;
                    }
                    return -1;
                }
                if (wr != WAIT_OBJECT_0) {
                    CancelIo(h);
                    t->connected = 0;
                    return -1;
                }
                if (!GetOverlappedResult(h, &ov, &nread, FALSE)) {
                    t->connected = 0;
                    return -1;
                }
                /* Update remaining timeout */
                DWORD elapsed = GetTickCount() - t0;
                if (elapsed >= remaining_ms)
                    remaining_ms = 0;
                else
                    remaining_ms -= elapsed;
            }

            if (nread == 0) {
                t->connected = 0;
                return -1;
            }
            t->readbuf_len += nread;

            n = readbuf_extract_line(t, buf, bufsize);
            if (n >= 0) return n;

            /* No complete line yet; if no timeout left, return */
            if (remaining_ms == 0) return -1;
        }
    }
#endif

    sock_t s = (sock_t)t->fd;

    /* Wait for initial data with the caller's timeout */
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

    /* Bulk-read until we have a complete line */
    for (;;) {
        size_t space = sizeof(t->readbuf) - t->readbuf_len;
        if (space == 0) {
            /* Buffer full without newline — protocol violation, disconnect */
            t->readbuf_len = 0;
            t->connected = 0;
            return -1;
        }

        int r = (int)recv(s, t->readbuf + t->readbuf_len, (int)space, 0);
        if (r <= 0) {
            t->connected = 0;
            return -1;
        }
        t->readbuf_len += (size_t)r;

        n = readbuf_extract_line(t, buf, bufsize);
        if (n >= 0) return n;
    }
}

void transport_close(jgd_transport_t *t) {
#ifdef _WIN32
    if (t->overlap_event) {
        CloseHandle((HANDLE)t->overlap_event);
        t->overlap_event = NULL;
    }
    if (t->pipe_handle != INVALID_HANDLE_VALUE) {
        CloseHandle((HANDLE)t->pipe_handle);
        t->pipe_handle = INVALID_HANDLE_VALUE;
    }
#endif
    if (t->fd != (int)SOCK_INVALID) {
        SOCK_CLOSE((sock_t)t->fd);
        t->fd = (int)SOCK_INVALID;
    }
    t->connected = 0;
    t->readbuf_len = 0;
}

