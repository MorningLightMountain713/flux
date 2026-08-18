'use strict';

const config = require('config');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const generalService = require('../generalService');
const networkStateService = require('../networkStateService');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const messageStore = require('../appMessaging/messageStore');
const reconcilerQueue = require('../appMonitoring/reconcilerQueue');
const fluxEventBus = require('../utils/fluxEventBus');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');
const { nowMs } = require('../utils/monotonicClock');
const grantClient = require('../quorumGrant/grantClient');
const log = require('../../lib/log');

// The activeStandby mastership consumer (doc §10.1): the seam between the
// grant plane and the reconciler. The reconciler asks one question per pass —
// "does the grant veto this component?" — and this module answers it
// VETO-ONLY: a lost grant answers desired:false, an unknown one defers
// bounded, and a held one answers nothing at all, falling through to the
// controllerDesired data gates exactly as today. It can never answer
// desired:true — the grant decides WHO may run, never THAT something runs.
//
// INERT BY DEFAULT, behind the config switch and the network's own version
// floor (see featureEnabled). The plane must never run beside the legacy
// election - two elections over one app is the split brain it exists to
// prevent - and the way that is guaranteed is SEQUENCING, not detection: the
// code ships everywhere inert, the enforced floor rises to the release that
// carries it, and only then does the flag mean anything. There is no runtime
// probe of what the fleet is running, because a node without this code cannot
// report that it lacks it: it can only fail to answer, exactly as a dead node
// does, and no probe can separate those two.
//
// The FluxOS-restart case shapes the unknown state: a restart wipes the
// in-memory holder while the container keeps running. Stopping a healthy
// master because this process rebooted would be self-inflicted failover, so
// unknown DEFERS (desired:null) while a re-acquire runs — the grantors
// remember their grantee, and incumbent priority makes that re-acquire
// immediate — and only past a bounded grace does unknown degrade to lost.
// Silence keeps the holder; absence of evidence authorizes nothing; and a
// bound turns "temporarily unsure" into "provably not mine" rather than
// letting a node run unverified forever.

const ROLE = 'master';

// The release that carries the grant plane, as a version the NETWORK enforces.
// Absent means the plane has not been pinned to a release yet and stays inert:
// there is no version to compare a floor against, so nothing can guarantee the
// code is everywhere.
function requiredFluxOSVersion() {
  return config.fluxapps.quorumGrantMinFluxOSVersion ?? null;
}

/**
 * Sequencing, not detection.
 *
 * A node that does not carry this code cannot say so - it can only fail to
 * answer, and so can a node that is dead, and so can a node behind a broken
 * path. No probe can tell those apart, which is why asking the fleet its
 * version at runtime cannot be made correct.
 *
 * So the plane does not ask. It governs only once `minimumFluxOSAllowedVersion`
 * - the floor the network already enforces on every node it will peer with -
 * has been raised to the release that carries it. At that point "every holder
 * speaks the plane" is enforced by the network rather than guessed by a probe,
 * and there is no mixed fleet left to detect.
 *
 * The flag may therefore be flipped at any time: it cannot engage the plane
 * before the floor makes it safe.
 */
function featureEnabled() {
  if (testOverrides.enabled !== null) return testOverrides.enabled;
  if (config.fluxapps.quorumGrantMastership !== true) return false;
  const required = requiredFluxOSVersion();
  if (!required) return false;
  return serviceHelper.minVersionSatisfy(config.minimumFluxOSAllowedVersion, required);
}

function unknownGraceMs() {
  if (testOverrides.unknownGraceMs !== null) return testOverrides.unknownGraceMs;
  return config.fluxapps.quorumGrantUnknownGraceMs ?? 120_000;
}

function pursuitIntervalMs() {
  return config.fluxapps.quorumGrantPursuitIntervalMs ?? 30_000;
}

function heldTtlMs() {
  return config.fluxapps.quorumGrantHeldTtlMs ?? 150_000;
}

const testOverrides = { enabled: null, unknownGraceMs: null };

// key -> monotonic ms of the last pursuit kick, jitter-spread
const pursuits = new Map();

