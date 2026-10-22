'use strict';

const config = require('config');
const serviceHelper = require('./serviceHelper');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const verificationHelper = require('./verificationHelper');
const { serialiseAndSignFluxBroadcast } = require('./utils/fluxBroadcastHelper');
const networkStateService = require('./networkStateService');
const nodeConfirmationService = require('./nodeConfirmationService');
const nodeDownStore = require('./appMessaging/nodeDownStore');
const messageStore = require('./appMessaging/messageStore');
const { RECORD_STATE } = nodeDownStore;
const { RingReconciler } = require('./utils/ringReconciler');
const {
  NodeDownJuror, DROP_REASON, STOP_CLOSE_AGE_MS, STOP_FORWARD_AGE_MS,
} = require('./utils/nodeDownJuror');
const stopStatements = require('./utils/stopStatements');
const { FlapLadder } = require('./utils/flapLadder');
const meshOrdinals = require('./appMesh/meshOrdinals');
const { FluxPeerManager } = require('./utils/FluxPeerManager');
const { CLOSE_CODES } = require('./utils/FluxPeerSocket');
const { normalizeSocketAddress, extractIp } = require('./utils/socketAddressUtils');
const fluxEventBus = require('./utils/fluxEventBus');
const capabilities = require('./utils/capabilities');
const { NODE_DOWN_GRACE_MS } = require('./utils/appConstants');
const log = require('../lib/log');
const grantorController = require('./quorumGrant/grantorController');
const peerNotification = require('./appMessaging/peerNotification');

// The node-down assembly: binds the reconciler (who to hold) and the juror
// (who to accuse) to the running node. Transport is injected at start by
// fluxCommunication, which owns the sockets; everything here stays inert
// until start() is called, so requiring this module changes nothing.

let transport = null;
// Set once at boot by setPlacementCheck.
let placementCheck = null;
let reconciler = null;
let juror = null;
// The mild tier's counters: this node's own, never stored or sent, gone with
// the process. A restart starts every duty from the bottom by design.
let ladder = null;
let localSocketAddress = null;
// The network is gone: the peer floor fell, and the recovery's resync has not
// completed since. Announcements are held meanwhile.
let wasUnreachable = false;
let unreachableSinceMs = null;
// The grant plane and the mesh have heard of this return (the first peer back).
let returnNoticed = false;
// The grace, armed at the loss: the live-isolation clock.
let isolationTimer = null;
let dropHandler = null;
let addHandler = null;
let answerHandler = null;
let unsubscribeList = null;
let unsubscribeFloorDown = null;
let unsubscribeFloorUp = null;
let unsubscribeSynced = null;
// The membership the duty memories were last pruned against.
let prunedFingerprint;
// This node's own lockout as last read — by the reconciler's pass, or the
// moment a certificate about this node locks it out. Read by every dialler.
let selfLocked = false;
// edge: the lockout on this node could not be read; cleared when it can again
let selfLockoutUnreadable = false;
// edge: the death count for a subject could not be read; cleared when it can
let deathUnreadable = false;

// A coded drop reaches the juror once its stop statement is checked, which
// takes a turn of the event loop: a duty's drops and holds wait on its
// pending check, so the juror reads them in the order they happened.
const pendingDrops = new Map();

/**
 * Run `apply` for this connection once every earlier drop on it has reached
 * the juror: at once when none is pending. An `apply` that answers a promise
 * is pending until it settles.
 * @param {string} socketAddress
 * @param {() => (void|Promise<void>)} apply
 */
function inDropOrder(socketAddress, apply) {
  const before = pendingDrops.get(socketAddress);
  const settled = before ? before.then(apply) : apply();
  if (!settled || typeof settled.then !== 'function') return;
  const tail = settled
    .catch((error) => log.warn(`nodeDownService: ${error.message}`))
    .then(() => {
      if (pendingDrops.get(socketAddress) === tail) pendingDrops.delete(socketAddress);
    });
  pendingDrops.set(socketAddress, tail);
}

// outpoint <-> dialable address, rebuilt when the membership moves.
const index = { fingerprint: undefined, byOutpoint: new Map(), bySocket: new Map() };

// What a stopping process says on the connection it closes. Any other
// reconnect-worthy code is a drop it did not announce.
const STOP_REASON_BY_CODE = new Map([
  [CLOSE_CODES.SHUTTING_DOWN, DROP_REASON.SHUTDOWN],
  [CLOSE_CODES.RESTARTING, DROP_REASON.RESTART],
]);

