'use strict';

const serviceHelper = require('./serviceHelper');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const verificationHelper = require('./verificationHelper');
const networkStateService = require('./networkStateService');
const nodeDownStore = require('./appMessaging/nodeDownStore');
const { RECORD_STATE } = nodeDownStore;
const { RingReconciler } = require('./utils/ringReconciler');
const { NodeDownJuror } = require('./utils/nodeDownJuror');
const { FlapLadder } = require('./utils/flapLadder');
const { FluxPeerManager } = require('./utils/FluxPeerManager');
const { normalizeSocketAddress, extractIp } = require('./utils/socketAddressUtils');
const fluxEventBus = require('./utils/fluxEventBus');
const log = require('../lib/log');

// The node-down assembly: binds the reconciler (who to hold) and the juror
// (who to accuse) to the running node. Transport is injected at start by
// fluxCommunication, which owns the sockets; everything here stays inert
// until start() is called, so requiring this module changes nothing.

let transport = null;
let reconciler = null;
let juror = null;
// The mild tier's counters: this node's own, never stored or sent, gone with
// the process. A restart starts every duty from the bottom by design.
let ladder = null;
let localSocketAddress = null;
let wasUnreachable = false;
let dropHandler = null;
let addHandler = null;

// outpoint <-> dialable address, rebuilt when the membership moves.
const index = { fingerprint: undefined, byOutpoint: new Map(), bySocket: new Map() };

// The records this node has seen standing, by subject: its own observation,
// kept so that a record's lapse — gone unrefuted — is an edge it can act on.
// Rows expire silently, so nothing else announces a lapse.
const seenStanding = new Map();

function refreshIndex() {
  const fingerprint = networkStateService.membershipFingerprint();
  if (fingerprint === index.fingerprint && fingerprint !== null) return;
  index.byOutpoint.clear();
  index.bySocket.clear();
  networkStateService.networkState().forEach((node) => {
    if (!node || !node.txhash || node.outidx === undefined || node.outidx === null) return;
    const outpoint = `${node.txhash}:${node.outidx}`;
    const socketAddress = normalizeSocketAddress(node.ip);
    if (!socketAddress) return;
    index.byOutpoint.set(outpoint, socketAddress);
    index.bySocket.set(socketAddress, outpoint);
  });
  index.fingerprint = fingerprint;
}

function resolveOutpoint(outpoint) {
  refreshIndex();
  return index.byOutpoint.get(outpoint) || null;
}

function myOutpoint() {
  if (!localSocketAddress) return null;
  refreshIndex();
  return index.bySocket.get(localSocketAddress) || null;
}

/** The duties this node owes now, by outpoint; empty off the list. */
function dutyOutpoints() {
  const topology = networkStateService.nodeDownTopology();
  const me = myOutpoint();
  const duties = topology && me ? topology.duties(me) : null;
  return new Set((duties || []).map((duty) => duty.outpoint));
}

async function primeLocalAddress() {
  try {
    const address = await fluxNetworkHelper.getLocalSocketAddress();
    if (address) localSocketAddress = normalizeSocketAddress(address);
  } catch (error) {
    log.warn(`nodeDownService: local address unavailable: ${error.message}`);
  }
}

/**
 * A record seen standing that is now gone unrefuted has lapsed: the jury
 * probes the subject once, so a still-dark node is re-certified rather than
 * forgotten at six hours — and a quarantined one, whose watchers no longer
 * dial it, is re-certified through this probe alone. A refutation is a
 * return, not a lapse; it only ends the watch.
 */
function noteRecordState(outpoint, record) {
  if (record.state === RECORD_STATE.STANDING) {
    seenStanding.set(outpoint, record.key);
    return;
  }
  if (!seenStanding.has(outpoint)) return;
  seenStanding.delete(outpoint);
  if (record.state === RECORD_STATE.NONE && juror) juror.look(outpoint, 'record-lapse');
}

/**
 * Whether a node is held out of the network: its certificate stands, or its
 * quarantine holds the stand-down open past the certificate. Both leave the
 * node out of the dial plan and off the verdict push list.
 */
async function stoodDown(outpoint) {
  try {
    const [record, quarantine] = await Promise.all([
      nodeDownStore.recordStateFor(outpoint),
      nodeDownStore.quarantineFor(outpoint),
    ]);
    noteRecordState(outpoint, record);
    return record.state === RECORD_STATE.STANDING || quarantine.quarantined;
  } catch (error) {
    return false;
  }
}

