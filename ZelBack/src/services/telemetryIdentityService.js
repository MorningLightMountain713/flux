const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const log = require('../lib/log');
const dockerService = require('./dockerService');
const serviceHelper = require('./serviceHelper');
const geolocationService = require('./geolocationService');
const telemetrySinkCache = require('./telemetrySinkCache');
const telemetryConfigService = require('./telemetryConfigService');

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

// Docker event subscription state (container start/die -> announce/stop).
let eventStream = null;
let stopped = false;

function parseContainerName(name) {
  if (!name) return null;

  const underscoreIdx = name.indexOf('_');
  if (underscoreIdx > 0 && underscoreIdx < name.length - 1) {
    // Container names are flux<component>_<app>; the tag carries the spec
    // component name, so strip the docker prefix (container_name keeps it).
    let componentName = name.slice(0, underscoreIdx);
    if (componentName.startsWith('flux')) componentName = componentName.slice(4);
    const appName = name.slice(underscoreIdx + 1);
    return { appName, componentName: componentName || null };
  }

  if (name.startsWith('flux')) {
    return { appName: name.slice(4), componentName: null };
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
 * Build the identity a telemetry app's container is announced with. Returns
 * null when the container is not a telemetry app (no cached sink) — the
 * scoping gate that keeps non-telemetry containers off the wire entirely.
 */
function buildIdentity(rawName, image, region) {
  if (!rawName) return null;
  const dockerName = rawName.startsWith('/') ? rawName.slice(1) : rawName;
  const parsed = parseContainerName(dockerName);
  if (!parsed) return null;

  const { appName, componentName } = parsed;
  const sink = telemetrySinkCache.getSink(appName);
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
  return buildIdentity(inspect.Name, image, region);
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

function notifyStarted(containerId, identity) {
  broadcast({ op: 'started', container_id: containerId, identity });
}

function notifyStopped(containerId) {
  broadcast({ op: 'stopped', container_id: containerId });
}

/** Send a daemon a full snapshot of every running telemetry-app container. */
async function sendSync(socket) {
  const containers = await dockerService.dockerListContainers(false);
  const region = await nodeRegion();
  const entries = [];
  for (const container of containers) {
    const rawName = container.Names && container.Names[0];
    const identity = buildIdentity(rawName, container.Image, region);
    if (identity) entries.push({ container_id: container.Id, identity });
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
  }
}

// The data-root and containers dir grants are set once (they persist); the
// daemon only needs traverse + read-dir there, and read on each json-log.
async function setBaseAcls() {
  await setfacl(['-m', `u:${TELEMETRY_USER}:x`, `${DOCKER_ROOT}/`]);
  await setfacl(['-m', `u:${TELEMETRY_USER}:rX`, `${DOCKER_CONTAINERS}/`]);
}

async function setContainerAcls(containerId) {
  const dir = `${DOCKER_CONTAINERS}/${containerId}`;
  const user = `u:${TELEMETRY_USER}`;
  // Read the current log file, traverse the dir, and a DEFAULT ACL so the
  // log files Docker creates on rotation inherit read access automatically.
  await setfacl(['-m', `${user}:rX`, dir]);
  await setfacl(['-d', '-m', `${user}:r`, dir]);
  await setfacl(['-m', `${user}:r`, `${dir}/${containerId}-json.log`]);
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

  const region = await nodeRegion();
  const image = inspect.Config && inspect.Config.Image;
  const identity = buildIdentity(inspect.Name, image, region);
  if (!identity) return;

  await setContainerAcls(inspect.Id);
  notifyStarted(inspect.Id, identity);
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
    notifyStopped(containerId);
  }
}

async function subscribeEvents() {
  if (eventStream) return;
  let lineBuf = '';

  try {
    eventStream = await dockerService.dockerGetEvents({
      filters: { type: ['container'], event: ['start', 'die', 'destroy'] },
    });

    eventStream.on('data', (buf) => {
      if (stopped) return;
      lineBuf += buf.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (parseErr) {
          log.error(`telemetry identity: failed to parse docker event: ${parseErr.message}`);
          continue;
        }
        handleDockerEvent(event).catch((err) => {
          log.error(`telemetry identity: event handler error: ${err.message}`);
        });
      }
    });

    eventStream.on('error', (err) => {
      log.error(`telemetry identity: event stream error: ${err.message}`);
      eventStream = null;
      if (!stopped) setTimeout(() => subscribeEvents(), 10000);
    });

    eventStream.on('end', () => {
      log.warn('telemetry identity: event stream ended');
      eventStream = null;
      if (!stopped) setTimeout(() => subscribeEvents(), 10000);
    });

    log.info('telemetry identity: listening for container start/stop events');
  } catch (err) {
    log.error(`telemetry identity: failed to subscribe to docker events: ${err.message}`);
    eventStream = null;
    if (!stopped) setTimeout(() => subscribeEvents(), 10000);
  }
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

  if (eventStream) {
    eventStream.destroy();
    eventStream = null;
  }

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
  resolveIdentity,
  sendSync,
  handleRequest,
  notifyStarted,
  notifyStopped,
  onComponentCreated,
  resyncAll,
  SOCKET_PATH,
  TAG_ALLOWLIST,
};
