'use strict';

const crypto = require('node:crypto');
const config = require('config');
const dbHelper = require('../dbHelper');
const networkStateService = require('../networkStateService');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { selectCommittee } = require('../utils/committeeSelector');
const { globalAppStateEvents } = require('../utils/appConstants');
const fluxEventBus = require('../utils/fluxEventBus');
const log = require('../../lib/log');

// The founding committees, materialized: the photo, not the album. A founding
// committee must be ONE agreed set however late the founding happens, and the
// only moment everyone naturally shares the same list is when they process an
// owner-signed spec anchor — so that is when committees are photographed,
// once per anchor, and persisted. Nobody ever reconstructs a months-old node
// list; they read back what the fleet agreed when the list was current.
//
// REFEREES ARE COMPONENT-BLIND. A committee member is an arbitrary fleet
// node, and for an encrypted app it can read nothing inside the envelope —
// not the components, not even the mesh flag. So the referee side of this
// module works from public registry metadata alone: every spec anchor of
// every v9 app gets a photo, and a founder register is served iff its key
// names an anchor this node photographed. Which components exist, and which
// register key belongs to which component, is knowledge that lives ONLY
// where the cleartext legitimately lives — the hosting nodes, which decrypt
// the spec to run the app and which are where the founder ask arrives. The
// component's name never travels: the register key carries a
// domain-separated hash token the hosts compute and everyone else treats as
// opaque.
//
// The pin is immutable; the membership is not. When a photo's owners rot
// below a quorum of the CURRENT list, the committee does NOT re-derive at
// read time — a read-time current list is a moving target two readers never
// share, which is the two-committees-one-register hazard the model runs
// broke (formal/founder-pin-expiry, §8.5). Instead THE FLIP: rot sustained
// for GateLag blocks arms the world, and at the next rung of a fixed grid
// (intro anchor + k·FlipN) every node photographs a NEW basis at that exact
// height — a different height, a different register key, one answer however
// late anyone computes it. Dead referees still never wedge a register; they
// just stop being able to wedge anyone else's view of WHICH register.

const ONESHOT_COMMITTEE_SIZE = () => config.fluxapps.quorumGrantOneshotCommitteeSize ?? 9;

// The flip dials. Code fallbacks like every other plane tunable. The dial
// rule (§8.5, David's catch): the gate's earliest fire — rot observed plus
// GATE_LAG — must exceed the unsynced self-clean horizon (~2 h: a segmented
// node removes its own apps), and delisting itself takes deconfirmation
// (≈5.3 h), so the defaults keep the pocket's world long dead before any
// successor basis can exist.
const FLIP_N = () => config.fluxapps.founderFlipNBlocks ?? 720; // rung grid, ~24 h
const GATE_LAG = () => config.fluxapps.founderGateLagBlocks ?? 240; // sustained rot, ~8 h
const QUIET_ZONE = () => config.fluxapps.founderQuietZoneBlocks ?? 10; // pre-flip, ~20 min
const FLIP_EVALUATE_MS = () => config.fluxapps.founderFlipEvaluateIntervalMs ?? 60_000;

const collection = () => config.database.local.collections.foundingCommittees;

const DURABLE = { writeConcern: { w: 1, j: true } };

function db() {
  const connection = dbHelper.databaseConnection();
  return connection ? connection.db(config.database.local.database) : null;
}

function outpointOf(member) {
  return `${member.txhash}:${member.outidx}`;
}

/**
 * The blinded component token that rides in founder register keys. Stable
 * everywhere the name is known, meaningless everywhere it is not — a
 * non-hosting node learns nothing about an encrypted app's insides from
 * the keys it referees.
 */
function founderToken(appName, component) {
  return crypto.createHash('sha256')
    .update(`fluxfounder|${appName}|${component}`)
    .digest('hex')
    .slice(0, 16);
}

// One writer per app at a time: the anchor recorder, the view mapper and
// the generation record all read-modify-write the same row. The chain never
// rejects — each link swallows its predecessor's error, which the
// predecessor's caller already received.
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
 * Record one spec anchor from public registry metadata — name, height,
 * version — and photograph the committee there. Runs on EVERY node for
 * every v9 spec write, encrypted or not: nothing here needs the envelope
 * opened. Anchors apply in chain order; a replay or an out-of-order
 * catch-up write changes nothing. No-throw — a failed materialization
 * never fails a spec store.
 */
