const config = require('config');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const generalService = require('../generalService');
const hwRequirements = require('../appRequirements/hwRequirements');
const admissionControl = require('../utils/admissionControl');
const appQueryService = require('../appQuery/appQueryService');
const jobRegistry = require('../utils/jobRegistry');
const operationsController = require('../appManagement/operationsController');
const { validateSubmissionSpec, getSpecBackend } = require('../utils/specLibs');
const { appsFolder } = require('../utils/appConstants');
const playgroundLimits = require('./playgroundLimits');
const playgroundRunner = require('./playgroundRunner');
const playgroundSessionRegistry = require('./playgroundSessionRegistry');
const playgroundAudit = require('./playgroundAudit');

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
 * A tier that cannot be read is treated as ineligible. The alternative - assume
 * the node is big enough - puts guest containers on exactly the nodes least able
 * to absorb them, which is the one outcome the tier rule exists to prevent.
 */
async function nodeEligible() {
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
async function buildDeployment(rawSpec) {
  const spec = await validateSubmissionSpec(rawSpec, {});
  const { DeploymentSpec } = await getSpecBackend();

  // The declared view: a session is one copy on one node, so `instances` and the
  // whole placement block are not merely ignored - they have no meaning here.
  // replica: null is that view, the same one pricing uses.
  const deployment = DeploymentSpec.fromSpec(spec, appsFolder, { replica: null });

  return { spec, deployment };
}

/**
 * Refuse a name this node is already using.
 *
 * A session runs under the spec's own name, so its containers and network are
 * named exactly as they would be in production - which is most of what makes
 * reading the logs useful. The cost is that an installed app of the same name
 * would collide on both, so that case is refused rather than worked around: a
 * synthetic name would make every identifier in the output a thing the owner has
 * to mentally translate, to buy a case that another node solves for free.
 */
async function assertNameFree(appName) {
  const installed = await appQueryService.installedApps();
  if (installed.status !== 'success') {
    throw new Error('This node cannot check its installed apps right now, so it is not starting a session. Try another node.');
  }
  if (installed.data.some((app) => app.name === appName)) {
    const clash = new Error(
      `This node already runs an app called '${appName}', and a session would collide with it. Try another node.`,
    );
    clash.kind = 'busy';
    throw clash;
  }
}

/**
 * Does the node have room for this session right now, on top of everything it
 * is already committed to?
 *
 * Held under the admission lock and reserved in the same critical section, so a
 * session and a concurrent app install cannot both be told yes for the same
 * capacity. The reservation is released the moment the session ends, by
 * whichever path ends it.
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

    admissionControl.reserve(session.appName, session.deployment);
    session.reserved = true;
  });
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

  if (session.ttlTimer) {
    clearTimeout(session.ttlTimer);
    session.ttlTimer = null;
  }

  session.endedAt = Date.now();
  session.outcome = outcome;

  // The deadline can fire while the run is still going, and that path has no
  // other way to close the job out. Without this the operation stays Running
  // forever: retention is only scheduled on a terminal status, so it would never
  // age out either. Failed rather than Succeeded because the caller asked for a
  // verdict and the deadline is precisely not getting one - whatever partial
  // results were gathered are still in the detail. jobRegistry ignores this on a
  // job the run already settled, so the normal path is unaffected.
  if (outcome === 'expired') {
    jobRegistry.fail(session.sessionId, {
      title: 'SessionExpired',
      status: 504,
      detail: `The session reached its ${Math.round(sessionTtlMs() / 60000)}-minute limit and was torn down.`,
      code: 'PLAYGROUND_SESSION_EXPIRED',
    });
  }

  await playgroundRunner.teardownSession(session);

  if (session.reserved) {
    admissionControl.release(session.appName);
    session.reserved = false;
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
    jobRegistry.succeed(session.sessionId);
  } catch (error) {
    if (error.kind === 'cancelled') {
      // A cancel is not a failure: the caller got the outcome they asked for, so
      // it is recorded as its own terminal state rather than as an error the
      // spec did not cause.
      session.verdict = 'cancelled';
      jobRegistry.cancelled(session.sessionId);
    } else {
      session.verdict = 'error';
      session.error = error.message;
      jobRegistry.fail(session.sessionId, error);
    }
  } finally {
    await finishSession(session, session.verdict ?? 'error').catch((error) => {
      log.error(`playground: teardown of ${session.sessionId} failed: ${error.message}`);
    });
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
function sessionDetail(session) {
  return {
    sessionId: session.sessionId,
    appName: session.appName,
    verdict: session.verdict,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    expiresInMs: session.finished
      ? 0
      : Math.max(0, session.startedAt + sessionTtlMs() - Date.now()),
    components: session.results,
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
 * @param {string|null} caller.sourceIp the OBSERVED socket peer, never a header
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

  if (playgroundSessionRegistry.size() >= maxConcurrent()) {
    const busy = new Error('This node is already running a playground session. Try another node.');
    busy.kind = 'busy';
    throw busy;
  }

  const { spec, deployment } = await buildDeployment(serviceHelper.ensureObject(body));

  const ceiling = playgroundLimits.ceilingShortfall(deployment.resourceTotals());
  if (ceiling) {
    // A ceiling refusal is the spec's own shape and will be identical on every
    // node, so it says so - otherwise an owner shops the whole fleet for a node
    // that will say yes, and none of them will.
    const refused = new Error(`${ceiling} Every node applies the same session ceiling, so another node will answer the same.`);
    refused.kind = 'rejected';
    throw refused;
  }

  await assertNameFree(spec.name);

  const session = {
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
    ttlTimer: null,
  };

  // Capacity before the duty cycle, because capacity is the refusal a caller can
  // do nothing about and must not be charged for. The reservation taken here is
  // given straight back if the hourly limit then refuses, so a session that
  // never runs leaves nothing behind either way.
  await admitSession(session);

  const slot = playgroundLimits.consumeSessionSlot(fluxId, sourceIp);
  if (!slot.allowed) {
    if (session.reserved) {
      admissionControl.release(session.appName);
      session.reserved = false;
    }
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
    // Owner-scoped: a session names the images and the spec an owner is working
    // on, so only the identity that asked can read it.
    owner: fluxId,
    detail: () => sessionDetail(session),
  });
  session.sessionId = handle.jobId;

  playgroundSessionRegistry.add(session);

  // The hard deadline. It is a timer rather than a check inside the run loop
  // because it has to fire on a session that is not making progress at all - a
  // container that hangs on start, a pull that stalls past its own watchdog.
  session.ttlTimer = setTimeout(() => {
    log.info(`playground: session ${session.sessionId} reached its ${sessionTtlMs() / 1000}s deadline`);
    jobRegistry.progress(session.sessionId, 'The session reached its time limit and was torn down.');
    finishSession(session, 'expired').catch((error) => {
      log.error(`playground: expiry teardown of ${session.sessionId} failed: ${error.message}`);
    });
  }, sessionTtlMs());

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
 * Remove playground containers this node no longer has a session for. Run at
 * startup, where it collects everything a restart abandoned, and periodically
 * after that for whatever a failed teardown left.
 */
async function reap() {
  return playgroundRunner.reapOrphans(playgroundSessionRegistry.liveIds());
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

    const handle = await submitSession(req.body ?? {}, {
      fluxId,
      sourceIp: ingress.observed.ip,
      ingress,
    });

    return operationsController.accepted(res, handle, { sessionId: handle.sessionId });
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

module.exports = {
  ELIGIBLE_TIERS,
  submitSession,
  submitSessionAPI,
  getSession,
  sessionDetail,
  reap,
  reset,
};
