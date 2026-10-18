// Reads a node's OWN syncthing daemon, for suites booted with
// `createTestEnv({ syncthing: 'real' })`.
//
// Deliberately observers, not setters. The stub's control surface
// (syncthing-control.js) scripts what a node believes about sync state, because
// with a stub there is no truth to read. With a real daemon there is, and
// scripting it would only hide what the test exists to establish - so these
// wait on what actually happened.
//
// Everything goes through the node's container, because the daemon binds
// 127.0.0.1 inside it and its API key is whatever it generated for itself.
import { execInContainer } from './container.js';

async function apiKey(client) {
  const r = await execInContainer(client.container,
    "sed -n 's|.*<apikey>\\(.*\\)</apikey>.*|\\1|p' /dat/usr/lib/syncthing/config.xml | head -1");
  const key = r.stdout.trim();
  if (!key) throw new Error('syncthing-real: no api key in the node\'s config.xml - is this env booted with syncthing: "binary"?');
  return key;
}

async function api(client, path) {
  const key = await apiKey(client);
  const r = await execInContainer(client.container,
    `curl -sS -H "X-API-Key: ${key}" "http://127.0.0.1:8384${path}"`);
  if (r.exitCode !== 0) throw new Error(`syncthing-real: GET ${path} failed: ${r.stderr || r.output}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`syncthing-real: GET ${path} returned unparseable body: ${r.stdout.slice(0, 200)}`);
  }
}

export async function isDaemonUp(client) {
  try {
    const pong = await api(client, '/rest/system/ping');
    return pong?.ping === 'pong';
  } catch {
    return false;
  }
}

export async function getVersion(client) {
  return (await api(client, '/rest/system/version')).version;
}

export async function getDeviceId(client) {
  return (await api(client, '/rest/system/status')).myID;
}

export async function getFolders(client) {
  return api(client, '/rest/config/folders');
}

export async function getFolderStatus(client, folderId) {
  return api(client, `/rest/db/status?folder=${encodeURIComponent(folderId)}`);
}

// A folder is complete when the index describes something and the disk holds all
// of it. globalBytes === 0 means the index is empty, which is not the same as
// synced and must never read as done.
export async function isFolderSynced(client, folderId) {
  try {
    const s = await getFolderStatus(client, folderId);
    return s.globalBytes > 0 && s.inSyncBytes === s.globalBytes && s.needBytes === 0;
  } catch {
    return false;
  }
}

// Which peers this node is actually connected to, by device id.
export async function getConnectedDevices(client) {
  const conns = await api(client, '/rest/system/connections');
  return Object.entries(conns.connections || {})
    .filter(([, c]) => c.connected)
    .map(([id]) => id);
}

// Ask the daemon to look at the folder NOW. Without this a test that writes into a
// volume waits on syncthing's own rescan interval, which is an hour by default - so
// "the daemon has not noticed yet" reads identically to "the write never landed".
export async function scanFolder(client, folderId) {
  const key = await apiKey(client);
  const r = await execInContainer(client.container,
    `curl -sS -X POST -H "X-API-Key: ${key}" "http://127.0.0.1:8384/rest/db/scan?folder=${encodeURIComponent(folderId)}"`);
  if (r.exitCode !== 0) throw new Error(`syncthing-real: scan of ${folderId} failed: ${r.stderr || r.output}`);
}

// What is actually on disk inside the folder, which is the only thing that
// settles whether data moved. The index can describe files a node does not have.
export async function listFolderFiles(client, path) {
  const r = await execInContainer(client.container, `ls -A "${path}" 2>/dev/null | sort | tr '\\n' ' '`);
  return r.stdout.trim();
}

/**
 * What a node's own syncthing daemon recorded, for a failure dump: its device,
 * the devices and folders it is configured with, every change to a folder it
 * saw, made on its own disk (LocalChangeDetected) or taken from a peer
 * (RemoteChangeDetected, naming the device that made it), and its recent log.
 * Throws for a node that runs no daemon.
 * @returns {Promise<string>}
 */
export async function syncthingRecord(client) {
  const [status, devices, folders, disk, log] = await Promise.all([
    api(client, '/rest/system/status'),
    api(client, '/rest/config/devices'),
    api(client, '/rest/config/folders'),
    api(client, '/rest/events/disk?since=0&timeout=1'),
    api(client, '/rest/system/log'),
  ]);
  const lines = [`this device ${status.myID}`];
  for (const d of devices) lines.push(`device ${d.deviceID} ${d.name ?? ''} ${(d.addresses || []).join(',')}`);
  for (const f of folders) {
    lines.push(`folder ${f.id} ${f.type} paused=${f.paused} devices=${(f.devices || []).map((x) => x.deviceID).join(',')}`);
  }
  lines.push('', '--- folder changes (LocalChangeDetected: made on this node; RemoteChangeDetected: modifiedBy names the device) ---');
  for (const e of disk || []) lines.push(`${e.time} ${e.type} ${JSON.stringify(e.data)}`);
  lines.push('', '--- log ---');
  for (const m of log?.messages || []) lines.push(`${m.when} ${m.message}`);
  return lines.join('\n');
}
