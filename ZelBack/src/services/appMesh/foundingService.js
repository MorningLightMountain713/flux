'use strict';

const generalService = require('../generalService');
const messageStore = require('../appMessaging/messageStore');
const grantClient = require('../quorumGrant/grantClient');
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
// Each component founds its own register: the ask is scoped to the calling
// container, so the key names the caller's component and one committee —
// the app's founding committee — referees them all.

/**
 * Answer one component's founding ask.
 *
 * @param {string} appName
 * @param {string} component the calling container's component
 * @returns {Promise<{answer: 'yes'|'no'|'wait', retryAfterMs?: number}>}
 */
async function founderAsk(appName, component) {
  const committee = await foundingCommittee.effectiveCommittee(appName);
  if (!committee) {
    // No committee basis is an honest "not yet" — never a no, and never a
    // freshly minted basis. Sync will bring the record.
    return { answer: 'wait' };
  }

  const recorded = await recordedFounder(appName, component, committee.generation);
  if (recorded) {
    const collateral = await generalService.obtainNodeCollateralInformation();
    const self = `${collateral.txhash}:${collateral.txindex}`;
    return { answer: recorded === self ? 'yes' : 'no' };
  }

  const outcome = await grantClient.acquire(`${appName}/founder-${component}`, {
    mode: 'oneshot',
    committee,
  });
  if (outcome.granted) return { answer: 'yes' };
  if (outcome.founder) return { answer: 'no' };
  log.info(`foundingService - ${appName}/${component}: wait (${outcome.reason ?? `retry in ${outcome.retryAfterMs}ms`})`);
  return {
    answer: 'wait',
    ...(outcome.retryAfterMs ? { retryAfterMs: outcome.retryAfterMs } : {}),
  };
}

/**
 * The founder the published record names for this component under the
 * current generation, or null. Answering from the record spares the
 * committee a wire round per ask — a founding is durable, so once the
 * record has synced, every later ask is a local read. A record from a
 * retired generation is the dead world's and answers nothing.
 */
async function recordedFounder(appName, component, generation) {
  try {
    const record = await messageStore.getMasterleaseRecord(appName, `founder-${component}`);
    const data = record?.data;
    if (!data || data.mode !== 'oneshot' || typeof data.grantee !== 'string') return null;
    if ((data.generation ?? 0) !== generation) return null;
    return data.grantee;
  } catch (error) {
    return null;
  }
}

module.exports = {
  founderAsk,
};
