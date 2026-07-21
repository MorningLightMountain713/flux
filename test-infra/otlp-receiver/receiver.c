/*
 * Minimal OTLP/HTTP receiver for the flux-telemetryd e2e suite.
 *
 * Plays the customer collector component: accepts HTTP/1.1 POSTs
 * (keep-alive), drains Content-Length bodies, answers 200 {}. Logs ONE
 * stdout line per request:
 *
 *   OTLP-RECV path=/v1/logs bytes=1234 mark1=1 mark2=0
 *
 * where markN reports whether the raw body contains the env-supplied
 * substring MARK1/MARK2. OTLP protobuf carries strings as plain UTF-8, so
 * shipped log lines and resource attributes are findable by substring
 * without a protobuf parser — the suite greps this container's docker logs
 * for the verdict.
 *
 * A batch whose body contains REJECT_SUBSTR (optional) is answered 400 and
 * logged as OTLP-REJECT instead of OTLP-RECV — the "receiver is up but rejects
 * this payload" case, which the daemon must drop rather than retry. Inert when
 * REJECT_SUBSTR is unset or absent from the body.
 *
 * Env: RECEIVER_PORT (default 4318), MARK1, MARK2, REJECT_SUBSTR (optional
 * substrings).
 *
 * Compiled to a small static linux/amd64 binary (see build.sh) and pushed
 * as a single-layer image by registry-helper.pushOtlpReceiver.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <signal.h>
#include <netinet/in.h>
#include <sys/socket.h>

#define MAX_BODY (32 * 1024 * 1024)

static const char *mark1;
static const char *mark2;
static const char *reject_substr;

static int contains(const char *body, size_t len, const char *needle)
{
    if (!needle || !*needle || !body) return 0;
    return memmem(body, len, needle, strlen(needle)) != NULL;
}

/* Serve one connection: a loop of requests (HTTP/1.1 keep-alive). */
static void serve(int fd)
{
    FILE *in = fdopen(fd, "r");
    if (!in) { close(fd); return; }
    char line[8192];

    for (;;) {
        if (!fgets(line, sizeof(line), in)) break;
        char path[1024] = "?";
        sscanf(line, "%*s %1023s", path);

        long content_length = 0;
        for (;;) {
            if (!fgets(line, sizeof(line), in)) goto done;
            if (line[0] == '\r' || line[0] == '\n') break;
            if (strncasecmp(line, "Content-Length:", 15) == 0) {
                content_length = strtol(line + 15, NULL, 10);
            }
        }

        char *body = NULL;
        long got = 0;
        if (content_length > 0 && content_length <= MAX_BODY) {
            body = malloc(content_length);
            while (body && got < content_length) {
                size_t n = fread(body + got, 1, content_length - got, in);
                if (n == 0) goto done;
                got += (long)n;
            }
        } else if (content_length > MAX_BODY) {
            goto done; /* oversized: drop the connection */
        }

        /* Reject mode: a batch carrying REJECT_SUBSTR is refused with 400 —
         * the receiver is up but rejecting this payload, the case the daemon
         * must drop rather than retry. Logged distinctly (OTLP-REJECT) so the
         * suite sees it was received and refused. Inert unless REJECT_SUBSTR is
         * set and present in the body. */
        if (contains(body, (size_t)got, reject_substr)) {
            char rej[1200];
            int rn = snprintf(rej, sizeof(rej), "OTLP-REJECT path=%s bytes=%ld\n", path, got);
            if (rn > 0) { ssize_t w = write(1, rej, (size_t)rn); (void)w; }
            free(body);
            const char *bad = "HTTP/1.1 400 Bad Request\r\n"
                              "Content-Type: application/json\r\n"
                              "Content-Length: 2\r\n"
                              "\r\n"
                              "{}";
            if (write(fd, bad, strlen(bad)) < 0) break;
            continue;
        }

        /* One atomic stdout line per request — the suite's evidence. */
        char out[1200];
        int n = snprintf(out, sizeof(out), "OTLP-RECV path=%s bytes=%ld mark1=%d mark2=%d\n",
                         path, got,
                         contains(body, (size_t)got, mark1),
                         contains(body, (size_t)got, mark2));
        if (n > 0) { ssize_t w = write(1, out, (size_t)n); (void)w; }
        free(body);

        const char *resp = "HTTP/1.1 200 OK\r\n"
                           "Content-Type: application/json\r\n"
                           "Content-Length: 2\r\n"
                           "\r\n"
                           "{}";
        if (write(fd, resp, strlen(resp)) < 0) break;
    }
done:
    fclose(in); /* closes fd */
}

int main(void)
{
    signal(SIGCHLD, SIG_IGN); /* auto-reap the per-connection children */
    signal(SIGPIPE, SIG_IGN);
    mark1 = getenv("MARK1");
    mark2 = getenv("MARK2");
    reject_substr = getenv("REJECT_SUBSTR");
    const char *portEnv = getenv("RECEIVER_PORT");
    int port = portEnv ? atoi(portEnv) : 4318;

    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return 1;
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in addr = { 0 };
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((unsigned short)port);
    if (bind(s, (struct sockaddr *)&addr, sizeof(addr)) < 0) return 2;
    if (listen(s, 64) < 0) return 3;

    {
        char out[64];
        int n = snprintf(out, sizeof(out), "OTLP-RECEIVER listening on %d\n", port);
        if (n > 0) { ssize_t w = write(1, out, (size_t)n); (void)w; }
    }

    for (;;) {
        int c = accept(s, NULL, NULL);
        if (c < 0) continue;
        pid_t pid = fork();
        if (pid == 0) {
            close(s);
            serve(c);
            _exit(0);
        }
        close(c);
    }
}
