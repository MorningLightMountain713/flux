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

// Full snapshot: blob metadata, stored manifests, the reconcile log, strict
// floors, and the active mode. The primary assertion surface.
export async function getFluxDriveState() {
  return get('/state');
}

export async function getFluxDriveBlob(locator) {
  return get(`/blob/${locator}`);
}

export async function getFluxDriveManifest(appName) {
  return get(`/manifest/${encodeURIComponent(appName)}`);
}

// Pre-seed a blob (peer-fallback / cold-start). bytes is a Buffer or base64 string.
export async function seedFluxDriveBlob(locator, bytes, opts = {}) {
  const base64 = Buffer.isBuffer(bytes) ? bytes.toString('base64') : bytes;
  return post(`/blob/${locator}`, { base64, appName: opts.appName, source: opts.source });
}

// Pre-seed a manifest backstop. confirmed defaults true (immediately servable).
export async function seedFluxDriveManifest(appName, version, manifest, opts = {}) {
  return post(`/manifest/${encodeURIComponent(appName)}`, { version, manifest, confirmed: opts.confirmed });
}

export async function promoteFluxDriveManifest(appName) {
  return post(`/manifest/${encodeURIComponent(appName)}/promote`);
}

// Toggle strict (floors/409s/confirmed-gating), slow (per-request delay ms), or
// fail5xx (data plane returns 503).
export async function setFluxDriveMode(mode) {
  return post('/mode', mode);
}

export async function resetFluxDrive() {
  return post('/reset');
}