// identifier -> monotonic ms the unknown state was first seen, for the bound
const unknownSince = new Map();

function keyFor(appName) {
  return `${appName}/${ROLE}`;
}


/**
 * Kick an acquisition if none is running and the last kick is stale. A
 * settled standby RESTS: while the published record names another node as
 * a live held master, pursuing adds nothing — the incumbent shield would
 * turn it away — and it costs exactly the thing the coast rule needs,
 * witnesses that are acquiring nothing. A dead master's record stops
 * being republished and its row ages out, and pursuit resumes on the row's
 * absence — freshness judged by the store's own expiry, never by this
 * node's clock against another's, and never by reachability. A record
 * naming THIS node never suppresses anything: the restart re-acquire must
 * stay immediate. When the master dies, whoever's jitter fires first wins
 * and the rest adopt. Demotion re-enters the reconciler through the
 * queue — the veto on the next pass is what stops the container.
 */
function pursue(identifier, appName) {
  const key = keyFor(appName);
  if (grantClient.holderFor(key) || grantClient.isAcquiring(key)) return;
  const last = pursuits.get(key) ?? 0;
  const interval = pursuitIntervalMs();
  const jittered = interval / 2 + Math.random() * interval;
  if (nowMs() - last < jittered) return;
  pursuits.set(key, nowMs());
  acquireUnlessSettled(identifier, appName, key);
}

async function acquireUnlessSettled(identifier, appName, key) {
  // The operator stop lock silences EVERY pursue trigger — the reconciler
  // seam, the syncthing decider, and the coordinate path alike. A stopped
  // component that wins a term parks it on a node that will not run the
  // container (the 1209 fleet measured a yielded master re-taking its own
  // released term through exactly the decider paths, which never used to
  // ask). Unknown operator state pursues — the lock refuses only when it is
  // readable and true, so a state-read hiccup costs nothing but this pass.
  try {
    if (await appsRuntimeState.isOperatorStopped(identifier)) return;
  } catch (error) {
    log.warn(`mastershipGrantGate - operator-state read before pursuing ${key} failed: ${error.message}`);
  }
  try {
    const record = await messageStore.getMasterleaseRecord(appName, ROLE);
    const data = record?.data;
    if (data?.grantee && data.mode === 'held') {
      const self = await generalService.obtainNodeCollateralInformation();
      if (data.grantee !== `${self.txhash}:${self.txindex}`) {
        // The record is durable and names the last known master; whether it
        // still stands is asked of the referees, never inferred from the
        // row's age. Only a positive lapse answer opens a pursuit — a live
        // incumbent shield anywhere, or plain silence, keeps this standby
        // resting, which keeps an islanded app's witness vouch clean.
        const lapsed = await grantClient.termLapsed(key);
        if (!lapsed) return;
      }
    }
  } catch (error) {
    // an unreadable record must not stop a pursuit — the grantors decide
    log.warn(`mastershipGrantGate - record read before pursuing ${key} failed: ${error.message}`);
  }

  grantClient.acquire(key, {
    mode: 'held',
    ttlMs: heldTtlMs(),
    onDemoted: (reason) => {
      log.warn(`mastershipGrantGate - ${identifier} demoted: ${reason}`);
      // A deposed master stops HARD and NOW, straight at docker: it has lost
      // the right to write, and every second it runs politely is a second
      // beside a legitimately started successor. The reconciler queue then
      // converges the durable state, but its pass latency plus a graceful
      // drain measured over a minute on the fleet - the demotion slack only
      // undercuts the grantors' lock-delay if the stop is immediate.
      dockerService.appDockerStop(identifier, 2).catch((error) => {
        log.warn(`mastershipGrantGate - hard stop of ${identifier} failed: ${error.message}`);
      });
      reconcilerQueue.enqueueComponent(identifier);
    },
  }).then((outcome) => {
    if (outcome.granted) {
      log.info(`mastershipGrantGate - ${identifier} holds ${key} (epoch ${outcome.holder.epoch})`);
      if (outcome.deposed) raiseFence(appName, outcome.deposed);
      reconcilerQueue.enqueueComponent(identifier);
    }
    return outcome;
  }).catch((error) => {
    log.warn(`mastershipGrantGate - pursuit of ${key} failed: ${error.message}`);
  });
}

