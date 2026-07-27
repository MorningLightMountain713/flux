/*
 * tls-echo — a minimal HTTPS server for exercising the platform-managed
 * backend-TLS hop end to end.
 *
 * test-app cannot do this: it is freestanding C with no TLS, so it can prove a
 * signal arrived but not that the certificate it was handed actually serves.
 * This fixture closes that gap and nothing more — it is the app on the far side
 * of the verified hop, not a general web server.
 *
 * Certificate and key come from FLUX_TLS_CERT_PATH / FLUX_TLS_KEY_PATH, the env
 * vars the platform sets for a verify:'required' component, so the fixture reads
 * them exactly the way a real app is told to. Falling back to fixed paths would
 * hide a broken promise: if those vars were wrong, the app is supposed to fail.
 *
 * On SIGHUP/SIGUSR1/SIGUSR2 it RE-READS the certificate from disk and keeps
 * running, logging the signal in the same "RELOAD <SIG>" form test-app uses, so
 * the existing log assertions transfer. That is the whole point of file delivery
 * over env-var delivery: a rotated certificate is picked up in place, without
 * recreating the container. A suite proves rotation by comparing the certificate
 * served before and after the signal.
 *
 * Every response is the serving certificate's own SHA-256 fingerprint:
 *
 *     HTTP/1.1 200 OK
 *     X-Tls-Echo: <hex fingerprint of the cert this connection was served>
 *
 * so a client can tell which certificate answered without parsing the handshake
 * — which is what makes "rotated seamlessly under load" checkable.
 *
 *   PORT  listen port (default 443)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/sha.h>

static volatile sig_atomic_t reload_requested = 0;

/* async-signal-safe write of a fixed string (no libc string calls) */
static void wlog(const char *s)
{
    const char *p = s;
    while (*p) p++;
    (void)write(1, s, (size_t)(p - s));
}

static void on_reload(int sig)
{
    switch (sig) {
        case SIGHUP:  wlog("RELOAD SIGHUP\n");  break;
        case SIGUSR1: wlog("RELOAD SIGUSR1\n"); break;
        case SIGUSR2: wlog("RELOAD SIGUSR2\n"); break;
        default:      wlog("RELOAD\n");         break;
    }
    reload_requested = 1;
}

static char fingerprint[SHA256_DIGEST_LENGTH * 2 + 1];

/* Fingerprint of the leaf currently loaded, so a response identifies its cert. */
static void set_fingerprint(SSL_CTX *ctx)
{
    X509 *cert = SSL_CTX_get0_certificate(ctx);
    unsigned char md[SHA256_DIGEST_LENGTH];
    unsigned int len = 0;
    fingerprint[0] = '\0';
    if (!cert || !X509_digest(cert, EVP_sha256(), md, &len)) return;
    for (unsigned int i = 0; i < len; i++)
        sprintf(fingerprint + i * 2, "%02x", md[i]);
    fingerprint[len * 2] = '\0';
}

/* Build a fresh context from the delivered files. Returns NULL on failure so a
 * reload that lands mid-write keeps serving the certificate already loaded. */
static SSL_CTX *load_ctx(const char *cert_path, const char *key_path)
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) return NULL;
    if (SSL_CTX_use_certificate_file(ctx, cert_path, SSL_FILETYPE_PEM) != 1
        || SSL_CTX_use_PrivateKey_file(ctx, key_path, SSL_FILETYPE_PEM) != 1
        || SSL_CTX_check_private_key(ctx) != 1) {
        SSL_CTX_free(ctx);
        return NULL;
    }
    return ctx;
}

int main(void)
{
    const char *cert_path = getenv("FLUX_TLS_CERT_PATH");
    const char *key_path = getenv("FLUX_TLS_KEY_PATH");
    if (!cert_path || !key_path) {
        fprintf(stderr, "tls-echo: FLUX_TLS_CERT_PATH/FLUX_TLS_KEY_PATH not set\n");
        return 2;
    }

    const char *port_env = getenv("PORT");
    int port = port_env ? atoi(port_env) : 443;

    signal(SIGHUP, on_reload);
    signal(SIGUSR1, on_reload);
    signal(SIGUSR2, on_reload);
    signal(SIGPIPE, SIG_IGN);
    /* signal() installs handlers with SA_RESTART, which would silently restart
     * the blocking accept() below and defer the reload until the next connection
     * happened to arrive. Make these interrupt instead, so a rotation with no
     * traffic in flight is picked up immediately. */
    siginterrupt(SIGHUP, 1);
    siginterrupt(SIGUSR1, 1);
    siginterrupt(SIGUSR2, 1);

    SSL_library_init();
    SSL_load_error_strings();

    SSL_CTX *ctx = load_ctx(cert_path, key_path);
    if (!ctx) {
        fprintf(stderr, "tls-echo: could not load %s / %s\n", cert_path, key_path);
        ERR_print_errors_fp(stderr);
        return 3;
    }
    set_fingerprint(ctx);
    printf("tls-echo listening on %d cert=%s\n", port, fingerprint);
    fflush(stdout);

    int sock = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((uint16_t)port);
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) != 0
        || listen(sock, 16) != 0) {
        perror("tls-echo: bind/listen");
        return 4;
    }

    for (;;) {
        /* Applied at the top of the loop, so a reload lands whether the signal
         * interrupted a blocking accept() or arrived while a request was served. */
        if (reload_requested) {
            reload_requested = 0;
            SSL_CTX *fresh = load_ctx(cert_path, key_path);
            if (fresh) {
                SSL_CTX_free(ctx);
                ctx = fresh;
                set_fingerprint(ctx);
                printf("tls-echo reloaded cert=%s\n", fingerprint);
            } else {
                /* A reload that lands mid-write keeps serving what is already
                 * loaded rather than dropping the app off the network. */
                printf("tls-echo reload failed, keeping current cert\n");
            }
            fflush(stdout);
        }

        int client = accept(sock, NULL, NULL);
        if (client < 0) continue;

        SSL *ssl = SSL_new(ctx);
        SSL_set_fd(ssl, client);
        if (SSL_accept(ssl) == 1) {
            char buf[1024];
            SSL_read(ssl, buf, sizeof(buf));
            char resp[256];
            int n = snprintf(resp, sizeof(resp),
                             "HTTP/1.1 200 OK\r\n"
                             "Content-Length: 0\r\n"
                             "X-Tls-Echo: %s\r\n"
                             "Connection: close\r\n\r\n",
                             fingerprint);
            SSL_write(ssl, resp, n);
            SSL_shutdown(ssl);
        }
        SSL_free(ssl);
        close(client);
    }
}
