'use strict';

const config = require('config');
const dbHelper = require('../dbHelper');
const appsRepository = require('../appDatabase/appsRepository');
const networkStateService = require('../networkStateService');
const { selectCommittee } = require('../utils/committeeSelector');
const { globalAppStateEvents } = require('../utils/appConstants');
const log = require('../../lib/log');

// The founding committees, materialized: the photo, not the album. A founding
// committee must be ONE agreed set however late the founding happens, and the
// only moment everyone naturally shares the same list is when they process
// the owner-signed anchor that created the register — so that is when the
// committee is computed, once, and persisted. Nobody ever reconstructs a
// months-old node list; they read back what the fleet agreed when the list
// was current.
//
// Each component's founder register pins to the anchor that INTRODUCED the
// component: the registration for original components, the update that added
// it for later ones — every anchor an owner-signed, chain-confirmed act the
// whole live fleet witnesses inside its membership window. A component
// removed and later re-added under the same name is a NEW world with a new
// anchor: its old register cells and its old published record must never
// answer for it, or every container would wait forever to join a cluster
// that no longer exists.
//
// The pin is immutable; the membership is not. Reading back applies the exit
// rule: while at least a quorum's worth of the photo's owners remain on the
// CURRENT list, the recorded committee stands (listed today = alive today;
// members are reached at their current addresses). Below that, every reader
// re-derives a fresh committee from the current list — deterministic
// arithmetic over the same record and the same chain, so dead referees never
// wedge a register. Only lost MEMORY of the pin can, and the owner's
// generation re-roll re-anchors that to a recent height every node can walk.
//
// The component→anchor mapping is pure spec arithmetic — no membership
// needed — so EVERY node maintains it during catch-up, however young; only
// the photos themselves are window-bound.

const ONESHOT_COMMITTEE_SIZE = () => config.fluxapps.quorumGrantOneshotCommitteeSize ?? 9;

const collection = () => config.database.local.collections.foundingCommittees;

const DURABLE = { writeConcern: { w: 1, j: true } };

// One writer per app at a time: both materializers read-modify-write the
// same row, and a funnel pass racing a generation record must not lose
// either's fields. The chain never rejects — each link swallows its
// predecessor's error, which the predecessor's caller already received.
const inFlight = new Map();

function serialized(appName, operation) {
  const run = (inFlight.get(appName) ?? Promise.resolve())
    .catch(() => {})
    .then(operation);
  inFlight.set(appName, run);
  run.finally(() => {
    if (inFlight.get(appName) === run) inFlight.delete(appName);
  }).catch(() => {});
  return run;
}

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
 * Photograph the committee at a height, from this node's own window — or
 * null when the window does not cover it (an honest no-photo; minting one
 * from the current list would be exactly the two-photos hazard this record
 * exists to prevent).
 */
function photoAt(appName, height) {
  const fingerprint = networkStateService.membershipFingerprintAt(height);
  if (!fingerprint) return null;
  const membership = networkStateService.membershipAt(fingerprint);
  if (!membership) return null;

  const committee = selectCommittee(membership, `quorumgrant|${appName}/founder`, {
    size: ONESHOT_COMMITTEE_SIZE(),
  });
  if (committee.refusal) {
    log.warn(`foundingCommittee - ${appName} at ${height}: ${committee.refusal}`);
    return null;
  }
  return {
    fingerprint,
    height,
    quorum: committee.quorum,
    members: committee.members.map((member) => ({
      txhash: member.txhash,
      outidx: String(member.outidx),
      pubkey: member.pubkey,
      ip: member.ip,
    })),
    computedAt: Date.now(),
  };
}

/**
 * Maintain the app's founding row for one spec anchor: map every component
 * to the anchor that introduced it, drop removed components, and photograph
 * the committee for anything introduced here. Called from the registry's
 * single spec funnel on EVERY spec write — registration and update alike —
 * and no-throw: a failed materialization must never fail a spec store.
 *
 * Anchors only move forward: a component present in the previous mapping
 * keeps its anchor; one absent from it — brand new, or re-added after a
 * removal — pins here, which is what makes a re-add a fresh world.
 *
 * @param {object} specDoc the stored global spec (name, height, network, components)
 * @returns {Promise<void>}
 */
async function materializeFor(specDoc) {
  try {
    if (!isMeshSpec(specDoc) || !specDoc.name || !Number.isFinite(specDoc.height)) return;
    const names = Object.keys(specDoc.components ?? {});
    if (!names.length) return;
    await serialized(specDoc.name, () => applySpecAnchor(specDoc, names));
  } catch (error) {
    log.warn(`foundingCommittee - materialization for ${specDoc?.name} failed: ${error.message}`);
  }
}

