// The node's allocated mesh transport ports, one per mesh app. The allocator
// (UPnP enumerate → pick free → map → verify ownership) writes here; the
// broadcast reads here. Persisted so a FluxOS restart re-publishes the same
// port instead of re-negotiating one the router already maps.
const fsp = require('node:fs/promises');
const path = require('node:path');

const { MESH_STATE_ROOT } = require('./meshCertificates');

const PORTS_FILE = path.join(MESH_STATE_ROOT, 'ports.json');

async function readAll() {
  try {
    return JSON.parse(await fsp.readFile(PORTS_FILE, 'utf8'));
  } catch (error) {
    return {};
  }
}

async function writeAll(ports) {
  await fsp.mkdir(MESH_STATE_ROOT, { recursive: true, mode: 0o755 });
  const tmp = `${PORTS_FILE}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(ports, null, 2)}\n`);
  await fsp.rename(tmp, PORTS_FILE);
}

/**
 * The transport port allocated to one app on this node, or null before the
 * allocator has secured one — a mesh app without a port is simply not
 * announced as reachable yet.
 *
 * @param {string} instance the app's identity segment
 * @returns {Promise<number|null>}
 */
async function getPort(instance) {
  const ports = await readAll();
  return Number.isInteger(ports[instance]) ? ports[instance] : null;
}

/**
 * Record a secured allocation.
 * @param {string} instance
 * @param {number} port
 */
async function setPort(instance, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('port must be a valid port number');
  }
  const ports = await readAll();
  ports[instance] = port;
  await writeAll(ports);
}

/**
 * Release an app's allocation (uninstall; the UPnP unmap is the allocator's).
 * @param {string} instance
 */
async function removePort(instance) {
  const ports = await readAll();
  if (!(instance in ports)) return;
  delete ports[instance];
  await writeAll(ports);
}

/**
 * Every allocation, for the allocator's own free-port scan.
 * @returns {Promise<Object<string, number>>}
 */
async function allPorts() {
  return readAll();
}

module.exports = {
  getPort,
  setPort,
  removePort,
  allPorts,
};