async function recordAnchor(specDoc) {
  try {
    if (!specDoc?.name || !Number.isFinite(specDoc.height)) return;
    if ((specDoc.version ?? 0) < 9) return;
    await serialized(specDoc.name, () => applyAnchor(specDoc.name, specDoc.height));
  } catch (error) {
    log.warn(`foundingCommittee - anchor for ${specDoc?.name} failed: ${error.message}`);
  }
}

async function applyAnchor(appName, height) {
  const database = db();
  if (!database) return;

  const existing = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });
  if (existing && Number.isFinite(existing.specHeight) && height <= existing.specHeight) return;

  const anchors = { ...(existing?.anchors ?? {}) };
  if (!anchors[String(height)]) {
    const photo = photoAt(appName, height);
    if (photo) anchors[String(height)] = photo;
  }

  await dbHelper.findOneAndUpdateInDatabase(
    database,
    collection(),
    { _id: appName },
    {
      $set: { specHeight: height, anchors },
      $setOnInsert: { generation: 0 },
    },
    { upsert: true, ...DURABLE },
  );
  log.info(`foundingCommittee - ${appName} anchored at height ${height}`);
}

/**
 * Maintain the component→anchor mapping from the CLEARTEXT view of a spec
 * just stored — host-side knowledge, present exactly where the view can be
 * resolved and absent everywhere else, which is the design and not a gap.
 * A component absent from the mapping — brand new, or re-added after a
 * removal — pins at this spec act; a standing owner re-roll lifts the pin
 * to at least its own height, and the max keeps anchors identical whatever
 * order the roll and the specs arrive in.
 *
 * @param {{name: string, height: number, network?: object, components?: object}} view
 */
async function applyComponentView(view) {
  try {
    if (view?.network?.mesh !== true || !view.name || !Number.isFinite(view.height)) return;
    const names = Object.keys(view.components ?? {});
    if (!names.length) return;
    await serialized(view.name, () => applyMapping(view.name, view.height, names));
  } catch (error) {
    log.warn(`foundingCommittee - component view for ${view?.name} failed: ${error.message}`);
  }
}

async function applyMapping(appName, height, names) {
  const database = db();
  if (!database) return;

  const existing = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });
  if (existing?.mappedHeight !== undefined && height <= existing.mappedHeight) return;

  const rollFloor = (existing?.generation ?? 0) >= 1 ? existing.generationHeight : 0;
  const components = {};
  names.forEach((name) => {
    const kept = existing?.components?.[name];
    components[name] = kept ?? { anchorHeight: Math.max(height, rollFloor) };
  });

  await dbHelper.findOneAndUpdateInDatabase(
    database,
    collection(),
    { _id: appName },
    {
      $set: { mappedHeight: height, components },
      $setOnInsert: { generation: 0 },
    },
    { upsert: true, ...DURABLE },
  );
}

/**
 * Re-materialize at an owner generation record's named height — the
 * re-found for founding and the tier-2 referee re-roll, one record
 * re-dealing the whole app. Public-facts side: the record is owner-signed
 * and fleet-visible, its height is photographed like any anchor, and a
 * node with NO row at all mints one from it (the designed rescue for
 * nodes that never witnessed an anchor). Where a host-side mapping
 * exists, every pin lifts to at least the roll height — never dragging
 * DOWN an anchor a later spec act advanced. Generation-guarded: a lower
 * generation never overwrites a higher one, whatever order records
 * arrive in.
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

  const anchors = { ...(existing?.anchors ?? {}), [String(record.height)]: photo };
  const set = {
    generation: record.generation,
    generationHeight: record.height,
    anchors,
  };
  if (existing?.components) {
    const lifted = {};
    Object.entries(existing.components).forEach(([name, entry]) => {
      lifted[name] = { anchorHeight: Math.max(entry.anchorHeight, record.height) };
    });
    set.components = lifted;
  }

  await dbHelper.findOneAndUpdateInDatabase(
    database,
    collection(),
    { _id: record.appName },
    { $set: set, $setOnInsert: {} },
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
 * The committee for one ANCHOR of an app — the referee-side read, from
 * public facts alone. Three answers:
 *
 *   {members, quorum, fingerprint, anchor, repinned: false} — the photo stands
 *   {members, quorum, fingerprint, anchor, repinned: true}  — exit: fresh from the current list
 *   null — this node cannot answer honestly (no row, an anchor it never
 *          photographed, or no current list)
 *
 * An anchor this node never photographed is indistinguishable from one
 * that is not a real spec height, and both get the same honest null.
 * Members carry their CURRENT listed address where one exists; a delisted
 * member keeps its seat in the denominator and simply has nowhere to be
 * reached — seats never quietly vanish.
 *
 * @param {string} appName
 * @param {number} anchor a spec anchor height the ask names
 * @returns {Promise<object|null>}
 */
