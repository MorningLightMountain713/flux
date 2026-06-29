/*
 * Configurable test container for the reconciler integration suites.
 *
 * Compiled to a small static linux/amd64 binary and pushed into the per-test
 * registry as a single-layer image (see registry-helper.pushTestApp). Behaviour
 * is driven entirely by env vars, supplied through an app spec's
 * environmentParameters, so one image serves every exit scenario:
 *
 *   EXIT_CODE     exit status to use on a signal / timed exit (default 0)
 *   EXIT_AFTER_S  if > 0, self-exit with EXIT_CODE after this many seconds
 *                 (models a container that exits on its own, e.g. exit 0 to
 *                 free memory); if unset, stay up until signalled
 *
 * On SIGTERM/SIGINT (i.e. `docker stop`) it exits with EXIT_CODE, so a test can
 * deterministically produce a clean exit 0 or any non-zero code on demand.
 *
 * On SIGHUP/SIGUSR1/SIGUSR2 it logs the signal name to stdout and KEEPS RUNNING,
 * so a content-slot onUpdate:signal reaction is observable via `docker logs`
 * (and the container's StartedAt is unchanged — no restart).
 *
 * Static + freestanding: it runs in an otherwise-empty rootfs (no libc loader,
 * no shell), exactly like the /bin/pause fixture.
 */
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>

static int exit_code = 0;

static void on_signal(int sig)
{
    (void)sig;
    _exit(exit_code);
}

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
}

int main(void)
{
    const char *ec = getenv("EXIT_CODE");
    if (ec)
        exit_code = atoi(ec);

    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGHUP, on_reload);
    signal(SIGUSR1, on_reload);
    signal(SIGUSR2, on_reload);

    const char *after = getenv("EXIT_AFTER_S");
    if (after) {
        int seconds = atoi(after);
        if (seconds > 0) {
            sleep((unsigned)seconds);
            return exit_code;
        }
    }

    for (;;)
        pause();

    return 0;
}