// How long the probe waits for the pong. The same bound as the handshake:
// a node that accepted the connection and then says nothing is not there.
const PROBE_ANSWER_MS = config.get('fluxapps.wsHandshakeTimeoutMs');

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

/**
 * This node's outpoint: the collateral the daemon names in the node's own
 * status. That is the node's identity whatever address the list currently
 * shows for it, which matters for the window after an address change and
 * before the chain records it. The list lookup by address is the fallback for
 * a status that carries no outpoint.
 * @returns {string|null}
 */
function myOutpoint() {
  const status = nodeConfirmationService.getNodeStatus();
  if (status?.txhash && status.outidx !== undefined && status.outidx !== null) {
    return `${status.txhash}:${status.outidx}`;
  }
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
 * forgotten at six hours — and a locked-out one, whose watchers no longer
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
 * lockout holds the stand-down open past the certificate. Both leave the
 * node out of the dial plan and off the verdict push list.
 */
async function stoodDown(outpoint) {
  try {
    const [record, lockout] = await Promise.all([
      nodeDownStore.recordStateFor(outpoint),
      nodeDownStore.lockoutFor(outpoint),
    ]);
    noteRecordState(outpoint, record);
    return record.state === RECORD_STATE.STANDING || lockout.lockedOut;
  } catch (error) {
    return false;
  }
}

/**
 * What a door hands a locked-out dialer before it closes: every row it holds
 * about the dialer, as the signed messages the gossip would have carried. The
 * dialer verifies each as it verifies any certificate and its own store
 * reaches the count, whichever rows it missed while it was dark — it learns
 * from the network's word, not from a reason string, and it needs no other
 * channel: every juror stands down and every door closes, so the door is the
 * one place a locked-out node can still hear.
 *
 * @param {string} subject collateral outpoint
 * @returns {Promise<string[]>} serialised, signed frames, oldest row first
 */
async function doorEvidence(subject) {
  const rows = await nodeDownStore.certificatesFor(subject);
  return Promise.all(rows.map(({ certificate, broadcastedAt }) => serialiseAndSignFluxBroadcast({
    type: 'fluxnodedown', version: 1, certificate, broadcastedAt,
  })));
}

/**
 * Whether a node is on this node's own jury: one of the nodes assigned to
 * watch it, whose peering is its guaranteed inbound.
 *
 * @param {string} outpoint
 * @returns {boolean}
 */
function isOwnJuror(outpoint) {
  const topology = networkStateService.nodeDownTopology();
  const me = myOutpoint();
  const jury = topology && me ? topology.jury(me) : null;
  return Boolean(jury && jury.some((juror) => juror.outpoint === outpoint));
}

/**
 * The peering gate the peer manager asks before a peering inbound registers.
 * Only a listed subject under the lockout is refused — a placement freeze
 * refuses nobody; who else may peer is decided where it always was. A
 * refusal carries the rows behind it (`tell`), written before the close. An
 * admitted dialer on this node's own jury is marked `juror`: the inbound cap
 * does not apply to it, since a juror held off cannot watch.
 *
 * @param {string} socketAddress the dialer's ip:port
 * @returns {Promise<{admitted: boolean, reason: string, juror?: boolean, subject?: string, tell?: string[]}>}
 */
async function inboundGate(socketAddress) {
  refreshIndex();
  const subject = index.bySocket.get(normalizeSocketAddress(socketAddress));
  if (!subject) return { admitted: true, reason: 'unlisted', juror: false };
  try {
    const lockout = await nodeDownStore.lockoutFor(subject);
    if (!lockout.lockedOut) return { admitted: true, reason: 'not_locked_out', juror: isOwnJuror(subject) };
    let tell = [];
    try {
      tell = await doorEvidence(subject);
    } catch (error) {
      log.warn(`nodeDownService: the rows behind ${subject}'s lockout could not be signed; refusing without them: ${error.message}`);
    }
    fluxEventBus.publish('nodedown:inboundRefused', {
      subject, socketAddress, count: lockout.count, liftsAt: lockout.liftsAt,
    });
    return {
      admitted: false, reason: 'locked_out', subject, tell,
    };
  } catch (error) {
    log.warn(`nodeDownService: lockout lookup for ${subject} failed, admitting: ${error.message}`);
    return { admitted: true, reason: 'store_error', juror: isOwnJuror(subject) };
  }
}

/**
 * A certification just stored may have locked the subject out: say so, and
 * drop any connection still held to it — its watchers will not dial it and
 * the gate will not readmit it until the hold lifts.
 */
async function noteLockout(subject, source) {
  const lockout = await nodeDownStore.lockoutFor(subject);
  if (!lockout.lockedOut) return;
  fluxEventBus.publish('nodedown:lockedOut', {
    subject, source, count: lockout.count, liftsAt: lockout.liftsAt,
  });
  const socketAddress = resolveOutpoint(subject);
  if (transport && socketAddress && transport.peerManager.has(socketAddress)) {
    transport.closePeer(socketAddress, 'locked out');
  }
}

/**
 * One fresh dial, now, and one exchange: reachable means the far end
 * accepted the connection AND answered a ping. A node that is up but not
 * yet confirmed completes the handshake and hangs up before reading a frame
 * (FluxPeerManager.validateAndAddInbound), so the handshake alone would
 * call a rebooting node reachable and nothing would ever expire its rows;
 * the pong is what only a confirmed FluxOS gives. The connection is closed
 * either way; a probe must never register a peer.
 *
 * @param {string} socketAddress
 * @returns {Promise<boolean>}
 */
async function probe(socketAddress) {
  const peer = await transport.openEphemeralConnection(socketAddress);
  if (!peer) return false;
  return new Promise((resolve) => {
    let timer = null;
    const answer = (reachable) => {
      clearTimeout(timer);
      peer.ws.removeListener('pong', onPong);
      peer.ws.removeListener('close', onClose);
      peer.ws.removeListener('error', onClose);
      try {
        peer.close();
      } catch (error) { /* already gone */ }
      resolve(reachable);
    };
    const onPong = () => answer(true);
    const onClose = () => answer(false);
    peer.ws.on('pong', onPong);
    peer.ws.on('close', onClose);
    peer.ws.on('error', onClose);
    timer = setTimeout(() => answer(false), PROBE_ANSWER_MS);
    try {
      peer.ws.ping();
    } catch (error) {
      answer(false);
    }
  });
}

/**
 * One signed message to another juror, one-way over an ephemeral
 * connection; nothing to a juror the network holds down.
 * @param {string} socketAddress
 * @param {object} message
 * @param {string} what journal only
 */
async function pushToJuror(socketAddress, message, what) {
  try {
    refreshIndex();
    const target = index.bySocket.get(socketAddress);
    if (target && await stoodDown(target)) return;
    const peer = await transport.openEphemeralConnection(socketAddress);
    if (!peer) {
      log.warn(`nodeDownService: ${what} push to ${socketAddress}: no ephemeral connection`);
      return;
    }
    await transport.sendSignedMessage(message, peer, { awaitDrain: true });
    peer.close();
  } catch (error) {
    log.warn(`nodeDownService: ${what} push to ${socketAddress} failed: ${error.message}`);
  }
}

async function pushVerdict(socketAddress, verdict) {
  await pushToJuror(socketAddress, { type: 'fluxnodedownverdict', version: 1, verdict }, 'verdict');
}

async function pushNote(socketAddress, statement) {
  await pushToJuror(socketAddress, { type: 'fluxcourtesynote', version: 1, statement }, 'stop note');
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
  // The fleet first: what the store's answer sets in motion on this node
  // follows, and cannot hold the broadcast back.
  await transport.broadcastMessageToAll({
    type: 'fluxnodedown', version: 1, certificate, broadcastedAt,
  });
  await settleStoredCertificate(certificate, 'own', stored);
}

/**
 * What a stored certificate sets in motion on this node, whichever path
 * stored it — the node's own assembly, gossip, or the sync stream. On a full
 * jury every juror collects and assembles, and the gossip copies that follow
 * are refused as already standing, so a lockout noted on the intake alone is
 * a lockout no juror says: the fourth certificate locked the subject out of
 * every door and not one survivor announced it or dropped a held connection.
 *
 * @param {object} certificate
 * @param {string} source 'own', 'gossip' or 'sync' — stamped on the harness
 *   events, so a suite can assert WHICH path delivered a certificate
 * @param {{superseded?: boolean}} stored the store's answer
 */
async function settleStoredCertificate(certificate, source, stored) {
  fluxEventBus.publish('nodedown:stored', { subject: certificate.subject, source });
  await noteLockout(certificate.subject, source);
  // the ordinals the certified node holds are NOT reclaimed here: the vacate
  // follows the derivation's placement-dead edge (since + the grace), asked
  // by the joiner that needs the name on its own scan (meshOrdinals.js,
  // ordinalRegister.vacateOrdinal) — R9, NODE_DOWN_SCENARIOS.md §5

  if (certificate.subject === myOutpoint()) {
    // A lockout has no ordering race: four standing rows are four whichever
    // arrived first. And the door that handed them over is the only channel
    // a locked-out node has — its return sync never completes, so the wait
    // for it is over and the check runs now.
    const lockout = await nodeDownStore.lockoutFor(certificate.subject);
    selfLocked = lockout.lockedOut;
    if (lockout.lockedOut) {
      cancelPendingReturn();
      applyPlacementThenAnnounce('lockout').catch((error) => log.warn(`nodeDownService: ${error.message}`));
    } else if (!wasUnreachable && !stored.superseded) {
      // Not while a return is pending: the recovery's resync delivers the
      // records in its own order, a past one ahead of the newest, and a
      // check run on the first would answer for a store the resync has not
      // finished filling — then release the hold and announce, which refutes
      // the newest on every survivor. The return check reads the whole store
      // once the resync has completed. And not for a certificate older than
      // the record held: a past incident is stored for the count, not news.
      applyPlacementThenAnnounce('certificate').catch((error) => log.warn(`nodeDownService: ${error.message}`));
    }
  } else if (reconciler) {
    // Sync can deliver before start(); the reconciler's first pass reads the
    // store, so a certificate stored now is honoured then.
    reconciler.schedule(`nodedown-stored:${source}`);
  }
}

/**
 * This node's alive record: the refutation of every certificate about it
 * stamped at or before now, sent whether or not the node runs an app. It
 * touches no app row, so placement is unaffected by it. Stored here too, so
 * this node serves it over sync like any other record it holds.
 */
async function announceAlive(trigger) {
  const outpoint = myOutpoint();
  const ip = await fluxNetworkHelper.getLocalSocketAddress();
  if (!transport || !outpoint || !ip) {
    log.warn(`nodeDownService: alive record (${trigger}) not sent: this node cannot name itself`);
    return;
  }
  const message = {
    type: 'fluxnodealive', version: 1, ip, broadcastedAt: Date.now(),
  };
  const signed = await transport.broadcastMessageToAll(message);
  const envelope = signed
    ? {
      version: signed.version, timestamp: signed.timestamp, pubKey: signed.pubKey, signature: signed.signature,
    }
    : null;
  const separator = outpoint.lastIndexOf(':');
  await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.NODEALIVE, {
    message,
    envelope,
    announcer: { txhash: outpoint.slice(0, separator), outidx: outpoint.slice(separator + 1) },
  });
  fluxEventBus.publish('nodedown:aliveAnnounced', { trigger, broadcastedAt: message.broadcastedAt });
}

