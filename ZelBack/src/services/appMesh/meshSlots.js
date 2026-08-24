'use strict';

// Slot assignment — the dense ordinal identity consensus software needs
// (db-0, db-1, …), self-claimed and carried by the message flows the network
// already gossips. Nobody computes an assignment for anyone else: a member
// claims the lowest slot it observes vacant, asserts the claim in its own
// broadcasts, and every observer reads claims rather than deriving them
// (deriving is the trap — "lowest free slot" computed independently per node
// is path-dependent under eventually-consistent gossip and never reconverges).
//
// The slot space is 0..instances-1 — the spec's instance count, on-chain and
// agreed everywhere. Two rules keep the mechanism stable and honest:
//   - an OCCUPIED slot is never contested: a live member's assertion wins over
//     any later claim, and a member never re-evaluates its own settled slot
//     (the DHCP-lease property; the one exception is losing the deterministic
//     double-claim arbitration below, where the slot was never validly held);
//   - slots are a NAMING layer, never admission: a member without a slot is a
//     standby — admitted to the overlay, reachable by its nodeid name,
//     claiming a vacancy when one opens. Concretely: the slot decides who the
//     ordinal names and the SRV answers name, nothing else.
//
// A transient double-claim (two joiners racing inside one gossip window)
// converges because arbitration is a pure function of gossiped facts, ordered
// on keys the protocol's own actions can never move: among running assertions
// the lowest OUTPOINT wins (runningSince restamps on every rebuild — the
// resolution step itself — so it may gate running-vs-joiner but never order
// the contest); among installing claims the earliest announcedAt ??
// broadcastedAt wins — the seat election's exact key, immutable under claim
// renewals — tiebroken on the ip. Every observer reaches the same verdict,
// the winner KEEPS its slot, and only the losers re-pick the next vacancy.
// Both claimants walking away (the winner deferring to the loser and the
// loser to the winner) is the failure this arbitration exists to prevent.
const appsRepository = require('../appDatabase/appsRepository');
const registryManager = require('../appDatabase/registryManager');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const log = require('../../lib/log');

// runningSince gates, never orders: its PRESENCE says a member is running (a
// running member always beats a joiner still maturing out of its claim), but
// its VALUE restamps on every rebuild — the arbitration's own resolution step
// — so ordering on it would let a contest reshuffle itself. The order is the
// outpoint: immutable for a member's whole life, total across the fleet.
const contestKey = (a) => `${a.since != null ? '0' : '1'}|${a.tiebreak ?? ''}`;

/**
 * Winner per slot among assertions — deterministic on every node: a running
 * member (any `since`) beats a joiner (none); among equals the lowest
 * `tiebreak` (outpoint) wins. Input entries carry {slot, since, tiebreak, …};
 * the returned map keeps the whole winning entry so callers can read their
 * own fields back off it.
 *
 * @param {Array<{slot: number, since: string|null, tiebreak: string}>} assertions
 * @returns {Map<number, object>} slot → winning assertion
 */
function arbitrate(assertions) {
  const bySlot = new Map();
  for (const assertion of assertions) {
    if (!Number.isInteger(assertion.slot) || assertion.slot < 0) continue; // eslint-disable-line no-continue
    const held = bySlot.get(assertion.slot);
    if (!held || contestKey(assertion) < contestKey(held)) {
      bySlot.set(assertion.slot, assertion);
    }
  }
  return bySlot;
}

/**
 * Winner per slot among installing claims — deterministic on every node:
 * earliest `announcedAt ?? broadcastedAt` wins (the seat election's key,
 * which claim renewals never move), ties broken on the ip. Compared with
 * `<` as the seat election compares, so Date and numeric rows order the
 * same way.
 *
 * @param {Array<{meshSlot: number, ip: string}>} claims in-range slot claims
 * @returns {Map<number, object>} slot → winning claim
 */
function arbitrateClaims(claims) {
  const bySlot = new Map();
  for (const claim of claims) {
    const held = bySlot.get(claim.meshSlot);
    if (!held || claimBeats(claim, held)) {
      bySlot.set(claim.meshSlot, claim);
    }
  }
  return bySlot;
}

function claimBeats(claim, held) {
  const claimAt = claim.announcedAt ?? claim.broadcastedAt;
  const heldAt = held.announcedAt ?? held.broadcastedAt;
  if (claimAt < heldAt) return true;
  if (heldAt < claimAt) return false;
  return String(claim.ip) < String(held.ip);
}

/**
 * The lowest slot in 0..instances-1 not present in `occupied`, or null when
 * every slot is held — the caller is a standby.
 *
 * @param {Set<number>} occupied
 * @param {number} instances
 * @returns {number|null}
 */
function lowestVacancy(occupied, instances) {
  for (let slot = 0; slot < instances; slot += 1) {
    if (!occupied.has(slot)) return slot;
  }
  return null;
}

