const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const config = require('config');

const log = require('../lib/log');
const dockerService = require('./dockerService');
const dbHelper = require('./dbHelper');
const geolocationService = require('./geolocationService');
const appConstants = require('./utils/appConstants');

const SOCKET_DIR = '/run/flux/telemetry';
const SOCKET_PATH = path.join(SOCKET_DIR, 'identity.sock');

const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;

const TAG_ALLOWLIST = new Set([
  'region',
  'component',
  'image_name',
  'container_name',
]);

let server = null;

function parseContainerName(name) {
  if (!name) return null;

  const underscoreIdx = name.indexOf('_');
  if (underscoreIdx > 0 && underscoreIdx < name.length - 1) {
    const componentName = name.slice(0, underscoreIdx);
    const appName = name.slice(underscoreIdx + 1);
    return { appName, componentName };
  }

  if (name.startsWith('flux')) {
    return { appName: name.slice(4), componentName: null };
  }

  if (name.startsWith('zel')) {
    return { appName: name.slice(3), componentName: null };
  }

  return null;
}

async function resolveIdentity(containerId) {
  const containers = await dockerService.dockerListContainers(false);
  const container = containers.find((c) => c.Id === containerId);
  if (!container) return null;

  const rawName = container.Names && container.Names[0];
  if (!rawName) return null;

  const dockerName = rawName.startsWith('/') ? rawName.slice(1) : rawName;
  const parsed = parseContainerName(dockerName);
  if (!parsed) return null;

  const { appName, componentName } = parsed;

  const dbopen = dbHelper.databaseConnection();
  const appsDatabase = dbopen.db(config.database.appslocal.database);
  const appSpec = await dbHelper.findOneInDatabase(
    appsDatabase,
    appConstants.localAppsInformation,
    { name: appName },
    { projection: { _id: 0, name: 1, version: 1, compose: 1 } },
  );

  if (!appSpec) return null;

  const tags = {};

  if (componentName) {
    tags.component = componentName;
  }

  if (container.Image) {
    tags.image_name = container.Image;
  }
  tags.container_name = dockerName;

  try {
    const geo = await geolocationService.getNodeGeolocation();
    if (geo && geo.continentCode) {
      tags.region = geo.continentCode;
    }
  } catch (err) {
    log.warn(`telemetry identity: geolocation unavailable: ${err.message}`);
  }

  return {
    app_name: appName,
    tags,
  };
}

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

    if (buffer.length > 4096) {
      log.warn('telemetry identity: client exceeded line buffer limit, closing');
      socket.destroy();
    }
  });

  socket.on('error', (err) => {
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      log.error(`telemetry identity socket error: ${err.message}`);
    }
  });
}

async function start() {
  if (server) {
    log.warn('telemetry identity server already running');
    return;
  }

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
  parseContainerName,
  resolveIdentity,
  handleRequest,
  SOCKET_PATH,
  TAG_ALLOWLIST,
};