/**
 * Hand this service the check that decides, from this node's derived rows,
 * whether they still place it, removing every app when they do not. Wired at
 * boot, before any peer connects: a certificate about this node can arrive by
 * sync before start().
 *
 * @param {function(string): Promise<{placed: boolean}>} check
 */
function setPlacementCheck(check) {
  placementCheck = check;
}

/**
 * The return rule, run after the store is current: the node asks its own
 * derived rows whether they still place it. Placed: keep every app and
 * announce them. Not placed: every app is removed inside the check and no
 * app is announced. A check that throws announces, as before: nothing here
 * may be the reason an app is deleted. On a return or a certificate the node
 * also sends its alive record either way, which refutes the certificates
 * about it; a lockout holds the stand-down open, so it sends none.
 *
 * @param {string} trigger 'return' | 'certificate' | 'lockout'
 */
async function applyPlacementThenAnnounce(trigger) {
  let placed = true;
  try {
    if (!placementCheck) throw new Error('no placement check is wired');
    ({ placed } = await placementCheck(trigger));
  } catch (error) {
    log.warn(`nodeDownService: placement check (${trigger}) failed, announcing: ${error.message}`);
  }
  // the store has been read: whatever was held back is free to go
  peerNotification.releaseAnnouncements();
  if (placed) {
    log.info(`nodeDownService: placement check (${trigger}): the rows still place this node, announcing`);
    peerNotification.checkAndNotifyPeersOfRunningApps();
  }
  if (trigger !== 'lockout') {
    await announceAlive(trigger).catch((error) => log.warn(`nodeDownService: alive record (${trigger}) failed: ${error.message}`));
  }
}