/**
 * The peering gate the peer manager asks before a peering inbound registers.
 * Only a listed subject under quarantine is refused; who else may peer is
 * decided where it always was.
 *
 * @param {string} socketAddress the dialer's ip:port
 * @returns {Promise<{admitted: boolean, reason: string, subject?: string}>}
 */
async function inboundGate(socketAddress) {
  refreshIndex();
  const subject = index.bySocket.get(normalizeSocketAddress(socketAddress));
  if (!subject) return { admitted: true, reason: 'unlisted' };
  try {
    const quarantine = await nodeDownStore.quarantineFor(subject);
    if (!quarantine.quarantined) return { admitted: true, reason: 'not_quarantined' };
    fluxEventBus.publish('nodedown:inboundRefused', {
      subject, socketAddress, count: quarantine.count, liftsAt: quarantine.liftsAt,
    });
    return { admitted: false, reason: 'quarantined', subject };
  } catch (error) {
    log.warn(`nodeDownService: quarantine lookup for ${subject} failed, admitting: ${error.message}`);
    return { admitted: true, reason: 'store_error' };
  }
}

/**
 * A certification just stored may have tripped the subject's quarantine:
 * say so, and drop any connection still held to it — its watchers will not
 * dial it and the gate will not readmit it until the hold lifts.
 */
async function noteQuarantine(subject, source) {
  const quarantine = await nodeDownStore.quarantineFor(subject);
  if (!quarantine.quarantined) return;
  fluxEventBus.publish('nodedown:quarantined', {
    subject, source, count: quarantine.count, liftsAt: quarantine.liftsAt,
  });
  const socketAddress = resolveOutpoint(subject);
  if (transport && socketAddress && transport.peerManager.has(socketAddress)) {
    transport.closePeer(socketAddress, 'quarantined');
  }
}

/** One fresh dial, now — reachable or not. The connection is closed either
 *  way; a probe must never register a peer. */
async function probe(socketAddress) {
  const peer = await transport.openEphemeralConnection(socketAddress);
  if (!peer) return false;
  try {
    peer.close();
  } catch (error) { /* the answer was the handshake */ }
  return true;
}

async function pushVerdict(socketAddress, verdict) {
  try {
    refreshIndex();
    const target = index.bySocket.get(socketAddress);
    if (target && await stoodDown(target)) return;
    const peer = await transport.openEphemeralConnection(socketAddress);
    if (!peer) {
      log.warn(`nodeDownService: verdict push to ${socketAddress}: no ephemeral connection`);
      return;
    }
    await transport.sendSignedMessage(
      { type: 'fluxnodedownverdict', version: 1, verdict },
      peer,
      { awaitDrain: true },
    );
    peer.close();
  } catch (error) {
    log.warn(`nodeDownService: verdict push to ${socketAddress} failed: ${error.message}`);
  }
}

async function broadcastOwnCertificate(certificate) {
  fluxEventBus.publish('nodedown:assembled', { subject: certificate.subject });
  const broadcastedAt = Date.now();
  const stored = await nodeDownStore.handleNodeDownEvent({
    message: { certificate, broadcastedAt },
  });
  if (!stored.accepted) {
    fluxEventBus.publish('nodedown:refused', {
      subject: certificate.subject, source: 'own', reason: stored.reason,
    });
    return;
  }
  fluxEventBus.publish('nodedown:stored', { subject: certificate.subject, source: 'own' });
  await transport.broadcastMessageToAll({
    type: 'fluxnodedown', version: 1, certificate, broadcastedAt,
  });
  reconciler.schedule('own-assembly');
}

/**
 * The shared certificate intake: gossip and sync land here alike, so both
 * pass the store's full verification and both trigger the same reactions.
 * A certificate about THIS node fires the immediate coalesced announce —
 * the announcement is the refutation, and it must ride the existing stagger.
 *
 * @param {object} message {certificate, broadcastedAt}
 * @param {object|null} envelope
 * @param {string} source 'gossip' or 'sync' — stamped on the harness events,
 *   so a suite can assert WHICH path delivered a certificate
 * @returns {Promise<{accepted: boolean, rebroadcast: boolean, reason: string}>}
 */
