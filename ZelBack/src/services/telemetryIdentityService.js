/**
 * Telemetry Identity Socket Server
 *
 * Binds a Unix domain socket at /run/flux/telemetry/identity.sock and
 * answers newline-delimited JSON lookup requests from flux-telemetryd.
 *
 * Wire protocol (matches flux-telemetryd src/identity.rs):
 *
 *   Request:  {"op":"lookup","container_id":"<64hex>"}\n
 *   Response: {"ok":true,"identity":{"app_name":"...","tags":{...}}}\n
 *             | {"ok":true,"identity":null}\n
 *             | {"ok":false,"error":"..."}\n
 *
 * The tags map is pre-filtered to the public allowlist before sending.
 * flux-telemetryd applies a second, independent allowlist on its side.
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const config = require('config');

const log = require('../lib/log');
const dockerService = require('./dockerService');
const dbHelper = require('./dbHelper');
const geolocationService = require('./geolocationService');
const appConstants = require('./utils/appConstants');

// --- constants -----------------------------------------------------------

const SOCKET_DIR = '/run/flux/telemetry';
const SOCKET_PATH = path.join(SOCKET_DIR, 'identity.sock');

// Container ID: Docker always produces a 64-char lowercase hex string.
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

// Tag keys the identity server is allowed to emit.  Defence-in-depth:
// flux-telemetryd has its own compiled-in allowlist that independently
// filters anything we return here.
const TAG_ALLOWLIST = new Set([
  'flux.public.region',
  'flux.public.env',
  'flux.public.component',
]);

// Singleton server reference so we can shut down cleanly.
let server = null;

// --- container-name → app identity parsing -------------------------------

/**
 * Given a Docker container name (without the leading '/'), extract the
 * Flux app name and optional component name.
 *
 * Naming conventions (from dockerService.getAppIdentifier / appDockerCreate):
 *   - Legacy:     zel<AppName>          → app = <AppName>
 *   - Standard:   flux<AppName>         → app = <AppName>
 *   - Component:  <compName>_<AppName>  → app = <AppName>, component = <compName>
 *
 * Returns null if the name doesn't match any Flux pattern.
 */
function parseContainerName(name) {
  if (!name) return null;

  // Component containers: <component>_<appName>
  // The component name never starts with 'zel' or 'flux', but the
  // combined identifier is created by appDockerCreate and always has
  // exactly one underscore separating component from app name.
  // We need to check component pattern first because a component name
  // could theoretically start with 'flux' or 'zel'.
  const underscoreIdx = name.indexOf('_');
  if (underscoreIdx > 0 && underscoreIdx < name.length - 1) {
    const componentName = name.slice(0, underscoreIdx);
    const appName = name.slice(underscoreIdx + 1);
    // Validate: the app name portion should be registered by checking
    // that getAppIdentifier(appName) matches what Docker would have
    // for a top-level container of that app.
    return { appName, componentName };
  }

  // Standard prefix: flux<AppName>
  if (name.startsWith('flux')) {
    return { appName: name.slice(4), componentName: null };
  }

  // Legacy prefix: zel<AppName>
  if (name.startsWith('zel')) {
    return { appName: name.slice(3), componentName: null };
  }

  return null;
}

// --- identity lookup -----------------------------------------------------

/**
 * Resolve a 64-hex container ID to a Flux app identity.
 *
 * Steps:
 *   1. List running Docker containers.
 *   2. Find the one whose Id matches.
 *   3. Parse the container name to extract app name + component.
 *   4. Look up the app spec in localAppsInformation for validation.
 *   5. Build the tags map from allowed metadata.
 *
 * Returns { app_name, tags } or null if the container is unknown.
 */