/**
 * The shared certificate intake: gossip and sync land here alike, so both
 * pass the store's full verification and both trigger the same reactions.
 * A certificate about THIS node runs the return rule: inside the grace the
 * rows still place it and the announce refutes; past it they are gone and
 * the node removes.
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
  await settleStoredCertificate(message.certificate, source, result);
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

// Senders whose last verdict message carried no verdict; cleared by the next
// well-formed one, so the fault is logged on its edge and not per message.
const malformedVerdictSenders = new Set();

function onVerdictMessage(msgObj) {
  if (!juror) return;
  const verdict = msgObj?.data?.verdict;
  const sender = msgObj?.pubKey ?? '?';
  if (!verdict) {
    if (!malformedVerdictSenders.has(sender)) {
      malformedVerdictSenders.add(sender);
      log.warn(`nodeDownService: verdict message from ${sender} carries no verdict, dropped`);
    }
    return;
  }
  malformedVerdictSenders.delete(sender);
  const result = juror.onVerdictArrived(verdict);
  fluxEventBus.publish('nodedown:verdict', {
    subject: verdict.subject ?? null,
    juror: verdict.juror ?? null,
    piled: result.piled,
    reason: result.reason,
  });
}

/**
 * Another juror forwarded a subject's signed stop: held when it is the
 * subject's own, signed within STOP_FORWARD_AGE_MS of this node's clock,
 * and the subject is this node's duty.
 * @param {object} msgObj the note, its envelope already verified
 * @returns {Promise<void>}
 */
