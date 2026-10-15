// The real FluxDrive (createTestEnv({ fluxDrive: 'real' })): where its API and
// GC runner answer, and the GC runner's passes. The API stands at the stub's
// address on its own port; the GC runner runs FluxDrive's GC and pending-write
// passes only when a suite asks, each at the time it names.
import { getSubnetConfig } from './subnet-config.js';

export const FLUXDRIVE_API_PORT = 8082;
export const FLUXDRIVE_GC_PORT = 16142;

/** The API's base URL, as FluxOS's blobApiUrl names it. */
export function fluxDriveApiUrl() {
  return `http://${getSubnetConfig().fluxDrive}:${FLUXDRIVE_API_PORT}`;
}

async function runPass(path, now) {
  const res = await fetch(`http://${getSubnetConfig().fluxDriveGc}:${FLUXDRIVE_GC_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ now }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`fluxdrive ${path} at ${now} answered ${res.status}: ${body.error}`);
  return body;
}

/**
 * One GC pass at `now` (ms since epoch): its metrics, or `{ skipped, reason }`
 * when the live set could not be read.
 */
export function fluxDriveSweep(now) {
  return runPass('/sweep', now);
}

/**
 * One pass over the pending writes at `now`: how many were applied, discarded,
 * kept, left unasked and collected.
 */
export function fluxDrivePending(now) {
  return runPass('/pending', now);
}

/**
 * The manifest versions FluxDrive serves for an app name: confirmed ones only,
 * so a write held pending is not among them. An empty list when it serves none.
 * @returns {Promise<Array<{version:number, ownedFrom:number, owner:string, manifest:object}>>}
 */
export async function fluxDriveManifests(appName) {
  const res = await fetch(`${fluxDriveApiUrl()}/api/v1/manifest/${encodeURIComponent(appName)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`fluxdrive manifest ${appName} answered ${res.status}`);
  return (await res.json()).versions;
}

/** Whether FluxDrive holds a blob under `locator`. */
export async function fluxDriveHolds(locator) {
  const res = await fetch(`${fluxDriveApiUrl()}/api/v1/blob/${locator}`, { method: 'HEAD' });
  if (res.status !== 200 && res.status !== 404) throw new Error(`fluxdrive blob ${locator} answered ${res.status}`);
  return res.status === 200;
}

/**
 * One blob upload as a node makes it: the bytes and both signatures over
 * `locator:identity:timestamp`.
 * @param {{bytes:Buffer, locator:string, appName:string, identity:string, timestamp:number, ownerSig:string, arcaneSig:string, source?:string}} upload
 * @returns {Promise<{status:number, body:object}>}
 */
export async function uploadToFluxDrive({
  bytes, locator, appName, identity, timestamp, ownerSig, arcaneSig, source = 'blob',
}) {
  const res = await fetch(`${fluxDriveApiUrl()}/api/v1/blob`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Flux-Locator': locator,
      'X-Flux-AppName': appName,
      'X-Flux-Identity': identity,
      'X-Flux-Timestamp': String(timestamp),
      'X-Flux-Arcane-Sig': arcaneSig,
      'X-Flux-Owner-Sig': ownerSig,
      'X-Flux-Source': source,
    },
    body: bytes,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