async function refereeCommittee(appName, anchor) {
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
  const photo = record.anchors?.[String(anchor)];
  if (!photo) return null;

  const currentFingerprint = networkStateService.membershipFingerprint();
  const current = currentFingerprint ? networkStateService.membershipAt(currentFingerprint) : null;
  if (!current) return null;
  const listedByOutpoint = new Map(current.map((node) => [`${node.txhash}:${node.outidx}`, node]));

  // The photo IS the committee for this basis, standing or rotted — rot is
  // the flip evaluator's business (a NEW basis at a fixed height), never a
  // read-time re-derivation: a current list is a moving target two readers
  // never share, and the model broke every variant of serving one register
  // from it (formal/founder-pin-expiry). Members keep their seats; delisted
  // members simply have nowhere to be reached.
  return {
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

/**
 * The rung ladder of one world: the intro anchor, then every flip rung this
 * node has minted, in order. Flip rungs live in `anchors` like any photo,
 * linked by `flipOf`.
 */
function worldRungs(record, introAnchor) {
  const rungs = [introAnchor];
  for (;;) {
    const next = Object.entries(record?.anchors ?? {})
      .find(([, photo]) => photo?.flipOf === rungs[rungs.length - 1]);
    if (!next) return rungs;
    rungs.push(Number(next[0]));
  }
}

/**
 * The first rung-grid height at which an armed world may flip: on the
 * world's own grid (intro + k·FlipN), past the newest rung, and no earlier
 * than the observed rot start plus the gate lag.
 */
function nextFlipHeight(introAnchor, newestRung, rotSinceHeight) {
  const floor = Math.max(rotSinceHeight + GATE_LAG(), newestRung + 1);
  const steps = Math.ceil((floor - introAnchor) / FLIP_N());
  return introAnchor + Math.max(steps, 1) * FLIP_N();
}

/**
 * How many of a photo's members remain on the current list — the standing
 * check the evaluator and nothing else consumes.
 */
function listedSeats(photo, listedByOutpoint) {
  return photo.members.filter((member) => listedByOutpoint.has(outpointOf(member))).length;
}

/**
 * One evaluator pass: for every world's newest rung, track sustained rot
 * and mint the flip photo once the gate holds. Deterministic per node given
 * the chain — the rung height is grid arithmetic, the photo is taken AT
 * that height (fingerprintAt window), and a node that misses the window
 * simply lacks the rung photo: record-first and discovery cover it, and a
 * conservative miss only delays a flip, never forks one.
 */
async function evaluateFlips() {
  const database = db();
  if (!database) return;
  const height = daemonServiceMiscRpcs.getCurrentDaemonHeight();
  if (!Number.isFinite(height) || height <= 0) return;
  const currentFingerprint = networkStateService.membershipFingerprint();
  const current = currentFingerprint ? networkStateService.membershipAt(currentFingerprint) : null;
  if (!current) return;
  const listedByOutpoint = new Map(current.map((node) => [`${node.txhash}:${node.outidx}`, node]));

  const rows = await dbHelper.findInDatabase(database, collection(), {}, { projection: {} });
  for (const row of rows ?? []) {
    const intros = Object.entries(row.anchors ?? {})
      .filter(([, photo]) => photo && photo.flipOf === undefined)
      .map(([h]) => Number(h));
    for (const intro of intros) {
      // eslint-disable-next-line no-await-in-loop
      await serialized(row._id, () => evaluateWorld(row._id, intro, height, listedByOutpoint));
    }
  }
}

async function evaluateWorld(appName, intro, height, listedByOutpoint) {
  const database = db();
  if (!database) return;
  const record = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });
  if (!record) return;
  const rungs = worldRungs(record, intro);
  const newest = rungs[rungs.length - 1];
  const photo = record.anchors?.[String(newest)];
  if (!photo) return;

  const standing = listedSeats(photo, listedByOutpoint) >= photo.quorum;
  if (standing) {
    if (photo.rotSinceHeight !== undefined) {
      await dbHelper.findOneAndUpdateInDatabase(
        database, collection(), { _id: appName },
        { $set: { anchors: { ...record.anchors, [String(newest)]: stripRot(photo) } } },
        DURABLE,
      );
    }
    return;
  }

  if (photo.rotSinceHeight === undefined) {
    await dbHelper.findOneAndUpdateInDatabase(
      database, collection(), { _id: appName },
      { $set: { anchors: { ...record.anchors, [String(newest)]: { ...photo, rotSinceHeight: height } } } },
      DURABLE,
    );
    return;
  }

  const flipHeight = nextFlipHeight(intro, newest, photo.rotSinceHeight);
  if (height < flipHeight || record.anchors?.[String(flipHeight)]) return;
  const flipPhoto = photoAt(appName, flipHeight);
  if (!flipPhoto) return; // window missed on this node — an honest gap, never a guess
  await dbHelper.findOneAndUpdateInDatabase(
    database, collection(), { _id: appName },
    { $set: { anchors: { ...record.anchors, [String(flipHeight)]: { ...flipPhoto, flipOf: newest } } } },
    DURABLE,
  );
  fluxEventBus.publish('quorumGrant:founderFlip', {
    appName, world: intro, rung: flipHeight, of: newest,
  });
  log.info(`foundingCommittee - ${appName} world ${intro} flipped to basis ${flipHeight} (rot since ${photo.rotSinceHeight})`);
}