async function intakeCertificate(message, envelope, source) {
  const result = await nodeDownStore.handleNodeDownEvent({ message, envelope });
  if (!result.accepted) {
    fluxEventBus.publish('nodedown:refused', {
      subject: message?.certificate?.subject ?? null, source, reason: result.reason,
    });
    return result;
  }
  fluxEventBus.publish('nodedown:stored', { subject: message.certificate.subject, source });
  await noteQuarantine(message.certificate.subject, source);

  if (message.certificate.subject === myOutpoint()) {
    // eslint-disable-next-line global-require
    const peerNotification = require('./appMessaging/peerNotification');
    peerNotification.checkAndNotifyPeersOfRunningApps();
  } else if (reconciler) {
    // Sync can deliver before start(); the reconciler's first pass reads the
    // store, so a certificate stored now is honoured then.
    reconciler.schedule('nodedown-stored');
  }
  return result;
}

/**
 * Intake for a nodedown broadcast; fluxCommunication relays on rebroadcast.
 *
 * @param {object} data {certificate, broadcastedAt}
 * @param {object} [envelope]
 * @returns {Promise<{accepted: boolean, rebroadcast: boolean, reason: string}>}
 */
async function onCertificateBroadcast(data, envelope = null) {
  return intakeCertificate(data, envelope, 'gossip');
}

/**
 * Intake for a nodedown row arriving over the app-state sync stream — a
 * booting node catching up on certificates it missed. The row is the stored
 * document served whole, so its dates arrive JSON-serialized. The jury
 * signatures inside the certificate are the gate, checked by the same
 * verification as gossip; there is no envelope-freshness check because a
 * synced record is old by nature — the record lifetime is the age bound.
 * Sync is solicited catch-up, so nothing is relayed.
 *
 * @param {object} event stored row {broadcastedAt, data: {certificate}, envelope}
 * @returns {Promise<{accepted: boolean, rebroadcast: boolean, reason: string}>}
 */
async function onCertificateSyncEvent(event) {
  const certificate = event?.data?.certificate;
  const broadcastedAt = new Date(event?.broadcastedAt ?? NaN).getTime();
  if (!certificate || !Number.isFinite(broadcastedAt)) {
    fluxEventBus.publish('nodedown:refused', {
      subject: certificate?.subject ?? null, source: 'sync', reason: 'malformed',
    });
    return { accepted: false, rebroadcast: false, reason: 'malformed' };
  }
  return intakeCertificate({ certificate, broadcastedAt }, event.envelope ?? null, 'sync');
}

function onVerdictMessage(msgObj) {
  if (!juror) return;
  const verdict = msgObj?.data?.verdict;
  if (!verdict) return;
  const result = juror.onVerdictArrived(verdict);
  fluxEventBus.publish('nodedown:verdict', {
    subject: verdict.subject ?? null,
    juror: verdict.juror ?? null,
    piled: result.piled,
    reason: result.reason,
  });
}

function onPeerRemoved({ ip, port, closeCode }) {
  if (!reconciler) return;
  reconciler.schedule('peer-removed');
  if (transport.peerManager.allPeersDown()) wasUnreachable = true;

  // Only an unexpected loss raises suspicion or counts as a flap — a
  // deliberate close (duplicate, capacity, our own teardown) is not an
  // observation about the peer.
  if (!FluxPeerManager.shouldReconnect(closeCode)) return;
  refreshIndex();
  const outpoint = index.bySocket.get(`${ip}:${port}`);
  if (!outpoint) return;
  if (dutyOutpoints().has(outpoint)) ladder.noteDrop(outpoint);
  juror.look(outpoint, 'drop');
}

function onPeerAdded({ ip, port } = {}) {
  if (ladder && ip && port) {
    refreshIndex();
    const outpoint = index.bySocket.get(`${ip}:${port}`);
    if (outpoint && dutyOutpoints().has(outpoint)) ladder.noteReturn(outpoint);
  }
  if (!wasUnreachable) return;
  wasUnreachable = false;
  // Back from unreachability without a restart: the grant plane re-fetches
  // its published records before answering, and the announce doubles as the
  // certificate refutation should one have formed while we were dark.
  try {
    // eslint-disable-next-line global-require
    require('./quorumGrant/grantorController').noteReturnFromUnreachability();
  } catch (error) {
    log.warn(`nodeDownService: return notice failed: ${error.message}`);
  }
  // eslint-disable-next-line global-require
  require('./appMessaging/peerNotification').checkAndNotifyPeersOfRunningApps();
}

