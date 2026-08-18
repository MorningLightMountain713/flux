// Node.js v17+ resolves localhost to ::1 (IPv6) but Docker binds ports to 0.0.0.0 (IPv4).
// Without this, testcontainers can't connect to the Ryuk reaper and cleanup never runs.
// See: https://github.com/testcontainers/testcontainers-node/issues/772
process.env.TESTCONTAINERS_HOST_OVERRIDE ??= '127.0.0.1';
process.env.TESTCONTAINERS_RYUK_RECONNECTION_TIMEOUT ??= '5s';

import { GenericContainer, Wait, getContainerRuntimeClient } from 'testcontainers';
import {
  readFileSync, mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { nodeClient } from './node-client.js';
import { execInContainer } from './container.js';
import { HttpPollWaitStrategy } from './http-wait-strategy.js';
import { TcpPollWaitStrategy } from './tcp-wait-strategy.js';
import { getSubnetConfig, REGISTRY_ALIAS } from './subnet-config.js';
import { closeDb } from './db-client.js';
import { stubPeerClient } from './stub-peer-helper.js';
import { pushImage } from './registry-helper.js';
import { defaultGroupGrantDoc } from './policy-helper.js';
import { MongoClient } from 'mongodb';
import { authenticate } from '../auth.js';
import { fluxTeamKey, nodeKey } from './keys.js';
import { assertFluxSpecVendorCurrent, NODE_IMAGE, OLD_NODE_IMAGE } from './flux-spec-vendor.js';
import { assertNodeConfigsCurrent } from './node-configs.js';
import { statelessRegex } from './log-reader.js';
import {
  renderFluxdConf, DEFAULT_ZMQ_TOPICS, ZMQ_NODE_PORT_BASE, zmqNodePort,
} from './fluxd-conf.js';

function createLogCollector() {
  // Each entry is { t, line }: t is the capture wall-clock (ISO), line is the raw
  // log text. The container's own log lines carry no timestamp, so we stamp at
  // capture time (near-realtime off the stream). hasLine/countPattern match the
  // raw text; getLines prepends t so inter-line gaps reveal timing (e.g. the
  // monitor cycle interval between successive "sync status" lines).
  const entries = [];
  const push = (line) => entries.push({ t: new Date().toISOString(), line });

  function consumer(stream) {
    stream.on('data', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf-8');
      for (const line of text.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed) push(trimmed);
      }
    });
    stream.on('end', () => push('[LOG_STREAM_ENDED]'));
    stream.on('error', (err) => push(`[LOG_STREAM_ERROR: ${err.message}]`));
    stream.on('close', () => push('[LOG_STREAM_CLOSED]'));
  }

  // Both match line by line, so the regex must not carry state between lines — see
  // statelessRegex.
  consumer.hasLine = (pattern) => {
    const regex = statelessRegex(pattern);
    return entries.some((e) => regex.test(e.line));
  };

  consumer.countPattern = (pattern) => {
    const regex = statelessRegex(pattern);
    return entries.filter((e) => regex.test(e.line)).length;
  };

  consumer.getLines = () => entries.map((e) => `${e.t} ${e.line}`);

  return consumer;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', '..', 'fixtures');
const manifest = JSON.parse(readFileSync(join(fixturesDir, 'node-manifest.json'), 'utf-8'));
// Identity for the fake-blockchain node list (collateral/pubkey/tier). Base-independent;
// the per-run IPs are assigned from subnet-config and POSTed to the daemon stub.
const deterministicList = JSON.parse(readFileSync(join(fixturesDir, 'deterministic-list.json'), 'utf-8'));

// All infra/node addresses derive from the per-run subnet base (TEST_SUBNET_BASE,
// default '198.18'); see subnet-config.js. The named constants below are kept so
// downstream references are unchanged — only the base varies per run.
const subnet = getSubnetConfig();
const SUBNET = subnet.subnet;
const GATEWAY = subnet.gateway;
const MONGO_IP = subnet.mongo;
const DAEMON_IP = subnet.daemon;
const SYNCTHING_IP = subnet.syncthing;
const REGISTRY_IP = subnet.registry;
const EXTERNAL_STUB_IP = subnet.externalStub;
const FDM_IP = subnet.fdm;
const FLUXDRIVE_IP = subnet.fluxDrive;
const INITIAL_HEIGHT = 2100000;

// Per-run-all label. run-all.sh exports E2E_RUN_LABEL (unique per invocation) and
// scopes its between-suite cleanup to it, so concurrent run-all invocations only
// ever remove their OWN docker objects — never another live run's fleet. Applied
// to every container, network and volume this run creates. Empty when a suite is
// run standalone (no run-all), in which case the cleanup never fires anyway.
const RUN_LABEL = process.env.E2E_RUN_LABEL || '';
const runLabels = () => (RUN_LABEL ? { 'flux-e2e-run': RUN_LABEL } : {});

// Exported for suite-scoped infra that is not part of the base fleet (see
// haproxy-control.js). Anything joining the test network needs what this adds:
// the static-IP assignment, because the runner reaches services by subnet IP and
// never by a mapped host port, and the run labels, because run-all.sh's
// between-suite cleanup scopes removal by them.
export class StaticIpContainer extends GenericContainer {
  #staticIp;
  #networkName;
  #aliases = [];
  #stopSignal;

  withStaticIp(networkName, ip, aliases = []) {
    this.#staticIp = ip;
    this.#networkName = networkName;
    this.#aliases = aliases;
    return this;
  }

  // Per-container stop signal (the image's STOPSIGNAL stays SIGTERM for the
  // default entrypoint). systemd-mode nodes need SIGRTMIN+3: systemd as PID 1
  // treats SIGTERM as a reexec request, so a plain docker stop would sit out
  // the full kill timeout on every teardown.
  withStopSignal(signal) {
    this.#stopSignal = signal;
    return this;
  }

