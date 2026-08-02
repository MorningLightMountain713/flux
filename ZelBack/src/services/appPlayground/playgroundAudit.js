const config = require('config');
const log = require('../../lib/log');
const dbHelper = require('../dbHelper');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxBroadcastHelper = require('../utils/fluxBroadcastHelper');
const ingressEncryptionKey = require('../utils/ingressEncryptionKey');
const ingressCapture = require('../utils/ingressCapture');
const { getSpecBackend } = require('../utils/specLibs');
const playgroundAbuse = require('./playgroundAbuse');

// What a node keeps about a playground session it ran.
//
// A session is anonymous work done for a stranger on a node operator's hardware,
// so there has to be a record. But the design's other half is that a session is
// PRIVATE to the node - nothing about it is gossiped, and no other node learns
// it happened. Those pull in opposite directions, and the seal is what lets both
// be true: the identifying part of the record is encrypted to the fluxteam key
// before it is written, so the node holds evidence it cannot itself read, and
// fluxteam can answer an abuse report without a feed that tells the network who
// is trying what.
//
// This is the registration path's discipline (ingressAttestationService) minus
// the gossip, which is the only part a session must not have.

const AUDIT_DOMAIN = 'FLUX_PLAYGROUND_AUDIT_v1';

function localDb() {
  return dbHelper.databaseConnection().db(config.database.appslocal.database);
}

function collection() {
  return config.database.appslocal.collections.playgroundSessions;
}

function retentionMs() {
  return config.fluxapps.playgroundAuditRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
}

/**
 * The observed and asserted view of the request that asked for a session.
 * Captured at the HTTP edge, because by the time the session ends the socket is
 * long gone.
 */
async function captureIngress(req) {
  return ingressCapture.captureIngress(req);
}

/**
 * The behavioural summary a miner profile is read from.
 *
 * The shape is unmistakable and it is the shape, not any single number, that
 * identifies it: CPU pegged for the whole session, nothing ever answering, and
 * running to the deadline rather than exiting. A legitimate app is the inverse -
 * it starts, binds, answers, and then mostly idles.
 *
 * Recorded as facts rather than as a verdict, so the judgement can be revised
 * later without the evidence having to be gathered again. playgroundAbuse turns
 * these into the verdict.
 */
function behaviour(session) {
  const components = Object.values(session.results || {});
  const probes = components.map((c) => c.probe).filter(Boolean);

  return {
    componentCount: components.length,
    probesPassed: probes.filter((p) => p.passed).length,
    probesFailed: probes.filter((p) => !p.passed).length,
    // A session where nothing ever accepted a connection is the single strongest
    // signal, because an app nobody can reach is an app doing something other
    // than serving.
    everAcceptedConnection: probes.some((p) => p.basis === 'tcp' || p.basis === 'healthcheck'),
    weakPassOnly: probes.length > 0 && probes.every((p) => p.basis === 'uptime'),
    // Fraction of the session spent at full tilt against its OWN allocation.
    // null means it could not be sampled, which the miner check treats as
    // "cannot tell" rather than as "idle".
    cpuBusyFraction: session.cpuBusyFraction ?? null,
    // Ran its full window rather than stopping on its own. Set by the runner,
    // which owns the running clock and times it from the containers starting.
    ranToDeadline: Boolean(session.reachedDeadline),
    durationMs: session.endedAt && session.startedAt ? session.endedAt - session.startedAt : null,
  };
}

/**
 * Seal and sign one session's record.
 *
 * The FluxID, the address and the images are the identifying half and are sealed
 * together; the verdict, timings and behaviour stay in the clear so the node
 * operator (and any later analysis) can see WHAT happened on their hardware
 * without being able to see WHO. The node signs over the sealed bytes, which is
 * what makes the record something fluxteam can rely on rather than something
 * this node could have written after the fact.
 *
 * @returns {Promise<object|null>} null when there is nothing worth attesting
 */
async function build(session) {
  const { seal } = await getSpecBackend();

  const ingress = session.ingress ?? { observed: { ip: session.sourceIp, port: null }, asserted: {} };
  if (!ingress.observed || !ingress.observed.ip) return null;

  const identifying = {
    fluxId: session.fluxId,
    observed: ingress.observed,
    asserted: ingress.asserted,
    appName: session.appName,
    images: session.images ?? [],
  };

  const { kid, publicKey } = ingressEncryptionKey.current();
  const sealed = seal(JSON.stringify(identifying), publicKey, { kid });

  const observedAt = Date.now();
  const node = await fluxNetworkHelper.getFluxNodePublicKey();
  const summary = behaviour(session);
  const flagged = playgroundAbuse.looksLikeMining(summary);

  // In the clear alongside the summary, NOT inside the seal. The node has to be
  // able to match a returning caller against it, which it could never do with a
  // value only fluxteam can open - that is the whole reason this field exists
  // rather than the identity being read back out. One-way and node-local: it
  // cannot be reversed into a FluxID, and it does not compare across nodes.
  const callerFingerprint = await playgroundAbuse.fingerprint(session.fluxId, session.sourceIp);

  // Signed over the sealed bytes and the cleartext summary together, so neither
  // half can be swapped for another session's while the signature still checks.
  const payload = `${AUDIT_DOMAIN}|${JSON.stringify([
    session.sessionId, observedAt, node, sealed.v, sealed.alg, sealed.kid,
    sealed.epk, sealed.n, sealed.ct, session.verdict ?? null, session.outcome ?? null,
  ])}`;
  const signature = await fluxBroadcastHelper.getFluxMessageSignature(payload);

  return {
    sessionId: session.sessionId,
    observedAt,
    node,
    sealed,
    signature,
    verdict: session.verdict ?? null,
    outcome: session.outcome ?? null,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    behaviour: summary,
    callerFingerprint,
    flagged,
  };
}

/**
 * Write the record for a finished session.
 *
 * Best effort, and it must stay that way: this runs inside the teardown path, and
 * a node that could not write its audit row still has to release the session slot
 * and destroy the containers. A failure here is logged loudly rather than
 * allowed to strand the node.
 */
async function record(session) {
  try {
    const doc = await build(session);
    if (!doc) return null;

    // Self-reaping: the record exists to answer an abuse question while it is
    // still a live question. Keeping sealed records of strangers' sessions
    // indefinitely on an operator's node is a liability, not diligence.
    doc.expireAt = new Date(Date.now() + retentionMs());

    await dbHelper.insertOneToDatabase(localDb(), collection(), doc);
    return doc;
  } catch (error) {
    log.error(`playground: could not write the audit record for ${session.sessionId}: ${error.message}`);
    return null;
  }
}

/**
 * Whether this node flagged the same caller within the given window.
 *
 * Matched on the fingerprint, which is all the node has: the identity itself is
 * sealed and unreadable here. Indexed lookup on two equality fields plus a
 * range, so it stays cheap on the admission path.
 *
 * @param {string} fingerprint - from playgroundAbuse.fingerprint()
 * @param {number} since - epoch ms; records older than this do not count
 * @returns {Promise<object|null>}
 */
async function findFlaggedSince(fingerprint, since) {
  return dbHelper.findOneInDatabase(
    localDb(),
    collection(),
    { callerFingerprint: fingerprint, flagged: true, observedAt: { $gte: since } },
    { projection: { _id: 1, observedAt: 1 } },
  );
}

module.exports = {
  AUDIT_DOMAIN,
  findFlaggedSince,
  captureIngress,
  behaviour,
  build,
  record,
};
