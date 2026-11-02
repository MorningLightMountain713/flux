'use strict';

// Re-export cache from globalState for convenience
// This provides a cleaner API for accessing syncthing caches
const globalState = require('./globalState');
const volumeService = require('./volumeService');
const log = require('../../lib/log');

/**
 * Stores a receive-only sync mark, stamped with the identity of the filesystem it
 * describes. Every write goes through here so the stamp cannot be forgotten at a call
 * site.
 *
 * The mark is keyed by the component's syncthing folder id, which is stable across
 * volume incarnations, while the data it describes is not. The stamp is what lets a
 * later read tell "this component finished its receive-only bootstrap" from "a
 * previous incarnation of this component did, on storage that no longer exists". The
 * volume is the component's own directory, named by its identifier: for an app
 * registered before v9 that is not its folder id.
 *
 * The mark is stamped and stored as the object given, so work begun on it - a check
 * of its local changes - still finds it current once the pass that read it has
 * stored it again.
 *
 * A null stamp (the volume is not mounted yet, as during boot) is recorded as-is and
 * treated as unverifiable on read rather than as a mismatch.
 * @param {Map} marks the receive-only mark store, passed in rather than reached for so
 *   the syncthing machinery stays injectable.
 * @param {string} folderId the component's syncthing folder id.
 * @param {string} identifier the component's identifier, which names its directory.
 * @param {object} cache the mark to store.
 * @returns {Promise<object>} the stored mark, carrying the volume identity.
 */
async function setSyncedMark(marks, folderId, identifier, cache) {
  // eslint-disable-next-line no-param-reassign
  cache.volumeUuid = await volumeService.appVolumeFilesystemId(identifier);
  marks.set(folderId, cache);
  return cache;
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
 * @param {string} folderId the component's syncthing folder id.
 * @param {string} identifier the component's identifier, which names its directory.
 * @returns {Promise<object|null>} the live mark, or null when it has been invalidated.
 */
async function syncedMark(marks, folderId, identifier) {
  const cache = marks.get(folderId);
  if (!cache) return null;
  if (!cache.volumeUuid) return cache;

  const liveUuid = await volumeService.appVolumeFilesystemId(identifier);
  if (!liveUuid || liveUuid === cache.volumeUuid) return cache;

  marks.delete(folderId);
  log.info(`syncedMark - dropped the sync mark for ${folderId}: it describes filesystem ${cache.volumeUuid}, the mounted volume is ${liveUuid}`);
  return null;
}

module.exports = {
  receiveOnlySyncthingAppsCache: globalState.receiveOnlySyncthingAppsCache,
  syncthingDevicesIDCache: globalState.syncthingDevicesIDCache,
  setSyncedMark,
  syncedMark,
};