async function onCourtesyNote(msgObj) {
  if (!juror) return;
  const statement = msgObj?.data?.statement;
  const stop = await stopStatements.verifyStop(statement, { now: Date.now(), maxAgeMs: STOP_FORWARD_AGE_MS });
  if (!stop.ok) {
    log.info(`nodeDownService: a stop note from ${msgObj?.pubKey ?? '?'} is not accepted (${stop.why})`);
    return;
  }
  if (!juror) return;
  refreshIndex();
  juror.onNote(index.bySocket.get(stop.ip), stop.reason, { processId: stop.processId, statement });
}

/**
 * The stop statement a coded close carried, when it is the closing node's,
 * names this close's reason and was signed within STOP_CLOSE_AGE_MS of this
 * node's clock; null otherwise, and the juror reads the close as
 * unannounced.
 *
 * @param {object|null} statement
 * @param {string} socketAddress the closing node's
 * @param {string} reason the close code's DROP_REASON
 * @returns {Promise<{processId: string, statement: object}|null>}
 */
async function stopOnClose(statement, socketAddress, reason) {
  if (!statement) return null;
  const stop = await stopStatements.verifyStop(statement, {
    now: Date.now(), maxAgeMs: STOP_CLOSE_AGE_MS, socketAddress, reason,
  });
  if (!stop.ok) {
    log.info(`nodeDownService: the stop statement on ${socketAddress}'s ${reason} close is not accepted (${stop.why})`);
    return null;
  }
  return { processId: stop.processId, statement };
}

function onPeerRemoved({
  ip, port, closeCode, stopStatement = null,
}) {
  if (!reconciler) return;
  reconciler.schedule('peer-removed');
  // every peer gone again while the network is still not back: the grace
  // runs again from this drop, as the jurors' does
  if (wasUnreachable && !isolationTimer && transport.peerManager.allPeersDown()) armIsolationClock();

  // Only an unexpected loss raises suspicion or counts as a flap — a
  // deliberate close (duplicate, capacity, our own teardown) is not an
  // observation about the peer. A stopping process closes with its reason:
  // the juror honours it, and an honoured stop is neither suspicion nor a
  // flap.
  if (!FluxPeerManager.shouldReconnect(closeCode)) return;
  refreshIndex();
  const socketAddress = `${ip}:${port}`;
  const outpoint = index.bySocket.get(socketAddress);
  if (!outpoint) return;
  const reason = STOP_REASON_BY_CODE.get(closeCode) ?? DROP_REASON.UNANNOUNCED;
  const noted = (stop) => {
    if (!juror) return;
    const { honoured } = juror.noteDrop(outpoint, reason, stop);
    const duties = dutyOutpoints();
    if (!honoured && duties.has(outpoint)) ladder.noteDrop(outpoint, duties.size);
  };
  if (reason === DROP_REASON.UNANNOUNCED) {
    inDropOrder(socketAddress, () => noted(null));
    return;
  }
  const checked = stopOnClose(stopStatement, socketAddress, reason)
    .catch((error) => {
      log.warn(`nodeDownService: the stop statement from ${socketAddress} could not be checked: ${error.message}`);
      return null;
    });
  inDropOrder(socketAddress, () => checked.then(noted));
}

