#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

/* Read-only socket audit. No payload, credential or socket option is changed. */
static void record(int fd, const char *phase, const struct sockaddr *remote) {
    int saved = errno;
    const char *path = getenv("LUMIO_WEAKNET_NAGLE_PATH");
    struct sockaddr_in local = {0}, peer = {0};
    socklen_t size = sizeof(local);
    int value = -1;
    socklen_t length = sizeof(value);
    if (!path || getsockname(fd, (struct sockaddr *)&local, &size) || local.sin_family != AF_INET
        || getsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &value, &length)) { errno = saved; return; }
    size = sizeof(peer);
    if (getpeername(fd, (struct sockaddr *)&peer, &size) && remote && remote->sa_family == AF_INET)
        peer = *(const struct sockaddr_in *)remote;
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    char line[256];
    int count = snprintf(line, sizeof(line), "%lld,%d,%d,%s,%u,%u,%d\n",
        (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000, getpid(), fd, phase,
        ntohs(local.sin_port), ntohs(peer.sin_port), value);
    int file = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (file >= 0) {
        if (count > 0 && write(file, line, (size_t)count) != count)
            fputs("weaknet socket audit write failed\n", stderr);
        close(file);
    }
    errno = saved;
}

int connect(int fd, const struct sockaddr *address, socklen_t size) {
    static int (*real_connect)(int, const struct sockaddr *, socklen_t);
    if (!real_connect) real_connect = dlsym(RTLD_NEXT, "connect");
    int result = real_connect(fd, address, size);
    record(fd, "connect", address);
    return result;
}

int accept4(int fd, struct sockaddr *address, socklen_t *size, int flags) {
    static int (*real_accept4)(int, struct sockaddr *, socklen_t *, int);
    if (!real_accept4) real_accept4 = dlsym(RTLD_NEXT, "accept4");
    int accepted = real_accept4(fd, address, size, flags);
    if (accepted >= 0) record(accepted, "accept", NULL);
    return accepted;
}

int setsockopt(int fd, int level, int option, const void *value, socklen_t size) {
    static int (*real_setsockopt)(int, int, int, const void *, socklen_t);
    if (!real_setsockopt) real_setsockopt = dlsym(RTLD_NEXT, "setsockopt");
    int result = real_setsockopt(fd, level, option, value, size);
    if (!result && level == IPPROTO_TCP && option == TCP_NODELAY) record(fd, "setsockopt", NULL);
    return result;
}
