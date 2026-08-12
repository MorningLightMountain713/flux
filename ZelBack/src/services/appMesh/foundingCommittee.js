'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const networkStateService = require('../networkStateService');
const { selectCommittee } = require('../utils/committeeSelector');
const { globalAppStateEvents } = require('../utils/appConstants');
const log = require('../../lib/log');

// The founding committee, materialized: the photo, not the album. A founding
// committee must be ONE agreed set however late the founding happens, and the
// only moment everyone naturally shares the same list is when they process
// the app's registration — so that is when the committee is computed, once,
// and persisted as a ~700-byte record. Nobody ever reconstructs a months-old
// node list; they read back what the fleet agreed when the list was current.
//
// The record is written by every node that processes the registration inside
// its own membership window. A node that processes it late (bulk catch-up on
// an old app) stores nothing rather than guessing — it can still VERIFY a
// committee another way (the §5 re-pin arithmetic below), it just cannot
// mint the original photo it never saw.
//
// Reading back applies the §5 exit rule: while at least a quorum's worth of
// the recorded owners remain on the CURRENT list, the recorded committee
// stands (listed today = alive today; nothing asks referees to have been
// online in between). Below that, every reader re-derives a fresh committee
// from the current list — deterministic arithmetic over the same record and
// the same chain, behind the adoption gate, with the boundary-overlap
// argument (§5) making crossing-block quorums intersect structurally.

const ONESHOT_COMMITTEE_SIZE = () => config.fluxapps.quorumGrantOneshotCommitteeSize ?? 9;

const collection = () => config.database.local.collections.foundingCommittees;

function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(config.database.local.database) : null;
}

function isMeshSpec(specDoc) {
  return specDoc?.network?.mesh === true;
}

function outpointOf(member) {
  return `${member.txhash}:${member.outidx}`;
}

/**
 * Materialize the founding committee for a just-stored mesh app spec, once.
 * Called from the registry's single spec funnel; absent-only, no-throw — a
 * failed materialization must never fail a spec store, and read-time covers
 * the gap.
 *
 * @param {object} specDoc the stored global spec (name, height, network)
 * @returns {Promise<void>}
 */
async function materializeFor(specDoc) {
  try {
    if (!isMeshSpec(specDoc) || !specDoc.name || !Number.isFinite(specDoc.height)) return;
    const database = db();
    if (!database) return;

    const existing = await dbHelper.findOneInDatabase(database, collection(), { _id: specDoc.name });
    if (existing) return;

    const fingerprint = networkStateService.membershipFingerprintAt(specDoc.height);
    if (!fingerprint) {
      // processing an app older than this node's own window — an honest
      // no-photo; minting one from the current list here would be exactly
      // the two-photos hazard this record exists to prevent
      return;
    }
    const membership = networkStateService.membershipAt(fingerprint);
    if (!membership) return;

    const committee = selectCommittee(membership, `quorumgrant|${specDoc.name}/founder`, {
      size: ONESHOT_COMMITTEE_SIZE(),
    });
    if (committee.refusal) {
      log.warn(`foundingCommittee - ${specDoc.name}: ${committee.refusal}`);
      return;
    }

    await dbHelper.findOneAndUpdateInDatabase(
      database,
      collection(),
      { _id: specDoc.name },
      {
        $setOnInsert: {
          generation: 0,
          fingerprint,
          height: specDoc.height,
          quorum: committee.quorum,
          members: committee.members.map((member) => ({
            txhash: member.txhash,
            outidx: String(member.outidx),
            pubkey: member.pubkey,
            ip: member.ip,
          })),
          computedAt: Date.now(),
        },
      },
      { upsert: true, writeConcern: { w: 1, j: true } },
    );
    log.info(`foundingCommittee - materialized for ${specDoc.name} at height ${specDoc.height}`);
  } catch (error) {
    log.warn(`foundingCommittee - materialization for ${specDoc?.name} failed: ${error.message}`);
  }
}

/**
 * Re-materialize the committee at an owner generation record's named height —
 * the §8.3 re-found and the §7.1 tier-2 re-roll, both landing here. Only a
 * node whose window covers the named height may act; anyone else keeps its
 * older record and answers honestly until sync or a fresh record helps it.
 * The write is generation-guarded: a lower generation never overwrites a
 * higher one, whatever order records arrive in.
 *
 * @param {{appName: string, generation: number, height: number}} record
 *   an ALREADY OWNER-VERIFIED generation record (the store verifies)
 * @returns {Promise<boolean>} whether this node now holds the generation
 */
async function materializeGeneration(record) {
  try {
    const database = db();
    if (!database) return false;

    const fingerprint = networkStateService.membershipFingerprintAt(record.height);
    if (!fingerprint) return false;
    const membership = networkStateService.membershipAt(fingerprint);
    if (!membership) return false;

    const committee = selectCommittee(membership, `quorumgrant|${record.appName}/founder`, {
      size: ONESHOT_COMMITTEE_SIZE(),
    });
    if (committee.refusal) {
      log.warn(`foundingCommittee - generation ${record.generation} for ${record.appName}: ${committee.refusal}`);
      return false;
    }

    await dbHelper.updateOneInDatabase(
      database,
      collection(),
      { _id: record.appName, $or: [{ generation: { $lt: record.generation } }, { generation: { $exists: false } }] },
      {
        $set: {
          generation: record.generation,
          fingerprint,
          height: record.height,
          quorum: committee.quorum,
          members: committee.members.map((member) => ({
            txhash: member.txhash,
            outidx: String(member.outidx),
            pubkey: member.pubkey,
            ip: member.ip,
          })),
          computedAt: Date.now(),
        },
      },
      { upsert: false, writeConcern: { w: 1, j: true } },
    );
    log.info(`foundingCommittee - ${record.appName} re-rolled to generation ${record.generation} at height ${record.height}`);
    return true;
  } catch (error) {
    log.warn(`foundingCommittee - generation materialization for ${record?.appName} failed: ${error.message}`);
    return false;
  }
}

