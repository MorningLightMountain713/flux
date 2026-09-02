'use strict';

const config = require('config');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const { nodeApiUrl } = require('../utils/socketAddressUtils');
const limitCounter = require('../utils/limitCounter');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const generalService = require('../generalService');
const hwRequirements = require('../appRequirements/hwRequirements');
const admissionControl = require('../utils/admissionControl');
const jobRegistry = require('../utils/jobRegistry');
const globalState = require('../utils/globalState');
const ingressCapture = require('../utils/ingressCapture');
const operationsController = require('../appManagement/operationsController');
const appSpawner = require('../appLifecycle/appSpawner');
const { validateSubmissionSpec, getSpecBackend } = require('../utils/specLibs');
const { appsFolder } = require('../utils/appConstants');
const playgroundLimits = require('./playgroundLimits');
const playgroundRunner = require('./playgroundRunner');
const playgroundSessionRegistry = require('./playgroundSessionRegistry');
const playgroundServingSet = require('./playgroundServingSet');
const playgroundAudit = require('./playgroundAudit');
const playgroundAbuse = require('./playgroundAbuse');

// The playground: an owner watches their own spec boot on a real node, at the
// resources it declares, before anything is registered, signed or paid for.
//
// It is the "does it actually run" half of what testappinstall claimed to do.
// The facts half - does the image exist, what architectures, how big, does it
// fit rootFsGb - is POST /apps/imagepreflight and installs nothing. The old
// endpoint answered both badly by running every app at 0.2 CPU and 300 MB, so a
// pass proved nothing and a failure blamed the wrong thing. Here the spec runs
// at what it asks for or it is refused with the numbers; there is no third
// option where it runs at something else.
//
// A session is a private arrangement between one requester and one node.
// Nothing touches the chain, nothing is gossiped, and no other node is told the
// session exists.

// Tiers big enough that a 2-core guest is not felt. Cumulus is 4 cores / 7 GB,
// where a session would be real load competing with paid apps; Nimbus (8/30) and
// Stratus (16/61) barely notice, which is what makes this default-on with no
// operator opt-out defensible.
const ELIGIBLE_TIERS = ['nimbus', 'stratus'];

function sessionTtlMs() {
  return config.fluxapps.playgroundSessionTtlMs ?? 900_000;
}

function maxConcurrent() {
  return config.fluxapps.playgroundNodeConcurrentSessions ?? 1;
}

/**
 * Whether this node offers the playground at all.
 *
 * Arcane AND a big enough tier, and both fail safe. A tier that cannot be read
 * is treated as ineligible - assuming a node is big enough puts guest containers
 * on exactly the nodes least able to absorb them - and an unresolved capability
 * verdict reads as not-Arcane, which globalState.isArcane() already guarantees.
 *
 * Arcane because a session is the one thing this node runs for a stranger, and
 * what contains it is the Arcane environment: the systemd slice the guest's
 * aggregate load is capped in, the managed iptables the egress policy is written
 * into, the tc rules that cap its bandwidth. On a node without them the
 * containment is not weaker, it is absent - and the feature would be handing an
 * anonymous caller an uncontained container.
 *
 * Checked before the tier, because it is a local read and the tier is not.
 */
async function nodeEligible() {
  if (!globalState.isArcane()) {
    return { eligible: false, reason: 'The playground runs on ArcaneOS nodes; this node is not one.' };
  }
  try {
    const tier = await generalService.getNewNodeTier();
    if (!ELIGIBLE_TIERS.includes(tier)) {
      return { eligible: false, reason: `The playground runs on Nimbus and Stratus nodes; this is a ${tier} node.` };
    }
    return { eligible: true, reason: null };
  } catch (error) {
    log.warn(`playground: could not determine node tier: ${error.message}`);
    return { eligible: false, reason: 'This node cannot determine its tier, so it is not offering playground sessions.' };
  }
}

