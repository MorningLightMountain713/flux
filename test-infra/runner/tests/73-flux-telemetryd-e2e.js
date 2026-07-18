import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitFor } from '../framework/wait.js';
import { pushTestApp, pushOtlpReceiver } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execInContainer } from '../framework/container.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';

// The REAL flux-telemetryd, end to end. Suite 69 pins the FluxOS half of
// the identity contract against a mock daemon; this suite closes the class
// of bug 69 structurally cannot see — disagreement between the two REAL
// ends — by running the actual Rust daemon (cindy's vendored cargo build,
// ~/flux-e2e/flux-telemetryd) as its real hardened systemd unit inside a
// systemd-mode node:
//
//   - the node carries the Arcane host shape (xfs/prjquota docker root at
//     /dat/var/lib/docker, host-swap fence, flux-apps.slice, app-swap dir),
//     so FluxOS's managed-storage capability passes and app containers land
//     in /sys/fs/cgroup/flux.slice/flux-apps.slice — the daemon's sampler
//     path — while its logtail reads the real json-logs under the Arcane
//     data-root;
//   - FluxOS itself starts the daemon unit when the telemetry app installs
//     (telemetryConfigService.ensureNode), writes config.toml, and serves
//     the identity socket the daemon connects to — the production flow;
//   - the app's collector component is the otlp-receiver fixture
//     (test-infra/otlp-receiver), which logs one OTLP-RECV line per
//     OTLP/HTTP post with substring-match verdicts, so metrics and shipped
//     log lines are asserted at the far end of the real pipe.
//
// Deliberate scope cuts (documented follow-ups, not gaps): endpoint
// rotation and ghost-prune-across-socket-outage stay with the daemon's
// unit tests and suite 69's sync pins; post-uninstall traffic silence is
// unobservable here because uninstalling the app removes the receiver too.
const NODES = 5;
const APP = 'otlprealapp';
const RECV_REPO = `${APP}recv`;
const WEB_PORT = 31360;
// test-app logs this exact line on SIGUSR1 and keeps running — the shipped
// log payload the receiver looks for (MARK1).
const LOG_MARKER = 'RELOAD SIGUSR1';

const webContainer = `fluxweb_${APP}`;
const collectorContainer = `fluxcollector_${APP}`;

const components = {
  web: {
    name: 'web',
    description: 'workload component (test-app; SIGUSR1 provokes a log line)',
    image: `${REGISTRY_REPO_HOST}/${APP}:v1`,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: {} },
    ports: { http: { containerPort: 80, hostPort: WEB_PORT } },
  },
  // Portless on purpose, like suite 69's agent: reachable only node-locally
  // on the app network — the deployment model the telemetry block points at.
  collector: {
    name: 'collector',
    description: 'customer OTLP collector (receiver fixture)',
    image: `${REGISTRY_REPO_HOST}/${RECV_REPO}:v1`,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: {} },
    env: { RECEIVER_PORT: '4318', MARK1: LOG_MARKER, MARK2: APP },
  },
};