// A peering counts as a hold once the far end has spoken. The add is the
// handshake, and a node refusing at the door completes it and hangs up
// before it says anything: every juror's redial to a listed-but-unconfirmed
// node was a four-millisecond hold that retired its deferral and its
// standing answer, and the grace-end look never came.
function onPeerAnswered({ ip, port } = {}) {
  if (!ladder || !ip || !port) return;
  refreshIndex();
  const socketAddress = `${ip}:${port}`;
  const outpoint = index.bySocket.get(socketAddress);
  if (outpoint && dutyOutpoints().has(outpoint)) {
    inDropOrder(socketAddress, () => {
      if (!juror) return;
      ladder.noteReturn(outpoint);
      juror.noteHeld(outpoint);
    });
  }
}

/**
 * Whether this node is locked out, as last read. Every dialler reads it:
 * a locked-out node dials nobody, whoever asks — on the fleet the survivors'
 * asks to be dialled back had it knocking four times a second with its own
 * plan stood down.
 *
 * @returns {boolean}
 */
function isLockedOut() {
  return selfLocked;
}

async function onPeerAdded({ ip, port } = {}) {
  // A peering with a node the network holds out is closed as it is added,
  // whichever end dialled: a dial in flight when the lockout landed lands
  // after it, and a locked-out node holds nothing in either direction.
  if (transport && ip && port) {
    const socketAddress = `${ip}:${port}`;
    if (selfLocked) {
      transport.closePeer(socketAddress, 'locked out');
      return;
    }
    refreshIndex();
    const subject = index.bySocket.get(socketAddress);
    if (subject) {
      const lockout = await nodeDownStore.lockoutFor(subject).catch(() => ({ lockedOut: false }));
      if (lockout.lockedOut) {
        transport.closePeer(socketAddress, 'locked out');
        return;
      }
    }
  }
  if (!wasUnreachable) return;
  // someone reached this node: the jurors hold it or can, and the fleet's
  // grace stops running against it
  clearIsolationTimer();
  if (returnNoticed) return;
  returnNoticed = true;
  // Back from unreachability without a restart, from the first peer back: the
  // grant plane re-fetches its published records before answering, and the
  // mesh re-probes the names a record gives this node before trusting them
  // again. The announce waits for the network: the floor re-attained and the
  // recovery's resync completed, which is when the rows can be read for real.
  try {
    grantorController.noteReturnFromUnreachability();
  } catch (error) {
    log.warn(`nodeDownService: return notice failed: ${error.message}`);
  }
  meshOrdinals.noteReturnFromUnreachability();
}

/**
 * The network is gone: the peer floor fell. Announcements are held until the
 * return check has read what the network kept meanwhile, and the grace runs
 * against this node as the jurors run it against every drop.
 */
function onFloorLost() {
  if (!transport || wasUnreachable) return;
  wasUnreachable = true;
  returnNoticed = false;
  peerNotification.holdAnnouncements('every peer is gone; the return check answers before the next announce');
  fluxEventBus.publish('nodedown:unreachable', { sinceMs: unreachableSinceMs });
  armIsolationClock();
}

/** The grace, from now: nobody reaches this node. */
function armIsolationClock() {
  unreachableSinceMs = Date.now();
  isolationTimer = setTimeout(() => {
    isolationTimer = null;
    onIsolatedPastGrace().catch((error) => log.warn(`nodeDownService: ${error.message}`));
  }, NODE_DOWN_GRACE_MS);
  if (isolationTimer.unref) isolationTimer.unref();
}

/**
 * The live-isolation clock: nobody reached this node for the whole grace,
 * the same test and constant the jurors certify it by, so the fleet has moved
 * on; the node applies the constant to itself and removes every app where it
 * stands, broadcasting nothing. Its rows are read for real once the network
 * is back.
 */