/**
 * The identity a session's containers, network and host dirs are built from.
 *
 * Derived from the session id rather than the spec's name, because a name is a
 * LEASE - it says which app holds it right now, and an expiry hands it to
 * whoever registers it next - while everything named here can outlive the
 * session that made it. A failed teardown leaves containers and dirs behind,
 * and if those carry an app's name then the next thing to hold that name
 * inherits them.
 *
 * Short because the identifier it lands in is bounded, and short is enough: it
 * has to be unique against one node's app names and its own live sessions, not
 * against the network. The app's real name stays on the session for display and
 * the audit record.
 */
function sessionIdentity(sessionId) {
  return `pg-${sessionId.replace('op_', '').replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Turn a submitted spec into something runnable, or throw the reason it is not.
 *
 * Validation is flux-spec's own submission validator - the same code the
 * registration gate runs - so a spec the playground accepts is one registration
 * will also accept on shape. What is deliberately NOT run here is everything
 * about ownership and the chain: no signature, no name-conflict check, no
 * entitlements, no marketplace template, no daemon height. A session proves the
 * app runs; it says nothing about who may register it, and asking for a signed
 * message before an owner can watch their container boot would defeat the point.
 *
 * The height gate is skipped for the same reason: a spec being too new for the
 * current chain height is a registration verdict, not a statement about whether
 * the thing boots.
 */
async function buildDeployment(rawSpec, identity) {
  // A session is one copy on one node, and the validation says so: SESSION
  // purpose skips the placement-family requirements (instances, and the
  // canonical wire shape a session spec never becomes) while every rule
  // about the spec's own shape still runs.
  const { ValidationPurpose } = await getSpecBackend();
  // `encrypted: true` states what the encryption-forcing rules actually ask:
  // will these fields be published? A session is built and run on this node and
  // never broadcast — there is no message, no chain entry and no relay — so a
  // private image's credentials go no further than the box the operator is
  // already using. Left silent, the rules read the spec as a cleartext
  // broadcast and refuse exactly the apps the playground exists to try out.
  const spec = await validateSubmissionSpec(rawSpec, {
    purpose: ValidationPurpose.SESSION, encrypted: true,
  });
  const { DeploymentSpec } = await getSpecBackend();

  // The declared view: a session is one copy on one node, so `instances` and the
  // whole placement block are not merely ignored - they have no meaning here.
  // replica: null is that view, the same one pricing uses.
  //
  // The identity is the session's, so every identifier this produces - container
  // names, host dirs, every mount source - belongs to the session rather than to
  // the name in the spec. `deployment.appName` is untouched and still that name,
  // which is what the image check and the audit record want.
  const deployment = DeploymentSpec.fromSpec(spec, appsFolder, { replica: null, identity });

  return { spec, deployment };
}

/**
 * Does the node have room for this session right now, on top of everything it
 * is already committed to?
 *
 * Held under the admission lock and reserved in the same critical section, so a
 * session and a concurrent app install cannot both be told yes for the same
 * capacity. The reservation is released the moment the session ends, by
 * whichever path ends it.
 *
 * Reserved under the SESSION id. Admission is keyed by name, and an install
 * reserves under the app's - so a session reserving under the spec's name would
 * be overwritten by a same-named install and then deleted by its release, and
 * the session's capacity would silently stop being counted while its containers
 * ran. The reverse held too: the session's own teardown deleted the installer's.
 */
async function admitSession(session) {
  const totals = session.deployment.resourceTotals();

  await admissionControl.withLock(async () => {
    const capacity = await hwRequirements.nodeCapacity();
    const shortfall = hwRequirements.capacityShortfall(capacity, totals)
      || hwRequirements.burstHeadroomShortfall(capacity, totals);

    if (shortfall) {
      const busy = new Error(`This node has no room for the session right now: ${shortfall} Try another node.`);
      busy.kind = 'busy';
      throw busy;
    }

    // Reclaimable: a session is free, interruptible work, so a paid install that
    // cannot otherwise fit asks for this back rather than being refused. Without
    // the class the installer's only options are to admit or to fail, and a
    // failure benches the app's hash for seven days.
    admissionControl.reserve(session.sessionId, session.deployment, { reclaimable: true });
    session.reserved = true;
  });
}

/**
 * Give capacity back to paid work that cannot otherwise fit.
 *
 * Ends whole sessions, oldest first, until enough is free. Whole, because a
 * session's resources are the containers it is running - there is no partial
 * yield - and oldest first because that session has had the most of what it came
 * for, and its owner has seen the most of their app.
 *
 * Never a cancel. The owner did not ask for this and nothing they did caused it;
 * a cancel would tell them they stopped their own session, and a failure would
 * tell them their spec was at fault. It is its own outcome with its own sentence.
 *
 * @param {object} needed - ResourceTotals the paid work could not fit
 * @returns {Promise<number>} how many sessions were ended
 */
async function reclaimFor(needed) {
  const live = playgroundSessionRegistry.all()
    .filter((session) => session.reserved && !session.finished)
    .sort((a, b) => a.startedAt - b.startedAt);

  let freedCpu = 0;
  let freedMemory = 0;
  let freedHdd = 0;
  let ended = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const session of live) {
    if (freedCpu >= needed.cpu && freedMemory >= needed.memoryMb && freedHdd >= needed.hostDiskGb) break;

    const totals = session.deployment.resourceTotals();
    log.warn(`playground: ending session ${session.sessionId} to release capacity for a paid application`);
    session.verdict = 'evicted';
    jobRegistry.evicted(
      session.sessionId,
      'This node needed the capacity for a paid application, so the session was ended early. '
      + 'Nothing about your spec caused this - try another node.',
    );
    // eslint-disable-next-line no-await-in-loop
    await finishSession(session, 'evicted').catch((error) => {
      log.error(`playground: could not end ${session.sessionId} for eviction: ${error.message}`);
    });

    freedCpu += totals.cpu;
    freedMemory += totals.memoryMb;
    freedHdd += totals.hostDiskGb;
    ended += 1;
  }

  // The capacity is back, so let the spawn loop try again now rather than at the
  // end of its idle delay - the install that asked returned DEFERRED and is
  // waiting on exactly this.
  if (ended) appSpawner.wakeIdleLoop();
  return ended;
}

/**
 * End a session exactly once, whatever ends it.
 *
 * Three paths race for this - the run finishing, the TTL firing, and a cancel -
 * and all three must leave the node in the same state: containers gone, network
 * gone, capacity released, slot free. Doing that twice is harmless; doing it
 * never strands the node's only session slot until a restart.
 */
async function finishSession(session, outcome) {
  if (session.finished) return;
  session.finished = true;

  session.endedAt = Date.now();
  session.outcome = outcome;

  await playgroundRunner.teardownSession(session);

  if (session.reserved) {
    admissionControl.release(session.sessionId);
    session.reserved = false;
  }

  // Give the fleet-wide slot back to the node that issued it. Best-effort: the
  // lease expires on its own, so a failure here costs a slot held for the rest of
  // its lease rather than one held indefinitely.
  if (session.fleetSlot) {
    const { token, at, fluxId } = session.fleetSlot;
    session.fleetSlot = null;
    await limitCounter.release('playground', 'identity', fluxId, token, at).catch((error) => {
      log.warn(`playground: could not return the fleet slot for ${session.sessionId}: ${error.message}`);
    });
  }

  playgroundSessionRegistry.remove(session.sessionId);

  // The audit record is written at the END, so it carries the verdict and the
  // observed behaviour rather than just the request. Sealed to the fluxteam key
  // and node-signed, held node-locally: a session is private to this node, and
  // the seal is what lets that stay true while still leaving forensics possible.
  await playgroundAudit.record(session);
}

/**
 * Run the session to completion, then tear it down.
 *
 * Teardown is in the `finally` because every way this ends - success, a refused
 * image, a docker failure, a cancel - leaves containers that must not outlive
 * the session. The 15-minute timer is the backstop for the case where this
 * function itself never returns.
 */
async function driveSession(session) {
  let failure = null;
  try {
    const results = await playgroundRunner.runSession(session, {
      onStatus: (message) => jobRegistry.progress(session.sessionId, message),
      // DELETE /apps/operations/:jobId raises a flag; the run is what has to act
      // on it. Without this the endpoint would report a cancel it never
      // performed, and the containers would keep running to the deadline.
      isCancelled: () => jobRegistry.isCanceled(session.sessionId),
    });

    const allPassed = Object.values(results).every((r) => r.probe && r.probe.passed);
    session.verdict = allPassed ? 'passed' : 'failed';
  } catch (error) {
    if (error.kind === 'cancelled') {
      // A cancel is not a failure: the caller got the outcome they asked for, so
      // it is recorded as its own terminal state rather than as an error the
      // spec did not cause.
      session.verdict = 'cancelled';
    } else {
      session.verdict = 'error';
      session.error = error.message;
      failure = error;
    }
  } finally {
    await finishSession(session, session.verdict ?? 'error').catch((error) => {
      log.error(`playground: teardown of ${session.sessionId} failed: ${error.message}`);
    });
    // The operation settles only now, teardown included: a terminal status is
    // the claim "this session has stopped and its slot is free", and the
    // admission check that refuses a second session reads exactly that slot.
    // Settled before the teardown, a caller who waited for Cancelled is
    // refused by the very session they cancelled until the cleanup catches up.
    if (session.verdict === 'cancelled') {
      jobRegistry.cancelled(session.sessionId);
    } else if (failure) {
      jobRegistry.fail(session.sessionId, failure);
    } else {
      jobRegistry.succeed(session.sessionId);
    }
  }
}

/**
 * What a poll of a playground session shows.
 *
 * Keyed by component name, and it says plainly what a pass does and does not
 * prove. A session is one copy on one node with no inbound path, so it can say
 * nothing about multi-node behaviour, syncthing, domains or load balancing - and
 * an owner who reads a pass as "ready to register" because the response did not
 * say otherwise has been misled by omission.
 */
/**
 * Each component's result with its log view attached, built now rather than
 * snapshotted when the probe finished: the follow keeps writing for the whole
 * session, so a stored copy would be stale the moment it was taken.
 *
 * @param {object} session
 * @param {number} sinceSeq what the caller already has
 */
function componentsView(session, sinceSeq) {
  const view = {};
  for (const [name, result] of Object.entries(session.results || {})) {
    const buffer = session.logBuffers && session.logBuffers[name];
    view[name] = {
      ...result,
      logs: buffer ? buffer.view(sinceSeq) : { lines: [], dropped: 0, total: 0 },
    };
  }
  return view;
}

function sessionDetail(session, { sinceSeq = 0 } = {}) {
  return {
    sessionId: session.sessionId,
    appName: session.appName,
    verdict: session.verdict,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    // Counted from when the containers started, because that is when the
    // session began. Before that it is still preparing and the window has not
    // opened yet, which is reported as null rather than as a full window.
    runningSince: session.runningSince ?? null,
    expiresInMs: (() => {
      if (session.finished) return 0;
      if (!session.runningSince) return null;
      return Math.max(0, session.runningSince + sessionTtlMs() - Date.now());
    })(),
    components: componentsView(session, sinceSeq),
    proves: 'The image boots and answers its probe at the resources this spec declares, on one node.',
    doesNotProve: 'Nothing about multiple instances, syncthing, domains or load balancing. '
      + 'A session runs one copy with no inbound network path.',
  };
}

/**
 * Accept a spec and run it, or say why not.
 *
 * Every refusal that can be decided without doing work is decided here, before a
 * job exists, so a caller learns immediately and can move to another node rather
 * than polling to discover the answer. Order matters: cheapest and most
 * node-specific first, so a caller shopping for a node is not made to wait on
 * validation this node was never going to accept the result of.
 *
 * @param {object} body the raw spec, unsigned and unmodified
 * @param {object} caller
 * @param {string} caller.fluxId the authenticated signer
 * @param {string|null} caller.sourceIp the RESOLVED caller address: the socket
 *   peer, or the client hop from the forwarding header when the peer is one of
 *   the balancers in config.fdmAddresses. A browser reaches a node through FDM,
 *   so the socket peer alone is the balancer for every caller and every key
 *   built on it collapses to the FluxID. The sealed ingress record keeps
 *   `observed` and `asserted` unresolved - this is for the controls only.
 * @param {object} [caller.ingress] the ingress capture for the audit record
 * @returns {Promise<{jobId: string, statusUrl: string, sessionId: string}>}
 */
async function submitSession(body, caller = {}) {
  const { fluxId, sourceIp = null } = caller;
  if (!fluxId) throw new Error('A playground session requires an authenticated FluxID');

  const eligibility = await nodeEligible();
  if (!eligibility.eligible) {
    const refused = new Error(eligibility.reason);
    refused.kind = 'ineligible';
    throw refused;
  }

  // Whether this node serves this caller at all, before anything else about
  // them is read. A pure local computation over a list already in memory, and
  // the only control here that a simultaneous fan-out cannot outrun: every
  // other one is enforced from a gossiped record and so has a window in which
  // every node independently says yes.
  //
  // This refusal is the one that can say where to go instead, because the set
  // is the answer to "which node, then".
  const serving = await playgroundServingSet.servesLocalNode({ fluxId, sourceIp });
  if (!serving.serves) {
    // Named as URLs for the same reason the servingset endpoint answers in them:
    // a bare address is not somewhere a client can send its next request.
    const elsewhere = serving.candidates.map(nodeApiUrl).filter(Boolean).slice(0, 5);
    const refused = new Error(
      'This node is not one of the nodes serving your FluxID today.'
      + (elsewhere.length ? ` Try: ${elsewhere.join(', ')}.` : ' Try another node.'),
    );
    refused.kind = 'busy';
    throw refused;
  }

  // Checked before anything expensive, and deliberately vague. Naming the
  // signal would tell someone grinding at this exactly which of the three to
  // defeat; a caller who was flagged in error loses this node for a day and can
  // use another, which is the cheaper of the two mistakes.
  const blocked = await playgroundAbuse.isBlocked(fluxId, sourceIp, playgroundAudit.findFlaggedSince);
  if (blocked) {
    const refused = new Error('This node is not running further playground sessions for you today. Try another node.');
    refused.kind = 'busy';
    throw refused;
  }

  if (playgroundSessionRegistry.size() >= maxConcurrent()) {
    const busy = new Error(
      `This node is already running its ${maxConcurrent()} playground session(s). Try another node.`,
    );
    busy.kind = 'busy';
    throw busy;
  }

  // Minted before anything is built, because the identity is what the spec is
  // built AGAINST: container names, host dirs and the network all come from it,
  // and the reservation is keyed on it. The job is still registered last - this
  // is an id, not a job, and a refusal below is still an immediate answer on the
  // request rather than something a caller has to poll to discover.
  const sessionId = jobRegistry.mintJobId();

  const { spec, deployment } = await buildDeployment(
    serviceHelper.ensureObject(body),
    sessionIdentity(sessionId),
  );

  const ceiling = playgroundLimits.ceilingShortfall(deployment.resourceTotals());
  if (ceiling) {
    // A ceiling refusal is the spec's own shape and will be identical on every
    // node, so it says so - otherwise an owner shops the whole fleet for a node
    // that will say yes, and none of them will.
    const refused = new Error(`${ceiling} Every node applies the same session ceiling, so another node will answer the same.`);
    refused.kind = 'rejected';
    throw refused;
  }

  // No name check. A session's containers, network and dirs are named for the
  // session, so a name this node already runs cannot collide with them - and
  // refusing that case was never sound anyway: it read the installed-app table,
  // which an install populates AFTER creating its network, leaving a window in
  // which both checks passed and the two shared everything.

  // Collect anything a previous session left behind, BEFORE this one claims
  // capacity or a subnet. It reads docker's own labels rather than our record of
  // what is live, so it is the one check that catches a session we lost track of
  // rather than one whose teardown merely failed. The periodic sweep does the
  // same thing; running it here is what makes "at most one session's debris"
  // true at the only moment it matters, instead of up to a sweep interval later.
  //
  // Never fatal: a docker that cannot list containers will fail the session a
  // few steps further on, with a better message than this could give.
  try {
    const collected = await playgroundRunner.reapOrphans(playgroundSessionRegistry.liveIds());
    if (collected.removed) {
      log.warn(`playground: collected ${collected.removed} abandoned session container(s) before starting a new session`);
    }
  } catch (error) {
    log.warn(`playground: could not check for abandoned containers before starting: ${error.message}`);
  }

  const session = {
    sessionId,
    // The owner's own name for their app, for the poll and the audit record.
    // Nothing is named after it.
    appName: spec.name,
    fluxId,
    sourceIp,
    ingress: caller.ingress ?? null,
    deployment,
    images: deployment.allImages(),
    results: {},
    verdict: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    finished: false,
    reserved: false,
  };

  // Capacity before the duty cycle, because capacity is the refusal a caller can
  // do nothing about and must not be charged for. The reservation taken here is
  // given straight back if the hourly limit then refuses, so a session that
  // never runs leaves nothing behind either way.
  await admitSession(session);

  // The fleet-wide ask. Everything above this line is what THIS node is willing
  // to give away; this is the only control that knows what the caller is doing
  // anywhere else. One node holds that tally, so thirty-two simultaneous requests
  // become thirty-two questions to it rather than thirty-two independent yeses.
  const fleetSlot = await limitCounter.reserve('playground', 'identity', fluxId);
  if (!fleetSlot.allowed) {
    if (session.reserved) {
      admissionControl.release(session.sessionId);
      session.reserved = false;
    }
    const busy = new Error(fleetSlot.reason === 'counterUnreachable'
      ? 'The node holding your playground allowance cannot be reached right now. Try again shortly.'
      : 'You are already running your allowance of playground sessions. Try again when one finishes.');
    busy.kind = 'busy';
    throw busy;
  }
  // Held on the session so the teardown can give it back to the node that issued
  // it. A lost release costs one lease-length of a slot staying held, never a slot
  // held forever.
  session.fleetSlot = { token: fleetSlot.token, at: fleetSlot.at, fluxId };
  // Tell the fleet, so the count survives the node holding it restarting or
  // leaving. Not awaited for correctness - the slot is already taken; this only
  // makes it durable.
  limitCounter.announce('playground', 'identity', fluxId, session.sessionId, Date.now() + sessionTtlMs())
    .catch((error) => log.warn(`playground: could not announce the session record: ${error.message}`));

  const slot = playgroundLimits.consumeSessionSlot(fluxId, sourceIp);
  if (!slot.allowed) {
    if (session.reserved) {
      admissionControl.release(session.sessionId);
      session.reserved = false;
    }
    await limitCounter.release('playground', 'identity', fluxId, fleetSlot.token, fleetSlot.at)
      .catch(() => {});
    session.fleetSlot = null;
    const busy = new Error(slot.message);
    busy.kind = 'busy';
    busy.retryAfterMs = slot.retryAfterMs;
    throw busy;
  }

  // The job is registered last, once the session is certain to run: a refusal
  // that happens before this point is an immediate answer on the request itself,
  // never a job the caller has to poll to discover the outcome of.
  const handle = jobRegistry.start({
    kind: 'playground',
    // The id the session has been building against since before it was admitted.
    jobId: sessionId,
    // Owner-scoped: a session names the images and the spec an owner is working
    // on, so only the identity that asked can read it.
    owner: fluxId,
    detail: (readOptions) => sessionDetail(session, readOptions),
    // The run waits on docker events, and a cancel is not one: a session whose
    // containers are quiet would otherwise not notice it until the deadline.
    // The watcher exists once the run reaches its containers; before that every
    // preparation step checks the flag between its own steps anyway.
    onCancel: () => {
      if (session.watcher) session.watcher.wake();
    },
  });

  playgroundSessionRegistry.add(session);

  // No timer here on purpose. The running window is the runner's, armed by the
  // EVENT of the containers starting; and every preparation step before that is
  // already bounded by something that observes progress rather than by a clock.
  // The pull - the only genuinely long step - aborts on "no progress for 90s"
  // via dockerPullStream's stall watchdog; verifying, creating and starting each
  // return or throw. A blanket allowance on top of those would be a number
  // invented to stand in for information the steps already report.

  // Deliberately not awaited: the caller already has the poll URL, and the run
  // takes minutes.
  driveSession(session);

  return { ...handle, sessionId: session.sessionId };
}

/**
 * A session's public view, through the shared operation registry.
 * @param {string} jobId
 * @param {string|null} [fluxId] the authenticated caller
 * @returns {object|null} null when unknown, aged out, or someone else's
 */
function getSession(jobId, fluxId = null) {
  if (typeof jobId !== 'string' || !jobId) throw new Error('Missing sessionId');
  return jobRegistry.get(jobId, fluxId);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function submitSessionAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('user', req);
    if (!authorized) {
      return res.status(401).json(messageHelper.errUnauthorizedMessage());
    }
    const auth = serviceHelper.ensureObject(req.headers.zelidauth);
    const fluxId = auth ? auth.zelid : null;

    const ingress = await playgroundAudit.captureIngress(req);

    const { ip: sourceIp } = ingressCapture.resolveClientIp(
      req.socket && req.socket.remoteAddress,
      req.headers,
    );

    const handle = await submitSession(req.body ?? {}, {
      fluxId,
      sourceIp,
      ingress,
    });

    // awaited, not returned bare: accepted resolves this node's own address to
    // build the status URL, and a rejection must land in this catch
    return await operationsController.accepted(res, handle, { sessionId: handle.sessionId });
  } catch (error) {
    if (error.kind === 'busy' || error.kind === 'ineligible') {
      if (error.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      }
      return res.status(503).json(messageHelper.createErrorMessage(error.message));
    }
    log.warn(`playground: ${error.message}`);
    return res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
  }
}

/** Test seam: drop every session without touching docker. */
function reset() {
  playgroundSessionRegistry.reset();
}

/**
 * The nodes serving this caller today.
 *
 * Answers only for the caller: the FluxID comes off the auth header, never off a
 * parameter, so there is nothing to validate and no way to enumerate another
 * identity's set. That is also why it needs no rate limit of its own — a caller
 * can only ever ask about themselves, and the answer is one they could already
 * obtain by trying nodes until one accepted.
 *
 * The same question a refused submission answers with its "try these" list, asked
 * up front so a client can go straight to a node that will take it instead of
 * discovering the set by rejection. Both read the one set function, so they cannot
 * disagree.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function servingSetAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('user', req);
    if (!authorized) {
      return res.status(401).json(messageHelper.errUnauthorizedMessage());
    }
    const auth = serviceHelper.ensureObject(req.headers.zelidauth);
    const fluxId = auth ? auth.zelid : null;
    if (!fluxId) {
      return res.status(401).json(messageHelper.errUnauthorizedMessage());
    }

    // The same axis admission uses, or this endpoint names nodes that will
    // then refuse: a caller asking "which node, then" must be answered on the
    // key their session will actually be judged by.
    const { ip: sourceIp } = ingressCapture.resolveClientIp(
      req.socket && req.socket.remoteAddress,
      req.headers,
    );

    const set = await playgroundServingSet.servingSet({ fluxId, sourceIp });
    return res.json(messageHelper.createDataMessage({
      // URLs, in set order, not bare ip:port. A node serves its API under a
      // certificate issued for its *.node.api.runonflux.io name, so an address is
      // not something a client can connect to — handing one back would leave every
      // caller to repeat the same transform. Same values the refusal offers.
      nodes: set.map((node) => nodeApiUrl(node.ip)).filter(Boolean),
      // Which window this answer belongs to. The set rotates, so a client that
      // cached one can tell whether it is still the current answer.
      window: playgroundServingSet.windowIndex(),
    }));
  } catch (error) {
    log.error(error);
    return res.status(503).json(messageHelper.createErrorMessage(error.message));
  }
}

module.exports = {
  ELIGIBLE_TIERS,
  reclaimFor,
  submitSession,
  submitSessionAPI,
  servingSetAPI,
  getSession,
  sessionDetail,
  reset,
};