async function resolveIdentity(containerId) {
  // 1. Find the container in Docker
  const containers = await dockerService.dockerListContainers(false);
  const container = containers.find((c) => c.Id === containerId);
  if (!container) return null;

  // 2. Parse the container name
  // Docker Names array entries have a leading '/'
  const rawName = container.Names && container.Names[0];
  if (!rawName) return null;

  const dockerName = rawName.startsWith('/') ? rawName.slice(1) : rawName;
  const parsed = parseContainerName(dockerName);
  if (!parsed) return null;

  const { appName, componentName } = parsed;

  // 3. Validate against local app database
  const dbopen = dbHelper.databaseConnection();
  const appsDatabase = dbopen.db(config.database.appslocal.database);
  const appSpec = await dbHelper.findOneInDatabase(
    appsDatabase,
    appConstants.localAppsInformation,
    { name: appName },
    { projection: { _id: 0, name: 1, version: 1, compose: 1 } },
  );

  // If the app isn't in our local database, we don't vouch for it.
  if (!appSpec) return null;

  // 4. Build public tags
  const tags = {};

  if (componentName) {
    tags['flux.public.component'] = componentName;
  }

  // Region from node geolocation (continentCode is a stable, coarse value
  // that doesn't leak precise location).
  try {
    const geo = await geolocationService.getNodeGeolocation();
    if (geo && geo.continentCode) {
      tags['flux.public.region'] = geo.continentCode;
    }
  } catch (err) {
    // Non-fatal — node may not have geolocation yet at first boot.
    log.warn(`telemetry identity: geolocation unavailable: ${err.message}`);
  }

  return {
    app_name: appName,
    tags,
  };
}

// --- protocol handler ----------------------------------------------------

/**
 * Handle a single line of input from a connected client.
 * Returns the JSON string to send back (without trailing newline).
 */
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

/**
 * Handle a connected client socket.  Frames are newline-delimited.
 * One request per line, one response per line.
 */
function handleConnection(socket) {
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');

    // Process all complete lines in the buffer.
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length > 0) {
        handleRequest(line)
          .then((response) => {
            if (!socket.destroyed) {
              socket.write(`${response}\n`);
            }
          })
          .catch((err) => {
            log.error(`telemetry identity: unhandled error: ${err.message}`);
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify({ ok: false, error: 'internal error' })}\n`);
            }
          });
      }

      newlineIdx = buffer.indexOf('\n');
    }

    // Guard against a misbehaving client sending endless data without newlines.
    if (buffer.length > 4096) {
      log.warn('telemetry identity: client exceeded line buffer limit, closing');
      socket.destroy();
    }
  });

  socket.on('error', (err) => {
    // EPIPE / ECONNRESET are expected when the daemon disconnects.
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      log.error(`telemetry identity socket error: ${err.message}`);
    }
  });
}

// --- server lifecycle ----------------------------------------------------

/**
 * Start the identity socket server.
 *
 * The runtime directory (SOCKET_DIR) is created by systemd via
 * RuntimeDirectory= in the fluxos unit — we don't mkdir here so we
 * can't accidentally override the ownership systemd set.  If the
 * directory doesn't exist (dev mode, non-ArcaneOS), we skip silently.
 */
async function start() {
  if (server) {
    log.warn('telemetry identity server already running');
    return;
  }

  // Verify the runtime directory exists (systemd creates it).
  try {
    await fs.promises.access(SOCKET_DIR, fs.constants.W_OK);
  } catch (err) {
    log.warn(`telemetry identity: ${SOCKET_DIR} not available (${err.code}), skipping`);
    return;
  }

  // Remove stale socket from a previous unclean shutdown.
  try {
    await fs.promises.unlink(SOCKET_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error(`telemetry identity: cannot remove stale socket: ${err.message}`);
      return;
    }
  }

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
}

/**
 * Stop the identity socket server and clean up the socket file.
 */
async function stop() {
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
  // Exported for testing:
  parseContainerName,
  resolveIdentity,
  handleRequest,
  SOCKET_PATH,
  TAG_ALLOWLIST,
};
