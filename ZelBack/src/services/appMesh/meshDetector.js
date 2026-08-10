'use strict';

// The impersonation detector: compares nebula's live peer table against the
// derivation. Every tunnel carries the peer's presented certificate, and the
// derivation says exactly which addresses the authority that signed it is
// entitled to — so a claim outside the issuer's entitlement is provably a
// cheat, never a matter of interpretation (addresses are permanent under the
// uuid-keyed derivation; there is no convergence state to mistake for one).
//
// A confirmed cheat is evicted by OUTPOINT into the persisted refuse set:
// evicting the certificate alone would be undone the moment the attacker
// republishes under a fresh authority, which is indistinguishable from an
// ordinary rotation. The reconciler rebuilds the bundle without the refused
// outpoint and reloads; awaitEvictionConverged then watches the peer table
// until no tunnel cites an authority outside the intended set — the
// behavioural read-back that stands in for a "loaded CA pool" query nebula
// does not offer, and the check that catches a reload that silently kept the
// old pool.
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const meshSsh = require('./meshSsh');
const meshRefuseSet = require('./meshRefuseSet');

// An evicted peer's tunnel drops within ~5 s (nebula's connection manager
// re-checks certificates on that cadence); the window is double that plus
// slack, so a pass never gives up on a converging eviction.
const CONVERGE_TIMEOUT_MS = 12000;
const CONVERGE_POLL_MS = 2000;

/**
 * Judge every tunnel of one app's peer table against the accepted members.
 * Pure.
 *
 * A tunnel whose issuer is one of a member's authorities must claim exactly
 * that member's derived address and route nothing beyond its block. A tunnel
 * whose issuer is outside every member's bundle is "foreign": either an
 * eviction that has not converged yet, or the footprint of a reload that
 * silently kept a stale pool — the caller decides which by how long it
 * persists.
 *
 * @param {Array<{vpnAddrs: string[], cert: object}>} hostmap
 * @param {Array<{outpoint: string, address: string, block: string,
 *   caShas: string[]}>} members
 * @returns {{cheats: Array<{outpoint: string, issuer: string,
 *   claimedAddrs: string[], claimedBlocks: string[], expectedAddress: string,
 *   expectedBlock: string}>, foreign: Array<{issuer: string|null,
 *   vpnAddrs: string[]}>}}
 */
function classifyPeers(hostmap, members) {
  const byIssuer = new Map();
  members.forEach((member) => {
    member.caShas.forEach((sha) => byIssuer.set(sha, member));
  });
  const cheats = new Map();
  const foreign = [];
  for (const entry of hostmap) {
    const details = entry?.cert?.details;
    const issuer = typeof details?.issuer === 'string' ? details.issuer : null;
    const member = issuer ? byIssuer.get(issuer) : undefined;
    if (!member) {
      foreign.push({ issuer, vpnAddrs: entry?.vpnAddrs ?? [] });
      continue; // eslint-disable-line no-continue
    }
    const claimedAddrs = Array.isArray(entry.vpnAddrs) ? entry.vpnAddrs : [];
    const claimedBlocks = Array.isArray(details.unsafeNetworks) ? details.unsafeNetworks : [];
    const addrsOwned = claimedAddrs.every((addr) => addr === member.address);
    const blocksOwned = claimedBlocks.every((block) => block === member.block);
    if (!addrsOwned || !blocksOwned) {
      cheats.set(member.outpoint, {
        outpoint: member.outpoint,
        issuer,
        claimedAddrs,
        claimedBlocks,
        expectedAddress: member.address,
        expectedBlock: member.block,
      });
    }
  }
  return { cheats: [...cheats.values()], foreign };
}

/**
 * One detector pass for one app: read the peer table, refuse every confirmed
 * cheat. The caller rebuilds the bundle and reloads when anything was
 * evicted, then verifies with awaitEvictionConverged.
 *
 * @param {string} instance the app's identity segment
 * @param {Array<object>} members the accepted members (classifyPeers shape)
 * @returns {Promise<{checked: boolean, evicted: Array<object>,
 *   foreign: Array<object>}>} checked=false when the peer table was
 *   unreadable (daemon down, sshd unreachable) — nothing was judged
 */
async function detectImpersonation(instance, members) {
  let hostmap;
  try {
    hostmap = await meshSsh.listHostmap(instance);
  } catch (error) {
    log.warn(`meshDetector - ${instance}: peer table unreadable, nothing judged: ${error.message}`);
    return { checked: false, evicted: [], foreign: [] };
  }
  const { cheats, foreign } = classifyPeers(hostmap, members);
  // eslint-disable-next-line no-restricted-syntax
  for (const cheat of cheats) {
    // eslint-disable-next-line no-await-in-loop
    await meshRefuseSet.refuseOutpoint(instance, cheat.outpoint);
    log.error(`meshDetector - ${instance}: outpoint ${cheat.outpoint} claimed ${cheat.claimedAddrs.join(',') || '(none)'} `
      + `routing ${cheat.claimedBlocks.join(',') || '(none)'} under authority ${cheat.issuer}; `
      + `that authority owns ${cheat.expectedAddress} (${cheat.expectedBlock}). Evicted.`);
  }
  return { checked: true, evicted: cheats, foreign };
}

/**
 * Watch the peer table until every tunnel cites an authority in the trusted
 * set — the proof an eviction (bundle rewrite + reload) actually took. False
 * after the window is a security event for the caller: the likely cause is a
 * reload that silently kept the previous pool.
 *
 * @param {string} instance
 * @param {Set<string>} trustedShas every authority fingerprint still trusted
 * @returns {Promise<boolean>}
 */
async function awaitEvictionConverged(instance, trustedShas) {
  const deadline = Date.now() + CONVERGE_TIMEOUT_MS;
  for (;;) {
    let converged = null;
    try {
      const hostmap = await meshSsh.listHostmap(instance); // eslint-disable-line no-await-in-loop
      converged = hostmap.every((entry) => trustedShas.has(entry?.cert?.details?.issuer));
    } catch (error) {
      // An unreadable table proves nothing either way; keep polling.
    }
    if (converged) return true;
    if (Date.now() >= deadline) return false;
    await serviceHelper.delay(CONVERGE_POLL_MS); // eslint-disable-line no-await-in-loop
  }
}

module.exports = {
  classifyPeers,
  detectImpersonation,
  awaitEvictionConverged,
};
