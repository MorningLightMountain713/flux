'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const log = require('../lib/log');
const dockerService = require('./dockerService');
const dockerEventStream = require('./utils/dockerEventStream');
const serviceHelper = require('./serviceHelper');
const geolocationService = require('./geolocationService');
const telemetrySinkCache = require('./telemetrySinkCache');
const telemetryConfigService = require('./telemetryConfigService');
const { getSpecBackend } = require('./utils/specLibs');

const SOCKET_DIR = '/run/flux/telemetry';
const SOCKET_PATH = path.join(SOCKET_DIR, 'identity.sock');

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

// flux-telemetryd reads each container's json-log via POSIX ACLs we set at
// announce time. ArcaneOS sets the Docker data-root to /dat/var/lib/docker.
const TELEMETRY_USER = 'flux-telemetry';
const DOCKER_ROOT = '/dat/var/lib/docker';
const DOCKER_CONTAINERS = `${DOCKER_ROOT}/containers`;

const TAG_ALLOWLIST = new Set([
  'region',
  'component',
  'image_name',
  'container_name',
]);

// The unix-socket server, and the set of connected daemon sockets we push to.
let server = null;
const sockets = new Set();

// Resolved OTLP collector addresses, keyed by the COLLECTOR's identity
// (`<collectorAppKey>/<componentLower>`) rather than the consumer app — one
// shared collector in a shareWith-linked app serves every consumer that
// routes to it. The cached sink names the collector; the daemon needs a
// concrete node-local endpoint, built per consumer as
// `http://<collectorIp>:<consumer sink port>`. The IP is resolved from the
// collector container's address on its own app's Docker network (static
// from `docker create`, host-routable) and refreshed whenever that
// container is announced — a recreate with a new IP re-resolves here and
// the resync makes the daemon rotate every consumer's exporter.
const collectorIps = new Map();

/** The collectorIps key a consumer's otlp sink routes to. */
function collectorKey(consumerAppName, sink) {
  const hostApp = sink.app !== undefined ? sink.app : consumerAppName;
  return `${String(hostApp).toLowerCase()}/${String(sink.component).toLowerCase()}`;
}

// Docker event subscription state (container start/die -> announce/stop).
let eventStream = null;
let stopped = false;

function parseContainerName(name) {
  if (!name) return null;

  const parts = name.split('_');
  if (parts.length >= 2 && parts[0] && parts[1]) {
    // Container names are flux<component>_<app>[_<replica>]; no segment may
    // contain '_', so the app is always [1]. The tag carries the spec
    // component name, so strip the docker prefix (container_name keeps it).
    let componentName = parts[0];
    if (componentName.startsWith('flux')) componentName = componentName.slice(4);
    return {
      appName: parts[1],
      componentName: componentName || null,
      replica: parts[2] ?? null,
    };
  }

  if (name.startsWith('flux')) {
    return { appName: name.slice(4), componentName: null, replica: null };
  }

  return null;
}

async function nodeRegion() {
  try {
    const geo = await geolocationService.getNodeGeolocation();
    if (geo && geo.continentCode) return geo.continentCode;
  } catch (err) {
    log.warn(`telemetry identity: geolocation unavailable: ${err.message}`);
  }
  return null;
}

/**
 * Project a cached sink into the shape the daemon consumes. Credentialed
 * sinks pass through; an otlp sink becomes `{provider, endpoint}` once the
 * collector's address is resolved, and null before that — the container
 * stays unannounced until the collector's announce triggers the resync.
 * The endpoint pairs the collector's IP with THIS consumer's declared port.
 */
function wireSink(appName, sink) {
  if (sink.provider !== 'otlp') return sink;
  const ip = collectorIps.get(collectorKey(appName, sink));
  return ip ? { provider: 'otlp', endpoint: `http://${ip}:${sink.port}` } : null;
}

/**
 * If ANY cached otlp sink routes to this container as its collector —
 * same-app or via a shareWith link — resolve the container's node-local
 * address from its own app's Docker network and cache it under the
 * collector key. Returns true when the cached address changed — callers
 * resync so every consumer re-announces with the new endpoint.
 */