/**
 * The reconciler seam. Answers null to stay out of the way — feature off,
 * not an activeStandby component, or a mixed fleet — and otherwise a
 * veto-only verdict:
 *
 *   held                        -> null (fall through; the data gates decide)
 *   another node holds          -> { desired: false } — a standby stays down
 *   unknown, within the grace   -> { desired: null } — leave as-is, re-acquiring
 *   unknown, past the grace     -> { desired: false } — fail closed
 *
 * @param {string} identifier component identifier
 * @param {object} comp the deployment component (hasActiveStandbySyncthing, appName)
 * @returns {Promise<{desired: false|null, reason: string}|null>}
 */
async function grantVerdict(identifier, comp) {
  if (!featureEnabled()) return null;
  if (!comp?.hasActiveStandbySyncthing?.()) return null;

  const { appName } = comp;

  const key = keyFor(appName);
  if (grantClient.holderFor(key)) {
    unknownSince.delete(identifier);
    return null;
  }

  pursue(identifier, appName);

  // a fresh published record naming someone else is a settled answer, not an
  // unknown: this node is a standby and its container stays down
  try {
    const record = await messageStore.getMasterleaseRecord(appName, ROLE);
    const grantee = record?.data?.grantee ?? null;
    if (grantee) {
      const self = await generalService.obtainNodeCollateralInformation();
      if (grantee !== `${self.txhash}:${self.txindex}`) {
        unknownSince.delete(identifier);
        return { desired: false, reason: 'peerHoldsGrant' };
      }
    }
  } catch (error) {
    log.warn(`mastershipGrantGate - record read for ${appName} failed: ${error.message}`);
  }

  const firstSeen = unknownSince.get(identifier) ?? nowMs();
  unknownSince.set(identifier, firstSeen);
  if (nowMs() - firstSeen <= unknownGraceMs()) {
    return { desired: null, reason: 'grantUnknown' };
  }
  return { desired: false, reason: 'grantNotHeld' };
}

/**
 * Whether the grant currently wants this component NOT started — the
 * actuation-time re-read and the volume-unavailable stop both key on it.
 */
async function blocksStart(identifier, comp) {
  const verdict = await grantVerdict(identifier, comp);
  return verdict !== null;
}

/**
 * The seed/leader answer for the syncthing state machine's cold-start
 * election. null = not applicable (feature off, not activeStandby, mixed
 * fleet) and the lowest-IP election stands; otherwise a boolean naming
 * whether THIS node is the leader — the grant holder, and nobody else. A
 * non-holder answering false still kicks the pursuit: becoming leader goes
 * through acquisition, never through winning an address sort.
 *
 * @param {string} identifier component identifier
 * @param {string} appName
 * @param {boolean} isActiveStandby
 * @returns {Promise<boolean|null>}
 */
async function leaderIsSelf(identifier, appName, isActiveStandby) {
  if (!featureEnabled() || !isActiveStandby) return null;
  if (grantClient.holderFor(keyFor(appName))) return true;
  pursue(identifier, appName);
  return false;
}

/**
 * The coordinator's intent source under the grant (the stamped FDM decision,
 * (a) form): the published record's grantee, resolved to its current listed
 * address, in the same shape the FDM read answers — so the coordinator's
 * downstream actuation does not change at all. null = not applicable and the
 * FDM read stands. `ip: null` = the plane is on but nothing is granted yet:
 * no primary exists, and becoming one goes through acquisition, never
 * through the no-primary self-election branch.
 *
 * @param {string} identifier component identifier
 * @param {object} comp the activeStandby deployment component
 * @returns {Promise<{ip: string|null, fdmOk: true}|null>}
 */
