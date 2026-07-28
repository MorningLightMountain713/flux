// Re-export cache from globalState for convenience
// This provides a cleaner API for accessing syncthing caches
const globalState = require('./globalState');
const volumeService = require('./volumeService');
const log = require('../../lib/log');

/**
 * Stores a receive-only sync mark, stamped with the identity of the filesystem it
 * describes. Every write goes through here so the stamp cannot be forgotten at a call
 * site — the mark is built in several places and mutated in several more, but persisted
 * only here and by the monitor's write-through.
 *
 * The mark is keyed by appId, which is stable across volume incarnations, while the data
 * it describes is not. The stamp is what lets a later read tell "this component finished
 * its receive-only bootstrap" from "a previous incarnation of this component did, on
 * storage that no longer exists".
 *
 * A null stamp (the volume is not mounted yet, as during boot) is recorded as-is and
 * treated as unverifiable on read rather than as a mismatch.
 * @param {Map} marks the receive-only mark store, passed in rather than reached for so
 *   the syncthing machinery stays injectable.
 * @param {string} appId Docker app identifier (e.g. fluxcomp_app).
 * @param {object} cache the mark to store.
 * @returns {Promise<object>} the stored mark, carrying the volume identity.
 */
async function setSyncedMark(marks, appId, cache) {
  const stamped = { ...cache, volumeUuid: await volumeService.appVolumeFilesystemId(appId) };
  marks.set(appId, stamped);
  return stamped;
}

/**
 * The receive-only sync mark for a component, or null when it describes storage that no
 * longer exists.
 *
 * A component's volume can be rebuilt while the app stays installed, and the only entry
 * removal in the codebase is at uninstall — so a surviving mark can otherwise certify an
 * empty disk as synced, and the election reads `restarted` off it to decide a node may
 * become primary. Comparing the stamped filesystem against the live one closes that.
 *
 * Honoured whenever staleness cannot be PROVEN: an unstamped entry and an unreadable live
 * identity (the volume is not mounted, so nothing is being promoted off it anyway) both
 * pass through. Absence of evidence must not discard a valid mark — that would re-run the
 * receive-only bootstrap for every app on the node after every reboot.
 * @param {Map} marks the receive-only mark store.
 * @param {string} appId Docker app identifier (e.g. fluxcomp_app).
 * @returns {Promise<object|null>} the live mark, or null when it has been invalidated.
 */
async function syncedMark(marks, appId) {
  const cache = marks.get(appId);
  if (!cache) return null;
  if (!cache.volumeUuid) return cache;

  const liveUuid = await volumeService.appVolumeFilesystemId(appId);
  if (!liveUuid || liveUuid === cache.volumeUuid) return cache;

  marks.delete(appId);
  log.info(`syncedMark - dropped the sync mark for ${appId}: it describes filesystem ${cache.volumeUuid}, the mounted volume is ${liveUuid}`);
  return null;
}

module.exports = {
  receiveOnlySyncthingAppsCache: globalState.receiveOnlySyncthingAppsCache,
  syncthingDevicesIDCache: globalState.syncthingDevicesIDCache,
  setSyncedMark,
  syncedMark,
};
