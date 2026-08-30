// weight: heavy
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlock, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitFor } from '../framework/wait.js';
import { pushTestApp, pushOtlpReceiver } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execInContainer, requireAppContainerName } from '../framework/container.js';
import {
  stopFluxos, startFluxos, unitState, journalGrep, journalCount,
} from '../framework/systemd-control.js';
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
// Deliberate scope cut (documented follow-up, not a gap): post-uninstall
// traffic silence is unobservable here because uninstalling the app removes
// the receiver with it.
const NODES = 5;
const APP = 'otlprealapp';
const RECV_REPO = `${APP}recv`;
const WEB_PORT = 31360;
// The second telemetry app: the daemon's lifecycle is owned per-NODE, not
// per-app, so its stop must wait for the LAST telemetry app to leave.
const APP2 = 'otlpreallast';
const RECV2_REPO = `${APP2}recv`;
const WEB2_PORT = 31362;
const DAEMON_UNIT = 'flux-telemetryd';
// apply_snapshot's reconcile line (collector.rs). Distinct from a plain
// "untracking container", which it ALSO emits right after — grepping the
// short form counts both, so the ghost path must match the full string.
const PRUNE_LINE = 'untracking container absent from sync';
// Rotation stimulus: a spec update moves BOTH the telemetry endpoint port and
// the receiver's listen port, so the far end really is somewhere new.
const UPDATED_PORT = 4319;
// test-app logs this exact line on SIGUSR1 and keeps running — the shipped
// log payload the receiver looks for (MARK1).
const LOG_MARKER = 'RELOAD SIGUSR1';
// The drop-on-reject scenario poisons this line (test-app logs it on SIGUSR2):
// the receiver 400s any batch carrying it. No other scenario provokes SIGUSR2,
// so REJECT_SUBSTR is inert everywhere else.
const POISON_MARKER = 'RELOAD SIGUSR2';

// Container names carry the app's minted identity; resolved from the labels once the
// containers exist, never spelled from the app name.
let webContainer;
let collectorContainer;

const buildComponents = ({
  appRepo, recvRepo, webPort, receiverPort = 4318,
}) => ({
  web: {
    name: 'web',
    description: 'workload component (test-app; SIGUSR1 provokes a log line)',
    image: `${REGISTRY_REPO_HOST}/${appRepo}:v1`,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: {} },
    ports: { http: { containerPort: 80, hostPort: webPort } },
  },
  // Portless on purpose, like suite 69's agent: reachable only node-locally
  // on the app network — the deployment model the telemetry block points at.
  collector: {
    name: 'collector',
    description: 'customer OTLP collector (receiver fixture)',
    image: `${REGISTRY_REPO_HOST}/${recvRepo}:v1`,
    cpu: 0.2,
    memory: 200,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: {} },
    env: {
      RECEIVER_PORT: String(receiverPort),
      MARK1: LOG_MARKER,
      MARK2: appRepo,
      REJECT_SUBSTR: POISON_MARKER,
    },
  },
});

const components = buildComponents({ appRepo: APP, recvRepo: RECV_REPO, webPort: WEB_PORT });