  async beforeContainerCreated() {
    // Tag with this run's label so run-all.sh's between-suite cleanup can scope
    // removal to its own fleet (see runLabels()).
    this.createOpts.Labels = { ...(this.createOpts.Labels || {}), ...runLabels() };
    if (this.#stopSignal) this.createOpts.StopSignal = this.#stopSignal;
    if (this.#staticIp && this.#networkName) {
      this.createOpts.NetworkingConfig = {
        EndpointsConfig: {
          [this.#networkName]: {
            IPAMConfig: { IPv4Address: this.#staticIp },
            // Network aliases are served by Docker's embedded DNS (127.0.0.11),
            // so they're resolvable via c-ares (dns.resolve) — unlike /etc/hosts
            // extra_hosts, which only getaddrinfo (dns.lookup) consults.
            ...(this.#aliases.length ? { Aliases: this.#aliases } : {}),
          },
        },
      };
    }
  }
}

async function createNetwork() {
  const client = await getContainerRuntimeClient();
  const { getReaper } = await import('testcontainers');
  const reaper = await getReaper(client);
  const networkName = `flux-test-${Date.now()}`;
  await client.container.dockerode.createNetwork({
    Name: networkName,
    Driver: 'bridge',
    // Internal enforces the harness boundary: every external dependency must be a
    // stub on this network. An unstubbed code path (hardcoded URL, shell-out) fails
    // instantly and loudly here instead of silently reaching the real internet.
    // Host->container traffic (the runner, pushImage) is unaffected.
    Internal: true,
    Labels: { 'org.testcontainers.session-id': reaper.sessionId, ...runLabels() },
    IPAM: {
      Driver: 'default',
      Config: [{ Subnet: SUBNET, Gateway: GATEWAY }],
    },
  });
  return networkName;
}

async function removeNetwork(networkName) {
  const client = await getContainerRuntimeClient();
  const network = client.container.dockerode.getNetwork(networkName);
  await network.remove().catch(() => {});
}

// Every env this process ever booted, including partially-built ones whose boot
// threw. log-on-failure's root hooks read this registry — envs carry an
// `ownerSuite` tag (from hookCtx) so a failure dumps only the envs attributed to
// the failing describe's chain, untagged envs included as unattributable.
// Envs stay registered after teardown on purpose: the failure dump runs in an
// after-all hook, i.e. potentially after teardown, and reads in-memory log lines
// and event snapshots that outlive the containers. A module singleton is safe
// because run-all gives each suite file its own mocha process.
const activeEnvs = new Set();
/**
 * Node-list entries as the harness itself builds them: identity from the committed
 * fixture, addresses from subnet-config. A suite that seeds its own list needs these
 * rather than bare addresses, because the delta wire format identifies a node by its
 * outpoint — a list of `{ ip }` collapses to one entry under the diff and publishes
 * nothing at all when one is removed.
 * @param {number} count How many entries, up to the fixture's size.
 * @returns {Array<object>} Entries carrying txhash, outidx, pubkeys and this run's IPs.
 */
export function deterministicNodes(count) {
  if (count > deterministicList.length) {
    throw new Error(`only ${deterministicList.length} fixture nodes exist, asked for ${count}`);
  }
  return deterministicList.slice(0, count).map((n, idx) => ({ ...n, ip: subnet.nodeIp(idx + 1) }));
}

export function activeTestEnvs() {
  return [...activeEnvs];
}

// The env is a handle that exists from the moment boot starts, not a reward for
// a successful boot: _buildEnv registers resources onto it as they come up, so
// any boot-phase failure can still reach them — for the evidence dump AND for
// teardown (one idempotent path shared by the boot-failure catch and the suite's
// own after-hook). Previously the env object was only assembled on successful
// return: a boot-gate failure left the suite's `env` undefined, the after-all
// dump empty-handed, and the SSE clients connected — open EventSource handles
// that kept the mocha process alive forever (the 2026-06-12 gate wedge).
function makeEnvShell(networkName) {
  const started = []; // every started container, boot order (teardown stops in reverse)
  const clients = []; // node SSE clients, index-aligned with fluxNodes (null gaps)
  const nodeConfigs = []; // per real node: { index, ip, num, logCollector, bootIdDir, ... }
  const volumeNames = [];
  const eventSnapshots = new Map(); // node index -> SSE events captured at teardown
  let tornDown = false;

  const env = {
    networkName,
    containers: {},
    started,
    clients,
    nodeConfigs,
    volumeNames,
    stubPeerClients: new Map(),
    get nodeCount() { return clients.length; },
    get lastNodeIndex() { return clients.length - 1; },

    // Everything captured for each node so far: log lines (streaming since
    // container create) and SSE events (live buffer, or the snapshot teardown
    // takes before disconnect wipes it). Defined on the shell — unlike the
    // post-boot accessors — because the failure dump needs it at ANY boot phase.
    nodeDiagnostics() {
      const byIndex = new Map();
      for (const cfg of nodeConfigs) {
        byIndex.set(cfg.index, {
          index: cfg.index,
          ip: cfg.ip,
          lines: cfg.logCollector?.getLines() ?? [],
          events: [],
        });
      }
      clients.forEach((client, i) => {
        if (!client) return;
        const d = byIndex.get(i) ?? { index: i, ip: client.ip, lines: [], events: [] };
        const live = client.getEventBuffer();
        d.events = live.length ? live : (eventSnapshots.get(i) ?? []);
        byIndex.set(i, d);
      });
      return [...byIndex.values()].sort((a, b) => a.index - b.index);
    },

    async teardown() {
      if (tornDown) return;
      tornDown = true;
      const warn = (label, err) => console.warn(`teardown [${networkName}] ${label}: ${err.message}`);
      // disconnectEventStream wipes the client's event buffer — snapshot first so
      // a failure dump running after teardown still has the events
      clients.forEach((client, i) => {
        if (client) eventSnapshots.set(i, client.getEventBuffer());
      });
      for (const client of clients) {
        if (client) client.disconnectEventStream();
      }
      // FluxOS sets app mountpoints immutable (chattr +i) so an unmounted app
      // dir rejects writes. The flag lives on the BARE dir under the loop mount
      // and survives into the node's named volume - Docker then cannot delete
      // the volume (EPERM) and every run leaks its node volumes. Unmount to
      // expose the bare dirs and strip the flag while the node is still
      // running; containers going down makes this the last chance to exec.
      await Promise.all(clients.map(async (client) => {
        if (!client?.container) return;
        await execInContainer(
          client.container,
          'for d in /mnt/appdata/flux-apps/*/; do umount -l "$d" 2>/dev/null; done; chattr -R -i /mnt/appdata/flux-apps 2>/dev/null; true',
        ).catch((e) => warn('immutable-flag sweep', e));
      }));
      for (const c of [...started].reverse()) {
        await c.stop().catch((e) => warn('container stop', e));
      }
      await closeDb();
      const cleanupClient = await getContainerRuntimeClient();
      for (const volName of volumeNames) {
        const volume = cleanupClient.container.dockerode.getVolume(volName);
        try {
          await volume.remove();
        } catch (firstErr) {
          // The in-container sweep above misses nodes that crashed or never got
          // a client (boot failure), and their immutable app dirs EPERM the
          // volume delete. Strip the flags from the volume side with a
          // throwaway container and retry, so even a wedged fleet cleans up.
          try {
            const helper = await cleanupClient.container.dockerode.createContainer({
              Image: NODE_IMAGE,
              Entrypoint: ['bash', '-c', 'chattr -R -i /v/flux-apps 2>/dev/null; true'],
              HostConfig: { Binds: [`${volName}:/v`], CapAdd: ['LINUX_IMMUTABLE'] },
            });
            await helper.start();
            await helper.wait();
            await helper.remove({ force: true }).catch(() => {});
            await volume.remove();
          } catch (retryErr) {
            warn(`volume ${volName}`, firstErr);
          }
        }
      }
      await removeNetwork(networkName);
      for (const cfg of nodeConfigs) {
        if (cfg.bootIdDir) rmSync(cfg.bootIdDir, { recursive: true, force: true });
        if (cfg.fluxdConfDir) rmSync(cfg.fluxdConfDir, { recursive: true, force: true });
      }
      http.globalAgent.destroy();
    },
  };
  return env;
}

function getBootId(nodeNum) {
  return `test-boot-id-node-${String(nodeNum).padStart(2, '0')}`;
}

async function seedMongo(mongoIp, nodeCount, bootContext = 'running', { dataCenter = true, arcane = false } = {}) {
  const client = new MongoClient(`mongodb://${mongoIp}:27017`);
  try {
    await client.connect();
    // v9 content/encrypted features are gated behind policy entitlements, and a fresh
    // harness chain grants none. Seed a default-group grant so every owner is entitled —
    // the precondition the submission gate checks (see policy-helper). Arcane only: the
    // legacy-verdict suites never submit v9 specs, so they don't need it.
    const policyGrant = arcane ? defaultGroupGrantDoc() : null;
    for (let i = 1; i <= nodeCount; i++) {
      const num = String(i).padStart(2, '0');
      if (policyGrant) {
        await client.db(`node${num}_chainparams`).collection('policygroupmessages')
          .insertOne(structuredClone(policyGrant));
      }
      const explorerDb = client.db(`node${num}_zelcashdata`);
      await explorerDb.collection('scannedheight').updateOne(
        {},
        { $set: { generalScannedHeight: INITIAL_HEIGHT } },
        { upsert: true },
      );
      const localDb = client.db(`node${num}_zelfluxlocal`);
      await localDb.collection('geolocation').updateOne(
        { _id: 'nodeGeolocation' },
        {
          $set: {
            geolocation: {
              ip: subnet.nodeIp(i),
              continent: 'Europe', continentCode: 'EU',
              country: 'Germany', countryCode: 'DE',
              region: 'HE', regionName: 'Hesse',
              lat: 50.1109, lon: 8.6821,
              org: 'Test Network', static: true, dataCenter,
            },
            staticIp: true, dataCenter,
            lastIpChangeDate: null, updatedAt: Date.now(),
          },
        },
        { upsert: true },
      );
      if (bootContext === 'running') {
        await localDb.collection('nodestartuptracker').updateOne(
          { _id: 'heartbeat' },
          { $set: { lastAlive: Date.now(), machineBootId: getBootId(i), shutdownReason: null } },
          { upsert: true },
        );
      } else if (bootContext === 'rebooted') {
        await localDb.collection('nodestartuptracker').updateOne(
          { _id: 'heartbeat' },
          { $set: { lastAlive: Date.now(), machineBootId: 'old-boot-id', shutdownReason: 'sigterm' } },
          { upsert: true },
        );
      } else if (typeof bootContext === 'object') {
        // Prefer downtimeMs: it is stamped HERE, so it excludes the env-build time a
        // caller-computed lastAlive would already have accrued. Boot latency after this
        // point still counts, and it only ever makes the observed downtime LONGER - so a
        // fixture targeting a window must anchor near that window's lower bound, never
        // its middle.
        const lastAlive = bootContext.downtimeMs != null
          ? Date.now() - bootContext.downtimeMs
          : bootContext.lastAlive ?? Date.now();
        await localDb.collection('nodestartuptracker').updateOne(
          { _id: 'heartbeat' },
          { $set: {
            lastAlive,
            machineBootId: bootContext.machineBootId ?? 'old-boot-id',
            shutdownReason: bootContext.shutdownReason ?? null,
          } },
          { upsert: true },
        );
      }
      // bootContext === 'firstBoot': no heartbeat seeded
    }
  } finally {
    await client.close();
  }
}

// ---- host-wide boot semaphore ----
// Fleet boot is the only CPU-heavy phase a suite has: every node in the fleet
// starts its own dockerd and runs FluxOS DB prep at once. When two suites' boots
// overlap under run-parallel.sh, they starve each other and a healthy node can
// blow its event-wait budget while merely slow (observed in the 42-suite gate:
// suite 22's second fleet booted at load ~15 on 16 cores and mongo collection
// prep crawled at 7-17s a step). Running fleets are cheap, so serialise just the
// boot phase host-wide and let everything else overlap. The claim protocol
// mirrors the subnet claim in run-all.sh: an atomic mkdir holding the owner pid,
// reclaimable by any waiter once the owner process is dead.
const BOOT_LOCK_DIR = process.env.E2E_BOOT_LOCK_DIR ?? join(tmpdir(), 'e2e-boot-lock');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A claimer writes its pid in the same breath as the mkdir, so a lock directory
// without one is either that microsecond-wide window or a run that was killed
// inside it. Treating the second as a live claimer waits forever, and because the
// wait logs nothing it presents as a suite that simply hangs — every later run on
// the box wedged by a directory nobody owns. A pid that never arrives is therefore
// taken as abandoned after a few polls, which is orders of magnitude longer than
// the window it protects.
const BOOT_LOCK_PIDLESS_GRACE_POLLS = 5;
// Waiting past this means the queue is wedged rather than busy. Failing here says
// so, instead of sleeping until the runner's wall-clock kills the suite with a
// SIGKILL that explains nothing.
const BOOT_LOCK_MAX_WAIT_MS = Number(process.env.E2E_BOOT_LOCK_MAX_WAIT_MS ?? 600000);

export async function acquireBootLock() {
  const startedAt = process.hrtime.bigint();
  let pidlessPolls = 0;
  for (;;) {
    try {
      mkdirSync(BOOT_LOCK_DIR);
      writeFileSync(join(BOOT_LOCK_DIR, 'pid'), String(process.pid));
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let owner = 0;
    try {
      owner = Number(readFileSync(join(BOOT_LOCK_DIR, 'pid'), 'utf-8'));
    } catch {
      // claimer is between mkdir and pid write, or died in it — the grace below decides
    }
    if (owner) {
      pidlessPolls = 0;
      try {
        process.kill(owner, 0);
      } catch {
        // owner is dead — reclaim; if a sibling reclaims first, the next
        // mkdir attempt just loses the race and waits
        rmSync(BOOT_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
    } else {
      pidlessPolls += 1;
      if (pidlessPolls >= BOOT_LOCK_PIDLESS_GRACE_POLLS) {
        rmSync(BOOT_LOCK_DIR, { recursive: true, force: true });
        pidlessPolls = 0;
        continue;
      }
    }
    const waitedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    if (waitedMs > BOOT_LOCK_MAX_WAIT_MS) {
      throw new Error(
        `boot lock: waited ${Math.round(waitedMs / 1000)}s for ${BOOT_LOCK_DIR} `
        + `(holder pid ${owner || 'none'}). The queue is wedged, not merely busy.`,
      );
    }
    await sleep(1000);
  }
}

export function releaseBootLock() {
  try {
    const owner = Number(readFileSync(join(BOOT_LOCK_DIR, 'pid'), 'utf-8'));
    if (owner === process.pid) rmSync(BOOT_LOCK_DIR, { recursive: true, force: true });
  } catch {
    // already released or reclaimed
  }
}

export async function createTestEnv({
  hookCtx = null, nodes = 1, deferredNodes = 0, legacyNodes = [], stubPeers = [],
  oldNodes = [], configOverrides = null, nodeConfigOverrides = {}, nodeTiers = null,
  dataCenter = true,
  tickerAutostart = false, discoveryAutostart = false, nodeStatusOverrides = {},
  rpcFailures = [], bootContext = 'running', arcane = true, shutdowndMock = true,
  telemetrydMock = false, systemdMode = false, telemetrydReal = false,
  shutdowndReal = false, dnsdReal = false,
  zmqTopics = DEFAULT_ZMQ_TOPICS, nodeZmqTopics = {}, perNodeZmq = false,
} = {}) {
  // Before the boot lock, the network, or a single container: a flux-spec
  // vendor lagging the branch surfaces as a product mystery minutes later,
  // and only in suites that install something.
  assertFluxSpecVendorCurrent();
  // Same reasoning for the fleet's own configs: a collection production
  // declares and a node config lacks fails as a product mystery, or as a
  // startup that never finishes.
  assertNodeConfigsCurrent();
  // The boot-lock queue wait must not count against the suite's hook budget.
  // Mocha enforces a hook's timeout twice: the watchdog timer (which would fire
  // MID-QUEUE whenever the queue alone outlasts the budget), and a completion-time
  // duration check that fails any hook whose TOTAL elapsed time exceeds the
  // timeout VALUE — so merely re-setting the same value re-arms the watchdog but
  // still fails the hook once it completes. Disable the timeout while queued
  // (queue liveness is the lock's own job: a dead owner's claim is reclaimed),
  // then set declared + queued: that value passes the duration check with exactly
  // the declared budget left for the boot, and setting it re-arms the watchdog.
  // Hooks that disabled their timeout (0) are left disabled.
  const declaredMs = (hookCtx && typeof hookCtx.timeout === 'function') ? hookCtx.timeout() : 0;
  if (declaredMs > 0) hookCtx.timeout(0);
  const queuedFrom = process.hrtime.bigint();
  await acquireBootLock();
  if (declaredMs > 0) {
    const queuedMs = Number((process.hrtime.bigint() - queuedFrom) / 1000000n);
    hookCtx.timeout(declaredMs + queuedMs);
  }
  const networkName = await createNetwork();
  const env = makeEnvShell(networkName);
  // Attribute the env to the describe whose hook is booting it — log-on-failure
  // uses this to dump only the envs that belong to a failing suite's chain.
  env.ownerSuite = (hookCtx && typeof hookCtx.runnable === 'function')
    ? (hookCtx.runnable()?.parent ?? null)
    : null;
  activeEnvs.add(env);

  try {
    await _buildEnv(
      env, nodes, deferredNodes, legacyNodes, oldNodes, stubPeers, configOverrides, nodeConfigOverrides,
      nodeTiers, dataCenter, tickerAutostart, discoveryAutostart, nodeStatusOverrides, rpcFailures,
      bootContext, arcane, shutdowndMock, telemetrydMock, systemdMode, telemetrydReal,
      shutdowndReal, dnsdReal, zmqTopics, nodeZmqTopics, { perNodeZmq },
    );
    return env;
  } catch (err) {
    // Boot failed: the env owns everything started so far. The shared teardown
    // disconnects the SSE clients (so mocha can exit) and stops the containers;
    // the log collectors and event snapshots stay reachable via activeTestEnvs()
    // for the after-all failure dump. The boot error is what matters — teardown
    // problems are warned, never allowed to mask it.
    await env.teardown().catch((e) => console.warn(`boot-failure teardown [${networkName}]: ${e.message}`));
    throw err;
  } finally {
    releaseBootLock();
  }
}

// A node is ready when it can SERVE AUTH, not merely HTTP: the first thing every
// suite does against a fresh or restarted node is authenticate (startDiscovery),
// and /id/loginphrase needs the mongo connection, which comes up after express
// starts answering /flux/version. During that window the route returns 200 with
// an error body, so readiness must validate the body, not just res.ok.
function nodeReadyWaitStrategy(nodeIp) {
  const validate = async (res) => {
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return !!(body && body.status === 'success');
  };
  return new HttpPollWaitStrategy(`http://${nodeIp}:16127/id/loginphrase`, { validate });
}

function mergeConfigs(base, override) {
  if (!override) return base;
  if (!base) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object') {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function _buildEnv(
  env, nodes, deferredNodes, legacyNodes, oldNodes, stubPeers, configOverrides, nodeConfigOverrides,
  nodeTiers, dataCenter, tickerAutostart, discoveryAutostart, nodeStatusOverrides, rpcFailures,
  bootContext, arcane, shutdowndMock, telemetrydMock, systemdMode, telemetrydReal, shutdowndReal,
  dnsdReal, zmqTopics, nodeZmqTopics, zmqOptions = {},
) {
  const { perNodeZmq = false } = zmqOptions;
  // Everything built here registers onto the env shell as it comes up, so a
  // boot-phase throw leaves the partial state reachable (see makeEnvShell).
  const {
    networkName, containers, started, clients, volumeNames, nodeConfigs,
    stubPeerClients: stubPeerClientsMap,
  } = env;
  const stubPeerSet = new Set(stubPeers);

  // Health check timeout must be < interval — Docker's health state machine
  // produces spurious "unhealthy" on container restart when timeout >= interval.
  // nofile: modern docker defaults give a 1024 soft limit; the shared mongod
  // spends an fd per pooled connection across every node PLUS one per WiredTiger
  // data file, and a 10-node fleet sits right at that cliff — the last node to
  // boot finds mongod unable to accept ("Too many open files") while the earlier
  // nodes coast on established pools. MongoDB's own floor is 64000.
  const mongo = await new StaticIpContainer('mongo:8')
    .withCommand(['--wiredTigerCacheSizeGB', '1', '--setParameter', 'maxNumActiveUserIndexBuilds=64', '--setParameter', 'enableTestCommands=1'])
    .withUlimits({ nofile: { soft: 64000, hard: 64000 } })
    .withStaticIp(networkName, MONGO_IP)
    .withWaitStrategy(new TcpPollWaitStrategy(MONGO_IP, 27017))
    .withHealthCheck({
      test: ['CMD', 'mongosh', '--eval', "db.adminCommand('ping')"],
      interval: 3000,
      timeout: 2000,
      retries: 10,
    })
    .start();
  started.push(mongo);
  containers.mongo = mongo;

  await seedMongo(MONGO_IP, nodes, bootContext, { dataCenter, arcane });

  const daemonStub = await new StaticIpContainer('flux-e2e-daemon-stub')
    .withStaticIp(networkName, DAEMON_IP)
    .withEnvironment({
      FLUX_TEST_HARNESS: 'true',
      FLUXD_PORT: '16124',
      BENCHD_PORT: '16224',
      CONTROL_PORT: '18232',
      // The publisher's port, which is what config.daemon.zmqport defaults to.
      ZMQ_PORT: '16123',
      ZMQ_NODE_PORT_BASE: String(ZMQ_NODE_PORT_BASE),
      TICKER_AUTOSTART: tickerAutostart ? 'true' : 'false',
      NODE_COUNT: String(nodes),
    })
    .withBindMounts([{
      source: fixturesDir,
      target: '/fixtures',
      mode: 'ro',
    }])
    .withWaitStrategy(new HttpPollWaitStrategy(`http://${DAEMON_IP}:18232/state`))
    .withHealthCheck({
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:18232/state', r => { r.on('data', () => {}); r.statusCode === 200 ? process.exit(0) : process.exit(1) })"],
      interval: 3000,
      timeout: 2000,
      retries: 10,
    })
    .start();
  started.push(daemonStub);
  containers.daemonStub = daemonStub;

  // Render the deterministic node list for this run: identity from the committed
  // fixture, addresses from subnet-config (the single source of truth for node IPs).
  // POST before any node boots; /set-node-list also resets the stub's restore/reset
  // baseline. A no-op-equivalent when base === '198.18'.
  const runNodeList = deterministicNodes(nodes);
  await fetch(`http://${DAEMON_IP}:18232/set-node-list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes: runNodeList }),
  });

  for (const [ip, status] of Object.entries(nodeStatusOverrides)) {
    await fetch(`http://${DAEMON_IP}:18232/node-status/${ip}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  }

  for (const ip of rpcFailures) {
    await fetch(`http://${DAEMON_IP}:18232/rpc-fail/${ip}`, { method: 'POST' });
  }

  if (nodeTiers) {
    for (const [index, tier] of Object.entries(nodeTiers)) {
      const ip = subnet.nodeIp(Number(index) + 1);
      await fetch(`http://${DAEMON_IP}:18232/node-tier/${ip}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
    }
  }

  const syncthingStub = await new StaticIpContainer('flux-e2e-syncthing-stub')
    .withStaticIp(networkName, SYNCTHING_IP)
    .withEnvironment({ SYNCTHING_PORT: '8384', CONTROL_PORT: '8385' })
    .withWaitStrategy(new HttpPollWaitStrategy(`http://${SYNCTHING_IP}:8384/rest/noauth/health`))
    .withHealthCheck({
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:8384/rest/noauth/health', r => { r.on('data', () => {}); r.statusCode === 200 ? process.exit(0) : process.exit(1) })"],
      interval: 3000,
      timeout: 2000,
      retries: 10,
    })
    .start();
  started.push(syncthingStub);
  containers.syncthingStub = syncthingStub;

  const externalStub = await new StaticIpContainer('flux-e2e-external-http-stub')
    .withStaticIp(networkName, EXTERNAL_STUB_IP)
    .withEnvironment({ STUB_PORT: '3000', CONTROL_PORT: '3001' })
    .withWaitStrategy(new HttpPollWaitStrategy(`http://${EXTERNAL_STUB_IP}:3001/health`))
    .withHealthCheck({
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:3001/health', r => { r.on('data', () => {}); r.statusCode === 200 ? process.exit(0) : process.exit(1) })"],
      interval: 3000,
      timeout: 2000,
      retries: 10,
    })
    .start();
  started.push(externalStub);
  containers.externalStub = externalStub;

  const fdmStub = await new StaticIpContainer('flux-e2e-fdm-stub')
    .withStaticIp(networkName, FDM_IP)
    .withEnvironment({ FDM_PORT: '16130', CONTROL_PORT: '16131' })
    .withWaitStrategy(new HttpPollWaitStrategy(`http://${FDM_IP}:16131/health`))
    .withHealthCheck({
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:16131/health', r => { r.on('data', () => {}); r.statusCode === 200 ? process.exit(0) : process.exit(1) })"],
      interval: 3000,
      timeout: 2000,
      retries: 10,
    })
    .start();
  started.push(fdmStub);
  containers.fdmStub = fdmStub;

  const fluxDriveStub = await new StaticIpContainer('flux-e2e-fluxdrive-stub')
    .withStaticIp(networkName, FLUXDRIVE_IP)
    .withEnvironment({ FLUXDRIVE_PORT: '16140', CONTROL_PORT: '16141' })
    .withWaitStrategy(new HttpPollWaitStrategy(`http://${FLUXDRIVE_IP}:16141/health`))
    .withHealthCheck({
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:16141/health', r => { r.on('data', () => {}); r.statusCode === 200 ? process.exit(0) : process.exit(1) })"],
      interval: 3000,
      timeout: 2000,
      retries: 10,
    })
    .start();
  started.push(fluxDriveStub);
  containers.fluxDriveStub = fluxDriveStub;

  if (!dataCenter) {
    for (let i = 1; i <= nodes; i++) {
      await fetch(`http://${EXTERNAL_STUB_IP}:3001/geolocation/${subnet.nodeIp(i)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosting: false }),
      });
    }
  }

  const registryTlsDir = join(fixturesDir, 'registry-tls');
  // The registry is reached by a stable network alias (fluxregistry.test), not its IP:
  // node dockerd pulls fluxregistry.test:5000/... and TLS verifies DNS:fluxregistry.test, so
  // the registry works under any subnet base without regenerating the cert.
  const registry = await new StaticIpContainer('registry:2')
    .withStaticIp(networkName, REGISTRY_IP, [REGISTRY_ALIAS])
    .withBindMounts([{
      source: registryTlsDir,
      target: '/certs',
      mode: 'ro',
    }])
    .withEnvironment({
      REGISTRY_HTTP_ADDR: '0.0.0.0:5000',
      REGISTRY_HTTP_TLS_CERTIFICATE: '/certs/server-cert.pem',
      REGISTRY_HTTP_TLS_KEY: '/certs/server-key.pem',
    })
    .withWaitStrategy(Wait.forLogMessage(/listening on/))
    .start();
  started.push(registry);
  containers.registry = registry;

  // Seed the default spec image so every env's registry can satisfy
  // registration verification and installs for buildAppSpec/buildSeedableApp
  // defaults BY CONSTRUCTION - no per-suite push incantation. The image is
  // synthesized in memory (static pause binary + marker; see registry-helper),
  // so this costs milliseconds and never contacts Docker Hub.
  await pushImage('e2e-pause', 'v1');

  const rtClient = await getContainerRuntimeClient();
  const { getReaper: getReaperFn } = await import('testcontainers');
  const reaper = await getReaperFn(rtClient);
  for (let i = 0; i < nodes; i++) {
    const volName = `${networkName}-node${i}`;
    await rtClient.container.dockerode.createVolume({
      Name: volName,
      Labels: { 'org.testcontainers.session-id': reaper.sessionId, ...runLabels() },
    });
    volumeNames.push(volName);
  }

  const deferredBuilders = new Map();
  const firstDeferred = nodes - deferredNodes;

  for (let i = 0; i < nodes; i++) {
    if (stubPeerSet.has(i)) continue;

    const num = String(i + 1).padStart(2, '0');
    const nodeIp = subnet.nodeIp(i + 1);
    const nodeManifest = manifest.nodes[i];

    const logCollector = createLogCollector();
    const bootIdDir = join(tmpdir(), `flux-bootid-${networkName}-${num}`);
    mkdirSync(bootIdDir, { recursive: true });
    writeFileSync(join(bootIdDir, 'boot-id'), getBootId(i + 1));
    const fluxdConfDir = join(tmpdir(), `flux-fluxd-conf-${networkName}-${num}`);
    mkdirSync(fluxdConfDir, { recursive: true });
    // Own-status is about the receiver, so a fleet that wants it reads from its own
    // socket rather than the shared one every node hears.
    const nodeZmqPort = perNodeZmq ? zmqNodePort(i + 1) : 16123;
    const fluxdConf = renderFluxdConf(num, nodeZmqTopics[i] ?? zmqTopics, fluxdConfDir, nodeZmqPort);
    const bindMounts = [
      { source: volumeNames[i], target: '/mnt/appdata' },
      { source: join(fixturesDir, 'registry-tls', 'ca.pem'), target: '/usr/local/share/ca-certificates/test-registry.crt', mode: 'ro' },
      { source: bootIdDir, target: '/tmp/flux-boot-config' },
      // Over the fixture baked into the image, so FLUXD_CONFIG_PATH is unchanged.
      { source: fluxdConf, target: `/flux/test-infra/fixtures/conf/flux-${num}.conf` },
    ];
    // Real flux-telemetryd (systemd mode only): the pinned daemon build from
    // test-infra/flux-telemetryd/dist (binary + its REAL hardened unit),
    // bind-mounted; the entrypoint installs them and FluxOS starts the unit
    // (production flow). A dist that is missing, or built from anything but the
    // pin, fails here rather than letting a skewed daemon produce runtime
    // mysteries — see the pin check below for why stale is the dangerous case.
    if (telemetrydReal) {
      const distDir = join(__dirname, '..', '..', 'flux-telemetryd', 'dist');
      const overridden = Boolean(process.env.TELEMETRYD_BINARY);
      const distBinary = process.env.TELEMETRYD_BINARY ?? join(distDir, 'flux-telemetryd');
      const distUnit = process.env.TELEMETRYD_UNIT ?? join(distDir, 'flux-telemetryd.service');
      const buildCmd = 'run: bash test-infra/flux-telemetryd/build.sh';
      if (!existsSync(distBinary) || !existsSync(distUnit)) {
        throw new Error(`telemetrydReal: ${distBinary} missing — ${buildCmd}`);
      }
      // A stale dist is worse than a missing one: the suite runs, the daemon
      // behaves like whatever it was built from, and a test written for a fix the
      // binary does not carry passes anyway — proving nothing while reading green.
      // Skipped when TELEMETRYD_BINARY names a binary explicitly: .built-ref
      // describes the dist build, not an override, so comparing it there would
      // block the deliberate case (running a chosen build to check a test can
      // actually fail).
      if (!overridden) {
        const pin = readFileSync(join(__dirname, '..', '..', 'flux-telemetryd', 'pin'), 'utf-8').trim();
        const builtRef = existsSync(join(distDir, '.built-ref'))
          ? readFileSync(join(distDir, '.built-ref'), 'utf-8').trim()
          : '(none)';
        if (builtRef !== pin) {
          throw new Error(`telemetrydReal: dist built from ${builtRef}, pin is ${pin} — ${buildCmd}`);
        }
      }
      bindMounts.push(
        { source: distBinary, target: '/opt/telemetryd-dist/flux-telemetryd', mode: 'ro' },
        { source: distUnit, target: '/opt/telemetryd-dist/flux-telemetryd.service', mode: 'ro' },
      );
    }
    // Real flux-dnsd (systemd mode only): the pinned resolver build from
    // test-infra/flux-dnsd/dist (binary + its REAL hardened unit),
    // bind-mounted; the entrypoint installs them and — matching the OS —
    // enables the unit at boot. Same pin discipline as telemetrydReal.
    if (dnsdReal) {
      const distDir = join(__dirname, '..', '..', 'flux-dnsd', 'dist');
      const overridden = Boolean(process.env.DNSD_BINARY);
      const distBinary = process.env.DNSD_BINARY ?? join(distDir, 'flux-dnsd');
      const distUnit = process.env.DNSD_UNIT ?? join(distDir, 'flux-dnsd.service');
      const buildCmd = 'run: bash test-infra/flux-dnsd/build.sh';
      if (!existsSync(distBinary) || !existsSync(distUnit)) {
        throw new Error(`dnsdReal: ${distBinary} missing — ${buildCmd}`);
      }
      if (!overridden) {
        const pin = readFileSync(join(__dirname, '..', '..', 'flux-dnsd', 'pin'), 'utf-8').trim();
        const builtRef = existsSync(join(distDir, '.built-ref'))
          ? readFileSync(join(distDir, '.built-ref'), 'utf-8').trim()
          : '(none)';
        if (builtRef !== pin) {
          throw new Error(`dnsdReal: dist built from ${builtRef}, pin is ${pin} — ${buildCmd}`);
        }
      }
      bindMounts.push(
        { source: distBinary, target: '/opt/dnsd-dist/flux-dnsd', mode: 'ro' },
        { source: distUnit, target: '/opt/dnsd-dist/flux-dnsd.service', mode: 'ro' },
      );
    }
    // Real flux-shutdownd: the pinned build from test-infra/flux-shutdownd/dist
    // replaces the mock in-container. It runs under the default entrypoint
    // rather than as a systemd unit — its paths are env-configurable and its
    // readiness notify is best-effort — but it must live in the node container,
    // since each node is DinD and the app containers it drains are inside.
    // A dist that does not match the pin fails here, not as a runtime mystery.
    if (shutdowndReal) {
      const distDir = join(__dirname, '..', '..', 'flux-shutdownd', 'dist');
      const distBinary = process.env.SHUTDOWND_BINARY ?? join(distDir, 'flux-shutdownd');
      const distCtl = process.env.SHUTDOWNCTL_BINARY ?? join(distDir, 'shutdownctl');
      const distDbus = join(distDir, 'io.runonflux.Shutdownd.conf');
      const buildCmd = 'run: bash test-infra/flux-shutdownd/build.sh';
      if (!existsSync(distBinary) || !existsSync(distCtl) || !existsSync(distDbus)) {
        throw new Error(`shutdowndReal: ${distDir} incomplete — ${buildCmd}`);
      }
      const pinPath = join(__dirname, '..', '..', 'flux-shutdownd', 'pin');
      const pin = readFileSync(pinPath, 'utf-8').trim();
      const builtRef = existsSync(join(distDir, '.built-ref'))
        ? readFileSync(join(distDir, '.built-ref'), 'utf-8').trim()
        : '(none)';
      if (builtRef !== pin) {
        throw new Error(`shutdowndReal: dist built from ${builtRef}, pin is ${pin} — ${buildCmd}`);
      }
      bindMounts.push(
        { source: distBinary, target: '/opt/shutdownd-dist/flux-shutdownd', mode: 'ro' },
        { source: distCtl, target: '/opt/shutdownd-dist/shutdownctl', mode: 'ro' },
        { source: distDbus, target: '/opt/shutdownd-dist/io.runonflux.Shutdownd.conf', mode: 'ro' },
      );
    }
    const isLegacy = legacyNodes.includes(i);
    const nodeEnv = {
      NODE_CONFIG_DIR: `/flux/test-infra/config/node-${num}`,
      FLUXD_PATH: '/dat/var/lib/fluxd',
      FLUXD_CONFIG_PATH: `/flux/test-infra/fixtures/conf/flux-${num}.conf`,
      SYNCTHING_PATH: '/dat/usr/lib/syncthing',
      FLUXBENCH_PATH: '/dat/usr/lib/fluxbenchd',
      FLUX_WATCHDOG_PATH: '/dat/usr/lib/fluxwatchdog',
      FLUX_APPS_FOLDER: '/mnt/appdata/flux-apps',
      FLUX_NODE_IP: nodeIp,
      FLUX_ADMIN_ZELID: nodeManifest.zelid,
      FLUX_API_PORT: '16127',
      FLUX_SYNCTHING_HOST: SYNCTHING_IP,
      FLUX_SYNCTHING_PORT: '8384',
      NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/test-registry.crt',
    };
    if (!isLegacy) nodeEnv.FLUXOS_PATH = '/flux';
    // Arcane is the harness default: resolveNodeCapability gates the verdict on
    // FLUX_ARCANE_NODE + an 'arcane' getnodetype (the daemon stub answers arcane).
    // A suite that tests legacy behavior opts out with arcane:false, or per-node
    // via legacyNodes.
    if (arcane && !isLegacy) nodeEnv.FLUX_ARCANE_NODE = 'true';
    // The mock flux-shutdownd pairs with the arcane default: a real arcane node
    // always has the daemon, so arcane-without-socket is the unreal state (stops
    // would degrade through the unreachable fallback instead of draining). The
    // mock runs in-container and its begin_app_stop performs the actual docker
    // stop, mirroring the daemon's production role.
    // The real daemon takes the mock's place rather than joining it: both bind
    // the same socket, so running the pair would race for it.
    if (shutdowndMock && !shutdowndReal && !isLegacy) nodeEnv.FLUX_SHUTDOWND_MOCK = 'true';
    if (shutdowndReal && !isLegacy) nodeEnv.FLUX_SHUTDOWND_REAL = 'true';
    // The mock flux-telemetryd is the CLIENT of FluxOS's identity socket (the
    // inverse of shutdownd's direction). Opt-in: only the telemetry suites pay
    // for the identity server + stub; the entrypoint also creates the
    // /run/flux/telemetry runtime dir the identity server's Arcane write-probe
    // demands.
    if (telemetrydMock && !isLegacy) nodeEnv.FLUX_TELEMETRYD_MOCK = 'true';
    // systemd mode (the journald-logging suite): the entrypoint execs a real
    // systemd as PID 1 — dockerd and fluxos run as units, fluxos's stdout is
    // journal-connected (JOURNAL_STREAM set, the Arcane sink mode) and
    // journalctl serves the admin log endpoints. Env-level and uniform across
    // the fleet. The default-entrypoint levers (restartFluxos, pauseDockerd,
    // the shutdownd/telemetryd mocks) do not exist under systemd; suites
    // using them must stay in the default mode.
    if (systemdMode) nodeEnv.FLUX_SYSTEMD_MODE = 'true';
    if (telemetrydReal) nodeEnv.FLUX_TELEMETRYD_REAL = 'true';
    if (dnsdReal) nodeEnv.FLUX_DNSD_REAL = 'true';
    if (discoveryAutostart) nodeEnv.FLUX_DISCOVERY_AUTOSTART = 'true';
    // Point the node's config at the base-derived infra IPs. The mounted config
    // files (shared.js / node-NN) carry the default 198.18 addresses; NODE_CONFIG
    // is deep-merged over them by the `config` package, so under a non-default base
    // these overrides take effect (and are a no-op when base === '198.18'). Explicit
    // test overrides still win (merged on top of this).
    const infraOverride = {
      database: { url: MONGO_IP },
      daemon: perNodeZmq ? { host: DAEMON_IP, zmqport: nodeZmqPort } : { host: DAEMON_IP },
      benchmark: { host: DAEMON_IP },
      syncthing: { ip: SYNCTHING_IP },
      github: { apiBaseUrl: `http://${EXTERNAL_STUB_IP}:3000` },
      policy: { baseUrl: `http://${EXTERNAL_STUB_IP}:3000/helpers` },
      geolocation: { ipApiBaseUrl: `http://${EXTERNAL_STUB_IP}:3000`, statsApiBaseUrl: `http://${EXTERNAL_STUB_IP}:3000` },
      stats: { apiBaseUrl: `http://${EXTERNAL_STUB_IP}:3000` },
      fiatRates: { ratesUrl: `http://${EXTERNAL_STUB_IP}:3000/rates` },
      // Install-trial timings scaled to harness cadence: prod proves a probe-less
      // first run at 60s / retries at 10s, which would drag every suite's install
      // converge. Thresholds only - the trial's shape is unchanged.
      fluxapps: { firstRunProofMs: 5000, convergeRetryMs: 2000 },
      // One stub serves every region/index (%i-free template leaves the URL as-is).
      fdm: { regions: [{ name: 'STUB', baseUrlTemplate: `http://${FDM_IP}:16130` }] },
      fluxDrive: { blobApiUrl: `http://${FLUXDRIVE_IP}:16140` },
    };
    const nodeConfig = mergeConfigs(infraOverride, mergeConfigs(configOverrides, nodeConfigOverrides[i]));
    nodeEnv.NODE_CONFIG = JSON.stringify(nodeConfig);

    // Wait on an HTTP poll of the node's own API, not Docker's health state
    // machine: under a contended 10-node fleet boot, Wait.forHealthCheck() tears
    // the fleet down on a transient "unhealthy" even when FluxOS is up. See
    // http-wait-strategy.js for the full rationale.
    // Mixed-version fleets: an oldNodes index boots the pre-grant-plane image.
    // Its baked flux-spec is historic by design (the vendor guard checks only
    // the default image).
    const builder = new StaticIpContainer(oldNodes.includes(i) ? OLD_NODE_IMAGE : NODE_IMAGE)
      .withPrivilegedMode()
      .withStaticIp(networkName, nodeIp)
      .withBindMounts(bindMounts)
      .withLogConsumer(logCollector)
      .withEnvironment(nodeEnv)
      .withWaitStrategy(nodeReadyWaitStrategy(nodeIp).withStartupTimeout(120000));
    if (systemdMode) builder.withStopSignal('SIGRTMIN+3');

    nodeConfigs.push({
      index: i, builder, ip: nodeIp, num: i + 1, logCollector, bootIdDir, fluxdConfDir,
    });
  }

  const startPromises = nodeConfigs
    .filter((n) => n.index < firstDeferred)
    .map(async (n) => {
      const container = await n.builder.start();
      started.push(container);
      return { ...n, container };
    });

  const startedNodes = await Promise.all(startPromises);
  const startedByIndex = new Map(startedNodes.map((n) => [n.index, n]));

  for (const stubIdx of stubPeers) {
    const nodeIp = subnet.nodeIp(stubIdx + 1);
    const key = nodeKey(stubIdx + 1);

    const stub = await new StaticIpContainer('flux-e2e-peer-stub')
      .withStaticIp(networkName, nodeIp)
      .withEnvironment({
        FLUX_TEST_HARNESS: 'true',
        WS_PORT: '16127',
        CONTROL_PORT: '16128',
        PRIVATE_KEY: key.privkey,
        PUBLIC_KEY: key.pubkey,
        NODE_IP: nodeIp,
      })
      .withWaitStrategy(new HttpPollWaitStrategy(`http://${nodeIp}:16128/health`))
      .withHealthCheck({
        test: ['CMD', 'node', '-e', "require('http').get('http://localhost:16128/health', r => { r.on('data', () => {}); r.statusCode === 200 ? process.exit(0) : process.exit(1) })"],
        interval: 3000,
        timeout: 2000,
        retries: 10,
      })
      .start();
    started.push(stub);
    stubPeerClientsMap.set(stubIdx, stubPeerClient(nodeIp));
  }

  const fluxNodesByIndex = new Map(nodeConfigs.map((n) => [n.index, n]));
  const fluxNodes = [];
  for (let i = 0; i < nodes; i++) {
    const cfg = fluxNodesByIndex.get(i);
    if (!cfg) {
      fluxNodes.push({ container: null, ip: subnet.nodeIp(i + 1), num: i + 1, logCollector: null, bootIdDir: null });
      continue;
    }
    const s = startedByIndex.get(i);
    if (s) {
      fluxNodes.push({ container: s.container, ip: cfg.ip, num: cfg.num, logCollector: cfg.logCollector, bootIdDir: cfg.bootIdDir });
    } else {
      deferredBuilders.set(i, cfg.builder);
      fluxNodes.push({ container: null, ip: cfg.ip, num: cfg.num, logCollector: cfg.logCollector, bootIdDir: cfg.bootIdDir });
    }
  }
  containers.fluxNodes = fluxNodes;

  for (const n of fluxNodes) {
    if (!n.container) {
      clients.push(null);
      continue;
    }
    const client = nodeClient(n.num);
    client.container = n.container;
    clients.push(client);
  }

  for (const client of clients) {
    if (client) await client.connectEventStream();
  }

  // Boot is NOT complete when the nodes answer HTTP: FluxOS still runs its
  // internal boot (mongo collection prep → daemon poll loop), and that is the
  // phase that actually crawls under fleet contention (both observed
  // daemon:polled gate failures — suites 22 and 01 — died there, post-HTTP).
  // Wait for each node's first daemon:polled here so the boot semaphore in
  // createTestEnv covers the whole boot, releasing only when the fleet is
  // operational. Exempt only nodes whose daemon RPC is deliberately broken at
  // creation (rpcFailures — they can never reach polling; their suites assert
  // the timeout path). Legacy nodes are NOT exempt: they run the same image
  // and emit daemon:polled (suite 21's waitForDaemonReady has always passed on
  // them) — an earlier exemption left all-legacy fleets booting outside the
  // lock and suite 21 failed on exactly the contention this wait prevents.
  const rpcFailSet = new Set(rpcFailures);
  await Promise.all(clients
    .filter((c) => c && !rpcFailSet.has(c.ip))
    .map((c) => c.waitForEvent('daemon:polled', () => true, 90000)));

  // In systemd mode the container's stdout is systemd's console and FluxOS's
  // own stream is journal-connected — that connection is the mechanism under
  // test (it sets JOURNAL_STREAM, which selects the journald sink), so the log
  // collectors legitimately receive nothing from FluxOS. Answering "no match"
  // would leave every assertion built on these silently unfalsifiable, so
  // refuse and name the replacement.
  const assertCollectorSeesFluxos = (fn) => {
    if (!systemdMode) return;
    throw new Error(
      `${fn}() cannot see FluxOS logs in systemd mode: its stdout is journal-connected, `
      + 'not the container stream. Read the journal instead — journalGrep(container, '
      + "'fluxos', pattern, { processOnly: true }) from framework/systemd-control.js",
    );
  };

  // Post-boot methods join the shell here (they close over _buildEnv locals like
  // deferredBuilders/fluxNodes); identity, registries and teardown live on the
  // shell itself so they exist from boot start.
  Object.assign(env, {
    daemonControl: `http://${DAEMON_IP}:18232`,
    stubControl: `http://${EXTERNAL_STUB_IP}:3001`,
    fdmControl: `http://${FDM_IP}:16131`,
    syncthingControl: `http://${SYNCTHING_IP}:8385`,
    registryUrl: `https://${REGISTRY_IP}:5000`,
    mongoUrl: `mongodb://${MONGO_IP}:27017`,

    async startNode(index) {
      const builder = deferredBuilders.get(index);
      if (!builder) throw new Error(`No deferred builder for node index ${index}`);
      const container = await builder.start();
      started.push(container);
      fluxNodes[index].container = container;
      const client = nodeClient(fluxNodes[index].num);
      client.container = container;
      await client.connectEventStream();
      clients[index] = client;
      deferredBuilders.delete(index);
      return client;
    },

    // Wait on an HTTP poll of the node's API rather than Docker's health state
    // machine: on restart Docker transiently reports "unhealthy" during monitor
    // teardown (moby/daemon/container/health.go CloseMonitorChannel), which a
    // health-coupled wait strategy would mistake for a dead container. This is
    // the same serve-auth readiness the initial fleet build uses.
    async restartNode(index, { timeout = 15000 } = {}) {
      if (clients[index]) clients[index].disconnectEventStream();
      const { container } = fluxNodes[index];
      const { waitStrategy: saved } = container;
      container.waitStrategy = nodeReadyWaitStrategy(fluxNodes[index].ip);
      try {
        await container.restart({ timeout });
      } finally {
        container.waitStrategy = saved;
      }
      if (clients[index]) await clients[index].connectEventStream();
      return clients[index];
    },

    setBootId(index, bootId) {
      writeFileSync(join(fluxNodes[index].bootIdDir, 'boot-id'), bootId);
    },

    async disconnectNode(index) {
      const rtClient = await getContainerRuntimeClient();
      const network = rtClient.container.dockerode.getNetwork(networkName);
      const containerId = fluxNodes[index].container.getId();
      await network.disconnect({ Container: containerId });
      if (clients[index]) clients[index].disconnectEventStream();
    },

    async reconnectNode(index) {
      const rtClient = await getContainerRuntimeClient();
      const network = rtClient.container.dockerode.getNetwork(networkName);
      const containerId = fluxNodes[index].container.getId();
      const nodeIp = fluxNodes[index].ip;
      await network.connect({
        Container: containerId,
        EndpointConfig: { IPAMConfig: { IPv4Address: nodeIp } },
      });
      if (clients[index]) await clients[index].connectEventStream();
    },

    // Split the fleet into two groups that stay internally connected but cannot reach
    // each other, by dropping cross-group node-to-node packets inside each container
    // (iptables; the image ships it and the nodes run privileged). Every node keeps its
    // path to the daemon and to its same-group peers. A node held in the minority
    // therefore stays daemon-confirmed (message capability intact) and above the peer
    // floor, so it never degrades or resyncs: the "partial partition, stays above the
    // floor, misses the fire-once gossip" case the steady-state backstop exists for. The
    // host runner reaches nodes over the gateway, not a node IP, so its REST/SSE access
    // to BOTH sides is unaffected — the minority is observable throughout.
    //
    // Returns only once the partition is REAL, which is a stronger guarantee than the
    // rules alone give. iptables stops packets, but TCP retransmits across a DROP: the
    // cross-group sockets stay up until ping/pong liveness gives up, and until then a
    // message sent to the other group is QUEUED, not lost — healPartition then delivers
    // the whole backlog. A suite whose premise is "this node missed the gossip" gets the
    // opposite of what it asked for, and finds out much later as an unrelated-looking
    // timeout (suite 511, 2026-07-30: the isolated node received the update it was
    // supposed to have missed, seconds after the heal, and the assertion that waited for
    // it to converge by reconcile could never fire because it had nothing left to fetch).
    //
    // So wait for both sides to actually drop the other group from their peer lists, and
    // fail HERE, naming who is still connected. How long that takes is peer liveness —
    // peers.wsPingIntervalMs x peers.wsMaxMissedPongs, 45s on production defaults — so a
    // suite that partitions should compress the interval in its configOverrides the same
    // way it compresses every other cadence. Pass { awaitSever: false } for a caller that
    // only wants packets dropped and is not asserting message loss.
    async partitionGroups(groupA, groupB, { awaitSever = true, severTimeoutMs = 60000 } = {}) {
      const ops = [];
      for (const a of groupA) {
        for (const b of groupB) {
          ops.push([a, fluxNodes[b].ip]);
          ops.push([b, fluxNodes[a].ip]);
        }
      }
      await Promise.all(ops.map(async ([node, otherIp]) => {
        const res = await fluxNodes[node].container.exec(['sh', '-c', `iptables -I INPUT -s ${otherIp} -j DROP`]);
        if (res.exitCode !== 0) {
          throw new Error(`partitionGroups: drop on node ${node} for ${otherIp} failed (exit ${res.exitCode}): ${res.output}`);
        }
      }));
      if (!awaitSever) return;

      // Each node paired with the cross-group IPs that must disappear from its peers.
      const crossGroup = [
        ...groupA.map((a) => [a, groupB.map((b) => fluxNodes[b].ip)]),
        ...groupB.map((b) => [b, groupA.map((a) => fluxNodes[a].ip)]),
      ];
      const stillConnected = async () => {
        const held = await Promise.all(crossGroup.map(async ([node, ips]) => {
          const client = clients[node];
          if (!client) return [];
          const [outbound, inbound] = await Promise.all([client.getPeers(), client.getIncomingPeers()]);
          const peers = new Set([...(outbound.data || []), ...(inbound.data || [])]);
          return ips.filter((ip) => peers.has(ip)).map((ip) => `node ${node} -> ${ip}`);
        }));
        return held.flat();
      };

      let remaining = await stillConnected();
      const deadline = Date.now() + severTimeoutMs;
      while (remaining.length > 0 && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
        // eslint-disable-next-line no-await-in-loop
        remaining = await stillConnected();
      }
      if (remaining.length > 0) {
        throw new Error(
          `partitionGroups: sockets survived the partition after ${severTimeoutMs}ms (${remaining.join(', ')}). `
          + 'Messages sent now would be queued and delivered on heal, not lost. Compress '
          + 'peers.wsPingIntervalMs in the suite configOverrides, or raise severTimeoutMs.',
        );
      }
    },

    // Remove the cross-group drops added by partitionGroups(groupA, groupB). Per-rule
    // best-effort (a rule already gone is not an error); the caller re-runs discovery so
    // the dead cross-group sockets get re-dialed.
    async healPartition(groupA, groupB) {
      const ops = [];
      for (const a of groupA) {
        for (const b of groupB) {
          ops.push([a, fluxNodes[b].ip]);
          ops.push([b, fluxNodes[a].ip]);
        }
      }
      await Promise.all(ops.map(([node, otherIp]) => fluxNodes[node].container.exec(
        ['sh', '-c', `iptables -D INPUT -s ${otherIp} -j DROP || true`],
      )));
    },

    async startDiscovery(indices = null) {
      const teamKey = fluxTeamKey();
      const targets = indices
        ? indices.map((i) => clients[i]).filter(Boolean)
        : clients.filter(Boolean);
      await Promise.all(targets.map(async (client) => {
        const auth = await authenticate(client.url, teamKey);
        await client.getAuthed('/flux/startdiscovery', auth.zelidauth);
      }));
    },

    nodeHasLog(index, pattern) {
      assertCollectorSeesFluxos('nodeHasLog');
      return fluxNodes[index].logCollector.hasLine(pattern);
    },

    nodeLogCount(index, pattern) {
      assertCollectorSeesFluxos('nodeLogCount');
      return fluxNodes[index].logCollector.countPattern(pattern);
    },

    nodeLogLines(index) {
      assertCollectorSeesFluxos('nodeLogLines');
      return fluxNodes[index].logCollector.getLines();
    },
  });
}
