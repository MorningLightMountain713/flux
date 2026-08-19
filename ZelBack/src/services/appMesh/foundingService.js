'use strict';

const config = require('config');
const generalService = require('../generalService');
const messageStore = require('../appMessaging/messageStore');
const grantClient = require('../quorumGrant/grantClient');
const registryManager = require('../appDatabase/registryManager');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const serviceHelper = require('../serviceHelper');
const fluxEventBus = require('../utils/fluxEventBus');
const foundingCommittee = require('./foundingCommittee');
const log = require('../../lib/log');

const HEX64 = /^[0-9a-f]{64}$/;

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
  // The world is host-side knowledge (this node runs the container, so it
  // resolves the view): the intro anchor and every flip rung this node has
  // minted. Missing it is an honest "not yet" — never a no, never a minted
  // basis.
  const world = await foundingCommittee.componentWorld(appName, component);
  if (!world) return { answer: 'wait' };

  const token = foundingCommittee.founderToken(appName, component);
  const generation = await currentGeneration(appName);

  // Record first, NEWEST rung first (newest-decided-wins, §8.5): a decided
  // register's answer is a durable, fleet-synced fact, judged against the
  // durable generation record — the newest owner-record view, the same
  // source the grantors teach from. Neither read needs a photo, so a node
  // however young answers a founded world from its own database, and a
  // rejoining pocket's older founding retires the moment a higher rung's
  // record is known.
  for (const rung of [...world.rungs].reverse()) {
    const role = `founder-${token}@${rung}`;
    // eslint-disable-next-line no-await-in-loop
    const recorded = await recordedFounder(appName, role, generation);
    if (recorded) {
      const collateral = await generalService.obtainNodeCollateralInformation();
      const self = `${collateral.txhash}:${collateral.txindex}`;
      return settled(appName, component, recorded === self ? 'yes' : 'no');
    }
  }

  // Undecided everywhere — asker gates before any round (§8.5, both
  // model-forced): a stale chain view cannot know the current basis, and
  // an ARMED world (rot sustained, flip within the quiet zone) refuses to
  // start a founding that would race the flip's one-block gossip window.
  if (daemonServiceMiscRpcs.isDaemonSynced()?.data?.synced !== true) {
    return { answer: 'wait' };
  }
  if (world.armed) return { answer: 'wait' };

  // The round runs at the newest rung. The own photo is authoritative;
  // without one, a peer-DISCOVERED basis routes the asks — routing needs
  // no trust ("receiving a photo is believing" governs refereeing): every
  // grantor reached verifies the ask against ITS OWN photo and the
  // register is write-once, so a lying answer can only misroute asks to
  // nodes that refuse. Discovery may also know a NEWER rung than this
  // node has minted (a missed flip window); asking there is the same
  // trust story. Nothing discovered is ever stored.
  let rung = world.rungs[world.rungs.length - 1];
  let committee = await foundingCommittee.refereeCommittee(appName, rung);
  if (!committee) {
    const discovered = await discoveredBasis(appName, world.intro);
    if (discovered && discovered.rung >= rung) {
      ({ rung } = discovered);
      committee = discovered.basis;
    }
  }
  if (!committee) return { answer: 'wait' };

  const role = `founder-${token}@${rung}`;
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
 * The current generation for the app's founder plane: the newest
 * owner-signed record on the event plane as this node has synced it, 0
 * when the owner never re-rolled. Durable and photo-free — the same view
 * the grantors 409-teach from, so the record read above and the
 * committee's judgment agree on which world is current. The re-roll is one
 * record for the whole plane, stored at role `founder`.
 */
async function currentGeneration(appName) {
  try {
    const record = await messageStore.getGrantGenerationRecord(appName, 'founder');
    return record?.data?.generation ?? 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Ask the app's peers for the founding basis this node holds no photo for
 * — or a newer rung than it has minted. The app's other locations are the
 * natural photo-holders (they processed the same spec acts); the first
 * well-formed answer routes the round. Ephemeral by design: a discovered
 * basis is used for this ask and never persisted — persistence would turn
 * routing aid into believed history.
 *
 * @returns {Promise<{rung: number, basis: object}|null>}
 */
async function discoveredBasis(appName, anchor) {
  let locations;
  try {
    locations = await registryManager.appLocation(appName);
  } catch (error) {
    return null;
  }
  const timeout = config.fluxapps.quorumGrantAskTimeoutMs ?? 5_000;
  for (const location of locations ?? []) {
    if (typeof location?.ip !== 'string' || !location.ip) continue; // eslint-disable-line no-continue
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await serviceHelper.axiosGet(
        `http://${location.ip}/flux/quorumgrant/foundingbasis?app=${encodeURIComponent(appName)}&anchor=${anchor}`,
        { timeout },
      );
      const payload = response?.data?.data;
      if (Number.isInteger(payload?.rung) && payload.rung >= anchor && validBasis(payload?.basis)) {
        log.info(`foundingService - ${appName}@${anchor}: founding basis discovered from ${location.ip} at rung ${payload.rung}`);
        return { rung: payload.rung, basis: payload.basis };
      }
    } catch (error) {
      // an unreachable or unhelpful peer is a routing miss, not an answer
    }
  }
  return null;
}

/**
 * Shape gate for a peer-supplied basis — strict, because everything here is
 * untrusted input that will only ever be used to ADDRESS asks.
 */
function validBasis(basis) {
  return Boolean(basis)
    && typeof basis.fingerprint === 'string' && HEX64.test(basis.fingerprint)
    && Number.isInteger(basis.generation) && basis.generation >= 0
    && Number.isInteger(basis.quorum) && basis.quorum >= 1
    && Array.isArray(basis.members) && basis.members.length >= basis.quorum
    && basis.members.every((m) => typeof m?.ip === 'string' && m.ip.length > 0);
}

module.exports = {
  founderAsk,
};
