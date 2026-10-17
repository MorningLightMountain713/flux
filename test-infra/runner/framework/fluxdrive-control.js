// Drives the FluxDrive stub (test-infra/fluxdrive-stub) that backs the v9
// content-delivery blob/manifest API. The data plane is what the node calls via
// fluxDriveClient; this control plane lets a suite seed state, flip strict/fault
// modes, snapshot what the node uploaded/reconciled, and reset between tests.
// Default host matches test-env's FLUXDRIVE_IP / control port.
import { getSubnetConfig } from './subnet-config.js';

const CONTROL = process.env.FLUXDRIVE_CONTROL || `http://${getSubnetConfig().fluxDrive}:16141`;

async function post(path, body) {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${CONTROL}${path}`);
  return res.json();
}

// Full snapshot: blob metadata, the manifest each name serves (`manifests`),
// every stored manifest row (`manifestRows`), the name holders, the kept lists
// manifests carried (`keptLists`), and the active mode. The primary assertion
// surface.
export async function getFluxDriveState() {
  return get('/state');
}

export async function getFluxDriveBlob(locator) {
  return get(`/blob/${locator}`);
}

// The manifest the name serves.
export async function getFluxDriveManifest(appName) {
  return get(`/manifest/${encodeURIComponent(appName)}`);
}

// Pre-seed a blob (peer-fallback / cold-start). bytes is a Buffer or base64 string.
export async function seedFluxDriveBlob(locator, bytes, opts = {}) {
  const base64 = Buffer.isBuffer(bytes) ? bytes.toString('base64') : bytes;
  return post(`/blob/${locator}`, { base64, appName: opts.appName, source: opts.source });
}

// Pre-seed a manifest backstop under the identity it names. confirmed defaults
// true (immediately servable).
export async function seedFluxDriveManifest(appName, version, manifest, opts = {}) {
  return post(`/manifest/${encodeURIComponent(appName)}`, { version, manifest, confirmed: opts.confirmed });
}

// Make `identity` the name's holder: its manifest is confirmed, every other
// row of the name is evicted, and a manifest for another identity is refused.
export async function promoteFluxDriveManifest(appName, identity) {
  return post(`/manifest/${encodeURIComponent(appName)}/promote`, { identity });
}

// The writes held pending, each naming the spec message it rides in; those
// naming one message when a hash is given.
export async function getFluxDrivePending(messageHash) {
  return get(messageHash ? `/pending?messageHash=${encodeURIComponent(messageHash)}` : '/pending');
}

// Decide the pending writes naming a message as the nodes' majority would:
// { decision: 'applied' | 'refused' | 'unpayable' | 'undecided', identity? }.
// The stub asks the fleet itself; this is for a suite that models an outcome.
export async function decideFluxDrivePending(messageHash, verdict) {
  return post(`/pending/${encodeURIComponent(messageHash)}/decide`, verdict);
}

// Ask the fleet about every pending write now, instead of at the next poll.
export async function askFluxDrivePending() {
  return post('/pending/ask');
}

// Toggle strict (version floors/409s/confirmed-gating), slow (per-request delay ms), or
// fail5xx (data plane returns 503).
export async function setFluxDriveMode(mode) {
  return post('/mode', mode);
}

export async function resetFluxDrive() {
  return post('/reset');
}