describe('flux-telemetryd e2e: the real daemon against real FluxOS on an Arcane-shaped node', function () {
  let env;
  let client;

  const X = (cmd) => execInContainer(client.container, cmd);
  const countIn = async (cmd) => Number((await X(`${cmd} | grep -c . || true`)).stdout.trim() || '0');
  const daemonJournal = (pattern) => X(`journalctl -u flux-telemetryd -o cat --no-pager | grep -F '${pattern}' | tail -5`);
  const receiverLogGrep = (pattern) => X(`docker logs ${collectorContainer} 2>&1 | grep -E '${pattern}' | tail -5`);

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      systemdMode: true,
      telemetrydReal: true,
      shutdowndMock: false,
      // Registration-door shape for a 5-node mesh (suite 52/69 sizing note).
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });

    await pushTestApp(APP);
    await pushOtlpReceiver(RECV_REPO);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: APP,
      components,
      instances: 3,
      specOverrides: { telemetry: { provider: 'otlp', component: 'collector' } },
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');

    await queueAppTx(res.data);
    await advanceBlocks(3);
    const installedIndex = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, APP, 300000);
      return i;
    }));
    client = env.clients[installedIndex];
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('passes the managed-storage capability and places app containers in flux-apps.slice', async function () {
    this.timeout(60000);
    const cap = await X('journalctl -u fluxos -o cat --no-pager | grep -c "managed storage supported" || true');
    expect(Number(cap.stdout.trim()), 'capability probe verdict in the fluxos journal').to.be.greaterThan(0);

    const parent = await X(`docker inspect -f '{{.HostConfig.CgroupParent}}' ${webContainer}`);
    expect(parent.stdout.trim()).to.equal('flux-apps.slice');

    const id = (await X(`docker inspect -f '{{.Id}}' ${webContainer}`)).stdout.trim();
    const scope = await X(`test -d /sys/fs/cgroup/flux.slice/flux-apps.slice/docker-${id}.scope`);
    expect(scope.exitCode, 'container scope under the daemon-sampled path').to.equal(0);
  });

  it('FluxOS starts the real daemon, which pairs on the identity socket and tracks the send set', async function () {
    this.timeout(120000);
    // ensureNode runs on the telemetry-app install: config written, unit
    // started — by FluxOS, never by this suite.
    await waitFor(async () => (await X('systemctl is-active flux-telemetryd')).stdout.trim() === 'active',
      { timeout: 60000, interval: 2000, label: 'flux-telemetryd unit active (started by FluxOS)' });

    const cfg = await X('ls -la /run/flux/telemetry/config.toml && cat /run/flux/telemetry/config.toml');
    expect(cfg.exitCode, cfg.output).to.equal(0);
    expect(cfg.stdout).to.include('opaqueId');

    // The running daemon is the PINNED one: build.rs stamps the source
    // commit into --version, and dist/ is built from the pin — the guard
    // against a stale dist silently testing the wrong daemon.
    const pin = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'flux-telemetryd', 'pin'),
      'utf-8',
    ).trim();
    const version = await X('/usr/local/bin/flux-telemetryd --version');
    expect(version.stdout, 'daemon binary commit matches the pin').to.include(pin.slice(0, 12));

    await waitFor(async () => {
      const sync = await daemonJournal('received container sync');
      const track = await daemonJournal('tracking container');
      return sync.stdout.trim() !== '' && track.stdout.includes(APP);
    }, { timeout: 60000, interval: 2000, label: 'daemon synced and tracking the app' });

    // The send-set gate holds with real ends too: web is tracked, the
    // same-app collector is not.
    const tracked = (await X('journalctl -u flux-telemetryd -o cat --no-pager | grep -F "tracking container"')).stdout;
    const webId = (await X(`docker inspect -f '{{.Id}}' ${webContainer}`)).stdout.trim();
    const collectorId = (await X(`docker inspect -f '{{.Id}}' ${collectorContainer}`)).stdout.trim();
    expect(tracked, 'web must be tracked').to.include(webId);
    expect(tracked, 'the same-app collector must stay out of the send set').to.not.include(collectorId);
  });

  it('ships metrics over real OTLP/HTTP into the app collector', async function () {
    this.timeout(120000);
    // 15s sample cadence; the receiver logs one OTLP-RECV line per post.
    await waitFor(async () => {
      const r = await receiverLogGrep('OTLP-RECV path=/v1/metrics');
      return r.stdout.trim() !== '';
    }, { timeout: 90000, interval: 3000, label: 'metrics posts arriving at the collector' });

    // mark2 = the app name riding the resource attributes.
    const attributed = await receiverLogGrep('OTLP-RECV path=/v1/metrics .*mark2=1');
    expect(attributed.stdout.trim(), 'metrics payload carries the app attribution').to.not.equal('');
  });

  it('tails the container json-log and ships provoked log lines', async function () {
    this.timeout(120000);
    // SIGUSR1 makes test-app write LOG_MARKER to stdout and keep running —
    // the daemon tails the json-log under /dat/var/lib/docker and ships it.
    const kill = await X(`docker kill --signal=SIGUSR1 ${webContainer}`);
    expect(kill.exitCode, kill.output).to.equal(0);

    await waitFor(async () => {
      const r = await receiverLogGrep('OTLP-RECV path=/v1/logs .*mark1=1');
      return r.stdout.trim() !== '';
    }, { timeout: 90000, interval: 3000, label: 'the provoked log line arriving at the collector' });
  });

  it('untracks on removal, then FluxOS stops the daemon with the last telemetry app', async function () {
    this.timeout(180000);
    const untracksBefore = await countIn('journalctl -u flux-telemetryd -o cat --no-pager | grep -F "untracking container"');

    const { zelidauth } = await authenticate(client.url, appOwnerKey());
    await client.removeApp(APP, { zelidauth });

    await waitFor(async () => {
      const untracks = await countIn('journalctl -u flux-telemetryd -o cat --no-pager | grep -F "untracking container"');
      return untracks > untracksBefore;
    }, { timeout: 120000, interval: 3000, label: 'daemon untracked the removed containers' });

    // Lifecycle ownership closes the loop: appUninstaller stops the unit and
    // removes config.toml once no telemetry apps remain — a clean stop, not
    // a crash ('inactive', never 'failed').
    await waitFor(async () => (await X('systemctl is-active flux-telemetryd')).stdout.trim() === 'inactive',
      { timeout: 60000, interval: 2000, label: 'FluxOS stopped the daemon after the last telemetry app' });
    const failed = await X('systemctl is-failed flux-telemetryd');
    expect(failed.stdout.trim(), 'unit must not be in a failed state').to.not.equal('failed');
    const cfg = await X('test -f /run/flux/telemetry/config.toml');
    expect(cfg.exitCode, 'config.toml removed with the daemon').to.not.equal(0);
  });
});