async function onIsolatedPastGrace() {
  if (!transport || !wasUnreachable) return;
  log.warn(`nodeDownService: no peers for ${NODE_DOWN_GRACE_MS / 1000}s, the grace the fleet certifies a node by; removing every app`);
  let removed = [];
  try {
    if (!placementCheck) throw new Error('no placement check is wired');
    ({ removed } = await placementCheck('isolated'));
  } catch (error) {
    log.warn(`nodeDownService: the isolated removal failed: ${error.message}`);
  }
  fluxEventBus.publish('nodedown:isolated', { sinceMs: unreachableSinceMs, removed });
}

function clearIsolationTimer() {
  if (isolationTimer) clearTimeout(isolationTimer);
  isolationTimer = null;
}

/** A lockout answered the return's question; nothing stays pending. */
function cancelPendingReturn() {
  wasUnreachable = false;
  clearIsolationTimer();
}

/**
 * The network is back once the peer floor stands AND the recovery's resync
 * has completed: the store then holds what the network decided while this
 * node was dark. Then the one question, then the announce — or the removal.
 */
function maybeReturn() {
  if (!wasUnreachable) return;
  if (!capabilities.isUp('peersAboveFloor') || !capabilities.isUp('appStateSynced')) return;
  wasUnreachable = false;
  clearIsolationTimer();
  applyPlacementThenAnnounce('return').catch((error) => log.warn(`nodeDownService: ${error.message}`));
}

/**
 * The list moved: duties this node no longer owes leave every memory, the
 * local address is re-read, and the ring re-plans against the new list.
 */
async function onListMoved() {
  if (!reconciler) return;
  const fingerprint = networkStateService.membershipFingerprint();
  if (fingerprint === null || fingerprint === prunedFingerprint) return;
  prunedFingerprint = fingerprint;
  await primeLocalAddress();
  const duties = dutyOutpoints();
  ladder.retain(duties);
  juror.retain(duties);
  // A record seen standing for a node the list has since dropped is never
  // asked about again: forget it, so a later relisting starts clean.
  [...seenStanding.keys()].forEach((outpoint) => {
    if (!duties.has(outpoint)) seenStanding.delete(outpoint);
  });
  reconciler.schedule('list-moved');
}

/**
 * Whether this node may dial the far end on its request
 * (/flux/addoutgoingpeer). Only the lockout refuses: a locked-out node must
 * not get its inbound back by asking for it, or it passes the communication
 * check the delisting rests on. A node whose record merely stands is a
 * different case — the request itself is proof it is back, and the inbound
 * it asks for is what lets it sync and refute inside the grace; the plan
 * declines to dial such a node on its own, but answers its ask.
 *
 * @param {string} socketAddress the requester's ip:port
 * @returns {Promise<{allowed: boolean, reason: string, subject?: string}>}
 */
