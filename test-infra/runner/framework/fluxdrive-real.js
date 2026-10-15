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