async function refreshAgentEndpoint(rawName, networks, labels = null) {
  if (!rawName) return false;
  const dockerName = rawName.startsWith('/') ? rawName.slice(1) : rawName;
  const parsed = parseContainerName(dockerName);
  if (!parsed || !parsed.componentName) return false;

  // The collector key is in the APP NAME domain - a sink names the app hosting its
  // collector, and a spec can only ever name one, since the identity is minted at
  // registration. The container name carries the IDENTITY in that position, so the
  // key has to come off the label; keyed from the name segment it matches no cached
  // sink at all and every otlp consumer stays unannounced. A container predating the
  // labels has no identity either, so its segment IS its app name.
  const { LABEL_KEYS, readLabel } = await getSpecBackend();
  const appName = readLabel(labels, LABEL_KEYS.APP) ?? parsed.appName;
  const thisKey = `${String(appName).toLowerCase()}/${parsed.componentName.toLowerCase()}`;
  let referenced = false;
  for (const [consumerKey, sink] of telemetrySinkCache.entries()) {
    if (sink.provider === 'otlp' && collectorKey(consumerKey, sink) === thisKey) {
      referenced = true;
      break;
    }
  }
  if (!referenced) return false;

  // The network IS named from the identity, which is exactly what the container
  // name's middle segment holds - so this one stays on `parsed`, not on the label.
  const nets = networks || {};
  const appNet = nets[`fluxDockerNetwork_${parsed.appName}`];
  const ip = (appNet && appNet.IPAddress)
    || Object.values(nets).map((n) => n && n.IPAddress).find(Boolean);
  if (!ip) return false;

  if (collectorIps.get(thisKey) === ip) return false;
  collectorIps.set(thisKey, ip);
  log.info(`telemetry identity: otlp collector ${thisKey} at ${ip}`);
  return true;
}

/** Drop cached collector addresses no cached sink routes to anymore. */
function pruneOtlpEndpoints() {
  const referenced = new Set();
  for (const [consumerKey, sink] of telemetrySinkCache.entries()) {
    if (sink.provider === 'otlp') referenced.add(collectorKey(consumerKey, sink));
  }
  for (const k of collectorIps.keys()) {
    if (!referenced.has(k)) collectorIps.delete(k);
  }
}

/**
 * True when this component is in its app's otlp send set. Explicit
 * `components` list wins; the default set is every component EXCEPT a
 * same-app collector — a collector ingesting its own log stream can
 * feedback-amplify (each ingested record logs a line, which ships, which…).
 * Inter-app sinks default to all components: the collector lives elsewhere.
 */
function inSendSet(componentName, sink) {
  if (sink.provider !== 'otlp' || !componentName) return true;
  const compLower = componentName.toLowerCase();
  if (sink.components) {
    return sink.components.some((c) => String(c).toLowerCase() === compLower);
  }
  return sink.app !== undefined || compLower !== String(sink.component).toLowerCase();
}

/**
 * Build the identity a telemetry app's container is announced with. Returns
 * null when the container is not a telemetry app (no cached sink), when its
 * component is outside the sink's send set, or when its otlp sink has no
 * resolved endpoint yet — the scoping gate that keeps non-telemetry (and
 * not-yet-routable) containers off the wire entirely.
 */
async function buildIdentity(rawName, image, region, labels = null) {
  if (!rawName) return null;
  const dockerName = rawName.startsWith('/') ? rawName.slice(1) : rawName;
  const parsed = parseContainerName(dockerName);
  if (!parsed) return null;

  // Off the label, for the same reason as the collector key: the sink cache is keyed
  // by the app's NAME, and the container name carries its minted IDENTITY in that
  // position. Read from the name segment, getSink misses for every app that has an
  // identity and the container is never announced at all. `app_name` on the wire is
  // the name too - it is what an operator reads and what the sink was declared under.
  const { LABEL_KEYS, readLabel } = await getSpecBackend();
  const { componentName } = parsed;
  const appName = readLabel(labels, LABEL_KEYS.APP) ?? parsed.appName;
  const cached = telemetrySinkCache.getSink(appName);
  if (!cached) return null;
  if (!inSendSet(componentName, cached)) return null;
  const sink = wireSink(appName, cached);
  if (!sink) return null;

  const tags = {};
  if (componentName) tags.component = componentName;
  if (image) tags.image_name = image;
  tags.container_name = dockerName;
  if (region) tags.region = region;

  return { app_name: appName, tags, sink };
}

async function resolveIdentity(containerId) {
  const inspect = await dockerService.dockerContainerInspect(containerId, { identifierType: 'id' });
  if (!inspect) return null;
  const region = await nodeRegion();
  const image = inspect.Config && inspect.Config.Image;
  return buildIdentity(inspect.Name, image, region, inspect.Config && inspect.Config.Labels);
}