/**
 * The newest owner generation record for the app's founder plane, read
 * directly from the synced event store (never through messageStore — that
 * module consumes this one).
 */
async function newestGenerationRecord(appName) {
  const connection = dbHelper.databaseConnection();
  if (!connection) return null;
  const database = connection.db(config.database.appsglobal.database);
  const row = await dbHelper.findOneInDatabase(
    database,
    globalAppStateEvents,
    { type: 'grantgeneration', dedupKey: `grantgeneration:${appName}/founder` },
  );
  return row?.data ?? null;
}

/**
 * The committee a founding ask should use right now, and the basis it must
 * name. Three answers:
 *
 *   {members, quorum, fingerprint, repinned: false}  — the recorded photo stands
 *   {members, quorum, fingerprint, repinned: true}   — §5 exit: fresh from the current list
 *   null                                             — this node cannot answer honestly
 *
 * Members carry their CURRENT listed address where one exists (asks need
 * somewhere to go); a delisted member keeps its seat in the denominator and
 * simply has nowhere to be reached — seats never quietly vanish.
 *
 * @param {string} appName
 * @returns {Promise<object|null>}
 */
async function effectiveCommittee(appName) {
  const database = db();
  if (!database) return null;
  let record = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });

  // An owner generation record outranks whatever is stored: try to catch up
  // in place, and when this node's window cannot reach the named height,
  // answer nothing rather than serve a retired generation — a stale
  // committee served confidently is the two-bases hazard.
  const generationRecord = await newestGenerationRecord(appName);
  if (generationRecord && generationRecord.generation > (record?.generation ?? 0)) {
    const caughtUp = await materializeGeneration(generationRecord);
    if (!caughtUp) return null;
    record = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });
  }

  // No record is an honest "I never witnessed this app's photo": the answer
  // is wait, never a freshly-minted basis — a young node deriving from ITS
  // current list while in-window nodes hold the true photo is exactly the
  // two-photos split. The §5 exit below re-derives only FROM the shared
  // record, which every participant holds identically.
  if (!record) return null;

  const currentFingerprint = networkStateService.membershipFingerprint();
  const current = currentFingerprint ? networkStateService.membershipAt(currentFingerprint) : null;
  if (!current) return null;
  const listedByOutpoint = new Map(current.map((node) => [`${node.txhash}:${node.outidx}`, node]));

  const listedOwners = new Set();
  record.members.forEach((member) => {
    if (listedByOutpoint.has(outpointOf(member))) listedOwners.add(member.pubkey);
  });
  if (listedOwners.size >= record.quorum) {
    return {
      repinned: false,
      generation: record.generation ?? 0,
      fingerprint: record.fingerprint,
      quorum: record.quorum,
      members: record.members.map((member) => ({
        ...member,
        ip: listedByOutpoint.get(outpointOf(member))?.ip ?? null,
      })),
    };
  }

  // The §5 exit: the recorded owners have churned below quorum — a fact
  // every reader computes identically from the same record and the same
  // chain — so the committee re-derives from the current list, behind the
  // adoption gate, with the boundary-overlap argument carrying the seam.
  const committee = selectCommittee(current, `quorumgrant|${appName}/founder`, {
    size: ONESHOT_COMMITTEE_SIZE(),
  });
  if (committee.refusal) return null;
  return {
    repinned: true,
    generation: record.generation ?? 0,
    fingerprint: currentFingerprint,
    quorum: committee.quorum,
    members: committee.members.map((member) => ({
      txhash: member.txhash,
      outidx: String(member.outidx),
      pubkey: member.pubkey,
      ip: member.ip,
    })),
  };
}

/**
 * Whether THIS node sits on the app's effective founding committee — the
 * grantor-side check for founder roles, answered from the same record and
 * the same arithmetic the candidates use.
 *
 * @param {string} appName
 * @param {string} askFingerprint the basis the ask names
 * @param {{txhash: string, txindex: number|string}} collateral this node's outpoint
 * @returns {Promise<{member: boolean, reason: string|null, quorum?: number}>}
 */
async function selfOnFoundingCommittee(appName, askFingerprint, collateral) {
  const committee = await effectiveCommittee(appName);
  if (!committee) {
    return { member: false, reason: 'no honest committee basis on this node' };
  }
  if (committee.fingerprint !== askFingerprint) {
    return { member: false, reason: 'ask names a different committee basis' };
  }
  const self = `${collateral.txhash}:${collateral.txindex}`;
  const member = committee.members.some((entry) => outpointOf(entry) === self);
  return {
    member,
    reason: member ? null : 'this node is not on that committee',
    quorum: committee.quorum,
  };
}

module.exports = {
  materializeFor,
  materializeGeneration,
  effectiveCommittee,
  selfOnFoundingCommittee,
};