/**
 * Wire and start. Everything the service touches outside its own modules
 * comes in through `injectedTransport`:
 * dial(socketAddress, {witness}) -> Promise<boolean|null>,
 * openEphemeralConnection, sendSignedMessage, broadcastMessageToAll,
 * closePeer(socketAddress, reason), peerManager.
 *
 * @param {object} injectedTransport
 */
function start(injectedTransport) {
  if (reconciler) return;
  transport = injectedTransport;
  ladder = new FlapLadder({ currentHeight: () => networkStateService.chainHeight() });

  reconciler = new RingReconciler({
    topology: () => networkStateService.nodeDownTopology(),
    myOutpoint,
    resolveOutpoint,
    isHeld: (socketAddress) => transport.peerManager.has(socketAddress),
    heldDirection: (socketAddress) => transport.peerManager.get(socketAddress)?.direction ?? null,
    mayDial: (socketAddress) => transport.peerManager.shouldAttemptConnection(
      extractIp(socketAddress),
      socketAddress.split(':')[1],
    ),
    dial: transport.dial,
    drop: transport.closePeer,
    ask: (socketAddress) => {
      if (!localSocketAddress) return;
      serviceHelper.axiosGet(
        `http://${socketAddress}/flux/addoutgoingpeer/${localSocketAddress}`,
        { timeout: 5_000 },
      ).catch(() => { /* the far end dials back or it does not */ });
    },
    inboundCount: () => transport.peerManager.inboundCount,
    stoodDown,
    dialPlan: (outpoint) => ladder.dialPlan(outpoint),
    noteContact: (outpoint) => ladder.noteContact(outpoint),
  });

  juror = new NodeDownJuror({
    topology: () => networkStateService.nodeDownTopology(),
    myOutpoint,
    resolveOutpoint,
    probe,
    healthy: () => {
      const monitor = transport.peerManager.networkHealthMonitor;
      return !monitor || monitor.getStatus() === 'HEALTHY';
    },
    myAddress: () => (localSocketAddress ? extractIp(localSocketAddress) : null),
    isHeld: (socketAddress) => transport.peerManager.has(socketAddress),
    signVerdict: async (payload) => verificationHelper.signMessage(
      payload.toString(),
      await fluxNetworkHelper.getFluxNodePrivateKey(),
    ),
    verifySignature: (owner, payload, signature) => verificationHelper
      .verifyMessage(payload.toString(), owner, signature) === true,
    pushVerdict,
    currentHeight: () => networkStateService.chainHeight() ?? 0,
    currentFingerprint: () => networkStateService.membershipFingerprint(),
    onCertificate: (certificate) => {
      broadcastOwnCertificate(certificate).catch((error) => log.error(error));
    },
  });

  nodeDownStore.registerWithGrantPlane();

  dropHandler = (payload) => onPeerRemoved(payload);
  addHandler = (payload) => onPeerAdded(payload);
  transport.peerManager.on('peer:removed', dropHandler);
  transport.peerManager.on('peer:added', addHandler);
  transport.peerManager.setInboundGate(inboundGate);

  primeLocalAddress().then(() => reconciler.start());
  log.info('nodeDownService started');
}

function stop() {
  if (transport && dropHandler) transport.peerManager.off('peer:removed', dropHandler);
  if (transport && addHandler) transport.peerManager.off('peer:added', addHandler);
  if (transport) transport.peerManager.setInboundGate(null);
  dropHandler = null;
  addHandler = null;
  if (reconciler) reconciler.stop();
  reconciler = null;
  juror = null;
  ladder = null;
  transport = null;
  index.fingerprint = undefined;
  index.byOutpoint.clear();
  index.bySocket.clear();
  seenStanding.clear();
}

/** The periodic housekeeping fluxDiscovery drives: refresh what a missed
 *  event may have left stale. Correctness never depends on it. */
async function sweep() {
  if (!reconciler) return;
  await primeLocalAddress();
  const duties = dutyOutpoints();
  ladder.retain(duties);
  // A record seen standing for a node the list has since dropped is never
  // asked about again: forget it, so a later relisting starts clean.
  [...seenStanding.keys()].forEach((outpoint) => {
    if (!duties.has(outpoint)) seenStanding.delete(outpoint);
  });
  reconciler.schedule('sweep');
  juror.sweep();
}

module.exports = {
  start,
  stop,
  sweep,
  onVerdictMessage,
  onCertificateBroadcast,
  onCertificateSyncEvent,
};