function writeMessage(socket, obj) {
  if (socket.destroyed) return;
  try {
    socket.write(`${JSON.stringify(obj)}\n`);
  } catch (err) {
    log.warn(`telemetry identity: socket write failed: ${err.message}`);
  }
}

function broadcast(obj) {
  for (const socket of sockets) writeMessage(socket, obj);
}

// The wire ops are ensure-verbs naming the daemon's obligation, not lifecycle
// edges: `track` upserts one container's identity (safe to repeat; a changed
// sink IS the rotation signal), `untrack` drops it (unknown id is a no-op),
// and `sync` asserts the authoritative full set (the daemon untracks
// anything absent from it).
function broadcastTrack(containerId, identity) {
  broadcast({ op: 'track', container_id: containerId, identity });
}

function broadcastUntrack(containerId) {
  broadcast({ op: 'untrack', container_id: containerId });
}

/** Send a daemon a full snapshot of every running telemetry-app container. */
async function sendSync(socket) {
  const containers = await dockerService.dockerListContainers(false);
  const region = await nodeRegion();

  // Resolve otlp collector addresses from the live list before building
  // identities, so a sync taken after a fluxos restart (no docker events
  // replayed) routes otlp apps without waiting for a collector event.
  for (const container of containers) {
    const rawName = container.Names && container.Names[0];
    // eslint-disable-next-line no-await-in-loop
    await refreshAgentEndpoint(
      rawName, container.NetworkSettings && container.NetworkSettings.Networks, container.Labels,
    );
  }

  // A consumer whose collector never resolved stays unannounced — say so
  // loudly rather than ship nothing in silence (a typo'd component name and
  // a not-yet-installed linked app both land here).
  for (const [consumerKey, sink] of telemetrySinkCache.entries()) {
    if (sink.provider === 'otlp' && !collectorIps.has(collectorKey(consumerKey, sink))) {
      log.warn(`telemetry identity: otlp collector ${collectorKey(consumerKey, sink)} for app ${consumerKey} is unresolved — its containers stay unannounced`);
    }
  }

  // The sync is an announce like any other, so it owes the same log-access
  // grant. It used to enumerate and send without one, which meant a
  // container first seen on this path — a daemon reconnect, a boot
  // reconcile, or a sink rotation resync — was handed to the daemon with no
  // readable log. The daemon attached, got EACCES, and that container's logs
  // never shipped again. Nothing said so: the grant lives here, the failure
  // surfaced in the daemon, and only at debug level.
  //
  // Granting is idempotent, so re-granting on every sync costs nothing and
  // repairs any container whose original announce was missed.
  const entries = [];
  for (const container of containers) {
    const rawName = container.Names && container.Names[0];
    // eslint-disable-next-line no-await-in-loop
    const identity = await buildIdentity(rawName, container.Image, region, container.Labels);
    if (!identity) continue;
    // eslint-disable-next-line no-await-in-loop
    const granted = await setContainerAcls(container.Id);
    if (!granted) {
      log.error(
        `telemetry identity: refusing to sync ${rawName} — could not grant ${TELEMETRY_USER} `
        + 'read access to its logs; its logs will not ship until this succeeds',
      );
      continue;
    }
    entries.push({ container_id: container.Id, identity });
  }
  writeMessage(socket, { op: 'sync', containers: entries });
}

/** Re-send a full sync to every connected daemon (after a boot reconcile). */
function resyncAll() {
  for (const socket of sockets) {
    sendSync(socket).catch((err) => log.error(`telemetry identity: resync failed: ${err.message}`));
  }
}

// Sinks can appear after boot: the sink cache rebuild races fluxbenchd's
// unseal, and the reconciler re-seeds the cache once decryption succeeds.
// When that happens the daemon must exist and re-sync, or containers that
// started sinkless stay invisible until the next fluxos restart.
let sinkResyncTimer = null;

function scheduleSinkResync() {
  if (stopped || sinkResyncTimer) return;
  sinkResyncTimer = setTimeout(() => {
    sinkResyncTimer = null;
    (async () => {
      pruneOtlpEndpoints();
      if (!telemetrySinkCache.hasAnyTelemetryApps()) return;
      await telemetryConfigService.ensureNode();
      resyncAll();
    })().catch((err) => log.warn(`telemetry identity: sink resync failed: ${err.message}`));
  }, 2000);
}