async function masterIntent(identifier, comp) {
  if (!featureEnabled()) return null;
  if (!comp?.hasActiveStandbySyncthing?.()) return null;

  pursue(identifier, comp.appName);

  try {
    const record = await messageStore.getMasterleaseRecord(comp.appName, ROLE);
    const grantee = record?.data?.grantee ?? null;
    if (!grantee) return { ip: null, fdmOk: true };
    const membership = networkStateService.membershipAt(networkStateService.membershipFingerprint()) ?? [];
    const node = membership.find((entry) => `${entry.txhash}:${entry.outidx}` === grantee);
    // a grantee that has left the list resolves to no primary rather than to
    // a stale address; its term expires on its own and the record with it
    return { ip: node?.ip ?? null, fdmOk: true };
  } catch (error) {
    log.warn(`mastershipGrantGate - intent read for ${comp.appName} failed: ${error.message}`);
    return { ip: null, fdmOk: true };
  }
}

// app -> monotonic ms of the last cooperative self-demotion (folder set
// receiveonly + local changes reverted). The deposed node's own attestation
// that its data can no longer win — what a fencing master consults before
// re-adding the device.
const folderDemotions = new Map();

/** The syncthing state machine reports its cooperative self-fence here. */
function noteFolderDemoted(appName) {
  folderDemotions.set(appName, nowMs());
}

/** Monotonic ms of the app's last self-demotion, or null. */
function folderDemotedAt(appName) {
  return folderDemotions.get(appName) ?? null;
}

// The peer fence (the wedged-deposed case): app -> {outpoint, host, since}.
// Declarative — the syncthing monitor consults fenceFor() every pass and
// keeps the folder's device list and the device's autoAcceptFolders in
// agreement with it, so the fence cannot be forgotten by a missed pass or
// silently reversed by syncthing's auto-accept (the trap the lease design
// found in the source). Lifting is event-driven and comes from the one
// party that knows: the deposed node's own witness attestation that it has
// demoted and reverted. A node too dead to answer stays fenced.
const fences = new Map();

// app -> monotonic ms of the last lift poll, so a standing fence costs one
// ask per interval, not one per monitor pass
const liftPolls = new Map();

/**
 * Raise the fence against a superseded grantee. Resolved to a host now —
 * the fence outlives the deposed node's list entry, and a fence that could
 * no longer name its target would lift by accident.
 */
function raiseFence(appName, deposedOutpoint) {
  const membership = networkStateService.membershipAt(networkStateService.membershipFingerprint()) ?? [];
  const node = membership.find((entry) => `${entry.txhash}:${entry.outidx}` === deposedOutpoint);
  if (!node) {
    log.warn(`mastershipGrantGate - deposed ${deposedOutpoint} of ${appName} is not listed; nothing to fence`);
    return;
  }
  fences.set(appName, {
    outpoint: deposedOutpoint, host: extractIp(node.ip), address: node.ip, since: nowMs(),
  });
  log.warn(`mastershipGrantGate - fencing ${extractIp(node.ip)} out of ${appName}'s folder until it attests demotion`);
  fluxEventBus.publish('quorumGrant:fenceRaised', {
    app: appName, deposed: deposedOutpoint, host: extractIp(node.ip),
  });
}

function liftFence(appName, reason) {
  if (fences.delete(appName)) {
    log.info(`mastershipGrantGate - fence on ${appName} lifted: ${reason}`);
    // the lift can only happen through the deposed node's own attestation
    // (or a fresh grant superseding the fence) — publishing it is what lets
    // the harness assert the raise→attest→lift cycle end to end. publish()
    // is a no-op outside the harness.
    fluxEventBus.publish('quorumGrant:fenceLifted', { app: appName, reason });
  }
}

/**
 * The standing fence for an app, or null. Consulting it also advances the
 * lift poll: while a fence stands, the deposed node's witness endpoint is
 * asked (throttled) whether it has demoted and reverted, and its own
 * attestation is what re-admits it.
 */
function fenceFor(appName) {
  const fence = fences.get(appName) ?? null;
  if (fence) pollFenceLift(appName, fence);
  return fence;
}