async function applySpecAnchor(specDoc, names) {
  const database = db();
  if (!database) return;

  const existing = await dbHelper.findOneInDatabase(database, collection(), { _id: specDoc.name });
  // Spec anchors apply in chain order; a replay or an out-of-order
  // catch-up write changes nothing.
  if (existing && Number.isFinite(existing.specHeight) && specDoc.height <= existing.specHeight) return;

  // A component absent from the mapping — brand new, or re-added after a
  // removal — pins here. A standing owner re-roll lifts the pin to at least
  // its own height: on a node that processes this spec after the roll, the
  // max keeps the anchor identical to what in-order nodes computed when the
  // roll rewrote theirs — anchors converge whatever the arrival order.
  const rollFloor = (existing?.generation ?? 0) >= 1 ? existing.generationHeight : 0;
  const components = {};
  const introducedAt = new Set();
  names.forEach((name) => {
    const kept = existing?.components?.[name];
    if (kept) {
      components[name] = kept;
    } else {
      const anchorHeight = Math.max(specDoc.height, rollFloor);
      components[name] = { anchorHeight };
      introducedAt.add(anchorHeight);
    }
  });

  const photos = { ...(existing?.photos ?? {}) };
  introducedAt.forEach((height) => {
    if (photos[String(height)]) return;
    const photo = photoAt(specDoc.name, height);
    if (photo) photos[String(height)] = photo;
  });
  // A photo nothing references anymore describes worlds no register can
  // name; the generation photo survives on its own key.
  const referenced = new Set(Object.values(components).map((entry) => String(entry.anchorHeight)));
  if (existing && Number.isFinite(existing.generationHeight)) {
    referenced.add(String(existing.generationHeight));
  }
  Object.keys(photos).forEach((height) => {
    if (!referenced.has(height)) delete photos[height];
  });

  await dbHelper.findOneAndUpdateInDatabase(
    database,
    collection(),
    { _id: specDoc.name },
    {
      $set: { specHeight: specDoc.height, components, photos },
      $setOnInsert: { generation: 0 },
    },
    { upsert: true, ...DURABLE },
  );
  log.info(`foundingCommittee - ${specDoc.name} materialized at height ${specDoc.height}`);
}

/**
 * Re-materialize at an owner generation record's named height — the re-found
 * for founding and the tier-2 referee re-roll, one record re-dealing the
 * whole app. Only a node whose window covers the named height may act; a
 * node with NO row at all MINTS one from the record (it is owner-signed and
 * names the height, the same shared arithmetic as any anchor — and the
 * re-roll is the designed rescue for exactly the nodes that never witnessed
 * one). Generation-guarded: a lower generation never overwrites a higher
 * one, whatever order records arrive in.
 *
 * @param {{appName: string, generation: number, height: number}} record
 *   an ALREADY OWNER-VERIFIED generation record (the store verifies)
 * @returns {Promise<boolean>} whether this node now holds the generation
 */
async function materializeGeneration(record) {
  try {
    return await serialized(record.appName, () => applyGenerationRecord(record));
  } catch (error) {
    log.warn(`foundingCommittee - generation materialization for ${record?.appName} failed: ${error.message}`);
    return false;
  }
}