async function setfacl(params) {
  const result = await serviceHelper.runCommand('setfacl', {
    runAsRoot: true,
    params,
    logError: false,
  });
  if (result.error) {
    log.warn(`telemetry identity: setfacl ${params.join(' ')} failed: ${result.error.message}`);
    return false;
  }
  return true;
}

// The data-root and containers dir grants are set once (they persist); the
// daemon only needs traverse + read-dir there, and read on each json-log.
async function setBaseAcls() {
  const root = await setfacl(['-m', `u:${TELEMETRY_USER}:x`, `${DOCKER_ROOT}/`]);
  const containers = await setfacl(['-m', `u:${TELEMETRY_USER}:rX`, `${DOCKER_CONTAINERS}/`]);
  return root && containers;
}

/**
 * Grant the daemon read access to a container's logs.
 *
 * The DEFAULT ACL is the load-bearing one: announce runs between docker
 * `create` and `start`, so the json-log does not exist yet and the kernel
 * applies the inherited ACL atomically when docker creates it. That is what
 * makes the grant race-free — there is no window in which the file exists
 * unreadable.
 *
 * The file-level grant is therefore only a repair path, for a log that
 * already existed when we got here (a restart, or a container we are
 * re-announcing). Its absence is not a failure.
 *
 * @returns {Promise<boolean>} whether the daemon can now read this container.
 */
async function setContainerAcls(containerId) {
  const dir = `${DOCKER_CONTAINERS}/${containerId}`;
  const user = `u:${TELEMETRY_USER}`;
  const traverse = await setfacl(['-m', `${user}:rX`, dir]);
  const inherit = await setfacl(['-d', '-m', `${user}:r`, dir]);

  const logPath = `${dir}/${containerId}-json.log`;
  const repaired = fs.existsSync(logPath)
    ? await setfacl(['-m', `${user}:r`, logPath])
    : true;

  return traverse && inherit && repaired;
}

/**
 * Set the container's log ACL and push its identity (with sink) to the
 * daemon. Idempotent on the daemon side, so it is safe to call both from the
 * install hook (before start) and from the docker `start` event (restarts).
 * A no-op on non-Arcane nodes (no socket server) and for non-telemetry apps.
 */
async function announce(idOrName, { identifierType = 'name' } = {}) {
  if (!server) return;
  const inspect = await dockerService.dockerContainerInspect(idOrName, { identifierType });
  if (!inspect || !inspect.Id) return;

  // An otlp collector container coming up (or back up with a new IP) is
  // what makes its consumer apps routable — resolve its address and resync
  // so every consumer's containers re-announce with the fresh endpoint.
  const networks = inspect.NetworkSettings && inspect.NetworkSettings.Networks;
  const inspectLabels = inspect.Config && inspect.Config.Labels;
  if (await refreshAgentEndpoint(inspect.Name, networks, inspectLabels)) scheduleSinkResync();

  const region = await nodeRegion();
  const image = inspect.Config && inspect.Config.Image;
  const identity = await buildIdentity(inspect.Name, image, region, inspectLabels);
  if (!identity) return;

  // Announcing a container the daemon cannot read is worse than not
  // announcing it: the daemon attaches, gets EACCES, and the container's
  // logs are silently absent for its whole life. Fail loudly instead and
  // leave it unannounced — the docker `start` event and the next full sync
  // both re-announce, so a transient failure repairs itself.
  const granted = await setContainerAcls(inspect.Id);
  if (!granted) {
    log.error(
      `telemetry identity: refusing to announce ${inspect.Name} — could not grant `
      + `${TELEMETRY_USER} read access to its logs; its logs will not ship until this succeeds`,
    );
    return;
  }
  broadcastTrack(inspect.Id, identity);
}

/**
 * Called from the install path right after the container is created and
 * before it is started, giving the daemon identity + log access before any
 * line is written.
 */
async function onComponentCreated(component) {
  if (!server) return;
  try {
    await announce(component.identifier);
  } catch (err) {
    log.warn(`telemetry identity: announce failed for ${component.identifier}: ${err.message}`);
  }
}

async function handleDockerEvent(event) {
  const action = event.Action || event.status;
  const containerId = (event.Actor && event.Actor.ID) || event.id;
  if (!containerId) return;
  if (action === 'start') {
    // docker events carry the raw container id, not a flux container name
    await announce(containerId, { identifierType: 'id' });
  } else {
    // die / destroy — the daemon untracks; an unknown id is a harmless no-op.
    broadcastUntrack(containerId);
  }
}