async function pollFenceLift(appName, fence) {
  const last = liftPolls.get(appName) ?? 0;
  if (nowMs() - last < pursuitIntervalMs()) return;
  liftPolls.set(appName, nowMs());
  try {
    const url = `http://${extractIp(fence.address)}:${extractPort(fence.address)}/flux/quorumgrant/witness`;
    const response = await serviceHelper.axiosPost(url, { key: keyFor(appName) }, { timeout: 5_000 });
    const answer = response?.data?.data;
    if (answer && answer.folderDemotedAt !== null && answer.folderDemotedAt !== undefined && !answer.holding) {
      liftFence(appName, 'the deposed node attests it demoted and reverted');
    }
  } catch (error) {
    // silence keeps the fence — exactly right for a node still down
  }
}

/**
 * Teardown hook, called from hard/softUninstallComponent — the two paths
 * every removal reaches at component granularity (the removedIdentifiers
 * loop does NOT: soft redeploys never get there, and a grant leaked through
 * a redeploy would shield a master that no longer exists). Voluntary
 * release, so successors pay no lock-delay.
 */
async function onComponentTeardown(identifier, comp) {
  if (!comp?.hasActiveStandbySyncthing?.()) return;
  unknownSince.delete(identifier);
  const holder = grantClient.holderFor(keyFor(comp.appName));
  if (!holder) return;
  try {
    await holder.release();
    log.info(`mastershipGrantGate - released ${keyFor(comp.appName)} on teardown of ${identifier}`);
  } catch (error) {
    log.warn(`mastershipGrantGate - release on teardown of ${identifier} failed: ${error.message}`);
  }
}

/**
 * The operator's grant-layer verb (`appyield`): voluntarily release this
 * node's held mastership grant so a standby can be seated with NO lock-delay.
 * The caller MUST have applied the durable operator stop first — a released
 * grant is free for anyone including this node's own gate, and the first
 * fleet run measured exactly that: released before locking, the ex-master's
 * gate re-acquired within one pass and the standbys rested against it
 * forever. Intent must arrive as a command — the plane never infers grant
 * intent from container state, because a stopped container cannot say
 * whether the operator wanted maintenance (`appstop`: the grant holds, no
 * failover behind their back) or failover (this). On a non-holder it is a
 * no-op, so the global fan-out stays idempotent: every instance stops, only
 * the master releases.
 */
async function yieldMastership(appName) {
  const key = keyFor(appName);
  // The fast-succession interleave: a yield can land while this node's own
  // gate is mid-pursuit (it may already be chasing a term another node just
  // yielded). The acquire completes milliseconds later and would seat a
  // master whose container the operator just stopped — so settle the
  // in-flight acquisition first, bounded by an acquisition's own worst-case
  // wire time, and release whatever it won.
  const settleDeadline = nowMs() + 20_000;
  while (grantClient.isAcquiring(key) && !grantClient.holderFor(key) && nowMs() < settleDeadline) {
    // eslint-disable-next-line no-await-in-loop -- deliberately serial: this IS the wait
    await new Promise((resolve) => { setTimeout(resolve, 250); });
  }
  const holder = grantClient.holderFor(key);
  if (!holder) return { held: false };
  try {
    await holder.release();
    log.info(`mastershipGrantGate - yielded ${key} on operator command`);
    fluxEventBus.publish('quorumGrant:yielded', { key });
    return { held: true };
  } catch (error) {
    log.warn(`mastershipGrantGate - yield of ${key} failed: ${error.message}`);
    return { held: true };
  }
}

/** Test seam. */
function resetForTests(options = {}) {
  testOverrides.enabled = options.enabled ?? null;
  testOverrides.unknownGraceMs = options.unknownGraceMs ?? null;
  pursuits.clear();
  unknownSince.clear();
  folderDemotions.clear();
  fences.clear();
  liftPolls.clear();
}

module.exports = {
  grantVerdict,
  blocksStart,
  leaderIsSelf,
  masterIntent,
  noteFolderDemoted,
  folderDemotedAt,
  fenceFor,
  raiseFence,
  liftFence,
  onComponentTeardown,
  yieldMastership,
  resetForTests,
};