function stripRot(photo) {
  const rest = { ...photo };
  delete rest.rotSinceHeight;
  return rest;
}

let flipTimer = null;

/** Start the flip evaluator chore. Idempotent; serviceManager calls once. */
function startFlipEvaluator() {
  if (flipTimer) return;
  flipTimer = setInterval(() => {
    evaluateFlips().catch((error) => log.error(`foundingCommittee - flip evaluation: ${error.message}`));
  }, FLIP_EVALUATE_MS());
  if (flipTimer.unref) flipTimer.unref();
}

/**
 * The anchor one component's founder register pins to — host-side
 * knowledge, null wherever the view was never resolvable (which for a
 * non-hosting node is the design, not a gap).
 */
async function componentAnchor(appName, component) {
  const database = db();
  if (!database) return null;
  const record = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });
  return record?.components?.[component]?.anchorHeight ?? null;
}

/**
 * One component's WORLD as this node knows it: the rung ladder from its
 * intro anchor through every minted flip, and whether the newest rung is
 * ARMED — rot sustained and the next flip within the quiet zone, the
 * chain-visible fact a fresh asker refuses to start a founding under
 * (§8.5: a completion landing one block before a flip loses a one-block
 * gossip race; the quiet zone closes that race entirely).
 */
async function componentWorld(appName, component) {
  const database = db();
  if (!database) return null;
  const record = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });
  const intro = record?.components?.[component]?.anchorHeight ?? null;
  if (intro === null) return null;

  const rungs = worldRungs(record, intro);
  const newest = rungs[rungs.length - 1];
  const photo = record.anchors?.[String(newest)];

  let armed = false;
  if (photo?.rotSinceHeight !== undefined) {
    const height = daemonServiceMiscRpcs.getCurrentDaemonHeight();
    if (Number.isFinite(height) && height > 0) {
      armed = nextFlipHeight(intro, newest, photo.rotSinceHeight) - height <= QUIET_ZONE();
    }
  }
  return { intro, rungs, armed };
}

/**
 * The APP's world: the ladder from the earliest component intro this node
 * recorded — what an ordinal register (per app, shared by every component a
 * node hosts) founds under. Components introduced later have their own
 * worlds for their own founder registers; the ordinals stay with the first.
 * Same shape as componentWorld; null until the app has a recorded anchor.
 *
 * @param {string} appName
 * @returns {Promise<{intro: number, rungs: number[], armed: boolean}|null>}
 */
async function appWorld(appName) {
  const database = db();
  if (!database) return null;
  const record = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });
  const intros = Object.values(record?.components ?? {})
    .map((entry) => entry?.anchorHeight)
    .filter((height) => Number.isInteger(height));
  if (!intros.length) return null;
  const intro = Math.min(...intros);

  const rungs = worldRungs(record, intro);
  const newest = rungs[rungs.length - 1];
  const photo = record.anchors?.[String(newest)];

  let armed = false;
  if (photo?.rotSinceHeight !== undefined) {
    const height = daemonServiceMiscRpcs.getCurrentDaemonHeight();
    if (Number.isFinite(height) && height > 0) {
      armed = nextFlipHeight(intro, newest, photo.rotSinceHeight) - height <= QUIET_ZONE();
    }
  }
  return { intro, rungs, armed };
}