async function subscribeEvents() {
  if (!eventStream) {
    eventStream = dockerEventStream.createDockerEventStream({
      label: 'telemetry identity',
      filters: { type: ['container'], event: ['start', 'die', 'destroy'] },
      onEvent: handleDockerEvent,
    });
  }
  await eventStream.start();
}

// Kept for forward-compat: the daemon may issue ad-hoc lookups.
async function handleRequest(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return JSON.stringify({ ok: false, error: 'invalid JSON' });
  }

  if (req.op !== 'lookup') {
    return JSON.stringify({ ok: false, error: `unknown op: ${req.op}` });
  }

  if (!req.container_id || !CONTAINER_ID_RE.test(req.container_id)) {
    return JSON.stringify({ ok: false, error: 'invalid container_id' });
  }

  try {
    const identity = await resolveIdentity(req.container_id);
    return JSON.stringify({ ok: true, identity: identity || null });
  } catch (err) {
    log.error(`telemetry identity lookup failed: ${err.message}`);
    return JSON.stringify({ ok: false, error: 'internal error' });
  }
}

function handleConnection(socket) {
  sockets.add(socket);
  sendSync(socket).catch((err) => log.error(`telemetry identity: initial sync failed: ${err.message}`));

  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');

    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length > 0) {
        handleRequest(line)
          .then((response) => {
            if (response && !socket.destroyed) socket.write(`${response}\n`);
          })
          .catch((err) => {
            log.error(`telemetry identity: unhandled error: ${err.message}`);
          });
      }

      newlineIdx = buffer.indexOf('\n');
    }

    if (buffer.length > 4096) {
      log.warn('telemetry identity: client exceeded line buffer limit, closing');
      socket.destroy();
    }
  });

  socket.on('error', (err) => {
    sockets.delete(socket);
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      log.error(`telemetry identity socket error: ${err.message}`);
    }
  });

  socket.on('close', () => {
    sockets.delete(socket);
  });
}

async function start() {
  if (server) {
    log.warn('telemetry identity server already running');
    return;
  }

  // The runtime dir exists only on Arcane nodes (created by the daemon's
  // package); this write probe is the Arcane gate — non-Arcane nodes no-op.
  try {
    await fs.promises.access(SOCKET_DIR, fs.constants.W_OK);
  } catch (err) {
    log.warn(`telemetry identity: ${SOCKET_DIR} not available (${err.code}), skipping`);
    return;
  }

  try {
    await fs.promises.unlink(SOCKET_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error(`telemetry identity: cannot remove stale socket: ${err.message}`);
      return;
    }
  }

  stopped = false;
  server = net.createServer(handleConnection);

  server.on('error', (err) => {
    log.error(`telemetry identity server error: ${err.message}`);
  });

  await new Promise((resolve, reject) => {
    server.listen(SOCKET_PATH, (err) => {
      if (err) return reject(err);
      return resolve();
    });
  });

  log.info(`telemetry identity server listening on ${SOCKET_PATH}`);

  // The unprivileged daemon must traverse the dir and connect to the socket
  // (connect needs write), so group-own both to flux-telemetry.
  await telemetryConfigService.chownGroup(SOCKET_DIR, '0750');
  await telemetryConfigService.chownGroup(SOCKET_PATH, '0660');

  await setBaseAcls();
  await subscribeEvents();
  telemetrySinkCache.onChange(scheduleSinkResync);
}

async function stop() {
  stopped = true;

  if (sinkResyncTimer) {
    clearTimeout(sinkResyncTimer);
    sinkResyncTimer = null;
  }

  if (eventStream) eventStream.stop();

  for (const socket of sockets) socket.destroy();
  sockets.clear();

  if (!server) return;

  await new Promise((resolve) => {
    server.close(resolve);
  });
  server = null;

  try {
    await fs.promises.unlink(SOCKET_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`telemetry identity: cleanup unlink failed: ${err.message}`);
    }
  }

  log.info('telemetry identity server stopped');
}

module.exports = {
  start,
  stop,
  parseContainerName,
  buildIdentity,
  refreshAgentEndpoint,
  resolveIdentity,
  sendSync,
  handleRequest,
  broadcastTrack,
  broadcastUntrack,
  onComponentCreated,
  resyncAll,
  SOCKET_PATH,
  TAG_ALLOWLIST,
};
