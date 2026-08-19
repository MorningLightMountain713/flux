'use strict';

const generalService = require('../generalService');
const messageStore = require('../appMessaging/messageStore');
const grantClient = require('../quorumGrant/grantClient');
const fluxEventBus = require('../utils/fluxEventBus');
const foundingCommittee = require('./foundingCommittee');
const log = require('../../lib/log');

// The container-facing half of founding. A component's entrypoint asks its
// own node "may I found?" and the node answers from the founding grant —
// acquiring it on the container's behalf, because the container has no node
// identity and never talks to a committee. Three answers:
//
//   yes  — the founder register records THIS node; found. Idempotent for a
//          restarted entrypoint: the recorded founder is told yes again,
//          because a crash between the ask and the founding action must not
//          wedge the app forever. What a wiped founder must do instead —
//          rejoin the surviving members, never re-initialize — is the data
//          side of founding, and it belongs to the entrypoint's own branch:
//          this node cannot tell a first boot from a wipe.
//   no   — another node founded; join it.
//   wait — no honest answer exists yet (no founding record synced, no
//          quorum reachable, a lock-delay running). Asking again is the
//          only correct move, and retryAfterMs hints when.
//
// Each component founds its own register, and the register's key carries
// the component's WORLD: the block anchor of the owner-signed spec act that
// introduced it (`<app>/founder-<component>@<anchor>`). A component removed
// and re-added under the same name is a new world with a new anchor, so
// nothing the dead world recorded — register cells, the published record —
// can ever answer for it. The anchor rides the key because the key is
// signed in every ask and names the register everywhere at once: cells,
// the published record's role, the refusals that teach.

/**
 * Answer one component's founding ask.
 *
 * @param {string} appName
 * @param {string} component the calling container's component
 * @returns {Promise<{answer: 'yes'|'no'|'wait', retryAfterMs?: number}>}
 */
async function founderAsk(appName, component) {
  // The anchor is host-side knowledge (this node runs the container, so it
  // resolves the view). Missing it is an honest "not yet" — never a no,
  // never a minted basis.
  const anchor = await foundingCommittee.componentAnchor(appName, component);
  if (anchor === null) return { answer: 'wait' };

  // Record first: a decided register's answer is a durable, fleet-synced
  // fact, judged against the durable generation record — the newest
  // owner-record view, the same source the grantors teach from. Neither
  // read needs the photo, so a node however young answers a founded world
  // from its own database. The photo is a safety input for JUDGING an
  // undecided round, and only that path below requires it.
  const role = `founder-${foundingCommittee.founderToken(appName, component)}@${anchor}`;
  const generation = await currentGeneration(appName, role);
  const recorded = await recordedFounder(appName, role, generation);
  if (recorded) {
    const collateral = await generalService.obtainNodeCollateralInformation();
    const self = `${collateral.txhash}:${collateral.txindex}`;
    return settled(appName, component, recorded === self ? 'yes' : 'no');
  }

  // Undecided: the committee is public-facts knowledge this node must hold
  // to ask a round; without the photo the honest answer stays "not yet".
  const committee = await foundingCommittee.refereeCommittee(appName, anchor);
  if (!committee) return { answer: 'wait' };

  const outcome = await grantClient.acquire(`${appName}/${role}`, {
    mode: 'oneshot',
    committee,
  });
  if (outcome.granted) return settled(appName, component, 'yes');
  if (outcome.founder) return settled(appName, component, 'no');
  log.info(`foundingService - ${appName}/${component}: wait (${outcome.reason ?? `retry in ${outcome.retryAfterMs}ms`})`);
  return {
    answer: 'wait',
    ...(outcome.retryAfterMs ? { retryAfterMs: outcome.retryAfterMs } : {}),
  };
}

/**
 * A settled founder answer — yes or no, never wait — published to the
 * event bus so the harness can await the verdict instead of inferring it.
 */
function settled(appName, component, answer) {
  fluxEventBus.publish('quorumGrant:founderAnswer', { appName, component, answer });
  return { answer };
}

/**
 * The founder the published record names for this world, or null. Answering
 * from the record spares the committee a wire round per ask — a founding is
 * durable, so once the record has synced, every later ask is a local read.
 * The role already names the world's anchor; the generation check keeps a
 * retired generation's record from answering for the re-rolled one.
 */
async function recordedFounder(appName, role, generation) {
  try {
    const record = await messageStore.getMasterleaseRecord(appName, role);
    const data = record?.data;
    if (!data || data.mode !== 'oneshot' || typeof data.grantee !== 'string') return null;
    if ((data.generation ?? 0) !== generation) return null;
    return data.grantee;
  } catch (error) {
    return null;
  }
}

/**
 * The current generation for this world: the newest owner-signed record on
 * the event plane as this node has synced it, 0 when the owner never
 * re-rolled. Durable and photo-free — the same view the grantors 409-teach
 * from, so the record read above and the committee's judgment agree on
 * which world is current.
 */
async function currentGeneration(appName, role) {
  try {
    const record = await messageStore.getGrantGenerationRecord(appName, role);
    return record?.data?.generation ?? 0;
  } catch (error) {
    return 0;
  }
}

module.exports = {
  founderAsk,
};