/**
 * One app's slot state, from this node's derived view: the running-assertion
 * winners, and this node's own slot resolved through the claim chain —
 *   1. the own settled running assertion, kept unless it lost arbitration;
 *   2. the own installing claim's slot, kept while it wins the per-slot
 *      claim arbitration and no running member holds it;
 *   3. a fresh pick of the lowest vacancy;
 *   4. null — every slot is held; this member is a standby.
 * Vacancy counts slots won by running members plus slots whose claim
 * arbitration OTHER nodes won — so two concurrent installers split, and a
 * contested slot keeps exactly its winning claimant.
 *
 * @param {string} appName
 * @param {number} instances the spec's instance count (the slot space)
 * @returns {Promise<{ownSlot: number|null, ownSince: string|null,
 *   winners: Map<number, object>}>}
 */
async function appSlotView(appName, instances) {
  const cap = Number.isInteger(instances) && instances > 0 ? instances : 0;
  const none = { ownSlot: null, ownSince: null, winners: new Map() };
  if (cap === 0) return none;
  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddr) return none;

  const rows = await appsRepository.appLocationFromEvents({ appname: appName });
  const assertions = rows
    .filter((row) => Number.isInteger(row.meshSlot) && row.meshSlot >= 0 && row.meshSlot < cap)
    .map((row) => ({
      slot: row.meshSlot,
      since: row.runningSince ?? null,
      tiebreak: row.outpoint ?? row.ip,
      ip: row.ip,
    }));
  const winners = arbitrate(assertions);
  const ownRow = rows.find((row) => row.ip === localSocketAddr);
  const ownSince = ownRow?.runningSince ?? null;

  // 1. The own settled assertion, unless a deterministic arbitration says the
  // slot was never validly ours (the transient double-claim, converging).
  if (ownRow && Number.isInteger(ownRow.meshSlot) && ownRow.meshSlot >= 0 && ownRow.meshSlot < cap
    && winners.get(ownRow.meshSlot)?.ip === localSocketAddr) {
    return { ownSlot: ownRow.meshSlot, ownSince, winners };
  }

  const occupied = new Set(
    [...winners.entries()].filter(([, a]) => a.ip !== localSocketAddr).map(([slot]) => slot),
  );
  // Claims are arbitrated per slot, never counted wholesale: a contested
  // slot occupies the space only for the losers, so the winning claimant
  // keeps it — two claimants both deferring would strand the slot and send
  // both nodes marching through the vacancies in lockstep.
  const claims = (await registryManager.appInstallingLocation(appName))
    .filter((claim) => Number.isInteger(claim.meshSlot)
      && claim.meshSlot >= 0 && claim.meshSlot < cap);
  const claimWinners = arbitrateClaims(claims);
  for (const [slot, claim] of claimWinners.entries()) {
    if (claim.ip !== localSocketAddr) occupied.add(slot);
  }

  // 2. The own installing claim's slot, while the claim arbitration says it
  // is ours and no running member holds it.
  const ownClaim = claims.find((claim) => claim.ip === localSocketAddr);
  if (ownClaim && claimWinners.get(ownClaim.meshSlot)?.ip === localSocketAddr
    && !occupied.has(ownClaim.meshSlot)) {
    return { ownSlot: ownClaim.meshSlot, ownSince, winners };
  }

  // 3./4. Fresh pick, or standby when the space is full.
  return { ownSlot: lowestVacancy(occupied, cap), ownSince, winners };
}

/**
 * This node's slot for an app, or null when it is a standby.
 * @param {string} appName
 * @param {number} instances
 * @returns {Promise<number|null>}
 */
async function resolveOwnSlot(appName, instances) {
  return (await appSlotView(appName, instances)).ownSlot;
}

/**
 * Re-broadcast this node's standing install claims carrying the chosen slot,
 * so a concurrent installer's vacancy read sees it before either is running.
 * The original announcedAt is preserved — it is the immutable seat-election
 * key and must never move — and only the slot rides along. A no-op when the
 * node holds no standing claim (post-install passes must not fabricate one).
 *
 * @param {string} appName
 * @param {number} slot
 */
async function publishClaimSlot(appName, slot) {
  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  if (!localSocketAddr) return;
  const claims = (await registryManager.appInstallingLocation(appName))
    .filter((claim) => claim.ip === localSocketAddr);
  // eslint-disable-next-line no-restricted-syntax
  for (const claim of claims) {
    if (claim.meshSlot === slot) continue; // eslint-disable-line no-continue
    const announcedAt = claim.announcedAt instanceof Date
      ? claim.announcedAt.getTime() : Date.now();
    const message = {
      type: 'fluxappinstalling',
      version: 2,
      name: appName,
      ip: localSocketAddr,
      ...(claim.replica != null ? { replica: claim.replica } : {}),
      announcedAt,
      broadcastedAt: Date.now(),
      meshSlot: slot,
    };
    // eslint-disable-next-line no-await-in-loop
    await registryManager.storeAppInstallingMessage(message);
    // eslint-disable-next-line no-await-in-loop
    await fluxCommunicationMessagesSender.broadcastMessageToAll(message, { requireCapability: 'appInstallingClaims' })
      .catch((error) => log.warn(`meshSlots - slot claim broadcast for ${appName} failed: ${error.message}`));
  }
}

module.exports = {
  arbitrate,
  lowestVacancy,
  appSlotView,
  resolveOwnSlot,
  publishClaimSlot,
};
