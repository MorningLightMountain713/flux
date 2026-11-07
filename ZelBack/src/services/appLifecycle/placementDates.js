'use strict';

const log = require('../../lib/log');
const appRecords = require('../appDatabase/appRecords');
const appsRepository = require('../appDatabase/appsRepository');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxEventBus = require('../utils/fluxEventBus');

/**
 * When this node took each instance it holds: the `placedAt` of the
 * instance's resources, which is how long the node has held the instance's
 * data. It is the runningSince this node announces, and so its place in each
 * app's order: the senior holders keep the app when there is a surplus and
 * are the ones a primary is chosen from.
 *
 * The network's copy of what this node announced lapses while the app goes on
 * running here (expiry, a node-down certificate, an off-list departure), so it
 * is read only for an instance whose resources hold no date.
 */

/**
 * What this node last announced for each instance it announced, by name and
 * replica.
 * @param {string} localSocketAddr This node's address, which its announcements are filed under.
 * @returns {Promise<Map<string, string>>} runningSince by instance key
 */
async function lastAnnounced(localSocketAddr) {
  const claims = await appsRepository.appLocationFromEvents({ ip: localSocketAddr });
  return new Map(claims
    .filter((claim) => claim.runningSince)
    .map((claim) => [appRecords.instanceKey({ name: claim.name, replica: claim.replica ?? null }), claim.runningSince]));
}

/**
 * The runningSince this node announces for an instance: when it took it, or,
 * for resources not yet dated, what it last announced for it, or now.
 * @param {string} name App name.
 * @param {string|null} replica The replica the instance runs as.
 * @param {string} localSocketAddr This node's address.
 * @returns {Promise<string>} ISO time
 */
async function announcedSince(name, replica, localSocketAddr) {
  const placedAt = (await appRecords.instanceResources().byInstance(name, replica))?.placedAt;
  if (placedAt) return placedAt.toISOString();
  const announced = (await lastAnnounced(localSocketAddr)).get(appRecords.instanceKey({ name, replica }));
  return announced ? new Date(announced).toISOString() : new Date().toISOString();
}

/**
 * Dates every instance whose resources hold no date, at what this node last
 * announced for it, or now when it announced nothing, so the instance keeps the
 * place the network already gives it. Waits for this node's address, which its
 * announcements are filed under. A date already held is left as it is.
 * @returns {Promise<{dated: number, fromAnnouncements: number}>} What was written.
 */
async function dateUndatedPlacements() {
  const localSocketAddr = await fluxNetworkHelper.waitForLocalSocketAddress();
  const undated = (await appRecords.instanceResources().all()).filter((resources) => resources.placedAt === null);
  const announced = undated.length ? await lastAnnounced(localSocketAddr) : new Map();
  let fromAnnouncements = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const resources of undated) {
    const since = announced.get(appRecords.instanceKey({ name: resources.name, replica: resources.replica }));
    const placedAt = since ? new Date(since) : new Date();
    if (since) fromAnnouncements += 1;
    // eslint-disable-next-line no-await-in-loop
    await appRecords.instanceResources().setPlacedAt(resources.name, resources.replica, placedAt);
    fluxEventBus.publish('app:placementRecorded', {
      name: resources.name, replica: resources.replica, placedAt: placedAt.toISOString(), source: since ? 'announcement' : 'now',
    });
  }
  if (undated.length) log.info(`placementDates - dated ${undated.length} instance(s), ${fromAnnouncements} from this node's announcements`);
  fluxEventBus.publish('app:placementsDated', { dated: undated.length, fromAnnouncements });
  return { dated: undated.length, fromAnnouncements };
}

module.exports = { announcedSince, dateUndatedPlacements };