/**
 * Whether THIS node sits on the committee for one anchor of an app — the
 * grantor-side check for founder registers, component-blind by design.
 * The ask must name the committee's basis whole: the fingerprint AND the
 * generation. A retired generation is refused with the current number —
 * rounds run by two generations' committees against one register would
 * be two answers.
 *
 * @param {string} appName
 * @param {number} anchor the spec anchor the register key names
 * @param {string} askFingerprint the basis the ask names
 * @param {number} askGeneration the generation the ask names
 * @param {{txhash: string, txindex: number|string}} collateral this node's outpoint
 * @returns {Promise<{member: boolean, reason: string|null, quorum?: number}>}
 */
async function selfOnFoundingCommittee(appName, anchor, askFingerprint, askGeneration, collateral) {
  // Founder-serving gates (§8.5, each a LOCAL fact, each model-forced):
  // a grantor whose own chain view is stale cannot know the current basis
  // (the dark-rot arm); one that can SEE itself delisted has no seat to
  // serve from (the collateral-moved arm). Founder registers only — HELD
  // asks pin to current fingerprints and keep their own rules.
  const synced = daemonServiceMiscRpcs.isDaemonSynced()?.data?.synced === true;
  if (!synced) {
    return { member: false, reason: 'own chain view is stale' };
  }
  const currentFingerprint = networkStateService.membershipFingerprint();
  const current = currentFingerprint ? networkStateService.membershipAt(currentFingerprint) : null;
  const self = `${collateral.txhash}:${collateral.txindex}`;
  if (current && !current.some((node) => `${node.txhash}:${node.outidx}` === self)) {
    return { member: false, reason: 'this node is no longer listed' };
  }

  const committee = await refereeCommittee(appName, anchor);
  if (!committee) {
    return { member: false, reason: 'no honest committee basis on this node' };
  }

  // EQUALITY serve (model run 6: the one-directional form leaked): this
  // node answers exactly the rung its own view holds newest for the asked
  // world — never a basis it has flipped past. The record answers decided
  // rungs; the register only ever collects at the current one.
  const database = db();
  const record = database
    ? await dbHelper.findOneInDatabase(database, collection(), { _id: appName }) : null;
  if (record) {
    const intro = introOf(record, anchor);
    const rungs = worldRungs(record, intro);
    const newest = rungs[rungs.length - 1];
    if (newest !== anchor) {
      return { member: false, reason: `basis flipped past — newest rung is ${newest}` };
    }
  }

  if (committee.fingerprint !== askFingerprint) {
    return { member: false, reason: 'ask names a different committee basis' };
  }
  if (committee.generation !== askGeneration) {
    return { member: false, reason: `ask names generation ${askGeneration}, current is ${committee.generation}` };
  }
  const member = committee.members.some((entry) => outpointOf(entry) === self);
  return {
    member,
    reason: member ? null : 'this node is not on that committee',
    quorum: committee.quorum,
  };
}

/** Walk flipOf links back from any rung to its world's intro anchor. */
function introOf(record, rung) {
  let at = rung;
  for (;;) {
    const photo = record.anchors?.[String(at)];
    if (photo?.flipOf === undefined) return at;
    at = photo.flipOf;
  }
}

/**
 * The newest rung this node holds for the world containing `anchor` —
 * referee-side and component-blind (the discovery endpoint's resolver).
 * Null when this node never photographed the world at all.
 */
async function newestRungFor(appName, anchor) {
  const database = db();
  if (!database) return null;
  const record = await dbHelper.findOneInDatabase(database, collection(), { _id: appName });
  if (!record?.anchors?.[String(anchor)]) return null;
  const rungs = worldRungs(record, introOf(record, anchor));
  return rungs[rungs.length - 1];
}

module.exports = {
  founderToken,
  recordAnchor,
  applyComponentView,
  materializeGeneration,
  refereeCommittee,
  componentAnchor,
  componentWorld,
  appWorld,
  newestRungFor,
  selfOnFoundingCommittee,
  evaluateFlips,
  startFlipEvaluator,
};
