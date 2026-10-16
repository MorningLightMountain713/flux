// fleet: 5
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlock, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitFor, waitForCapabilityUp } from '../framework/wait.js';
import { pushTestApp, pushOtlpReceiver } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
//   - systemd runs the daemon from boot and creates both its sockets from
//     their .socket units; FluxOS connects to the identity socket and pushes
//     the container feed — the production flow;
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
// The second telemetry app: removing one app untracks only its containers,
// and the daemon outlives the last one — it serves the node, not an app.
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

// The web component writes `log line <n>` every 100 ms, alternating stdout and
// stderr, and every 100 lines one 40,000-byte line that docker splits into
// 16 KiB entries: the container log the query-socket scenarios read.
const LOG_EVERY_MS = '100';
const LOG_BLOB_BYTES = '40000';
const LOG_BLOB_AFTER = '100';
// The rotation scenario's app: no telemetry, writing about 1 MB/s (a numbered
// line and a 10,000-byte line every 10 ms) against the 4 x 5 MB json-file set
// FluxOS gives every app container, so the current file is renamed to .1
// every few seconds and the oldest unlinked within half a minute.
const ROT_APP = 'otlprealrot';
const ROT_PORT = 31364;
// FluxOS's own decoder, for the docker side of the equality scenario.
const LogFrameDecoder = createRequire(import.meta.url)('../../../ZelBack/src/services/utils/logFrameDecoder.js');

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
    env: { LOG_EVERY_MS, LOG_BLOB_BYTES, LOG_BLOB_AFTER },
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
      BODY_DIR: '/bodies',
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
      telemetryd: 'real',
      shutdownd: 'none',
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
    // The submitting node refuses a registration until its app registry is
    // built.
    await waitForCapabilityUp(env.clients[0], 'appRegistryConsistent', 120000);

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

  it('systemd runs the real daemon, FluxOS connects, and the send set is tracked', async function () {
    this.timeout(120000);
    await waitFor(async () => (await X('systemctl is-active flux-telemetryd')).stdout.trim() === 'active',
      { timeout: 60000, interval: 2000, label: 'flux-telemetryd unit active (enabled at boot)' });

    // systemd created both sockets with the ownership their units name.
    const socks = await X("stat -c '%n %U:%G %a' /run/flux-telemetryd/identity.sock /run/flux-telemetryd/query.sock");
    expect(socks.exitCode, socks.output).to.equal(0);
    expect(socks.stdout).to.include('/run/flux-telemetryd/identity.sock fluxos:fluxos 600');
    expect(socks.stdout).to.include('/run/flux-telemetryd/query.sock root:flux-daemon-access 660');

    // FluxOS connected, and its sync carried the node tag: that is what
    // brings the daemon's telemetry half up.
    await waitFor(async () => (await daemonJournal('fluxos connected to the identity socket')).trim() !== ''
      && (await daemonJournal('first identity sync with a node id')).trim() !== '',
    { timeout: 60000, interval: 2000, label: 'FluxOS connected and synced with its opaque id' });

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

  it('attributes metrics and logs to the component by its identifier and identity', async function () {
    this.timeout(120000);
    const label = async (key) => (
      await X(`docker inspect -f '{{index .Config.Labels "${key}"}}' ${webContainer}`)
    ).stdout.trim();
    const identifier = await label('io.runonflux.identifier');
    const identity = await label('io.runonflux.identity');
    expect(identifier, 'the web container carries its identifier label').to.not.equal('');
    expect(identity, 'the web container carries its identity label').to.not.equal('');

    // The collector keeps the last body it accepted on each path; OTLP carries
    // attribute keys and string values as plain UTF-8.
    const bodyHas = async (path, needle) => (
      await X(`docker cp ${collectorContainer}:/bodies/${path}.bin - 2>/dev/null | grep -qaF -- '${needle}' && echo yes`)
    ).stdout.trim() === 'yes';
    for (const path of ['metrics', 'logs']) {
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => bodyHas(path, 'flux.identifier'), {
        timeout: 90000, interval: 3000, label: `a ${path} body carrying flux.identifier`,
      });
      // eslint-disable-next-line no-await-in-loop
      expect(await bodyHas(path, identifier), `${path} carry the web container's identifier`).to.equal(true);
      // eslint-disable-next-line no-await-in-loop
      expect(await bodyHas(path, 'flux.identity'), `${path} carry flux.identity`).to.equal(true);
      // eslint-disable-next-line no-await-in-loop
      expect(await bodyHas(path, identity), `${path} carry the app's identity`).to.equal(true);
      // eslint-disable-next-line no-await-in-loop
      expect(await bodyHas(path, 'flux.replica'), `a loose instance's ${path} carry no replica`).to.equal(false);
    }
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

    // FluxOS connects on start and sends the full set. Whatever it has
    // reinstalled by then, the ghost's id is absent from that set and must be
    // reconciled away.
    await waitFor(async () => (await daemonJournal(PRUNE_LINE, { lines: 50 })).includes(ghostId),
      { timeout: 180000, interval: 3000, label: 'daemon pruned the ghost on the reconnect sync' });
    expect(await daemonJournalCount(PRUNE_LINE),
      'the prune is new, not a pre-existing line').to.be.greaterThan(prunesBefore);

    // The scenarios after this one read web's log: wait for FluxOS's
    // reconciler to have it running again.
    await waitFor(async () => (await X(`docker inspect -f '{{.State.Running}}' ${webContainer} 2>/dev/null || true`)).stdout.trim() === 'true',
      { timeout: 180000, interval: 2000, label: 'FluxOS recreated the removed web container' });
  });

  it('FluxOS reconnects and re-syncs when the daemon restarts, and the sockets survive it', async function () {
    this.timeout(120000);
    // systemd holds both listening sockets across the restart, so FluxOS's
    // reconnect lands; the daemon starts empty and the sync re-fills it.
    const connectsBefore = await daemonJournalCount('fluxos connected to the identity socket');
    const syncsBefore = await daemonJournalCount('first identity sync with a node id');
    const drainsBefore = await daemonJournalCount('log shipping queues drained');
    const restart = await X(`systemctl restart ${DAEMON_UNIT}`);
    expect(restart.exitCode, restart.output).to.equal(0);
    // systemd's SIGTERM stopped it by draining the shipping queues, not by
    // killing it.
    expect(await daemonJournalCount('log shipping queues drained'),
      'the stopped daemon drained its queues').to.be.greaterThan(drainsBefore);

    await waitFor(async () => (await daemonJournalCount('fluxos connected to the identity socket')) > connectsBefore
      && (await daemonJournalCount('first identity sync with a node id')) > syncsBefore,
    { timeout: 60000, interval: 2000, label: 'FluxOS reconnected and re-synced after the daemon restart' });

    const socks = await X("stat -c '%n %U:%G %a' /run/flux-telemetryd/identity.sock /run/flux-telemetryd/query.sock");
    expect(socks.exitCode, socks.output).to.equal(0);
    expect(socks.stdout).to.include('/run/flux-telemetryd/identity.sock fluxos:fluxos 600');
    expect(socks.stdout).to.include('/run/flux-telemetryd/query.sock root:flux-daemon-access 660');
  });

  it('grants the daemon a container\'s log and nothing else in its directory', async function () {
    this.timeout(60000);
    // As flux-telemetry: the json log reads, the env-bearing config files do
    // not, and the directory does not list. The collector is not tailed, so
    // fluxos grants it nothing of its own: what holds is the boot unit's ACLs.
    // First as the container inherited them; then as a container that existed
    // before the grant gets them - no ACL at all, as on a node taking the
    // grant for the first time, until the unit runs. A file with no ACL has no
    // mask, and an explicit entry then sets one from what it grants.
    const asDaemon = async (cmd) => (await X(`runuser -u flux-telemetry -- ${cmd}`)).exitCode;
    const check = async (label) => {
      for (const name of [collectorContainer, webContainer]) {
        // eslint-disable-next-line no-await-in-loop
        const id = await containerId(name);
        const dir = `/dat/var/lib/docker/containers/${id}`;
        // eslint-disable-next-line no-await-in-loop
        expect(await asDaemon(`head -c1 ${dir}/${id}-json.log`), `${label}: ${name} log readable`).to.equal(0);
        for (const file of ['config.v2.json', 'hostconfig.json']) {
          // eslint-disable-next-line no-await-in-loop
          expect(await asDaemon(`head -c1 ${dir}/${file}`), `${label}: ${name} ${file} unreadable`).to.not.equal(0);
        }
      }
      const dir = `/dat/var/lib/docker/containers/${await containerId(collectorContainer)}`;
      expect(await asDaemon(`ls ${dir}`), `${label}: the collector's directory does not list`).to.not.equal(0);
    };
    await check('inherited');
    const collectorDir = `/dat/var/lib/docker/containers/${await containerId(collectorContainer)}`;
    const strip = await X(`setfacl -bR ${collectorDir}`);
    expect(strip.exitCode, strip.output).to.equal(0);
    const reapply = await X('systemctl restart flux-telemetryd-acl.service');
    expect(reapply.exitCode, reapply.output).to.equal(0);
    await check('a container from before the grant');
  });

  it('needs nothing from FluxOS: answers a query with FluxOS stopped, and starts shipping on its first sync', async function () {
    this.timeout(300000);
    const webId = await containerId(webContainer);
    // A read request straight to the socket, as root, parsed by its framing:
    // control lines, and chunk bodies of the byte count each declares.
    const query = async () => {
      const script = [
        "const s = require('net').createConnection('/run/flux-telemetryd/query.sock');",
        "s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'read', container: process.argv[2], tail: 3 }) + String.fromCharCode(10)));",
        'let b = Buffer.alloc(0);',
        "s.on('data', (d) => { b = Buffer.concat([b, d]); });",
        "s.on('end', () => {",
        '  const controls = []; let lines = 0; let at = 0;',
        '  while (at < b.length) {',
        '    const nl = b.indexOf(10, at); if (nl === -1) break;',
        "    const c = JSON.parse(b.toString('utf8', at, nl)); at = nl + 1;",
        "    if (Number.isInteger(c.chunk)) { lines += b.toString('utf8', at, at + c.chunk).split(String.fromCharCode(10)).length; at += c.chunk; } else controls.push(c);",
        '  }',
        '  console.log(JSON.stringify({ header: controls[0], trailer: controls[controls.length - 1], lines }));',
        '});',
      ].join('\n');
      const r = await X(`cat > /tmp/query.js <<'QUERY'\n${script}\nQUERY\nnode /tmp/query.js ${webId}`);
      expect(r.exitCode, r.output).to.equal(0);
      return JSON.parse(r.stdout.trim());
    };

    await stopFluxos(client.container);
    try {
      const restart = await X(`systemctl restart ${DAEMON_UNIT}`);
      expect(restart.exitCode, restart.output).to.equal(0);
      expect(await unitState(client.container, DAEMON_UNIT)).to.equal('active');
      const { header, trailer, lines } = await query();
      expect(header.ok, JSON.stringify(header)).to.equal(true);
      expect(trailer, 'three lines served with no FluxOS and no identity peer').to.include({ end: true, lines: 3 });
      expect(lines, 'the chunks carried the three lines the trailer counts').to.equal(3);
    } finally {
      await startFluxos(client.container);
    }

    // FluxOS's first sync carries the node id and brings the telemetry half
    // up in the process already running.
    const pid = (await X(`systemctl show -p MainPID --value ${DAEMON_UNIT}`)).stdout.trim();
    const syncsBefore = await daemonJournalCount('first identity sync with a node id');
    await waitFor(async () => (await daemonJournalCount('first identity sync with a node id')) > syncsBefore,
      { timeout: 120000, interval: 2000, label: 'the telemetry half started on FluxOS\'s first sync' });
    expect((await X(`systemctl show -p MainPID --value ${DAEMON_UNIT}`)).stdout.trim(),
      'no daemon restart').to.equal(pid);
  });

  it('reads container logs through the daemon: every line once, through a daemon stop and a restart', async function () {
    this.timeout(300000);
    const { zelidauth } = await authenticate(client.url, appOwnerKey());
    const poll = async (cursor) => {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const body = await client.getAuthed(`/apps/applogpolling/web_${APP}/100${query}`, zelidauth);
      expect(body.status, `applogpolling refused: ${JSON.stringify(body).slice(0, 300)}`).to.equal('success');
      return body;
    };
    const lineNumber = (line) => {
      const match = /log line (\d+)\s*$/.exec(line);
      return match ? Number(match[1]) : null;
    };
    const blob = (line) => /^\S+ B+$/.test(line);

    let { cursor } = await poll();
    // Only the daemon adds where it stopped in the file to the cursor.
    const fields = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    expect(fields, 'a daemon-issued cursor').to.include.keys('ino', 'firstNs', 'off');

    const collected = [];
    const take = (body) => {
      expect(body.rolledOver, 'a line this reader had not read was discarded').to.be.false;
      expect(body.skipped, 'a reader one second behind was moved to the end').to.be.false;
      body.logs.filter((line) => !blob(line)).forEach((line) => {
        const n = lineNumber(line);
        expect(n, `unparseable log line: ${line.slice(0, 200)}`).to.not.equal(null);
        collected.push(n);
      });
      return body.cursor;
    };

    for (let i = 0; i < 16; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
      if (i === 5) {
        // Stopped: systemd keeps the sockets, and the next connect - this
        // reader's poll or FluxOS's identity reconnect - starts it again.
        // eslint-disable-next-line no-await-in-loop
        expect((await X(`systemctl stop ${DAEMON_UNIT}`)).exitCode).to.equal(0);
      }
      if (i === 10) {
        // A restart racing a poll: a response cut before its trailer is asked
        // for again, of the daemon.
        // eslint-disable-next-line no-await-in-loop
        const [body, restart] = await Promise.all([poll(cursor), X(`systemctl restart ${DAEMON_UNIT}`)]);
        expect(restart.exitCode, restart.output).to.equal(0);
        cursor = take(body);
      } else {
        // eslint-disable-next-line no-await-in-loop
        cursor = take(await poll(cursor));
      }
    }
    expect(await unitState(client.container, DAEMON_UNIT), 'a connect started the stopped daemon').to.equal('active');
    // One poll more: stdout and stderr interleave, so the last poll's newest
    // line can have an older neighbour that only the next read carries.
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    take(await poll(cursor));

    expect(collected.length, 'sixteen polls over ten lines a second').to.be.above(100);
    expect(new Set(collected).size, `a line was delivered twice: ${collected.join(',')}`).to.equal(collected.length);
    const ordered = [...collected].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i], `a gap between ${ordered[i - 1]} and ${ordered[i]}`).to.equal(ordered[i - 1] + 1);
    }
  });

  it('answers a full read with what docker gives FluxOS\'s decoder, split lines included', async function () {
    this.timeout(120000);
    const { zelidauth } = await authenticate(client.url, appOwnerKey());
    // The comparison needs a log with a split line in it: the container writes
    // one every LOG_BLOB_AFTER lines, and may be younger than that here.
    const splitLine = (line) => line.length === 31 + Number(LOG_BLOB_BYTES);
    let served;
    await waitFor(async () => {
      served = await client.getAuthed(`/apps/applogpolling/web_${APP}/all`, zelidauth);
      expect(served.status, JSON.stringify(served).slice(0, 300)).to.equal('success');
      return served.logs.some(splitLine);
    }, { timeout: 60000, interval: 2000, label: 'a split line in the web container\'s log' });

    // Docker's framed stream for the same container, read after the daemon's
    // answer and so a superset of it, through the decoder FluxOS's docker
    // reader uses.
    const id = await containerId(webContainer);
    const framed = await X(`curl -sf --unix-socket /var/run/docker.sock 'http://docker/containers/${id}/logs?stdout=1&stderr=1&timestamps=1' | base64 -w0`);
    expect(framed.exitCode, framed.output.slice(0, 300)).to.equal(0);
    const decoder = new LogFrameDecoder({ timestamped: true });
    const fromDocker = [...decoder.push(Buffer.from(framed.stdout.trim(), 'base64')), ...decoder.flush()];

    expect(served.logs.length, 'a log to compare').to.be.above(100);
    expect(fromDocker.length).to.be.at.least(served.logs.length);
    expect(served.logs, 'the daemon\'s full read is docker\'s, line for line')
      .to.deep.equal(fromDocker.slice(0, served.logs.length));
  });

  it('follows a log across rotation: a fresh cursor continues, a stale one is told its lines are gone', async function () {
    this.timeout(600000);
    await pushTestApp(ROT_APP);
    await waitForSubmissionDoor(env.clients[0]);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: ROT_APP,
      components: {
        web: {
          name: 'web',
          description: 'writes about 1 MB of log a second',
          image: `${REGISTRY_REPO_HOST}/${ROT_APP}:v1`,
          cpu: 0.2,
          memory: 200,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 1, mounts: {} },
          ports: { http: { containerPort: 80, hostPort: ROT_PORT } },
          env: { LOG_EVERY_MS: '10', LOG_BLOB_BYTES: '10000', LOG_BLOB_AFTER: '1' },
        },
      },
      instances: NODES,
    });
    expect(res.status, JSON.stringify(res)).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);
    await waitForAppInstalled(client, ROT_APP, 300000);
    const rotWeb = await requireAppContainerName(client.container, ROT_APP, 'web');
    const dir = `/dat/var/lib/docker/containers/${await containerId(rotWeb)}`;
    const { zelidauth } = await authenticate(client.url, appOwnerKey());

    try {
      const poll = async (cursor) => {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const body = await client.getAuthed(`/apps/applogpolling/web_${ROT_APP}/100${query}`, zelidauth);
        expect(body.status, `applogpolling refused: ${JSON.stringify(body).slice(0, 300)}`).to.equal('success');
        return body;
      };
      const lineNumber = (line) => {
        const match = /log line (\d+)\s*$/.exec(line);
        return match ? Number(match[1]) : null;
      };
      const rotatedFiles = async () => Number(
        (await X(`ls ${dir} | grep -c 'json.log\\.' || true`)).stdout.trim() || 0,
      );
      await waitFor(async () => (await rotatedFiles()) >= 1,
        { timeout: 60000, interval: 1000, label: 'the log has rotated' });

      const stale = (await poll()).cursor;

      // A reader polling every second rides the renames: each poll's cursor
      // file has usually become .1 by the next, and nothing is lost or repeated.
      let { cursor } = await poll();
      const collected = [];
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
        // eslint-disable-next-line no-await-in-loop
        const body = await poll(cursor);
        expect(body.rolledOver, `poll ${i}: a reader one second behind lost lines`).to.be.false;
        expect(body.skipped, `poll ${i}: a reader one second behind was moved to the end`).to.be.false;
        body.logs.map(lineNumber).filter((n) => n !== null).forEach((n) => collected.push(n));
        ({ cursor } = body);
      }
      expect(await rotatedFiles(), 'rotation happened under the reader').to.be.at.least(3);
      const ordered = [...collected].sort((a, b) => a - b);
      expect(new Set(collected).size, 'a line delivered twice').to.equal(collected.length);
      for (let i = 1; i < ordered.length; i += 1) {
        expect(ordered[i], `a gap between ${ordered[i - 1]} and ${ordered[i]}`).to.equal(ordered[i - 1] + 1);
      }

      // Once 20 MB more is written the stale cursor's file is unlinked, and the
      // answer says the lines in between are gone.
      let late;
      await waitFor(async () => {
        late = await poll(stale);
        return late.rolledOver;
      }, { timeout: 120000, interval: 2000, label: 'the stale cursor\'s file rotated away' });
      expect(late.logs.length, 'answered from the oldest retained line').to.be.above(0);
    } finally {
      await client.removeApp(ROT_APP, { zelidauth });
    }
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

  it('untracks only the removed app, and keeps running after the last telemetry app leaves', async function () {
    this.timeout(900000);
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
    const web2Container = await requireAppContainerName(client.container, APP2, 'web');
    const web2Id = await containerId(web2Container);
    await waitFor(async () => (await daemonJournal('tracking container', { lines: 200 })).includes(web2Id),
      { timeout: 120000, interval: 3000, label: 'daemon tracking the second app' });

    const { zelidauth } = await authenticate(client.url, appOwnerKey());
    const pid = (await X(`systemctl show -p MainPID --value ${DAEMON_UNIT}`)).stdout.trim();
    const untracksBefore = await daemonJournalCount('untracking container');

    await client.removeApp(APP, { zelidauth });
    await waitFor(async () => (await daemonJournalCount('untracking container')) > untracksBefore,
      { timeout: 120000, interval: 3000, label: 'daemon untracked the removed app' });
    expect(await daemonJournal('untracking container', { lines: 50 }),
      'the remaining app stays tracked').to.not.include(web2Id);

    // The last one: the daemon untracks it and keeps running — it serves the
    // node (log queries, the next telemetry app), so FluxOS never stops it.
    await client.removeApp(APP2, { zelidauth });
    await waitFor(async () => (await daemonJournal('untracking container', { lines: 50 })).includes(web2Id),
      { timeout: 120000, interval: 3000, label: 'daemon untracked the last telemetry app' });
    expect(await unitState(client.container, DAEMON_UNIT), 'the daemon outlives the last telemetry app').to.equal('active');
    expect((await X(`systemctl show -p MainPID --value ${DAEMON_UNIT}`)).stdout.trim(),
      'the same process, never stopped and started again').to.equal(pid);
  });
});