async function mayDialBack(socketAddress) {
  if (!transport) return { allowed: true, reason: 'not_started' };
  refreshIndex();
  const subject = index.bySocket.get(normalizeSocketAddress(socketAddress));
  if (!subject) return { allowed: true, reason: 'unlisted' };
  try {
    const lockout = await nodeDownStore.lockoutFor(subject);
    if (lockout.lockedOut) return { allowed: false, reason: 'locked_out', subject };
    return { allowed: true, reason: 'not_locked_out', subject };
  } catch (error) {
    log.warn(`nodeDownService: lockout lookup for ${subject} failed, allowing the dial-back: ${error.message}`);
    return { allowed: true, reason: 'store_error', subject };
  }
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
        { timeout: 5000 },
      ).catch(() => { /* the far end dials back or it does not */ });
    },
    inboundCount: () => transport.peerManager.inboundCount,
    stoodDown,
    selfLockout: async () => {
      const me = myOutpoint();
      if (!me) return { lockedOut: false, count: 0, liftsAt: null };
      try {
        const lockout = await nodeDownStore.lockoutFor(me);
        selfLocked = lockout.lockedOut;
        if (selfLockoutUnreadable) {
          selfLockoutUnreadable = false;
          log.info('nodeDownService: the lockout on this node is readable again');
        }
        return lockout;
      } catch (error) {
        // A store that cannot be read is no evidence either way: the pass keeps
        // its last reading and goes on. The pass awaits this first, so a read
        // that rejected failed every pass and a node with a sick database
        // dialled nobody (217 on chud, 2026-09-07: the poisoned source never
        // reached the joiner).
        if (!selfLockoutUnreadable) {
          selfLockoutUnreadable = true;
          log.warn(`nodeDownService: the lockout on this node could not be read; the pass keeps its last reading (locked out: ${selfLocked}): ${error.message}`);
        }
        return { lockedOut: selfLocked, count: null, liftsAt: null };
      }
    },
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
    nextDeath: async (subject) => {
      try {
        const death = await nodeDownStore.nextDeathFor(subject);
        if (deathUnreadable) {
          deathUnreadable = false;
          log.info('nodeDownService: the death count is readable again');
        }
        return death;
      } catch (error) {
        // No number is a verdict the assembly still counts; the number comes
        // from the jurors that can read theirs.
        if (!deathUnreadable) {
          deathUnreadable = true;
          log.warn(`nodeDownService: the death count could not be read; verdicts name no death until it can: ${error.message}`);
        }
        return undefined;
      }
    },
    verifySignature: (owner, payload, signature) => verificationHelper
      .verifyMessage(payload.toString(), owner, signature) === true,
    pushVerdict,
    pushNote,
    isLie: stopStatements.isLie,
    onProof: (subject, a, b) => {
      broadcastOwnCertificate(stopStatements.lieCertificate(subject, a, b)).catch((error) => log.error(error));
    },
    currentHeight: () => networkStateService.chainHeight() ?? 0,
    now: () => Date.now(),
    currentFingerprint: () => networkStateService.membershipFingerprint(),
    onCertificate: (certificate) => {
      broadcastOwnCertificate(certificate).catch((error) => log.error(error));
    },
  });

  nodeDownStore.registerWithGrantPlane();

  dropHandler = (payload) => onPeerRemoved(payload);
  addHandler = (payload) => onPeerAdded(payload).catch((error) => log.warn(`nodeDownService: ${error.message}`));
  answerHandler = (payload) => onPeerAnswered(payload);
  transport.peerManager.on('peer:removed', dropHandler);
  transport.peerManager.on('peer:added', addHandler);
  transport.peerManager.on('peer:answered', answerHandler);
  transport.peerManager.setInboundGate(inboundGate);

  unsubscribeFloorDown = capabilities.onDown('peersAboveFloor', onFloorLost);
  unsubscribeFloorUp = capabilities.onUp('peersAboveFloor', maybeReturn);
  unsubscribeSynced = capabilities.onUp('appStateSynced', maybeReturn);
  unsubscribeList = networkStateService.onListUpdated(() => {
    onListMoved().catch((error) => log.warn(`nodeDownService: list move failed: ${error.message}`));
  });

  primeLocalAddress().then(() => reconciler.start());
  // A node started before its list arrives owes duties it cannot name yet:
  // the list's arrival is the pass that dials them.
  networkStateService.onReady(() => {
    if (reconciler) reconciler.schedule('list-ready');
  });
  log.info('nodeDownService started');
}

function stop() {
  if (transport && dropHandler) transport.peerManager.off('peer:removed', dropHandler);
  if (transport && addHandler) transport.peerManager.off('peer:added', addHandler);
  if (transport && answerHandler) transport.peerManager.off('peer:answered', answerHandler);
  if (unsubscribeFloorDown) unsubscribeFloorDown();
  if (unsubscribeFloorUp) unsubscribeFloorUp();
  if (unsubscribeSynced) unsubscribeSynced();
  unsubscribeFloorDown = null;
  unsubscribeFloorUp = null;
  unsubscribeSynced = null;
  if (unsubscribeList) unsubscribeList();
  unsubscribeList = null;
  clearIsolationTimer();
  if (wasUnreachable) peerNotification.releaseAnnouncements();
  wasUnreachable = false;
  returnNoticed = false;
  unreachableSinceMs = null;
  prunedFingerprint = undefined;
  if (transport) transport.peerManager.setInboundGate(null);
  dropHandler = null;
  addHandler = null;
  if (reconciler) reconciler.stop();
  reconciler = null;
  if (juror) juror.stop();
  juror = null;
  ladder = null;
  transport = null;
  index.fingerprint = undefined;
  index.byOutpoint.clear();
  index.bySocket.clear();
  seenStanding.clear();
  pendingDrops.clear();
}

module.exports = {
  setPlacementCheck,
  start,
  stop,
  probe,
  onVerdictMessage,
  onCourtesyNote,
  onCertificateBroadcast,
  onCertificateSyncEvent,
  mayDialBack,
  isLockedOut,
};
