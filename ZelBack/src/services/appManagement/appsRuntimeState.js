const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const dockerService = require('../dockerService');

// Node-local, per-component controller state. Sits between the app spec
// (desired config, in appsInformation) and Docker (actual state). Holds the
// durable inputs to the reconciler: the operator's stop lock and the
// crash-recovery backoff history, so both survive a FluxOS restart. The
// election/sync-derived `controllerDesired` is NOT here — it is in-memory,
// re-derived from live truth each cycle (see the reconcile workqueue).

const appsLocalDatabase = config.database.appslocal.database;
const { appsRuntimeState } = config.database.appslocal.collections;

// crash-recovery backoff ladder: immediate, 30s, 5m, 15m, 30m cap. Tunable via
// config (harness compression); the literals are the production defaults.
const BACKOFF_DELAYS_MS = config.fluxapps.crashBackoffDelaysMs ?? [0, 30 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
const STABLE_RUN_MS = config.fluxapps.crashBackoffStableRunMs ?? 10 * 60 * 1000;
// only the count (capped by the ladder) and the last timestamp are ever read,
// so the persisted history never needs to grow beyond the ladder length
const MAX_HISTORY = BACKOFF_DELAYS_MS.length;

function collection() {
  const db = dbHelper.databaseConnection();
  return db.db(appsLocalDatabase);
}

// The collection is keyed by the bare component identifier (`component_app`, or
// the app name for v1-3). Callers pass that form by convention, but convention
// across files is not an invariant: a docker-prefixed form would silently key a
// same-component twin the unique index cannot collapse (different key strings).
// Normalize at the storage boundary so the namespace is enforced in one place.
function canonical(identifier) {
  return dockerService.getBaseAppName(identifier);
}

/**
 * Returns the persisted runtime-state document for a component identifier
 * (e.g. `component_app`, or the app name for v1-3 apps), or null.
 *
 * @param {string} identifier
 * @returns {Promise<object|null>}
 */
async function getState(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  try {
    const database = collection();
    return await dbHelper.findOneInDatabase(database, appsRuntimeState, { identifier }, { projection: { _id: 0 } });
  } catch (err) {
    log.error(`appsRuntimeState - failed to read state for ${identifier}: ${err.message}`);
    return null;
  }
}

function isDuplicateKeyError(err) {
  return err && (err.code === 11000 || /E11000/.test(err.message || ''));
}

async function setFields(rawIdentifier, fields) {
  const identifier = canonical(rawIdentifier);
  const database = collection();
  const write = () => dbHelper.updateOneInDatabase(
    database,
    appsRuntimeState,
    { identifier },
    { $set: { identifier, ...fields, updatedAt: Date.now() } },
    { upsert: true },
  );
  try {
    await write();
  } catch (err) {
    // Under the unique index, the loser of a concurrent first upsert THROWS a
    // duplicate-key error instead of converting to an update. The document
    // exists at that point, so one retry takes the update path - without it the
    // loser's write (possibly the operator stop lock) would be silently dropped.
    if (!isDuplicateKeyError(err)) throw err;
    await write();
  }
}

/**
 * Sets the operator stop lock. This is the highest-priority desired-state
 * input — when true the reconciler must never auto-start the component. A
 * deliberate (re)start (operatorStopped=false, also install/redeploy) clears
 * the crash-recovery backoff so the component gets a fresh start.
 *
 * @param {string} identifier
 * @param {boolean} stopped
 */
async function setOperatorStopped(identifier, stopped, opts = {}) {
  // No catch: the lock is the contract that the reconciler will not restart the
  // app. Swallowing a write failure would let the API report success while the
  // lock never persisted - the caller must surface the failure instead.
  const fields = { operatorStopped: stopped };
  if (stopped) {
    // force = an operator hard-kill: skip the (possibly hours-long) graceful
    // shutdown window. Durable so a crash mid-kill never silently downgrades the
    // operator's "kill now" to a graceful drain (decision #1). Cleared on restart.
    fields.operatorStopForce = opts.force === true;
  } else {
    fields.operatorStopForce = false;
    fields.restartHistory = [];
  }
  await setFields(identifier, fields);
}

/**
 * Sets the condemned stamp — the durable record that this component is being torn
 * down. Like operatorStopped it keeps the reconciler from running the container
 * (effectiveDesiredRunning returns desired:false, reason 'condemned'), but the
 * intent differs: operatorStopped means "keep it, stopped"; condemned means "stop
 * it AND destroy it" — the deferred teardown worker reads it as "safe to remove",
 * and boot recovery re-stamps it so a crash mid-teardown never restarts an app
 * whose containers are being removed. Cleared only by remove() when teardown ends.
 *
 * @param {string} identifier
 * @param {boolean} condemned
 * @param {object} [opts]
 * @param {boolean} [opts.force] - operator hard-cancel: the reconciler's stop skips
 *        the (possibly hours-long) graceful window and kills. Durable, like
 *        operatorStopForce, so a crash mid-cancel never downgrades it to a drain.
 */
async function setCondemned(identifier, condemned, opts = {}) {
  // No catch: like the operator lock, the condemned stamp is a contract — that the
  // reconciler will not restart a being-torn-down app and the worker may destroy it.
  // A swallowed write would let a removal proceed with no durable "going away" record,
  // so boot recovery would restart the app whose containers the worker is removing.
  const fields = { condemned };
  fields.condemnedForce = condemned ? opts.force === true : false;
  await setFields(identifier, fields);
}

/**
 * Bump the desired restart generation — a durable, level-based "bounce this
 * container" request (operator restart, or a mount/network repair). The reconciler
 * restarts a running container when the desired generation exceeds the one it last
 * actuated, then records the new value; durable so an operator's restart survives a
 * crash. Idempotent at the reconciler: re-running never re-bounces. NOT a catch —
 * an operator restart that silently failed to persist must surface to the caller.
 *
 * @param {string} identifier
 */
async function requestRestart(identifier) {
  const state = await getState(identifier);
  const next = ((state && state.restartGeneration) || 0) + 1;
  await setFields(identifier, { restartGeneration: next });
}

/**
 * Records the restart generation the reconciler just actuated, so it won't bounce
 * the same generation again. Best-effort: a lost write at worst re-bounces once.
 *
 * @param {string} identifier
 * @param {number} generation
 */
async function recordRestartGeneration(identifier, generation) {
  try {
    await setFields(identifier, { actuatedRestartGeneration: generation });
  } catch (err) {
    log.error(`appsRuntimeState - failed to record restart generation for ${identifier}: ${err.message}`);
  }
}

/**
 * Whether the operator has deliberately stopped this component, so the
 * reconciler (and the masterSlave/syncthing deciders) must leave it stopped.
 *
 * @param {string} identifier
 * @returns {Promise<boolean>}
 */
async function isOperatorStopped(identifier) {
  const state = await getState(identifier);
  return state?.operatorStopped === true;
}

/**
 * Whether this component is condemned (being torn down). The reconciler stands it
 * down (desired:false, reason 'condemned') and the teardown worker treats it as
 * safe to destroy. Reads fail OPEN (false on a DB error): a transient read blip
 * must not let the reconciler believe a live app is being removed.
 *
 * @param {string} identifier
 * @returns {Promise<boolean>}
 */
async function isCondemned(identifier) {
  const state = await getState(identifier);
  return state?.condemned === true;
}

/**
 * Appends a restart attempt (wall-clock) and trims the history to the ladder
 * length so a perpetually crashing container never grows the array unbounded.
 *
 * @param {string} identifier
 */
async function recordRestart(identifier) {
  try {
    const state = await getState(identifier);
    const history = (state && state.restartHistory) || [];
    history.push(Date.now());
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    await setFields(identifier, { restartHistory: history });
  } catch (err) {
    log.error(`appsRuntimeState - failed to record restart for ${identifier}: ${err.message}`);
  }
}

/**
 * Marks that this component has successfully started at least once on this node
 * (set after a successful appDockerStart). Durable, so it survives a restart: it
 * distinguishes a first start (firstStart action; the install-window rollback
 * applies if it can't start) from a restart of a container that has run here
 * before (a later crash backs off, never rolls back). Cleared only by remove().
 *
 * @param {string} identifier
 */
async function setSuccessfullyStarted(identifier) {
  try {
    await setFields(identifier, { hasSuccessfullyStarted: true });
  } catch (err) {
    log.error(`appsRuntimeState - failed to record successful start for ${identifier}: ${err.message}`);
  }
}

/**
 * Returns how long (ms) the reconciler must wait before the next restart is
 * allowed — 0 means restart now. Level-based: measured from the last restart
 * against the backoff ladder, so the worker re-enqueues after the remaining
 * time rather than sleeping. Crash restarts and livenessProbe-unhealthy
 * restarts share one ladder: both mean "this container is unstable, back off".
 *
 * The ladder resets only on PROOF the last run lasted STABLE_RUN_MS. Two kinds
 * of proof, selected by the caller's context:
 *   - dead (the crash path): death time minus the restart that launched it,
 *     where the death time is the best evidence — the recorded die event, or
 *     docker's State.FinishedAt the reconciler passes from the inspect it
 *     already did (docker records the true death even when the event was
 *     missed: reboot, FluxOS restart, stream gap).
 *   - runningNow (the unhealthy path): the container is alive RIGHT NOW and
 *     docker won't auto-restart it (RestartPolicy 'no'), so it has been up
 *     continuously since the last restart — now minus lastRestart is genuine
 *     uptime, not idle backoff time.
 * Time since the ATTEMPT is never stability for a STOPPED container: it sits
 * idle in backoff between attempts, and resetting on that elapsed time launders
 * a crash loop's history at any rung longer than STABLE_RUN_MS, making the cap
 * unreachable. With no proof at all the ladder holds — the conservative
 * direction costs at most one deeper rung, the permissive one re-opens the bug.
 *
 * @param {string} identifier
 * @param {object} [opts]
 * @param {number|null} [opts.lastFinishedAtMs] - docker State.FinishedAt of the
 *        stopped container (ms epoch) — the crash path's stability evidence
 * @param {boolean} [opts.runningNow] - the container is confirmed running now
 *        (the unhealthy-restart path); reset on uptime since the last restart
 * @returns {Promise<number>}
 */
async function restartWaitMs(identifier, { lastFinishedAtMs = null, runningNow = false } = {}) {
  const state = await getState(identifier);
  const history = (state && state.restartHistory) || [];
  if (history.length === 0) return 0;

  const lastRestart = history[history.length - 1];
  let stableRunMs = 0;
  if (runningNow) {
    stableRunMs = Date.now() - lastRestart;
  } else {
    const lastDeath = Math.max(state.lastDiedAt || 0, lastFinishedAtMs || 0);
    if (lastDeath > lastRestart) stableRunMs = lastDeath - lastRestart;
  }
  if (stableRunMs > STABLE_RUN_MS) {
    await setFields(identifier, { restartHistory: [] });
    return 0;
  }

  const sinceLast = Date.now() - lastRestart;
  const index = Math.min(history.length, BACKOFF_DELAYS_MS.length - 1);
  return Math.max(0, BACKOFF_DELAYS_MS[index] - sinceLast);
}

/**
 * The network-detach heal force-removes a container in order to recreate it with
 * a fresh endpoint. Between those two steps the container is legitimately absent,
 * and that fact MUST be durable: if FluxOS restarts in that window, the next
 * reconcile would otherwise see a missing container with no heal in flight, call
 * it vanished (a false tampering signal) and, on a failed recreate, uninstall the
 * whole app. This flag is the reconciler's memory of "I removed this on purpose";
 * it is set before the remove and cleared once the container is seen running AND
 * attached again (see appReconciler).
 *
 * @param {string} identifier
 * @param {boolean} removed
 */
async function setNetworkHealRemoval(identifier, removed) {
  // No catch: the flag is what keeps a failed heal from escalating to an app
  // uninstall. If it cannot be persisted, the caller must not remove the container.
  await setFields(identifier, { networkHealRemoval: removed });
}

/**
 * Whether the reconciler removed this container itself for a network heal.
 *
 * Deliberately does NOT reuse getState: getState swallows a read failure and
 * returns null, which here would read as "not a heal removal" - the DESTRUCTIVE
 * direction (the caller would treat its own removal as a vanished container,
 * record a false tampering event and, on a failed recreate, uninstall the app).
 * A read failure must be a failure, so the caller can defer instead of guess.
 *
 * @param {string} identifier
 * @returns {Promise<boolean>} - throws if the state cannot be read
 */
async function isNetworkHealRemoval(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  const database = collection();
  const state = await dbHelper.findOneInDatabase(database, appsRuntimeState, { identifier }, { projection: { _id: 0 } });
  return state?.networkHealRemoval === true;
}

/**
 * Appends a network-heal attempt to its OWN durable ladder. Kept separate from
 * restartHistory: sharing it would cross-contaminate in both directions - a heal
 * that recreates a g: component (created, not started) would then have the very
 * container it just fixed held down by the crash ladder its own attempts grew,
 * and a crash-looping container could not be healed for up to the 30m cap.
 *
 * @param {string} identifier
 */
async function recordNetworkHealAttempt(identifier) {
  // No catch: pacing that silently fails to persist means the next pass sees an
  // empty ladder, waits 0, and hammers the destructive heal. The caller defers.
  const state = await getState(identifier);
  const history = (state && state.networkHealHistory) || [];
  history.push(Date.now());
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  await setFields(identifier, { networkHealHistory: history });
}

/**
 * How long (ms) before the next network-heal attempt is allowed - 0 means now.
 * Same ladder shape as the crash backoff (immediate, 30s, 5m, 15m, 30m cap), so
 * a container that keeps coming back detached is retried forever but at a
 * decaying rate. The ladder is reset by clearNetworkHeal once the container is
 * seen healthy, so a later, unrelated episode starts from the bottom again.
 *
 * @param {string} identifier
 * @returns {Promise<number>}
 */
async function networkHealWaitMs(identifier) {
  const state = await getState(identifier);
  const history = (state && state.networkHealHistory) || [];
  if (history.length === 0) return 0;
  const last = history[history.length - 1];
  const index = Math.min(history.length, BACKOFF_DELAYS_MS.length - 1);
  return Math.max(0, BACKOFF_DELAYS_MS[index] - (Date.now() - last));
}

/**
 * Drops all network-heal state (the removal flag and the heal ladder) once the
 * container is healthy again. Reads first so the healthy steady state - every
 * reconcile of every attached container - costs a lookup, not a write.
 *
 * @param {string} identifier
 */
async function clearNetworkHeal(identifier) {
  try {
    const state = await getState(identifier);
    if (!state) return;
    if (state.networkHealRemoval !== true && !(state.networkHealHistory || []).length) return;
    await setFields(identifier, { networkHealRemoval: false, networkHealHistory: [] });
  } catch (err) {
    // A stale flag only ever makes the reconciler MORE conservative (it keeps
    // recreating instead of escalating to an uninstall), so a failed clear is safe
    // to log and move on from - unlike a failed set, which must abort the remove.
    log.error(`appsRuntimeState - failed to clear network heal state for ${identifier}: ${err.message}`);
  }
}

/**
 * Records the last observed exit for diagnostics / tampering signals.
 *
 * @param {string} identifier
 * @param {number} exitCode
 */
async function recordExit(identifier, exitCode) {
  try {
    await setFields(identifier, { lastExitCode: exitCode, lastDiedAt: Date.now() });
  } catch (err) {
    log.error(`appsRuntimeState - failed to record exit for ${identifier}: ${err.message}`);
  }
}

/**
 * Drops all runtime state for a component (on uninstall) — including the condemned
 * stamp. Returns whether the drop succeeded: the teardown worker clears its durable
 * owed-teardown record ONLY when every component's state dropped, so a swallowed DB
 * error (stamp survives) keeps the record for boot recovery rather than orphaning a
 * condemned component.
 *
 * @param {string} identifier
 * @returns {Promise<boolean>} whether the state was dropped
 */
async function remove(rawIdentifier) {
  const identifier = canonical(rawIdentifier);
  try {
    const database = collection();
    await dbHelper.removeDocumentsFromCollection(database, appsRuntimeState, { identifier });
    return true;
  } catch (err) {
    log.error(`appsRuntimeState - failed to remove state for ${identifier}: ${err.message}`);
    return false;
  }
}

/**
 * Prepares the collection for use: merges any same-identifier twins, then
 * creates the unique index that makes twins impossible.
 *
 * Twins exist on nodes that wrote before the unique index did (concurrent
 * first upserts both insert without one). Because every later update matched
 * an ARBITRARY twin, fields scatter across them - the operator lock on one,
 * the backoff history on the other - so dedupe must merge field-wise rather
 * than keep one doc whole: dropping a doc could drop a real operator lock,
 * whose loss would auto-start a deliberately stopped app.
 */
async function prepareCollection() {
  try {
    const database = collection();
    const all = await dbHelper.findInDatabase(database, appsRuntimeState, {}, { projection: { _id: 0 } });
    const byIdentifier = new Map();
    // eslint-disable-next-line no-restricted-syntax
    for (const doc of all) {
      const list = byIdentifier.get(doc.identifier) || [];
      list.push(doc);
      byIdentifier.set(doc.identifier, list);
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const [identifier, twins] of byIdentifier) {
      if (twins.length > 1) {
        const merged = {
          identifier,
          // a lock anywhere is a lock: never auto-start a deliberately stopped app
          operatorStopped: twins.some((t) => t.operatorStopped === true),
          // likewise, a heal-removal anywhere means a heal may be mid-flight: keep
          // the reconciler on the recreate path rather than the uninstall path
          networkHealRemoval: twins.some((t) => t.networkHealRemoval === true),
          networkHealHistory: [...new Set(twins.flatMap((t) => t.networkHealHistory || []))].sort((a, b) => a - b).slice(-MAX_HISTORY),
          // a force on any twin is a force (honoured only while operatorStopped)
          operatorStopForce: twins.some((t) => t.operatorStopForce === true),
          // a condemned stamp anywhere is condemned: never restart a being-torn-down
          // app, and never lose the "teardown owed" intent on a boot dedupe
          condemned: twins.some((t) => t.condemned === true),
          condemnedForce: twins.some((t) => t.condemnedForce === true),
          // started on any twin = has started here (gates firstStart-vs-restart + the install-window rollback)
          hasSuccessfullyStarted: twins.some((t) => t.hasSuccessfullyStarted === true),
          // highest desired vs highest actuated restart generation across twins
          restartGeneration: Math.max(0, ...twins.map((t) => t.restartGeneration || 0)),
          actuatedRestartGeneration: Math.max(0, ...twins.map((t) => t.actuatedRestartGeneration || 0)),
          restartHistory: [...new Set(twins.flatMap((t) => t.restartHistory || []))].sort((a, b) => a - b).slice(-MAX_HISTORY),
          updatedAt: Math.max(...twins.map((t) => t.updatedAt || 0)),
        };
        const newestExit = twins.filter((t) => t.lastDiedAt !== undefined).sort((a, b) => b.lastDiedAt - a.lastDiedAt)[0];
        if (newestExit) {
          merged.lastExitCode = newestExit.lastExitCode;
          merged.lastDiedAt = newestExit.lastDiedAt;
        }
        log.warn(`appsRuntimeState - merged ${twins.length} duplicate docs for ${identifier} (operatorStopped=${merged.operatorStopped}, ${merged.restartHistory.length} restart entries)`);
        // eslint-disable-next-line no-await-in-loop
        await dbHelper.removeDocumentsFromCollection(database, appsRuntimeState, { identifier });
        // eslint-disable-next-line no-await-in-loop
        await dbHelper.updateOneInDatabase(database, appsRuntimeState, { identifier }, { $set: merged }, { upsert: true });
      }
    }
    await database.collection(appsRuntimeState).createIndex({ identifier: 1 }, { unique: true, name: 'identifier_unique' });
  } catch (err) {
    log.error(`appsRuntimeState - failed to prepare collection: ${err.message}`);
  }
}

module.exports = {
  prepareCollection,
  getState,
  setOperatorStopped,
  isOperatorStopped,
  setCondemned,
  isCondemned,
  recordRestart,
  setSuccessfullyStarted,
  requestRestart,
  recordRestartGeneration,
  restartWaitMs,
  setNetworkHealRemoval,
  isNetworkHealRemoval,
  recordNetworkHealAttempt,
  networkHealWaitMs,
  clearNetworkHeal,
  recordExit,
  remove,
  BACKOFF_DELAYS_MS,
  STABLE_RUN_MS,
  MAX_HISTORY,
};
