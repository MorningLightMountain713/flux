'use strict';

const config = require('config');
const serviceHelper = require('../serviceHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
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
const grantClientCore = require('../quorumGrant/grantClientCore');
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
// master because this process rebooted would be self-inflicted failover.
//
// There is NO TIMER here, and that is a proof rather than a preference. A node
// that lost its term knowledge at U knows the term ends no LATER than U + TTL,
// but safety needs the EARLIEST possible end, and that is unbounded below — the
// term may already be gone. So no value is sound: a short one kills healthy
// masters and a long one lets a lapsed holder keep writing. The node asks
// instead of counting — grantClient.relearn reads a QUORUM of registers, and
// those reads are served THROUGH the grantors' rejoin drain, so the answer
// arrives at exactly the moment acquisition is being refused.
//
// That moment is the production case. On a 10-node fleet the grantors were
// inside their drain, refused 30 of 31 asks, the old 120s grace expired, and
// the reconciler stopped a healthy master 22 seconds before that same node was
// granted its term back. Re-learning removes the race rather than re-tuning it.

const ROLE = 'master';

// The block at which the plane starts governing. Absent means it has not been
// scheduled yet and the plane stays inert.
function activationHeight() {
  if (testOverrides.activationHeight !== null) return testOverrides.activationHeight;
  const height = config.fluxapps.quorumGrantActivationHeight;
  return Number.isInteger(height) && height > 0 ? height : null;
}

/**
 * Sequencing, not detection - and the chain is the clock.
 *
 * A node that does not carry this code cannot say so: it can only fail to answer,
 * and so can a dead node, and so can one behind a broken path. No probe tells
 * those apart, so asking the fleet its version at runtime cannot be made correct.
 * That much the network already solves: `minimumFluxOSAllowedVersion` is refused
 * at handshake, so a node without the release is not on the network to run a
 * competing election. PRESENCE is settled before this function is reached.
 *
 * What a version floor cannot settle is WHEN. Each node satisfies a version
 * comparison the moment it upgrades, and upgrades are staggered - the watchdog
 * spreads them over hours. During that window some nodes would be granting while
 * others were still electing, which is the split brain this plane exists to
 * prevent, arriving on the way in.
 *
 * A height is the one value every node agrees on without asking anyone. Past the
 * block or not, same answer everywhere, at the same time. So the floor guarantees
 * everyone HAS it and the height decides when everyone USES it, and neither
 * substitutes for the other.
 *
 * The flag may still be flipped at any time; it cannot engage the plane before
 * the height, and the height must be scheduled far enough out for the floor to
 * have been raised first. That ordering is release management, not a runtime
 * check: a height that arrives while nodes below the floor are still on the
 * network is a scheduling mistake no config value here can catch.
 */
// A1: the plane's safety inequality, checked before it governs anything rather
// than described in a comment. slack + hard stop must be STRICTLY under the
// grantors' lock-delay, or a demoted holder is still stopping when its
// successor is granted.
//
// This is the whole clock-rate-skew budget of the plane. §7 used to credit the
// TTL:deadline ratio with that job and the code has no such ratio - the
// holder's deadline IS the TTL - so the lock-delay carries it alone and
// lowering it spends the margin silently.
//
// FAIL-CLOSED, not fail-loud. The plane is inert by default and the legacy
// election is what runs without it, so refusing to engage falls back to
// today's behaviour. Throwing would brick a node over a feature it is not
// using, which is a worse outcome than the bug.
let timingWarned = false;
function timingSafe() {
  const outcome = grantClientCore.timingIsSafe({
    demotionSlackMs: config.fluxapps.quorumGrantDemotionSlackMs ?? 15_000,
    hardStopMs: grantClientCore.HARD_STOP_MS,
    lockDelayMs: config.fluxapps.quorumGrantLockDelayMs ?? 30_000,
    renewIntervalMs: config.fluxapps.quorumGrantRenewIntervalMs ?? 20_000,
  });
  if (!outcome.safe && !timingWarned) {
    timingWarned = true;
    log.error(`mastershipGrantGate - the plane stays INERT: ${outcome.reason}`);
  }
  return outcome.safe;
}

/**
 * The node's own view of the chain against the scheduled activation, or null
 * when the plane cannot engage at all: flag off, timing unsafe, no height
 * scheduled, or a node that cannot say where the chain is - unsynced or
 * unknown reads as NOT reached, because a node that cannot place the tip must
 * not be the one deciding the plane has started.
 */
function planeView() {
  if (config.fluxapps.quorumGrantMastership !== true) return null;
  if (!timingSafe()) return null;
  const activateAt = activationHeight();
  if (!activateAt) return null;
  const { height, synced } = daemonServiceMiscRpcs.isDaemonSynced().data ?? {};
  if (!synced || !Number.isFinite(height)) return null;
  return { height, activateAt };
}

function preWindowBlocks() {
  return config.fluxapps.quorumGrantPreWindowBlocks ?? 40;
}

/**
 * The first of the two heights (ACTIVATION_CROSSING_DESIGN.md §2.1): the
 * referees serve a fresh key from activateAt - preWindowBlocks, and this is
 * the same arithmetic in the node's own view. From here to the height the
 * plane GOVERNS nothing - every seam answers null and the legacy election
 * still decides who runs - but the node whose own docker says it runs the
 * container takes its lease, so the key is warm when the plane starts
 * governing and nothing moves at the crossing. The window has to outlast a
 * referee restart met on the way: strictly,
 *
 *   preWindowBlocks x blockTime > quorumGrantDrainMs + retry + 3 x askTimeoutMs
 *                               > 300,000 + retry + 15,000 ms
 *
 * with the noticing lag (the coordinator's masterSlaveIntervalMs, 30 s, plus
 * the tip's own arrival) inside the slack: 40 blocks at 30 s is 1,200 s.
 */
function registerOpen() {
  if (testOverrides.enabled !== null) return testOverrides.enabled;
  const view = planeView();
  if (!view) return false;
  return view.height >= view.activateAt - preWindowBlocks();
}

function featureEnabled() {
  if (testOverrides.enabled !== null) return testOverrides.enabled;
  const view = planeView();
  if (!view) return false;
  const { height, activateAt } = view;
  if (height < activateAt) return false;
  // Once, on the way in. Every node crosses at its own moment - the tip arrives by
  // push for some and by poll for others - and the spread between those moments is
  // part of what the window absorbs. Unrecorded, it is not measurable after the
  // fact.
  if (!activationAnnounced) {
    activationAnnounced = true;
    log.info(`mastershipGrantGate - the plane is live: tip ${height} reached activation height ${activateAt}`);
    fluxEventBus.publish('quorumGrant:planeActivated', { height, activateAt });
  }
  return true;
}

function pursuitIntervalMs() {
  return config.fluxapps.quorumGrantPursuitIntervalMs ?? 30_000;
}

/**
 * How long a node that is NOT running the component waits before pursuing a COLD
 * key - one no grant has ever been issued for. Derived, not chosen, from the two
 * constants that actually govern the race:
 *
 *   daemonInfoIntervalMs   the worst case for NOTICING the activation height. A node
 *                          on the push path has the tip within milliseconds; one
 *                          whose daemon does not publish the topic is polling, and
 *                          can be a full interval behind. The incumbent may be the
 *                          late one.
 *   askTimeoutMs x 3       a healthy acquisition, with margin. One ask round is a
 *                          single timeout.
 *
 * Deliberately NOT sized to cover an acquisition that has to fall through relay and
 * witness (~7 timeouts): that only happens to an incumbent which is partitioned or
 * whose committee is unreachable, and a standby taking over then is the outcome you
 * want, not a failure to prevent.
 */
/**
 * Whether THIS node is running the component right now — the local half of the
 * incumbent question, and the only half that can be asked without an opinion about
 * another node. Docker is the authority rather than any record: the point is what is
 * actually serving, not what something believes should be.
 *
 * Unreadable docker answers false. A node that cannot see its own containers should
 * not claim the head start, and the fallback (waiting like a standby) is the safe
 * side of that error.
 *
 * It reports WHY, not just what. `running: false` has three causes — no such
 * container, a stopped one, and a docker that would not answer — and the head
 * start treats all three the same while a diagnosis cannot: a node that answers
 * false because the name it looked up is not the name docker holds is a lookup
 * bug, and one that answers false because it genuinely does not run the component
 * is the rule working. The lookup name is reported alongside the answer so the two
 * are never confused again.
 */
async function localComponentState(identifier) {
  const lookup = dockerService.getAppDockerNameIdentifier(identifier);
  try {
    const inspected = await dockerService.dockerContainerInspect(identifier);
    if (!inspected) return { running: false, found: false, lookup, name: null };
    return {
      running: Boolean(inspected.State?.Running),
      found: true,
      lookup,
      name: inspected.Name ?? null,
    };
  } catch (error) {
    return {
      running: false, found: false, lookup, name: null, error: error.message,
    };
  }
}

function coldKeyHeadStartMs() {
  const override = config.fluxapps.quorumGrantIncumbentHeadStartMs;
  if (Number.isFinite(override)) return override;
  const noticing = config.fluxapps.daemonInfoIntervalMs ?? 30_000;
  const acquiring = (config.fluxapps.quorumGrantAskTimeoutMs ?? 5_000) * 3;
  return noticing + acquiring;
}

function heldTtlMs() {
  return config.fluxapps.quorumGrantHeldTtlMs ?? 150_000;
}

const testOverrides = { enabled: null, activationHeight: null };

// one-shot, so the crossing is announced rather than repeated every pass
let activationAnnounced = false;

// key -> monotonic ms of the last pursuit kick, jitter-spread
const pursuits = new Map();

// key -> monotonic ms this node first saw the key with no grant ever issued. The
// head start below is measured from here rather than from process start, so a node
// that joins later does not get to skip the wait.
const coldSince = new Map();

// keys whose cold pursuit deferred for the activation drain: the head start
// runs only while the register it races is OPEN, so the first pursuit past
// the lift re-bases the clock instead of inheriting below-lift burn.
const activationDrainSeen = new Set();

// The activation drain's lift as THIS node's view sees it, or null when no
// activation is scheduled. The grantors refuse every cold-key seat below it.
function activationLiftHeight() {
  const activateAt = activationHeight();
  if (activateAt === null) return null;
  return activateAt + (config.fluxapps.quorumGrantActivationDrainBlocks ?? 20);
}


function keyFor(appName) {
  return `${appName}/${ROLE}`;
}


/**
 * What every seam does below the height: no verdict, and inside the window
 * a kick of the pursuit - which is where the running-only rule lives. The
 * activeStandby coordinator asks masterIntent every interval, so that is the
 * running node's periodic kick inside the window; the reconciler's own sweep
 * is hourly and cannot be relied on for it.
 */
function kickInsideWindow(identifier, appName) {
  if (registerOpen()) pursue(identifier, appName);
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
    if (await appsRuntimeState.isOperatorStopped(identifier)) {
      // the one swallow on this path that is invisible from the term's
      // final owner — say so, or a silent gate reads as a dead node
      log.info(`mastershipGrantGate - pursuit of ${key} silenced by the operator stop lock`);
      return;
    }
  } catch (error) {
    log.warn(`mastershipGrantGate - operator-state read before pursuing ${key} failed: ${error.message}`);
  }
  try {
    const record = await messageStore.getMasterleaseRecord(appName, ROLE);
    const data = record?.data;
    // A COLD key - no grant has ever been issued for this app. That is the state
    // every app is in at the activation crossing, because the grantors have no
    // memory of a regime that never ran, and it is the one moment the plane can
    // move a master for no reason: with nothing to shield an incumbent, the term
    // goes to whichever node's pursuit fires first, which is not the node holding
    // the container. Measured on a 10-node fleet: the app ran on .11 and the term
    // went to .10.
    //
    // Under this scheme exactly ONE node is running the component, and every node
    // knows locally whether that is itself. So the incumbent goes first and the
    // rest wait - no cross-node agreement, and no opinion about anyone else, which
    // is the property the plane requires of everything it decides on. The switch
    // then inherits what the legacy election decided instead of re-running it.
    //
    // A head start, not exclusivity: if the incumbent cannot acquire in that window
    // it is partitioned or dying, and a standby taking the term is exactly right.
    // Making it exclusive would leave an app whose master died before the crossing
    // with no master at all, because the only node allowed to claim it is gone.
    if (!data?.grantee) {
      const local = await localComponentState(identifier);
      // Below the activation drain's lift the register is shut to every
      // cold-key seat, so a standby's head-start clock must not run there —
      // a clock burning against a shut register would decide the crossing
      // by whose tip crossed earliest, not by who runs the container. The
      // incumbent never defers: its asks are refused grantor-side until the
      // lift and retried, which is what puts it first in line.
      if (!local.running) {
        const liftAt = activationLiftHeight();
        if (liftAt !== null) {
          const { height, synced } = daemonServiceMiscRpcs.isDaemonSynced().data ?? {};
          if (!synced || !Number.isFinite(height) || height < liftAt) {
            activationDrainSeen.add(key);
            log.info(`mastershipGrantGate - cold key ${key}: identifier=${identifier} `
              + `running=false -> DEFER (activation drain until height ${liftAt})`);
            return;
          }
          if (activationDrainSeen.delete(key)) coldSince.set(key, nowMs());
        }
      }
      const firstSeen = coldSince.get(key) ?? nowMs();
      coldSince.set(key, firstSeen);
      const waited = nowMs() - firstSeen;
      const headStart = coldKeyHeadStartMs();
      const deferring = !local.running && waited < headStart;
      // One line per pursuit of a cold key, and it carries every input to the
      // decision. A cold key is rare - an app's birth, and the activation crossing -
      // so this costs nothing standing, and without it the only observable is which
      // node ended up with the term, which cannot tell a lookup that missed from a
      // head start that was too short.
      log.info(`mastershipGrantGate - cold key ${key}: identifier=${identifier} `
        + `lookup=${local.lookup} found=${local.found} name=${local.name ?? 'none'} `
        + `running=${local.running}${local.error ? ` dockerError=${local.error}` : ''} `
        + `waited=${waited}ms headStart=${headStart}ms -> ${deferring ? 'DEFER' : 'PURSUE'}`);
      if (deferring) return;
    } else {
      coldSince.delete(key);
    }
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

  // The head start is a duration, so an acquisition's own duration is what says
  // whether it can fit inside one. A cold key is founded, not merely asked for -
  // a committee has to form first - and nothing until now measured how long that
  // takes against the window the incumbent is given.
  const acquireStarted = nowMs();
  log.info(`mastershipGrantGate - acquiring ${key} for ${identifier}`);
  grantClient.acquire(key, {
    mode: 'held',
    ttlMs: heldTtlMs(),
    onDemoted: (reason) => {
      log.warn(`mastershipGrantGate - ${identifier} demoted: ${reason}`);
      if (!featureEnabled()) {
        // Below the height the plane governs nothing, so a lease that lapses
        // inside the window - a referee majority restarting inside one term
        // (ACTIVATION_CROSSING_DESIGN.md §4) - is re-acquired, never a docker
        // stop of a container the legacy election still owns. The re-ask goes
        // straight, past the pursuit throttle: the lapse IS the kick.
        log.info(`mastershipGrantGate - ${identifier} lost ${key} below the activation height; re-acquiring`);
        pursuits.delete(key);
        pursue(identifier, appName);
        return;
      }
      // A deposed master stops HARD and NOW, straight at docker: it has lost
      // the right to write, and every second it runs politely is a second
      // beside a legitimately started successor. The reconciler queue then
      // converges the durable state, but its pass latency plus a graceful
      // drain measured over a minute on the fleet - the demotion slack only
      // undercuts the grantors' lock-delay if the stop is immediate.
      dockerService.appDockerStop(identifier, grantClientCore.HARD_STOP_MS / 1000).catch((error) => {
        log.warn(`mastershipGrantGate - hard stop of ${identifier} failed: ${error.message}`);
      });
      reconcilerQueue.enqueueComponent(identifier);
    },
  }).then((outcome) => {
    if (outcome.granted) {
      log.info(`mastershipGrantGate - ${identifier} holds ${key} (epoch ${outcome.holder.epoch}) `
        + `after ${nowMs() - acquireStarted}ms`);
      if (outcome.deposed) raiseFence(appName, outcome.deposed);
      reconcilerQueue.enqueueComponent(identifier);
    } else {
      // A refusal names itself four different ways (reason, a live incumbent, a
      // taught wait, another founder) and reading only `reason` reports three of
      // them as unexplained.
      const refusal = outcome.reason
        ?? (outcome.incumbent ? `shielded by incumbent ${outcome.incumbent.grantee ?? 'unknown'}` : null)
        ?? (Number.isFinite(outcome.retryAfterMs) ? `lock-delay taught ${outcome.retryAfterMs}ms` : null)
        ?? (outcome.founder ? `founded by ${outcome.founder}` : 'unexplained');
      log.info(`mastershipGrantGate - ${key} not granted to ${identifier} `
        + `after ${nowMs() - acquireStarted}ms: ${refusal}`);
    }
    return outcome;
  }).catch((error) => {
    log.warn(`mastershipGrantGate - pursuit of ${key} failed `
      + `after ${nowMs() - acquireStarted}ms: ${error.message}`);
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
  if (!featureEnabled()) {
    if (comp?.hasActiveStandbySyncthing?.()) kickInsideWindow(identifier, comp.appName);
    return null;
  }
  if (!comp?.hasActiveStandbySyncthing?.()) return null;

  const { appName } = comp;

  const key = keyFor(appName);
  if (grantClient.holderFor(key)) {
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
        return { desired: false, reason: 'peerHoldsGrant' };
      }
    }
  } catch (error) {
    log.warn(`mastershipGrantGate - record read for ${appName} failed: ${error.message}`);
  }

  // Ask, never count. A quorum of registers either still records this node's
  // term — in which case the holder is re-installed and the container keeps
  // running — or it does not, and there is nothing left to defer for.
  const relearned = await grantClient.relearn(key);
  if (relearned?.recovered) {
    return null;
  }
  // A quorum that cannot be READ is not a quorum that says no. Reads survive
  // the drain, so an unreadable committee means this node is isolated, and §7's
  // witness coast — not this seam — is what decides whether an isolated master
  // keeps running.
  return { desired: false, reason: relearned?.reason ?? 'grantNotHeld' };
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
  if (!isActiveStandby) return null;
  if (!featureEnabled()) {
    kickInsideWindow(identifier, appName);
    return null;
  }
  const key = keyFor(appName);
  if (grantClient.holderFor(key)) return true;
  // No verdict while this node's own acquisition is in flight — a false
  // here would demote the incumbent against a round it itself started.
  if (grantClient.isAcquiring(key)) return null;
  // The self-fence fences a DEPOSED node, and deposed means the plane has
  // DECIDED: a published record names a grantee. On an undecided plane — a
  // cold key at the activation crossing or an app's birth — "not the
  // holder" is true of everybody and fences nobody, and a false verdict
  // there stops the running incumbent's container, which forfeits the cold-
  // key head start that exists to let it inherit. A record naming ANYONE —
  // this node included — fences: a grantee that no longer holds is a
  // corpse, and the fence is for corpses. An unreadable record is no
  // verdict, matching masterIntent's error path; the epoch fencing and the
  // successor-raised peer fence carry safety regardless.
  try {
    const record = await messageStore.getMasterleaseRecord(appName, ROLE);
    if (!record?.data?.grantee) {
      pursue(identifier, appName);
      return null;
    }
  } catch (error) {
    log.warn(`mastershipGrantGate - leaderIsSelf record read for ${appName} failed: ${error.message}`);
    pursue(identifier, appName);
    return null;
  }
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
  if (!featureEnabled()) {
    if (comp?.hasActiveStandbySyncthing?.()) kickInsideWindow(identifier, comp.appName);
    return null;
  }
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
 * Teardown hook for a component whose data is being destroyed (true removal,
 * storage recreate). Volume-preserving teardowns must not call this: the
 * grant follows the data, and a rebuild-in-place holds the term. Voluntary
 * release, so successors pay no lock-delay.
 *
 * Keyed on the held grant alone — never the spec, which a crash-recovered
 * teardown may no longer be able to read. Only activeStandby apps ever hold
 * a grant, so a held grant IS the eligibility.
 */
async function onComponentTeardown(identifier, appName) {
  if (!appName) return;
  const holder = grantClient.holderFor(keyFor(appName));
  if (!holder) return;
  try {
    await holder.release();
    log.info(`mastershipGrantGate - released ${keyFor(appName)} on teardown of ${identifier}`);
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
  activationAnnounced = false;
  timingWarned = false;
  pursuits.clear();
  coldSince.clear();
  activationDrainSeen.clear();
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