describe('flux-telemetryd e2e: the real daemon against real FluxOS on an Arcane-shaped node', function () {
  let env;
  let client;

  const X = (cmd) => execInContainer(client.container, cmd);
  const daemonJournal = (pattern, opts) => journalGrep(client.container, DAEMON_UNIT, pattern, opts);
  const daemonJournalCount = (pattern) => journalCount(client.container, DAEMON_UNIT, pattern);
  const receiverLogGrep = (pattern, name = collectorContainer) => X(`docker logs ${name} 2>&1 | grep -E '${pattern}' | tail -5`);
  const containerId = async (name) => (await X(`docker inspect -f '{{.Id}}' ${name}`)).stdout.trim();
  const containerIp = async (name) => (
    await X(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${name}`)
  ).stdout.trim();
  // Counting posts, not just matching one: the outage scenario asserts on a
  // delta, since posts from earlier scenarios are still in the log.
  const receiverPostCount = async (pattern, name = collectorContainer) => Number(
    (await X(`docker logs ${name} 2>&1 | grep -cE 'OTLP-RECV .*${pattern}' || true`)).stdout.trim() || 0,
  );

  // startFluxos returns when the API answers, but the submission door also needs
  // the node re-peered. The door counts distinct peers HELD, either direction —
  // duty pairs are reciprocal and the outbound label is a dial-race outcome.
  // After a mid-suite FluxOS restart the node re-dials from zero, so a
  // register/update driven immediately is rejected ('does not hold enough peer
  // connections') until the peers are back. The counts come over REST, so they
  // survive the restart.
  const waitForSubmissionDoor = (node) => waitFor(async () => {
    const [outbound, inbound] = await Promise.all([node.getPeers(), node.getIncomingPeers()]);
    return (outbound.data?.length ?? 0) + (inbound.data?.length ?? 0) >= 3;
  }, { timeout: 120000, interval: 2000, label: 'submitting node re-peered past the submission door' });

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      systemdMode: true,
      telemetrydReal: true,
      shutdowndMock: false,
      // Submission-door sizing for a 5-node mesh. minOutgoing is what the mesh
      // actually yields (~2); minIncoming drops to 1 because a later scenario
      // restarts FluxOS on a node, and a freshly re-peered node can sit at a
      // single inbound for a moment. Both counts recover after the restart, so the
      // scenarios that submit afterwards wait for the door (waitForSubmissionDoor)
      // rather than racing it — this just sets the floor that wait targets.
      // The stagger overrides are required because this suite drives a spec
      // update: adoption otherwise paces at production 60s/300s.
      configOverrides: {
        fluxapps: {
          minOutgoing: 2,
          minIncoming: 1,
          adoptionStaggerStepMs: 15000,
          adoptionStaggerWindowMs: 15000,
        },
      },
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
    // Now that the containers exist, ask them what they are called: the names carry the
    // app's minted identity and cannot be derived from APP.
    webContainer = await requireAppContainerName(client.container, APP, 'web');
    collectorContainer = await requireAppContainerName(client.container, APP, 'collector');
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
      return sync.trim() !== '' && track.includes(APP);
    }, { timeout: 60000, interval: 2000, label: 'daemon synced and tracking the app' });

    // The send-set gate holds with real ends too: web is tracked, the
    // same-app collector is not.
    const tracked = await daemonJournal('tracking container', { lines: 200 });
    const webId = await containerId(webContainer);
    const collectorId = await containerId(collectorContainer);
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

  it('holds a batch across a collector outage instead of dropping it', async function () {
    this.timeout(300000);
    // A collector being redeployed is unreachable for tens of seconds. The
    // daemon must hold the batch and deliver it when the receiver returns.
    // Before the shipping queue this line was discarded on the first refusal
    // and never arrived — measured on a dev node as 8 of 21 lines lost.
    //
    // The outage is made with iptables, NOT by stopping the container:
    // FluxOS's reconciler restarts a stopped app container within about a
    // second, so nothing is ever actually unreachable and the scenario would
    // pass vacuously. Rejecting the traffic leaves the container healthy and
    // the reconciler uninvolved. REJECT rather than DROP so each attempt
    // fails fast like a refused connection instead of waiting out the
    // daemon's HTTP timeout — with DROP this measures the timeout, not the
    // outage.
    const before = await receiverPostCount('mark1=1');
    const ip = await containerIp(collectorContainer);
    expect(ip, 'the collector must have an address to block').to.match(/^\d+\.\d+\.\d+\.\d+$/);
    const rule = `-d ${ip} -p tcp --dport 4318 -j REJECT --reject-with tcp-reset`;

    await X(`iptables -I OUTPUT 1 ${rule}`);
    try {
      // Provoke while the far end is refusing. The batch is now in the
      // daemon's queue with nowhere to go.
      const kill = await X(`docker kill --signal=SIGUSR1 ${webContainer}`);
      expect(kill.exitCode, kill.output).to.equal(0);

      // Comfortably past the point the old posture had already discarded it,
      // and well inside the retry window so the batch is still held.
      await new Promise((resolve) => { setTimeout(resolve, 20000); });
      expect(await receiverPostCount('mark1=1'),
        'nothing can land while the collector is unreachable').to.equal(before);
    } finally {
      // Always restore, or every scenario after this one fails for the
      // wrong reason.
      await X(`iptables -D OUTPUT ${rule}`);
    }

    // The held batch is what proves the fix: it was produced during the
    // outage and still arrives.
    await waitFor(async () => (await receiverPostCount('mark1=1')) > before, {
      timeout: 120000,
      interval: 3000,
      label: 'the held batch arriving once the collector is reachable again',
    });
  });

  it('drops a batch the receiver rejects and keeps shipping the ones behind it', async function () {
    this.timeout(180000);
    // The receiver 400s any batch carrying the SIGUSR2 line (REJECT_SUBSTR): it
    // is up and answering, it just refuses this payload — the case the daemon
    // must DROP rather than retry. A dropped batch must not stall the ones
    // behind it. So provoke the poison line, watch the receiver reject it, then
    // provoke a good line and require it to arrive promptly. Without the
    // drop-on-reject fix the good line waits out the poison batch's retry
    // window (~120s) and this scenario's tight bound times out.
    const rejectCount = async () => Number(
      (await X(`docker logs ${collectorContainer} 2>&1 | grep -cE 'OTLP-REJECT' || true`)).stdout.trim() || 0,
    );
    const rejectsBefore = await rejectCount();

    // Poison: SIGUSR2 → "RELOAD SIGUSR2", which the receiver refuses with 400.
    const poison = await X(`docker kill --signal=SIGUSR2 ${webContainer}`);
    expect(poison.exitCode, poison.output).to.equal(0);
    await waitFor(async () => (await rejectCount()) > rejectsBefore, {
      timeout: 60000,
      interval: 2000,
      label: 'the receiver received and rejected the poison batch',
    });

    // Good: SIGUSR1 → "RELOAD SIGUSR1" (mark1), which the receiver accepts. It
    // can only land promptly if the rejected batch ahead of it was dropped, not
    // retried for the whole window.
    const goodBefore = await receiverPostCount('mark1=1');
    const good = await X(`docker kill --signal=SIGUSR1 ${webContainer}`);
    expect(good.exitCode, good.output).to.equal(0);
    await waitFor(async () => (await receiverPostCount('mark1=1')) > goodBefore, {
      timeout: 30000,
      interval: 2000,
      label: 'the good line shipped promptly, not stuck behind the rejected batch',
    });
  });

  it('prunes a container that died during a FluxOS outage, on the reconnect sync', async function () {
    this.timeout(300000);
    // The ghost: a tracked container that dies while the identity socket is
    // down. Its untrack has no other delivery — the reconnect sync is the
    // only exit from the tracked set (the authoritative-sync fix the daemon
    // pin carries). The outage must be on the FLUXOS side: the daemon holds
    // its tracked set in memory, so restarting the daemon instead would just
    // start it empty and prove nothing.
    const ghostId = await containerId(webContainer);
    expect(await daemonJournal('tracking container', { lines: 200 }),
      'the container must be tracked before it becomes a ghost').to.include(ghostId);
    const prunesBefore = await daemonJournalCount(PRUNE_LINE);

    // dockerd and the app containers keep running across this; only FluxOS
    // goes away, dropping the daemon's connection while it stays up.
    await stopFluxos(client.container);
    expect((await unitState(client.container, DAEMON_UNIT)),
      'the daemon must outlive the FluxOS outage').to.equal('active');
    const rm = await X(`docker rm -f ${webContainer}`);
    expect(rm.exitCode, rm.output).to.equal(0);
    await startFluxos(client.container);

    // FluxOS sends the full set on every connect; the daemon reconnects on a
    // 5s retry. Whatever FluxOS has reinstalled by then, the ghost's id is
    // absent from that set and must be reconciled away.
    await waitFor(async () => (await daemonJournal(PRUNE_LINE, { lines: 50 })).includes(ghostId),
      { timeout: 180000, interval: 3000, label: 'daemon pruned the ghost on the reconnect sync' });
    expect(await daemonJournalCount(PRUNE_LINE),
      'the prune is new, not a pre-existing line').to.be.greaterThan(prunesBefore);
  });

  it('re-routes the real pipe at a new endpoint after a port-changing update', async function () {
    this.timeout(600000);
    // The prune scenario restarted FluxOS on a node; wait for the submitter to
    // re-peer past the submission door before driving the update.
    await waitForSubmissionDoor(env.clients[0]);
    // Rotation with both real ends: the update moves the telemetry port AND
    // the receiver's listen port, so a stale endpoint cannot pass by
    // accident — traffic only reappears if the daemon was re-announced at
    // the new address. (Solo recreate cannot serve as the stimulus: the
    // lowest-free-IP allocator hands a recreated container its address back.)
    const updated = buildComponents({
      appRepo: APP, recvRepo: RECV_REPO, webPort: WEB_PORT, receiverPort: UPDATED_PORT,
    });
    const res = await updateEncryptedV9App(env.clients[0].url, {
      name: APP,
      components: updated,
      instances: 3,
      specOverrides: {
        telemetry: { provider: 'otlp', component: 'collector', port: UPDATED_PORT },
      },
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);

    // Update convergence runs at blocks processed at the tip (suite 68's
    // sizing note): advance one block per round and let every node catch up.
    // Adoption redeploys the components, so the receiver is a NEW container
    // with an empty log — any OTLP-RECV line in it is post-update traffic.
    let converged = false;
    for (let round = 0; round < 40 && !converged; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { currentHeight } = await advanceBlock();
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(env.clients.map((c) => c.waitForEvent(
        'block:processed', (d) => d.height >= currentHeight, 60000,
      )));
      // eslint-disable-next-line no-await-in-loop
      const env0 = await X(`docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${collectorContainer} 2>/dev/null || true`);
      converged = env0.stdout.includes(`RECEIVER_PORT=${UPDATED_PORT}`);
    }
    expect(converged, 'the collector was redeployed listening on the updated port').to.equal(true);

    await waitFor(async () => (await receiverLogGrep('OTLP-RECV path=/v1/metrics')).stdout.trim() !== '',
      { timeout: 180000, interval: 3000, label: 'metrics arriving at the rotated endpoint' });

    // And the log pipe follows the rotation too, not just metrics.
    const kill = await X(`docker kill --signal=SIGUSR1 ${webContainer}`);
    expect(kill.exitCode, kill.output).to.equal(0);
    await waitFor(async () => (await receiverLogGrep('OTLP-RECV path=/v1/logs .*mark1=1')).stdout.trim() !== '',
      { timeout: 120000, interval: 3000, label: 'shipped log line arriving at the rotated endpoint' });
  });

  it('keeps the daemon running until the LAST telemetry app leaves', async function () {
    this.timeout(900000);
    // Daemon lifecycle is per-NODE while telemetry is declared per-APP, so
    // the stop belongs to the last app on the node, not the first removal.
    // instances = NODES so the second app is guaranteed to land here: a
    // partial spread might miss this node entirely and prove nothing.
    await pushTestApp(APP2);
    await pushOtlpReceiver(RECV2_REPO);
    // Same post-restart door as the update scenario: don't race the re-peer.
    await waitForSubmissionDoor(env.clients[0]);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: APP2,
      components: buildComponents({ appRepo: APP2, recvRepo: RECV2_REPO, webPort: WEB2_PORT }),
      instances: NODES,
      specOverrides: { telemetry: { provider: 'otlp', component: 'collector' } },
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);
    await waitForAppInstalled(client, APP2, 300000);

    const { zelidauth } = await authenticate(client.url, appOwnerKey());
    const untracksBefore = await daemonJournalCount('untracking container');

    await client.removeApp(APP, { zelidauth });
    await waitFor(async () => (await daemonJournalCount('untracking container')) > untracksBefore,
      { timeout: 120000, interval: 3000, label: 'daemon untracked the removed app' });

    // The contract this scenario exists for: one telemetry app left, so the
    // daemon stays up and its config survives.
    expect(await unitState(client.container, DAEMON_UNIT),
      'daemon must survive while another telemetry app remains').to.equal('active');
    const stillConfigured = await X('test -f /run/flux/telemetry/config.toml');
    expect(stillConfigured.exitCode, 'config.toml must survive the non-final removal').to.equal(0);

    // Now the last one: appUninstaller stops the unit and removes config.toml
    // — a clean stop, not a crash ('inactive', never 'failed').
    await client.removeApp(APP2, { zelidauth });
    await waitFor(async () => (await unitState(client.container, DAEMON_UNIT)) === 'inactive',
      { timeout: 120000, interval: 2000, label: 'FluxOS stopped the daemon after the last telemetry app' });
    const failed = await X(`systemctl is-failed ${DAEMON_UNIT}`);
    expect(failed.stdout.trim(), 'unit must not be in a failed state').to.not.equal('failed');
    const cfg = await X('test -f /run/flux/telemetry/config.toml');
    expect(cfg.exitCode, 'config.toml removed with the daemon').to.not.equal(0);
  });
});