async function applyGenerationRecord(record) {
  const database = db();
  if (!database) return false;

  const photo = photoAt(record.appName, record.height);
  if (!photo) return false;

  const existing = await dbHelper.findOneInDatabase(database, collection(), { _id: record.appName });
  if (existing && (existing.generation ?? 0) >= record.generation) {
    // a lower or equal generation never overwrites; the call succeeds
    // because this node already holds at least the generation asked about
    return true;
  }

  // The roll lifts every mapped component's anchor to its height — the
  // whole app re-deals as one world — but never drags DOWN an anchor a
  // later spec act already advanced past it. On a node with no row at all
  // the mapping is minted from the stored spec (the rescue must not wait
  // on a funnel pass that may never come); no mesh spec, nothing to mint.
  let components = existing?.components ?? null;
  if (!components) {
    const spec = await appsRepository.getGlobalAppInfo(record.appName);
    if (!isMeshSpec(spec)) return false;
    components = {};
    Object.keys(spec.components ?? {}).forEach((name) => {
      components[name] = { anchorHeight: record.height };
    });
  } else {
    const lifted = {};
    Object.entries(components).forEach(([name, entry]) => {
      lifted[name] = { anchorHeight: Math.max(entry.anchorHeight, record.height) };
    });
    components = lifted;
  }

  const photos = { ...(existing?.photos ?? {}), [String(record.height)]: photo };
  const referenced = new Set(Object.values(components).map((entry) => String(entry.anchorHeight)));
  referenced.add(String(record.height));
  Object.keys(photos).forEach((height) => {
    if (!referenced.has(height)) delete photos[height];
  });

  await dbHelper.findOneAndUpdateInDatabase(
    database,
    collection(),
    { _id: record.appName },
    {
      $set: {
        generation: record.generation,
        generationHeight: record.height,
        components,
        photos,
      },
    },
    { upsert: true, ...DURABLE },
  );
  log.info(`foundingCommittee - ${record.appName} re-rolled to generation ${record.generation} at height ${record.height}`);
  return true;
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
 * The committee one component's founder register should use right now, and
 * the basis its asks must name. Three answers:
 *
 *   {members, quorum, fingerprint, anchor, repinned: false} — the photo stands
 *   {members, quorum, fingerprint, anchor, repinned: true}  — exit: fresh from the current list
 *   null — this node cannot answer honestly (no row, unknown or removed
 *          component, or a photo its window never covered)
 *
 * The owner's re-roll lifts every mapped anchor to at least its own height
 * — the whole app re-deals as one world — and a later spec act advances a
 * component's anchor past it again. Members carry their CURRENT listed
 * address where one exists; a delisted member keeps its seat in the
 * denominator and simply has nowhere to be reached — seats never quietly
 * vanish.
 *
 * @param {string} appName
 * @param {string} component
 * @returns {Promise<object|null>}
 */
async function effectiveCommittee(appName, component) {
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
  if (!record) return null;

  const generation = record.generation ?? 0;
  // The mapping is spec arithmetic, so it exists wherever the spec does —
  // an unmapped component is one this node does not know (or one the owner
  // removed), and the honest answer is no answer. The anchor already
  // incorporates any owner re-roll (the roll lifts every anchor to at
  // least its own height), so the anchor's photo IS the world's photo.
  const entry = record.components?.[component];
  if (!entry) return null;
  const anchor = entry.anchorHeight;
  const photo = record.photos?.[String(anchor)];
  if (!photo) return null;

  const currentFingerprint = networkStateService.membershipFingerprint();
  const current = currentFingerprint ? networkStateService.membershipAt(currentFingerprint) : null;
  if (!current) return null;
  const listedByOutpoint = new Map(current.map((node) => [`${node.txhash}:${node.outidx}`, node]));

  const listedOwners = new Set();
  photo.members.forEach((member) => {
    if (listedByOutpoint.has(outpointOf(member))) listedOwners.add(member.pubkey);
  });
  if (listedOwners.size >= photo.quorum) {
    return {
      repinned: false,
      generation,
      anchor,
      fingerprint: photo.fingerprint,
      quorum: photo.quorum,
      members: photo.members.map((member) => ({
        ...member,
        ip: listedByOutpoint.get(outpointOf(member))?.ip ?? null,
      })),
    };
  }

  // The exit: the photo's owners have churned below quorum — a fact every
  // reader computes identically from the same record and the same chain —
  // so the committee re-derives from the current list, behind the adoption
  // gate, with the boundary-overlap argument carrying the seam.
  const committee = selectCommittee(current, `quorumgrant|${appName}/founder`, {
    size: ONESHOT_COMMITTEE_SIZE(),
  });
  if (committee.refusal) return null;
  return {
    repinned: true,
    generation,
    anchor,
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
 * Whether THIS node sits on the effective founding committee for one
 * component's register — the grantor-side check for founder roles, answered
 * from the same record and the same arithmetic the candidates use. The ask
 * must name the committee's basis whole: the fingerprint AND the
 * generation. A retired generation is refused with the current number —
 * rounds run by two generations' committees against one register would be
 * two answers.
 *
 * @param {string} appName
 * @param {string} component
 * @param {string} askFingerprint the basis the ask names
 * @param {number} askGeneration the generation the ask names
 * @param {{txhash: string, txindex: number|string}} collateral this node's outpoint
 * @returns {Promise<{member: boolean, reason: string|null, quorum?: number,
 *   anchor?: number}>}
 */
async function selfOnFoundingCommittee(appName, component, askFingerprint, askGeneration, collateral) {
  const committee = await effectiveCommittee(appName, component);
  if (!committee) {
    return { member: false, reason: 'no honest committee basis on this node' };
  }
  if (committee.fingerprint !== askFingerprint) {
    return { member: false, reason: 'ask names a different committee basis' };
  }
  if (committee.generation !== askGeneration) {
    return { member: false, reason: `ask names generation ${askGeneration}, current is ${committee.generation}` };
  }
  const self = `${collateral.txhash}:${collateral.txindex}`;
  const member = committee.members.some((entry) => outpointOf(entry) === self);
  return {
    member,
    reason: member ? null : 'this node is not on that committee',
    quorum: committee.quorum,
    anchor: committee.anchor,
  };
}

module.exports = {
  materializeFor,
  materializeGeneration,
  effectiveCommittee,
  selfOnFoundingCommittee,
};
