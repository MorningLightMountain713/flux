'use strict';

/* eslint-disable no-underscore-dangle */
const config = require('config');
const hash = require('object-hash');
const WebSocket = require('ws');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const messageStore = require('./appMessaging/messageStore');
const nodeDownService = require('./nodeDownService');
const messageVerifier = require('./appMessaging/messageVerifier');
const ingressAttestationService = require('./appMessaging/ingressAttestationService');
const ingressAttestationSyncService = require('./appMessaging/ingressAttestationSyncService');
const verificationHelper = require('./verificationHelper');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const fluxCommunicationMessagesSender = require('./fluxCommunicationMessagesSender');
const policyStore = require('./policyStore');
const fluxCommunicationUtils = require('./fluxCommunicationUtils');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const messageHelper = require('./messageHelper');
const { peerManager, PEER_SOURCE, CLOSE_CODES } = require('./utils/peerState');
const limitCounter = require('./utils/limitCounter');
const cacheManager = require('./utils/cacheManager').default;
const networkStateService = require('./networkStateService');
const nodeConfirmationService = require('./nodeConfirmationService');
const { extractIp, extractPort, parseSocketAddress, socketAddressesMatch } = require('./utils/socketAddressUtils');
const appsRepository = require('./appDatabase/appsRepository');
const contentSlotService = require('./appLifecycle/contentSlotService');
const contentManifestSyncService = require('./appMessaging/contentManifestSyncService');
const fluxEventBus = require('./utils/fluxEventBus');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('./utils/appSyncEvents');
const { INTENT } = require('./utils/messageIntent');
const {
  ROUTE, register, declaredIntent, handlerFor, isOrdered,
} = require('./utils/messageRoutes');

const { announcementSeen, announcementStore, wsPeerCache } = cacheManager;

/* const LRUTest = {
  max: 25000000, // 25M
  ttl: 60 * 60 * 1000, // 1h
  maxAge: 60 * 60 * 1000, // 1h
};

const testListCache = new LRUCache(LRUTest); */

const { FLUX_VERSION, FLUX_CAPABILITIES } = require('./utils/FluxPeerManager');
const { NAK_REASON, buildSyncSignatureMessage } = require('./utils/peerCodec');
const { networkHealthMonitor } = require('./utils/NetworkHealthMonitor');
const verifyPool = require('./utils/verifyPool');
const { Privilege, authOf } = require('./utils/privileges');

// Upper bound of the random delay before each reconciler dial. Reciprocal
// duties make simultaneous crossing dials the common case; the jitter breaks
// the symmetry so a crossing loss cannot repeat in lockstep.
const DIAL_JITTER_MS = config.fluxapps.dialJitterMs ?? 250;

// How a dial resolved, for the reconciler's settle callback. HELD: the pair
// holds a live connection (this dial's, or the survivor of a crossing race).
// FAILED: the dial resolved without one — evidence against the target.
// NO_DIAL: nothing was dialed, no evidence gained — retry later.
const DIAL_RESULT = Object.freeze({ HELD: true, FAILED: false, NO_DIAL: null });

// How many events of a sync response are carried through verification and
// storage together. A response holds up to 2500, and each event fans out into a
// database operation per app it reports, so the whole response is never held at
// once.
const SYNC_EVENTS_PER_SLICE = 250;

/**
 * Fire the store's promotion signal: a just-stored temp message matched an
 * unresolved on-chain hash, so confirm it (spec materialization) off the hot path.
 * @param {object|null} promotion Promotion descriptor from storeAppTemporaryMessage.
 */
function schedulePromotion(promotion) {
  if (!promotion) return;
  setImmediate(() => {
    messageVerifier.checkAndRequestApp(promotion.hash, promotion.txid, promotion.height, promotion.value, promotion.blockTime ?? null, 2)
      .catch((err) => log.error(`Immediate promotion failed for ${promotion.hash}: ${err.message}`));
  });
}

/**
 * To handle temporary app messages.
 * @param {object} message Message.
 * @param {string} fromIP Sender's IP address.
 * @param {string} port Sender's node Api port.
 */
async function handleAppMessages(message, fromIP, port) {
  try {
    // check if we have it in database and if not add
    // if not in database, rebroadcast to all connections
    // do furtherVerification of message
    const storeResult = await messageStore.storeAppTemporaryMessage(message.data);
    // The store RETURNS an Error for a rejected message (false for a known dedup —
    // too common to log); it must be surfaced or rejections are invisible.
    if (storeResult instanceof Error) {
      log.warn(`handleAppMessages - message ${message.data.hash} from ${fromIP}:${port} rejected: ${storeResult.message}`);
      return;
    }
    schedulePromotion(storeResult.promotion);
    if (storeResult.rebroadcast) {
      fluxEventBus.publish('network:appmessage', { hash: message.data.hash, type: message.data.type, name: message.data.appSpecifications?.name });
      announceToPeers(message, `${fromIP}:${port}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Verify and store an inbound ingress attestation, then flood it onward the
 * first time it is seen. The attestation's own signature (by the ingress node)
 * is what is verified; a bad or duplicate one is dropped without relay.
 * @param {object} message Parsed message object.
 * @param {string} fromIP Sender's IP.
 * @param {string} port Sender's node Api port.
 */
async function handleIngressAttestation(message, fromIP, port) {
  try {
    const result = await ingressAttestationService.receive(message.data);
    if (result instanceof Error) {
      log.warn(`handleIngressAttestation - from ${fromIP}:${port} rejected: ${result.message}`);
      return;
    }
    if (result.rebroadcast) {
      await fluxCommunicationMessagesSender.broadcastIngressAttestation(result.record);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * @returns {Promise<{verified: object[], announcers: Map<object, object|null>}>}
 *   announcers is keyed by the broadcast object itself, so callers that already track
 *   broadcasts by identity keep working unchanged.
 */
async function batchVerifyBroadcasts(broadcasts, label) {
  if (broadcasts.length === 0) return { verified: [], announcers: new Map() };

  const items = [];
  const nodeCheckFailed = new Set();
  for (let i = 0; i < broadcasts.length; i++) {
    const b = broadcasts[i];
    const { pubKey, timestamp, signature, version, data: payload } = b;
    // payload.type is required here for the same reason verifyFluxBroadcast rejects a
    // typeless message as malformed: without it there is no rule for which address the
    // broadcast should be attributed to, and it would fall back to owner-granular.
    if (version !== 1 || !pubKey || !timestamp || !signature || !payload || !payload.type) {
      nodeCheckFailed.add(i);
      continue;
    }
    // Same resolution the per-message path uses, so a batched broadcast is attributed
    // by exactly the rule an individually gossiped one would be.
    const { result: lookup, announcer } = await fluxCommunicationUtils.resolveBroadcastAnnouncer(payload, pubKey);
    if (lookup !== fluxCommunicationUtils.VerifyResult.OK) { nodeCheckFailed.add(i); continue; }
    const message = serviceHelper.ensureString(payload);
    items.push({
      index: i, announcer, messageToVerify: String(version) + message + String(timestamp), pubKey, signature,
    });
  }

  if (nodeCheckFailed.size > 0) {
    log.warn(`${label} - ${nodeCheckFailed.size} broadcasts failed node lookup`);
  }

  // Same shape as every other exit. Returning a bare array here left callers
  // destructuring `verified` out of it as undefined, and the throw that followed
  // was caught by the handler - skipping the rest of it, including the
  // sync-complete signal, so the round never finished.
  if (items.length === 0) return { verified: [], announcers: new Map() };

  // The worker reads only the three fields it needs, so items go across as they
  // are rather than being copied into a narrower shape first
  const cryptoResults = await verifyPool.verify(items);

  const verified = [];
  const announcers = new Map();
  for (let i = 0; i < items.length; i++) {
    if (cryptoResults[i]) {
      const broadcast = broadcasts[items[i].index];
      verified.push(broadcast);
      announcers.set(broadcast, items[i].announcer);
    }
  }

  log.info(`${label} - Verified ${verified.length}/${broadcasts.length} broadcasts (${nodeCheckFailed.size} node lookup failures, ${items.length - verified.length} signature failures)`);
  return { verified, announcers };
}

async function handleTempSyncResponse(message, peerSocket) {
  try {
    if (!peerManager.isSyncResponseWanted(peerSocket)) return;
    const peerKey = peerSocket.key;
    if (!message.data || message.data.type !== 'fluxapptempsync') return;
    const { messages, done, refused } = message.data;
    // A peer whose own app state is not authoritative holds an unknown fraction
    // of the network's pending registrations, and says so rather than sending
    // the fraction. A refusal is an answer and not a completion - see
    // handleAppRunningSyncResponse - and a peer refuses all four streams or
    // none, so whichever refusal arrives first ends the request.
    if (refused) {
      log.info(`handleTempSyncResponse - ${peerKey} declined: its app state is not authoritative yet`);
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_REFUSED, 'apptemp', peerKey);
      return;
    }
    if (!Array.isArray(messages) || messages.length > 2500) return;
    log.info(`handleTempSyncResponse - Received ${messages.length} temp messages from ${peerKey} (done: ${!!done})`);
    let stored = 0;
    let rejected = 0;
    for (const msg of messages) {
      try {
        const result = await messageStore.storeAppTemporaryMessage(msg, { furtherVerification: true });
        if (result instanceof Error) {
          rejected += 1;
          log.warn(`handleTempSyncResponse - message ${msg && msg.hash} from ${peerKey} rejected: ${result.message}`);
        } else if (result && typeof result === 'object' && 'rebroadcast' in result) {
          stored += 1;
          // The promotion signal fires only on the FIRST store of a message; every
          // later copy dedups to false. Dropping it here orphans a scanned hash.
          schedulePromotion(result.promotion);
        }
      } catch (err) {
        log.error(`Temp sync message failed: ${err.message}`);
      }
    }
    log.info(`handleTempSyncResponse - Processed ${stored} of ${messages.length} messages (${rejected} rejected)`);
    // COUNTED LIKE THE REST. A peer is credited once it has delivered every
    // stream it was asked for, so the record that admits its responses stays
    // open until this one has ended too - the three surveys finishing first no
    // longer cuts off what is still arriving here.
    if (done) {
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apptemp', peerKey);
      log.info('handleTempSyncResponse - Sync complete');
    }
  } catch (error) {
    log.error(error);
  }
}

async function handleAppRunningSyncResponse(message, peerSocket) {
  try {
    if (!message.data || message.data.type !== 'fluxapprunningsync') return;
    if (!peerManager.isSyncResponseWanted(peerSocket)) return;
    const peerKey = peerSocket.key;
    const { messages, done, refused } = message.data;
    // A peer that says its own app state is not worth surveying has ANSWERED,
    // and the answer is not a completion. Marking it declined stops it being
    // offered again on this connection, which opens a deficit in the pool of
    // outstanding requests and gets another peer asked.
    if (refused) {
      log.info(`handleAppRunningSyncResponse - ${peerKey} declined: its app state is not authoritative yet`);
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_REFUSED, 'apprunning', peerKey);
      return;
    }
    if (!Array.isArray(messages) || messages.length > 2500) return;
    log.info(`handleAppRunningSyncResponse - Received ${messages.length} events from ${peerKey} (done: ${!!done})`);

    // A sync response is processed a slice at a time. Verifying and storing the
    // whole response at once holds the events, their verification copies and the
    // database encoding of every location update in memory together, which is
    // what made a single response cost hundreds of megabytes that were never
    // returned to the OS.
    // Evictions are applied ahead of the other state events, as they were
    // before this response was processed in slices.
    const evictions = [];
    const nodeDowns = [];
    const stateEvents = [];

    await serviceHelper.processInSlices(messages, SYNC_EVENTS_PER_SLICE, async (slice) => {
      const appRunningBroadcasts = [];
      const otherBroadcasts = [];
      const evictedEvents = [];
      const nodeDownEvents = [];
      for (const event of slice) {
        if (event.envelope && event.type === 'apprunning') {
          appRunningBroadcasts.push({ ...event.envelope, data: event.data });
        } else if (event.type === 'nodedown') {
          // A certificate row is self-proving: the jury signatures inside it
          // are the gate, checked by the same verification as the gossip
          // intake. The envelope is provenance only — a locally-assembled row
          // carries none — so these bypass the envelope filter below.
          nodeDownEvents.push(event);
        } else if (event.type === 'evicted') {
          // Evicted events lack per-event signatures because they are generated
          // locally by nodeStatusMonitor, which makes non-deterministic HTTP
          // probe decisions about whether a remote node is alive. The
          // isSyncRequested check above ensures only solicited responses are
          // processed, but a compromised confirmed peer we sync from could still
          // include fake evictions. Impact is limited: only affects this node's
          // view and self-heals on the next apprunning broadcast (≤60 min).
          //
          // The root cause is nodeStatusMonitor itself — it will be replaced by
          // a peer quorum approach where eviction is determined by consensus of
          // signed "peer unreachable" events (3 missed pongs on the WebSocket
          // layer). Once that lands, evicted events will carry verifiable
          // signatures and this path will verify them like all other event types.
          evictedEvents.push(event);
        } else if (event.envelope) {
          otherBroadcasts.push(event);
        }
      }

      const { verified: verifiedAppRunning, announcers } = await batchVerifyBroadcasts(appRunningBroadcasts, 'handleAppRunningSyncResponse');

      const otherToVerify = otherBroadcasts.map((e) => ({ ...e.envelope, data: e.data }));
      const { verified: verifiedOther } = await batchVerifyBroadcasts(otherToVerify, 'handleAppRunningSyncResponse');
      const verifiedOtherSet = new Set(verifiedOther);
      evictions.push(...evictedEvents);
      nodeDowns.push(...nodeDownEvents);
      for (let i = 0; i < otherBroadcasts.length; i++) {
        if (verifiedOtherSet.has(otherToVerify[i])) {
          stateEvents.push(otherBroadcasts[i]);
        }
      }

      if (verifiedAppRunning.length > 0) {
        const { stored } = await messageStore.storeBatchAppRunningEvents(verifiedAppRunning, announcers);
        log.info(`handleAppRunningSyncResponse - Stored ${stored} of ${verifiedAppRunning.length} verified apprunning events`);
        fluxEventBus.publish('sync:chunkVerified', { syncType: 'apprunning', peer: peerKey, verified: verifiedAppRunning.length, stored });
      }
    });

    // Applied after every slice, never inside one. The reason was the location
    // table - an eviction cleared a node's rows outright, so a slice storing that
    // node's apprunning events afterwards put them straight back - and that table
    // is now gone. The order is kept because the other half of the reason still
    // holds: evictions carry no broadcastedAt, so the sender's timestamp sort puts
    // them in the earliest slice every time, and nothing here establishes that the
    // event log is indifferent to seeing them last.
    for (const event of [...evictions, ...nodeDowns, ...stateEvents]) {
      if (event.type === 'sigterm' || event.type === 'appremoved' || event.type === 'ipchanged' || event.type === 'masterlease' || event.type === 'grantgeneration') {
        await messageStore.storeAppStateEvent(event.type, { message: event.data, envelope: event.envelope });
      } else if (event.type === 'evicted') {
        await messageStore.storeAppStateEvent(event.type, { ip: event.ip });
      } else if (event.type === 'nodedown') {
        await nodeDownService.onCertificateSyncEvent(event);
      }
    }

    if (done) {
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apprunning', peerKey);
      log.info('handleAppRunningSyncResponse - Sync complete');
    }
  } catch (error) {
    log.error(error);
  }
}

async function handleAppInstallingSyncResponse(message, peerSocket) {
  try {
    if (!peerManager.isSyncResponseWanted(peerSocket)) return;
    const peerKey = peerSocket.key;
    if (!message.data || message.data.type !== 'fluxappinstallingsync') return;
    const { messages, done, refused } = message.data;
    // A refusal is an answer and not a completion - see handleAppRunningSyncResponse.
    if (refused) {
      log.info(`handleAppInstallingSyncResponse - ${peerKey} declined: its app state is not authoritative yet`);
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_REFUSED, 'appinstalling', peerKey);
      return;
    }
    if (!Array.isArray(messages) || messages.length > 2500) return;
    log.info(`handleAppInstallingSyncResponse - Received ${messages.length} broadcasts from ${peerKey} (done: ${!!done})`);
    await serviceHelper.processInSlices(messages, SYNC_EVENTS_PER_SLICE, async (slice) => {
      const { verified } = await batchVerifyBroadcasts(slice, 'handleAppInstallingSyncResponse');
      if (verified.length === 0) return;
      const { stored } = await messageStore.storeBatchAppInstallingMessages(verified);
      log.info(`handleAppInstallingSyncResponse - Stored ${stored} of ${verified.length} verified broadcasts`);
      fluxEventBus.publish('sync:chunkVerified', { syncType: 'appinstalling', peer: peerKey, verified: verified.length, stored });
    });
    if (done) {
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, 'appinstalling', peerKey);
      log.info('handleAppInstallingSyncResponse - Sync complete');
    }
  } catch (error) {
    log.error(error);
  }
}

async function handleAppInstallingErrorsSyncResponse(message, peerSocket) {
  try {
    if (!peerManager.isSyncResponseWanted(peerSocket)) return;
    const peerKey = peerSocket.key;
    if (!message.data || message.data.type !== 'fluxappinstallingerrorssync') return;
    const { messages, done, refused } = message.data;
    // A refusal is an answer and not a completion - see handleAppRunningSyncResponse.
    if (refused) {
      log.info(`handleAppInstallingErrorsSyncResponse - ${peerKey} declined: its app state is not authoritative yet`);
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_REFUSED, 'apperrors', peerKey);
      return;
    }
    if (!Array.isArray(messages) || messages.length > 2500) return;
    log.info(`handleAppInstallingErrorsSyncResponse - Received ${messages.length} broadcasts from ${peerKey} (done: ${!!done})`);
    await serviceHelper.processInSlices(messages, SYNC_EVENTS_PER_SLICE, async (slice) => {
      const { verified } = await batchVerifyBroadcasts(slice, 'handleAppInstallingErrorsSyncResponse');
      if (verified.length === 0) return;
      const { stored } = await messageStore.storeBatchAppInstallingErrorMessages(verified);
      log.info(`handleAppInstallingErrorsSyncResponse - Stored ${stored} of ${verified.length} verified broadcasts`);
      fluxEventBus.publish('sync:chunkVerified', { syncType: 'apperrors', peer: peerKey, verified: verified.length, stored });
    });
    if (done) {
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, 'apperrors', peerKey);
      log.info('handleAppInstallingErrorsSyncResponse - Sync complete');
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Tell peers this node holds a message, and keep it for whichever of them asks.
 *
 * The store is written here rather than at dispatch because this is where a message
 * becomes something a peer can ask for: a request follows an announcement, and only a
 * verified message reaches a handler. Nothing this node never announced is ever asked
 * of it, so nothing else needs keeping.
 * @param {object} message The verified signed envelope, as it will be handed over.
 * @param {string} excludeKey The peer it came from, which has it already.
 */
function announceToPeers(message, excludeKey) {
  const messageHash = hash(message.data);
  announcementStore.set(messageHash, message);
  peerManager.broadcastHash(messageHash, excludeKey);
}

// A peer's index of (appName, version) for every confirmed manifest — step 1 of the
// two-step reconcile. Accepted only from a peer we asked this round (the reconcile
// service owns the round, replacing the ephemeral isSyncRequested gate).
async function handleContentManifestIndexResponse(message, peerKey) {
  try {
    if (!contentManifestSyncService.isPeerInActiveRound(peerKey)) return;
    if (!message.data || message.data.type !== 'fluxappcontentmanifestindex') return;
    const { index } = message.data;
    if (!Array.isArray(index) || index.length > 100000) return;
    contentManifestSyncService.depositIndex(peerKey, index);
  } catch (error) {
    log.error(error);
  }
}

// A peer's bucket digests for its confirmed attestation set — step 1 of the two-step
// ingress reconcile. Accepted only from a peer we asked this round (the reconcile
// service owns the round, replacing the ephemeral isSyncRequested gate).
async function handleIngressIndexResponse(message, peerKey) {
  try {
    if (!ingressAttestationSyncService.isPeerInActiveRound(peerKey)) return;
    if (!message.data || message.data.type !== 'fluxappingressindex') return;
    const { digests } = message.data;
    if (!Array.isArray(digests) || digests.length > 1024) return;
    ingressAttestationSyncService.depositDigests(peerKey, digests);
  } catch (error) {
    log.error(error);
  }
}

// The requested attestation bodies — step 2 of the two-step ingress reconcile. Same
// active-round gate; each record is verified by its own node signature in receive()
// before storing. No rebroadcast — this is a targeted backfill, not gossip.
async function handleIngressSyncResponse(message, peerKey) {
  try {
    if (!ingressAttestationSyncService.isPeerInActiveRound(peerKey)) return;
    if (!message.data || message.data.type !== 'fluxappingresssync') return;
    const { messages } = message.data;
    if (!Array.isArray(messages) || messages.length > 2500) return;
    let stored = 0;
    for (const record of messages) {
      // Same rule as live gossip: durability comes from whether this node holds the
      // message, not from the serving peer asserting it is confirmed.
      // eslint-disable-next-line no-await-in-loop
      const result = await ingressAttestationService.receive(record);
      if (!(result instanceof Error)) stored += 1;
    }
    log.info(`handleIngressSyncResponse - Stored ${stored} of ${messages.length} attestations from ${peerKey}`);
  } catch (error) {
    log.error(error);
  }
}

// The requested manifest bodies — step 2 of the two-step reconcile. Same active-round
// gate; bodies get the full owner-sig + spec gate in storeBatchContentManifests (no
// rebroadcast — this is a targeted backfill, not gossip).
async function handleContentManifestSyncResponse(message, peerKey) {
  try {
    if (!contentManifestSyncService.isPeerInActiveRound(peerKey)) return;
    if (!message.data || message.data.type !== 'fluxappcontentmanifestsync') return;
    const { messages, done } = message.data;
    if (!Array.isArray(messages) || messages.length > 2500) return;
    log.info(`handleContentManifestSyncResponse - Received ${messages.length} manifests from ${peerKey}`);
    // batchVerifyBroadcasts verifies the relaying node's envelope; storeBatchContentManifests
    // then applies the manifest owner-sig + spec gate before storing (or quarantining) each.
    const { verified } = await batchVerifyBroadcasts(messages, 'handleContentManifestSyncResponse');
    if (verified.length > 0) {
      const { stored } = await contentSlotService.storeBatchContentManifests(verified);
      log.info(`handleContentManifestSyncResponse - Stored ${stored} of ${verified.length} verified manifests`);
      fluxEventBus.publish('sync:chunkVerified', { syncType: 'appcontentmanifest', peer: peerKey, verified: verified.length, stored });
    }
    // The responder marks its last batch, exactly as the ephemeral sync responses do.
    // Released after the store above, so the round re-reads its gap knowing everything
    // this peer sent has already landed. Without it the round has no signal that a peer
    // has finished and can only wait out its settle bound.
    if (done) contentManifestSyncService.depositFetchDone(peerKey);
  } catch (error) {
    log.error(error);
  }
}

async function handleCheckMessageHashPresent(messageHash, fromIP, port) {
  try {
    // The filter, not the store: the question is whether this node already has the
    // message, and it has plenty it never announced - anything the database already
    // held when it arrived. Asking the store would re-request those.
    if (!announcementSeen.has(messageHash)) {
      peerManager.sendHashRequest(`${fromIP}:${port}`, messageHash);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To handle a request of a message, from the message hash from one of the ws connections.
 * @param {string} messageHash Message hash.
 * @param {string} fromIP Sender's IP address.
 * @param {string} port Sender's node Api port.
 * @param {boolean} outgoingConnection says if ip/port is from incoming or outgoing connections.
 */
async function handleRequestMessageHash(messageHash, fromIP, port) {
  try {
    // The store, not the filter: this hands the message over, so it needs the message.
    // A request follows an announcement, so what a peer can ask for is what this node
    // announced, which is exactly what the store holds.
    if (announcementStore.has(messageHash)) {
      const message = announcementStore.get(messageHash);
      if (message) {
        const messageString = serviceHelper.ensureString(message);
        const peer = peerManager.get(`${fromIP}:${port}`);
        if (peer) {
          peer.send(messageString);
        }
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To handle running app messages.
 * @param {object} message Message.
 * @param {string} fromIP Sender's IP address.
 * @param {string} port Sender's node Api port.
 */
async function handleAppRunningMessage(message, fromIP, port, announcer = null) {
  try {
    // Whether this told us anything new is the event log's answer, not the claim
    // release's: the log is what holds the node's running state, so it is what knows
    // if this announcement moved it. An announcement that advances nothing stops here
    // rather than being passed on.
    const { isNewer } = await messageStore.storeAppStateEvent(
      messageStore.APP_STATE_EVENT_TYPES.APPRUNNING,
      { signedBroadcast: message, announcer },
    );
    await messageStore.releaseInstallingClaims(message.data);
    if (isNewer) {
      fluxEventBus.publish('network:apprunning', { ip: message.data.ip, apps: message.data.apps || [{ name: message.data.name }] });
    }
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp, 240000);
    if (isNewer && timestampOK) {
      const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
      const daemonHeight = syncStatus.data.height || 0;
      if (daemonHeight >= config.messagesBroadcastRefactorStart) {
        peerManager.broadcastHash(hash(message.data), `${fromIP}:${port}`);
      } else {
        fluxCommunicationMessagesSender.relay(serviceHelper.ensureString(message), `${fromIP}:${port}`);
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To handle installing app messages.
 * @param {object} message Message.
 * @param {string} fromIP Sender's IP address.
 * @param {string} port Sender's node Api port.
 */
async function handleAppInstallingMessage(message, fromIP, port) {
  try {
    const rebroadcastToPeers = await messageStore.storeAppInstallingMessage(message.data);
    if (rebroadcastToPeers === true) {
      // Version 2 either withdraws the sender's claim or renews it, and both
      // arrive through this handler, so the event names which it was. Accepts
      // development's `withdrawn` and v9's `cleared` - the same fact, two
      // spellings, both on the wire in a mixed fleet.
      fluxEventBus.publish('network:appinstalling', {
        ip: message.data.ip,
        name: message.data.name,
        withdrawn: message.data.withdrawn === true || message.data.cleared === true,
      });
    }
    messageStore.storeSignedAppInstallingBroadcast(message);
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp);
    if (rebroadcastToPeers === true && timestampOK) {
      announceToPeers(message, `${fromIP}:${port}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To handle installing error app messages.
 * @param {object} message Message.
 * @param {string} fromIP Sender's IP address.
 * @param {string} port Sender's node Api port.
 */
async function handleAppInstallingErrorMessage(message, fromIP, port) {
  try {
    const rebroadcastToPeers = await messageStore.storeAppInstallingErrorMessage(message.data);
    if (rebroadcastToPeers === true) {
      fluxEventBus.publish('network:appinstallingerror', { ip: message.data.ip, name: message.data.name });
    }
    messageStore.storeSignedAppInstallingErrorBroadcast(message);
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp);
    if (rebroadcastToPeers === true && timestampOK) {
      announceToPeers(message, `${fromIP}:${port}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To handle IP changed messages.
 * @param {object} message Message.
 * @param {string} fromIP Sender's IP address.
 * @param {string} port Sender's node Api port.
 */
async function handleIPChangedMessage(message, fromIP, port) {
  try {
    const envelope = { version: message.version, timestamp: message.timestamp, pubKey: message.pubKey, signature: message.signature };
    await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.IPCHANGED, { message: message.data, envelope });
    const rebroadcastToPeers = await messageStore.storeIPChangedMessage(message.data);
    if (rebroadcastToPeers) {
      fluxEventBus.publish('network:ipchanged', { oldIP: message.data.oldIP, newIP: message.data.newIP });
    }
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp, 240000);
    if (rebroadcastToPeers && timestampOK) {
      announceToPeers(message, `${fromIP}:${port}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To handle app removed messages.
 * @param {object} message Message.
 * @param {string} fromIP Sender's IP address.
 * @param {string} port Sender's node Api port.
 */
async function handleAppRemovedMessage(message, fromIP, port) {
  try {
    // check if we have it any app running on that location and if yes, delete that information
    // rebroadcast message to the network if it's valid
    const envelope = { version: message.version, timestamp: message.timestamp, pubKey: message.pubKey, signature: message.signature };
    await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPREMOVED, { message: message.data, envelope });
    const rebroadcastToPeers = await messageStore.storeAppRemovedMessage(message.data);
    if (rebroadcastToPeers) {
      fluxEventBus.publish('network:appremoved', { ip: message.data.ip, name: message.data.appName });
    }
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp, 240000);
    if (rebroadcastToPeers && timestampOK) {
      announceToPeers(message, `${fromIP}:${port}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To handle node sigterm messages (graceful shutdown notifications).
 * @param {object} message Message.
 * @param {string} fromIP Sender's IP address.
 * @param {string} port Sender's node Api port.
 */
async function handleNodeSigtermMessage(message, fromIP, port) {
  try {
    const { ip, broadcastedAt } = message.data;
    log.info(`Received SIGTERM notification from node ${ip} (broadcasted at ${new Date(broadcastedAt).toISOString()})`);

    // Verify timestamp - only accept messages from last 4 minutes
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp, 240000);

    if (!timestampOK) {
      return;
    }

    const appsOnNode = await appsRepository.appLocationFromEvents({ ip });

    if (!appsOnNode || appsOnNode.length === 0) {
      log.info(`No apps found for node ${ip} in event log view, not rebroadcasting sigterm`);
      return;
    }

    log.info(`Found ${appsOnNode.length} apps for node ${ip}, updating expiration and rebroadcasting sigterm`);

    const envelope = { version: message.version, timestamp: message.timestamp, pubKey: message.pubKey, signature: message.signature };
    await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.SIGTERM, { message: message.data, envelope });
    fluxEventBus.publish('network:sigterm', { ip });

    // Rebroadcast to other peers
    announceToPeers(message, `${fromIP}:${port}`);
  } catch (error) {
    log.error(error);
  }
}

/**
 * The owner generation record: the app owner's signed word that a grant
 * key's world is retired and the next one draws from the named height. The
 * store verifies the inner OWNER signature against its own copy of the
 * spec; the outer envelope only had to be a valid node broadcast.
 * @param {object} message Signed broadcast whose data is the generation record.
 * @param {string} fromIP Sender's node ip.
 * @param {string} port Sender's node Api port.
 */
async function handleGrantGenerationMessage(message, fromIP, port) {
  try {
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp, 240000);
    if (!timestampOK) {
      return;
    }

    const envelope = {
      version: message.version, timestamp: message.timestamp, pubKey: message.pubKey, signature: message.signature,
    };
    await messageStore.storeAppStateEvent(
      messageStore.APP_STATE_EVENT_TYPES.GRANTGENERATION,
      { message: message.data, envelope },
    );

    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    const daemonHeight = syncStatus.data.height || 0;
    if (daemonHeight >= config.messagesBroadcastRefactorStart) {
      peerManager.broadcastHash(hash(message.data), `${fromIP}:${port}`);
    } else {
      fluxCommunicationMessagesSender.relay(serviceHelper.ensureString(message), `${fromIP}:${port}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * The published grant record (doc §9): who holds an app role, at what epoch.
 * The store is epoch-newer-wins, so relaying an already-superseded record is
 * harmless and dropping a fresher one only delays the peers one flood.
 * @param {object} message Signed broadcast whose data is the masterlease record.
 * @param {string} fromIP Sender's node ip.
 * @param {string} port Sender's node Api port.
 * @param {object|null} announcer Resolved list entry for the announcing node.
 */
async function handleMasterleaseMessage(message, fromIP, port, announcer) {
  try {
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp, 240000);
    if (!timestampOK) {
      return;
    }

    const envelope = {
      version: message.version, timestamp: message.timestamp, pubKey: message.pubKey, signature: message.signature,
    };
    await messageStore.storeAppStateEvent(
      messageStore.APP_STATE_EVENT_TYPES.MASTERLEASE,
      { message: message.data, envelope, announcer },
    );

    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    const daemonHeight = syncStatus.data.height || 0;
    if (daemonHeight >= config.messagesBroadcastRefactorStart) {
      peerManager.broadcastHash(hash(message.data), `${fromIP}:${port}`);
    } else {
      fluxCommunicationMessagesSender.relay(serviceHelper.ensureString(message), `${fromIP}:${port}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * A node-down certificate arriving off the wire: store on independent
 * verification, relay only what was accepted — a forgery dies at this hop.
 * @param {object} message Signed broadcast whose data carries the certificate.
 * @param {string} fromIP Sender's node ip.
 * @param {string} port Sender's node api port.
 */
async function handleNodeDownMessage(message, fromIP, port) {
  try {
    const currentTimeStamp = Date.now();
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(message, currentTimeStamp, 240000);
    if (!timestampOK) {
      return;
    }

    const envelope = {
      version: message.version, timestamp: message.timestamp, pubKey: message.pubKey, signature: message.signature,
    };
    const result = await nodeDownService.onCertificateBroadcast(message.data, envelope);
    if (!result.rebroadcast) return;

    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    const daemonHeight = syncStatus.data.height || 0;
    if (daemonHeight >= config.messagesBroadcastRefactorStart) {
      peerManager.broadcastHash(hash(message.data), `${fromIP}:${port}`);
    } else {
      fluxCommunicationMessagesSender.relay(serviceHelper.ensureString(message), `${fromIP}:${port}`);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * Unified message dispatcher for both inbound and outbound peer connections.
 * Handles message validation, cache checking, signature verification, and message type dispatch.
 * Registered as peerManager.messageDispatcher to break circular dependencies.
 * @param {object} msgObj Parsed message object.
 * @param {import('./utils/FluxPeerSocket').FluxPeerSocket} peerSocket FluxPeerSocket instance.
 */
// Only an announcement is a fact whose identity is its payload, so only an announcement
// is deduplicated. An ask and an answer are about the two nodes exchanging them, and
// `hash(data)` throws the sender away - see utils/messageIntent for the table.
//
// THE FILTER WAS NEVER WHAT BOUNDED THESE. It keys on the payload, which a peer sending a
// question controls: varying the hash on a fluxapprequest defeats it in one line. What it
// suppresses is accidental duplicates, which is the job it is for. The per-peer bound is
// FluxPeerSocket's inbound token bucket - lruRateLimit(ip:port, 120), applied to every
// frame before dispatch.
//
// That bucket counts messages, not bytes, and a ~60-byte fluxpolicyrequest draws a whole
// bundle back. It is still not a reflection vector: these arrive on an established
// websocket, so the sender cannot be spoofed and receives every byte it asks for. A peer
// can make this node serve it quickly; it cannot make this node serve anyone else. If a
// byte budget is ever wanted it belongs in lruRateLimit, covering every type, not in a
// second counter here.

async function dispatchFluxMessage(msgObj, peerSocket) {
  const codes = peerSocket.closeCodes;
  const {
    pubKey, timestamp, signature, version, data,
    messageHashPresent, requestMessageHash,
  } = msgObj;

  if (messageHashPresent) {
    if (typeof messageHashPresent !== 'string' || messageHashPresent.length !== 40) {
      try {
        log.info(`Invalid message of type messageHashPresent received from ${peerSocket.direction} peer ${peerSocket.key}. Closing connection`);
        peerSocket.close(codes.invalidMsg, 'Message not valid, disconnect');
      } catch (e) {
        log.error(e);
      }
      return;
    }
    const counter = peerSocket.msgMap.get('newHash');
    peerSocket.msgMap.set('newHash', counter + 1);
    setImmediate(() => handleCheckMessageHashPresent(messageHashPresent, peerSocket.ip, peerSocket.port));
    return;
  }
  if (requestMessageHash) {
    if (typeof requestMessageHash !== 'string' || requestMessageHash.length !== 40) {
      try {
        log.info(`Invalid message of type requestMessageHash from ${peerSocket.direction} peer ${peerSocket.key}. Closing connection`);
        peerSocket.close(codes.invalidMsg, 'Message not valid, disconnect');
      } catch (e) {
        log.error(e);
      }
      return;
    }
    const counter = peerSocket.msgMap.get('requestHash');
    peerSocket.msgMap.set('requestHash', counter + 1);
    setImmediate(() => handleRequestMessageHash(requestMessageHash, peerSocket.ip, peerSocket.port));
    return;
  }
  if (!pubKey || !timestamp || !signature || !version || !data) {
    try {
      log.info(`Invalid received from ${peerSocket.direction} peer ${peerSocket.key}. Closing connection`);
      peerSocket.close(codes.invalidMsg, 'Message not valid, disconnect');
    } catch (e) {
      log.error(e);
    }
    return;
  }

  await serviceHelper.delay(Math.floor(Math.random() * 75 + 1));
  // Also what a NAK names further down, so it is computed for every message.
  const messageHash = hash(msgObj.data);
  // THE FILTER IS FOR MESSAGES THAT REACH THIS NODE BY MORE THAN ONE ROUTE, WHICH IS WHAT
  // MAKES CONTENT THEIR IDENTITY. A relayed announcement arriving three ways is one fact and
  // acting once is the point. Everything else is point to point, so it reaches this node once
  // per peer that sends it, and two peers sending the same bytes are two peers rather than
  // one fact twice. Filtering those on content discards every sender after the first, which
  // for a message whose whole meaning is "ask me" discards the only thing it carries.
  //
  // The TYPE decides, never the message: one that chose for itself could opt out of the
  // filter by saying so, and a relayed type doing that is a flood every honest node joins in.
  //
  // CLAIMED BEFORE VERIFICATION, HELD ONLY BY A MESSAGE THAT EARNED IT. The filter runs first
  // because that is what bounds the cost of verifying a flood of copies. But a message that
  // does not go on to verify was never established as anything, and a hash it leaves behind
  // suppresses the genuine message that hashes the same. So the slot is released on every
  // path that does not reach a handler, and what remains is the window of one signature check
  // rather than the cache's whole ttl.
  const claimedSlot = declaredIntent(msgObj.data.type) === INTENT.ANNOUNCE;
  if (claimedSlot) {
    if (announcementSeen.has(messageHash)) return;
    announcementSeen.set(messageHash, true);
  }
  const releaseSlot = () => { if (claimedSlot) announcementSeen.delete(messageHash); };

  // check blocked list
  if (wsPeerCache.has(pubKey)) {
    try {
      log.info(`Closing ${peerSocket.direction} connection, peer is on blockedList`);
      peerSocket.close(codes.blocked, 'blocked list');
    } catch (e) {
      log.error(e);
    }
    // Nothing here judged the message; the peer is what was refused.
    releaseSlot();
    return;
  }
  const currentTimeStamp = Date.now();
  const { VerifyResult } = fluxCommunicationUtils;
  const { result: verifyResult, announcer } = await fluxCommunicationUtils.verifyFluxBroadcast(msgObj, undefined, currentTimeStamp);

  if (verifyResult === VerifyResult.OK) {
    const timestampOK = fluxCommunicationUtils.verifyTimestampInFluxBroadcast(msgObj, currentTimeStamp);
    if (timestampOK === true) {
      try {
        if (msgObj.data.type === 'zelappregister' || msgObj.data.type === 'zelappupdate' || msgObj.data.type === 'fluxappregister' || msgObj.data.type === 'fluxappupdate') {
          setImmediate(() => handleAppMessages(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxapprequest') {
          setImmediate(() => fluxCommunicationMessagesSender.respondWithAppMessage(msgObj, peerSocket));
        } else if (msgObj.data.type === 'fluxapprunning') {
          setImmediate(() => handleAppRunningMessage(msgObj, peerSocket.ip, peerSocket.port, announcer));
        } else if (msgObj.data.type === 'fluxipchanged') {
          setImmediate(() => handleIPChangedMessage(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxappremoved') {
          setImmediate(() => handleAppRemovedMessage(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxappinstalling') {
          setImmediate(() => handleAppInstallingMessage(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxappinstallingerror') {
          setImmediate(() => handleAppInstallingErrorMessage(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxlimitcounterrecord') {
          setImmediate(() => limitCounter.acceptRecord(msgObj.data));
        } else if (msgObj.data.type === 'fluxnodesigterm') {
          setImmediate(() => handleNodeSigtermMessage(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxmasterlease') {
          setImmediate(() => handleMasterleaseMessage(msgObj, peerSocket.ip, peerSocket.port, announcer));
        } else if (msgObj.data.type === 'fluxnodedown') {
          setImmediate(() => handleNodeDownMessage(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxnodedownverdict') {
          setImmediate(() => nodeDownService.onVerdictMessage(msgObj));
        } else if (msgObj.data.type === 'fluxgrantgeneration') {
          setImmediate(() => handleGrantGenerationMessage(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxappcontentmanifest') {
          setImmediate(() => contentSlotService.handleIncomingManifest(msgObj));
        } else if (msgObj.data.type === 'fluxappcontentmanifestindexrequest') {
          setImmediate(() => fluxCommunicationMessagesSender.respondWithManifestIndex(peerSocket));
        } else if (msgObj.data.type === 'fluxappcontentmanifestrequest') {
          setImmediate(() => fluxCommunicationMessagesSender.respondWithContentManifests(msgObj, peerSocket));
        } else if (msgObj.data.type === 'fluxappingress') {
          setImmediate(() => handleIngressAttestation(msgObj, peerSocket.ip, peerSocket.port));
        } else if (msgObj.data.type === 'fluxappingressindexrequest') {
          setImmediate(() => fluxCommunicationMessagesSender.respondWithIngressIndex(peerSocket));
        } else if (msgObj.data.type === 'fluxappingressrequest') {
          setImmediate(() => fluxCommunicationMessagesSender.respondWithIngressAttestations(msgObj, peerSocket));
        } else {
          log.warn(`Unrecognised message type of ${msgObj.data.type}`);
        }
      } catch (e) {
        log.error(e);
      }
    } else {
      // Signed by a real node and outside the window, which is what a replay looks like.
      releaseSlot();
      peerSocket.sendNak(messageHash, NAK_REASON.STALE);
    }
  } else if (verifyResult === VerifyResult.NODE_NOT_FOUND) {
    releaseSlot();
    // Originator's node is not in the deterministic list — stale list or node went offline.
    // The relay peer is not at fault. Drop the message, don't punish the relay.
    log.warn(`Dropping message from ${peerSocket.direction} peer ${peerSocket.key}: originator pubkey ${pubKey} not found in node list`);
  } else {
    releaseSlot();
    // BAD_SIGNATURE or MALFORMED — the message is corrupted or forged.
    // Track against this relay peer with a rolling window.
    // If they send 5+ bad messages in 10 minutes, disconnect.
    const BAD_MSG_WINDOW = 10 * 60 * 1000;
    const BAD_MSG_THRESHOLD = 5;
    const now = Date.now();
    const cutoff = now - BAD_MSG_WINDOW;
    peerSocket.badMessageTimestamps.push(now);
    while (peerSocket.badMessageTimestamps.length > 0 && peerSocket.badMessageTimestamps[0] < cutoff) {
      peerSocket.badMessageTimestamps.shift();
    }
    // Safety cap — prevent unbounded growth from adversarial peers
    if (peerSocket.badMessageTimestamps.length > 20) {
      peerSocket.badMessageTimestamps = peerSocket.badMessageTimestamps.slice(-10);
    }
    const count = peerSocket.badMessageTimestamps.length;
    log.warn(`Bad message (${verifyResult}) from ${peerSocket.direction} peer ${peerSocket.key}, count: ${count}/10min`);
    if (count >= BAD_MSG_THRESHOLD) {
      log.warn(`Disconnecting ${peerSocket.direction} peer ${peerSocket.key} after ${count} bad messages in 10 minutes`);
      peerSocket.close(codes.badOrigin, 'too many bad messages');
    }
  }
}

const syncChunkQueues = new Map();

// Verified by dispatchSyncResponse before the chunk was queued, because whether
// a peer signed what it sent is a statement about the peer and the deadline
// waiting on it needs the answer at arrival, not at the back of a queue.
async function processSyncChunk(msgObj, peerSocket) {
  const { type } = msgObj.data;
  switch (type) {
    case 'fluxapptempsync':
      await handleTempSyncResponse(msgObj, peerSocket);
      break;
    case 'fluxapprunningsync':
      await handleAppRunningSyncResponse(msgObj, peerSocket);
      break;
    case 'fluxappinstallingsync':
      await handleAppInstallingSyncResponse(msgObj, peerSocket);
      break;
    case 'fluxappinstallingerrorssync':
      await handleAppInstallingErrorsSyncResponse(msgObj, peerSocket);
      break;
    case 'fluxappcontentmanifestindex':
      await handleContentManifestIndexResponse(msgObj, peerSocket.key);
      break;
    case 'fluxappcontentmanifestsync':
      await handleContentManifestSyncResponse(msgObj, peerSocket.key);
      break;
    case 'fluxappingressindex':
      await handleIngressIndexResponse(msgObj, peerSocket.key);
      break;
    case 'fluxappingresssync':
      await handleIngressSyncResponse(msgObj, peerSocket.key);
      break;
    default:
      log.warn(`Unknown sync response type: ${type}`);
  }
}

/**
 * The envelope check, as a verdict that never rejects.
 *
 * A chunk's verdict is read twice - once by the arrival that queued it and once
 * by whichever arrival is draining - so a rejection would surface in two places
 * and one of them is holding a queue for a peer it does not own. A failure to
 * decide is not a pass: it answers null, which is not OK, and the stream ends
 * on it like any other envelope this node cannot stand behind.
 * @param {object} msgObj
 * @returns {Promise<string|null>}
 */
async function verifySyncEnvelope(msgObj) {
  try {
    return await fluxCommunicationUtils.verifyFluxBroadcast(msgObj);
  } catch (error) {
    log.error(error);
    return null;
  }
}

async function dispatchSyncResponse(msgObj, peerSocket) {
  try {
    const peerKey = peerSocket.key;
    // The two manifest-reconcile response types ride their own request/response and are
    // gated by the reconcile service's active round (checked in their handlers), not the
    // ephemeral isSyncRequested flag the boot-sync types use.
    const type = msgObj.data?.type;
    const isReconcile = type === 'fluxappcontentmanifestindex' || type === 'fluxappcontentmanifestsync'
      || type === 'fluxappingressindex' || type === 'fluxappingresssync';
    if (!isReconcile && !peerManager.isSyncResponseWanted(peerSocket)) return;

    // THE QUEUE IS THE ORDER, so nothing that can reorder may sit in front of
    // it. Chunks carry meaning by position: the sender sorts by timestamp and
    // an eviction has none, so evictions land in the FIRST chunk and clear a
    // node's locations outright - a later chunk processed ahead of them has its
    // rows deleted by an eviction that came before them. `done` is positional
    // too, and a stream marked finished early loses whatever was still coming.
    //
    // So the chunk takes its place here, in the same synchronous step as its
    // arrival, and the envelope check is STARTED rather than waited for. Four
    // chunks arriving together are queued in arrival order and their checks
    // race each other with no say in it.
    if (!syncChunkQueues.has(peerKey)) {
      syncChunkQueues.set(peerKey, { queue: [], processing: false });
    }
    const state = syncChunkQueues.get(peerKey);
    const chunk = { msgObj, verdict: verifySyncEnvelope(msgObj) };
    state.queue.push(chunk);
    // Decided here for the same reason: read after an await, two arrivals both
    // find a queue nobody is draining and both start draining it.
    const drainer = !state.processing;
    if (drainer) state.processing = true;

    // THE PEER SPOKE, AND IT REALLY WAS THE PEER. Two different questions used
    // to be split at the wrong seam: arrival on one side, everything else on
    // the other. The seam that matters is whose statement it is.
    //
    // Whether a peer signed what it sent is about the PEER, and it is a
    // signature check. Storing two thousand messages, or re-verifying every
    // pending registration, is about US. So the envelope is answered here, as
    // soon as the check comes back and whatever the queue is doing, and the
    // payload work stays in the drain below.
    //
    // Announced at arrival rather than after that work, because a peer that
    // answered all four requests correctly and instantly went unheard for as
    // long as WE took on the first of them - and was recorded as having said
    // nothing and set aside, with the three answers queued behind it discarded
    // on the way out.
    //
    // And unverifiable bytes are not the peer speaking. Credited as progress
    // they renewed the deadline that exists to take the slot back, so a peer
    // streaming rubbish inside every stall window held one of the answers this
    // node needs for the whole attempt while never answering at all.
    const verdict = await chunk.verdict;
    if (verdict === fluxCommunicationUtils.VerifyResult.OK && !msgObj?.data?.refused) {
      appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_PROGRESS, peerKey);
    }

    if (!drainer) return;

    while (state.queue.length > 0) {
      const next = state.queue.shift();
      const nextVerdict = await next.verdict;
      // A HOLE IS NOT A SURVEY. Stepping over the chunk and carrying on left
      // this node counting a peer as having surveyed the network out of an
      // answer it knows part of is missing - and it cannot know which part,
      // because the chunk it could not attribute is the one it cannot read.
      // The stream ends the way every other failure in this design ends: the
      // request is over, and another peer is asked.
      if (nextVerdict !== fluxCommunicationUtils.VerifyResult.OK) {
        log.warn(`Sync response from ${peerKey} failed envelope verification: ${nextVerdict}, ending its request`);
        syncChunkQueues.delete(peerKey);
        // Only about the connection this drain serves. A backlog left by a
        // connection that has since been replaced still drains, and ending a
        // request on its behalf would close the one belonging to the peer that
        // dialled back in - which has answered nothing wrong.
        if (peerManager.isSyncResponseWanted(peerSocket)) {
          appSyncEvents.emit(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, peerKey);
        }
        return;
      }
      await processSyncChunk(next.msgObj, peerSocket);
    }

    state.processing = false;
    syncChunkQueues.delete(peerKey);
  } catch (error) {
    log.error(error);
    syncChunkQueues.delete(peerSocket.key);
  }
}

// Register message dispatchers on the peerManager singleton
// Every wire type this node answers.
// Everything a node tells the network about itself or about an app it saw. One fact
// reaching us by many routes is one fact, and a relayed type must be deduplicated.
register(['zelappregister', 'zelappupdate', 'fluxappregister', 'fluxappupdate'],
  (msg, peer) => handleAppMessages(msg, peer.ip, peer.port), ROUTE.GOSSIP, INTENT.ANNOUNCE);
register('fluxapprunning', (msg, peer) => handleAppRunningMessage(msg, peer.ip, peer.port), ROUTE.GOSSIP, INTENT.ANNOUNCE);
register('fluxipchanged', (msg, peer) => handleIPChangedMessage(msg, peer.ip, peer.port), ROUTE.GOSSIP, INTENT.ANNOUNCE);
register('fluxappremoved', (msg, peer) => handleAppRemovedMessage(msg, peer.ip, peer.port), ROUTE.GOSSIP, INTENT.ANNOUNCE);
register('fluxappinstalling', (msg, peer) => handleAppInstallingMessage(msg, peer.ip, peer.port), ROUTE.GOSSIP, INTENT.ANNOUNCE);
register('fluxappinstallingerror', (msg, peer) => handleAppInstallingErrorMessage(msg, peer.ip, peer.port), ROUTE.GOSSIP, INTENT.ANNOUNCE);
register('fluxnodesigterm', (msg, peer) => handleNodeSigtermMessage(msg, peer.ip, peer.port), ROUTE.GOSSIP, INTENT.ANNOUNCE);
// An ask delivered by broadcast. Delivery is not the classifier: it goes to every peer,
// and it is still a question from one node that each of them answers separately.
register('fluxapprequest', (msg, peer) => fluxCommunicationMessagesSender.respondWithAppMessage(msg, peer), ROUTE.GOSSIP, INTENT.ASK);
register('fluxpolicyrequest', (msg, peer) => fluxCommunicationMessagesSender.respondWithPolicy(msg, peer), ROUTE.GOSSIP, INTENT.ASK);
// The one type sent both ways: news when a node announces what it adopted, an answer when
// it settles a peer's ask. Nothing relays it, which is what makes the marker safe to trust.
// A claim rather than an answer: a number cannot be checked, so it is a prompt to ask.
register('fluxpolicyseq', (msg, peer) => policyStore.notePeerSeq(
  msg.data.seq, peer.key, msg.data.correlationId,
), ROUTE.GOSSIP, INTENT.VARIES);
// Checked against the pinned keys before adoption, so an unsolicited bundle is no more
// dangerous than one this node asked for - and peers announce what they adopt.
register('fluxpolicy', (msg, peer) => policyStore.offerBundle(
  msg.data.bundle, peer.key, msg.data.correlationId,
), ROUTE.GOSSIP, INTENT.ANSWER);

// Answers to a sync this node asked for, which is why they are ordered.
register('fluxapptempsync', handleTempSyncResponse, ROUTE.ORDERED, INTENT.ANSWER);
register('fluxapprunningsync', handleAppRunningSyncResponse, ROUTE.ORDERED, INTENT.ANSWER);
register('fluxappinstallingsync', handleAppInstallingSyncResponse, ROUTE.ORDERED, INTENT.ANSWER);
register('fluxappinstallingerrorssync', handleAppInstallingErrorsSyncResponse, ROUTE.ORDERED, INTENT.ANSWER);

peerManager.messageDispatcher = dispatchFluxMessage;
peerManager.syncResponseDispatcher = dispatchSyncResponse;
async function verifySyncRequest(peer, decoded) {
  const { requestTimestamp, pubkey, signature, sinceTimestamp } = decoded;
  const now = Date.now();
  if (Math.abs(now - requestTimestamp) > 120_000) {
    log.warn(`Sync request from ${peer.key} rejected: timestamp too far (${now - requestTimestamp}ms)`);
    return false;
  }
  const nodes = await networkStateService.getFluxnodesByPubkey(pubkey);
  if (!nodes) {
    log.warn(`Sync request from ${peer.key} rejected: pubkey not in node list`);
    return false;
  }
  const msg = buildSyncSignatureMessage(decoded.type, sinceTimestamp, requestTimestamp);
  const verified = verificationHelper.verifyMessage(msg, pubkey, signature);
  if (!verified) {
    log.warn(`Sync request from ${peer.key} rejected: bad signature`);
    return false;
  }
  return true;
}

peerManager.hashHandlers = {
  handleHashPresent: (peer, hexHash) => {
    const counter = peer.msgMap.get('newHash');
    peer.msgMap.set('newHash', counter + 1);
    setImmediate(() => handleCheckMessageHashPresent(hexHash, peer.ip, peer.port));
  },
  handleHashRequest: (peer, hexHash) => {
    const counter = peer.msgMap.get('requestHash');
    peer.msgMap.set('requestHash', counter + 1);
    setImmediate(() => handleRequestMessageHash(hexHash, peer.ip, peer.port));
  },
  handleTempMessagesRequest: (peer, decoded) => {
    const now = Date.now();
    const last = peer.lastTempSyncResponse || 0;
    if (now - last < (config.fluxapps.syncResponseThrottleMs ?? 300000)) return;
    peer.lastTempSyncResponse = now;
    setImmediate(async () => {
      if (!await verifySyncRequest(peer, decoded)) return;
      fluxCommunicationMessagesSender.respondWithTempMessages(peer, decoded.sinceTimestamp);
    });
  },
  handleAppRunningRequest: (peer, decoded) => {
    const now = Date.now();
    const last = peer.lastAppRunningSyncResponse || 0;
    if (now - last < (config.fluxapps.syncResponseThrottleMs ?? 300000)) return;
    peer.lastAppRunningSyncResponse = now;
    setImmediate(async () => {
      if (!await verifySyncRequest(peer, decoded)) return;
      fluxCommunicationMessagesSender.respondWithAppRunningMessages(peer, decoded.sinceTimestamp);
    });
  },
  handleAppInstallingRequest: (peer, decoded) => {
    const now = Date.now();
    const last = peer.lastAppInstallingSyncResponse || 0;
    if (now - last < (config.fluxapps.syncResponseThrottleMs ?? 300000)) return;
    peer.lastAppInstallingSyncResponse = now;
    setImmediate(async () => {
      if (!await verifySyncRequest(peer, decoded)) return;
      fluxCommunicationMessagesSender.respondWithAppInstallingMessages(peer, decoded.sinceTimestamp);
    });
  },
  handleAppInstallingErrorsRequest: (peer, decoded) => {
    const now = Date.now();
    const last = peer.lastAppInstallingErrorsSyncResponse || 0;
    if (now - last < (config.fluxapps.syncResponseThrottleMs ?? 300000)) return;
    peer.lastAppInstallingErrorsSyncResponse = now;
    setImmediate(async () => {
      if (!await verifySyncRequest(peer, decoded)) return;
      fluxCommunicationMessagesSender.respondWithAppInstallingErrorsMessages(peer, decoded.sinceTimestamp);
    });
  },
};


/**
 * To get IP addresses for all outgoing connected peers.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
/**
 * @deprecated Use getPeers with direction=outbound instead.
 */
function connectedPeers(req, res) {
  const connections = [];
  for (const peer of peerManager.outboundValues()) {
    connections.push(peer.ip);
  }
  const message = messageHelper.createDataMessage(connections);
  return res ? res.json(message) : message;
}

/**
 * @deprecated Use getPeers with direction=outbound instead.
 */
function connectedPeersInfo(req, res) {
  const connections = [...peerManager.outboundValues()].map((p) => p.toPeerInfo());
  const message = messageHelper.createDataMessage(connections);
  return res ? res.json(message) : message;
}

/**
 * How many peers answered our most recent ping, out of how many we hold.
 *
 * The freshest liveness signal this node has about the network, and the one that
 * tells it whether IT is the thing that has gone quiet. Peer COUNT alone cannot: a
 * socket survives wsMaxMissedPongs rounds before it is dropped, so a node that has
 * just been cut off keeps a full peer list for ~45s and reads as perfectly healthy
 * throughout - after the point a decision gated on two 30s monitor passes could
 * already have been made. missedPongs moves on the first missed round instead
 * (~15s), which lands before that.
 *
 * Reported as a ratio rather than a bare count because the useful question is
 * proportional: one silent peer among many is that peer's problem, while all of
 * them going quiet at once is this node's. An absolute floor would also be a fleet
 * size in disguise - a node configured with two peers can never reach a threshold
 * written for a node with twelve.
 *
 * @returns {{responding: number, total: number}} Peers with no missed pong, and all peers
 */
function peerResponsiveness() {
  let responding = 0;
  let total = 0;
  for (const peer of peerManager.allValues()) {
    total += 1;
    if (peer.missedPongs === 0) responding += 1;
  }
  return { responding, total };
}

/**
 * To keep connections alive by pinging all outgoing and incoming peers.
 */
function keepConnectionsAlive() {
  networkHealthMonitor.setPeerManager(peerManager);
  peerManager.networkHealthMonitor = networkHealthMonitor;
  setInterval(() => {
    peerManager.pingAll();
  }, config.peers.wsPingIntervalMs ?? 15000);
}

/**
 * To remove an outgoing peer by specifying the IP address. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function removePeer(req, res) {
  try {
    let { ip } = req.params;
    ip = ip || req.query.ip;

    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));

    if (authorized !== true) {
      const message = messageHelper.errUnauthorizedMessage();
      res.json(message);
      return;
    }

    const parsed = parseSocketAddress(ip);

    if (!parsed) {
      const unparsableError = messageHelper.createErrorMessage(
        'Unparsable `ip` parameter',
      );
      res.json(unparsableError);
      return;
    }

    const response = await fluxNetworkHelper.closeConnection(parsed.ip, parsed.port);

    res.json(response);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To remove an incoming peer by specifying the IP address. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} expressWS Express web socket.
 * @returns {Promise<void>}
 */
async function removeIncomingPeer(req, res) {
  try {
    let { ip } = req.params;
    ip = ip || req.query.ip;

    const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));

    if (authorized !== true) {
      const message = messageHelper.errUnauthorizedMessage();
      res.json(message);
      return;
    }

    const parsed = parseSocketAddress(ip);

    if (!parsed) {
      const unparsableError = messageHelper.createErrorMessage(
        'Unparsable `ip` parameter',
      );
      res.json(unparsableError);
      return;
    }

    const response = await fluxNetworkHelper.closeIncomingConnection(parsed.ip, parsed.port);
    res.json(response);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To initiate and handle a connection. Opens a web socket and handles various events during connection.
 * @param {string} connection IP address (and port if applicable).
 */
let myPort = null;
let discoveryRunning = false;

/** @type {WeakMap<WebSocket, {ip: string, port: string, source: string}>} */
const wsMetadata = new WeakMap();

function settleOutbound(meta, connected) {
  if (meta.settled) return;
  meta.settled = true;
  if (meta.onSettle) meta.onSettle(connected);
}

function onOutboundError(error) {
  const meta = wsMetadata.get(this);
  if (!meta) return;
  const key = `${meta.ip}:${meta.port}`;
  peerManager.clearPending(key);
  peerManager.recordFailedConnection(meta.ip, meta.port);
  settleOutbound(meta, DIAL_RESULT.FAILED);
  log.error(`Outbound connection to ${key} failed: ${error.message}`);
}

function onOutboundClose() {
  const meta = wsMetadata.get(this);
  if (!meta || meta.settled) return;
  peerManager.clearPending(`${meta.ip}:${meta.port}`);
  settleOutbound(meta, DIAL_RESULT.FAILED);
}

function onOutboundOpen() {
  const meta = wsMetadata.get(this);
  if (!meta) return;
  const key = `${meta.ip}:${meta.port}`;
  const existing = peerManager.get(key);
  if (existing && existing.isAlive) {
    // Both ends of a reciprocal duty can dial the same pair at once. The
    // pair keeps the FIRST connection that established, whichever end
    // dialed it — the same rule at both ends and in both directions, so a
    // crossing race converges on one survivor. Replacing here instead
    // makes each side close the other's connection and the pair re-dials
    // forever. A dead or stalling existing still gets replaced by the
    // reconnect flows; this newcomer simply lost the race, and the duty it
    // was dialed for is satisfied by the survivor.
    peerManager.clearPending(key);
    try { this.close(CLOSE_CODES.DUPLICATE_PEER, 'Peer already connected'); } catch (_e) { /* noop */ }
    settleOutbound(meta, DIAL_RESULT.HELD);
    return;
  }
  peerManager.add(this, meta.ip, meta.port, {
    source: meta.source,
    remoteCapabilities: meta.remoteCapabilities,
    remoteClockOffsetMs: meta.remoteClockOffsetMs,
    remoteVersion: meta.remoteVersion,
    remoteFluxUptime: meta.remoteFluxUptime,
  });
  settleOutbound(meta, DIAL_RESULT.HELD);
}

function onOutboundUpgrade(response) {
  const meta = wsMetadata.get(this);
  if (!meta) return;
  if (response.headers['x-flux-capabilities']) {
    meta.remoteCapabilities = response.headers['x-flux-capabilities'].split(',').map((s) => s.trim()).filter(Boolean);
  }
  const clockHeader = response.headers['x-flux-clock-offset'];
  if (clockHeader !== undefined) {
    meta.remoteClockOffsetMs = Number(clockHeader);
  }
  if (response.headers['x-flux-version']) {
    meta.remoteVersion = response.headers['x-flux-version'];
  }
  if (response.headers['x-flux-uptime']) {
    meta.remoteFluxUptime = Number(response.headers['x-flux-uptime']);
  }
}

async function initiateAndHandleConnection(connection, source = PEER_SOURCE.RANDOM, dialOptions = {}) {
  const ip = extractIp(connection);
  const port = extractPort(connection);
  // onSettle reports how the dial resolved: true connected, false failed,
  // null indeterminate (no dial was made — retry later, no evidence gained).
  const { onSettle } = dialOptions;
  try {
    const key = `${ip}:${port}`;
    if (peerManager.has(key)) {
      if (onSettle) onSettle(DIAL_RESULT.HELD);
      return;
    }
    if (peerManager.isPending(key)) {
      if (onSettle) onSettle(DIAL_RESULT.NO_DIAL);
      return;
    }
    peerManager.markPending(key);

    // This node's own address, asked of the peer manager rather than of
    // benchmark. That is where the fact lives - fluxNetworkHelper pushes every
    // refresh into it from the one place the node learns what it is - and the
    // peer manager already answers this exact question for the sync draw.
    // Asking benchmark is an uncached RPC (executeCall), and this runs on every
    // dial: discovery's deterministic loop, the reconnect queue, the random
    // draw, the manual add and /flux/addpeer. It also made all five hard
    // dependent on benchd answering, which only discovery already was.
    //
    // Fresh enough by construction: fluxDiscovery refreshes it once per cycle
    // before it dials anything, and so do the availability checker and the
    // address-change handler. That is a bound the form this replaces did not
    // have - it read the port once per process and never again, so after an
    // address change a node announced a stale one for as long as it ran.
    let localSocketAddr = peerManager.getOwnSocketAddress?.() || null;

    if (!localSocketAddr) {
      // Never been told, which a dial arriving before the first refresh
      // genuinely is. Ask once - the answer fills the peer manager's copy on its
      // way through, so this costs one call rather than one per dial.
      localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    }

    if (!localSocketAddr) {
      peerManager.clearPending(key);
      if (onSettle) onSettle(DIAL_RESULT.NO_DIAL);
      return;
    }
    myPort = extractPort(localSocketAddr);

    // Never ourselves, and refused HERE rather than by each caller. fluxDiscovery
    // filters its own address before dialling, but it is one of four ways in -
    // manual, deterministic, reconnect and random all arrive through this
    // function, and the reconnect queue in particular re-dials whatever it holds
    // without asking whose address it is. A self-connection is not merely a
    // wasted socket: it occupies a peer slot, is offered back as a peer to
    // gossip and to sync from, and answers every question with what this node
    // already knows.
    if (socketAddressesMatch(key, localSocketAddr)) {
      log.warn(`initiateAndHandleConnection - refusing to connect to ourselves at ${key} (source ${source})`);
      peerManager.clearPending(key);
      if (onSettle) onSettle(DIAL_RESULT.NO_DIAL);
      return;
    }
    const options = {
      handshakeTimeout: config.fluxapps.wsHandshakeTimeoutMs ?? 10000,
      perMessageDeflate: {
        zlibDeflateOptions: {
        // See zlib defaults.
          chunkSize: 1024,
          // No-context-takeover resets the stream after every message, so the
          // window only ever matches within one. Gossip messages are a few KB
          // and compress to the same bytes on an 8KB window as on a 32KB one,
          // for a third of the memory - and a context is held per peer socket.
          memLevel: 8,
          level: 9,
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024,
        },
        // Other options settable:
        clientNoContextTakeover: true, // Defaults to negotiated value.
        serverNoContextTakeover: true, // Defaults to negotiated value.
        // This socket only ever talks to another node, so both directions size
        // down; a peer on an older build negotiates back up to 15.
        serverMaxWindowBits: 13,
        clientMaxWindowBits: 13,
        // Below options specified as default values.
        concurrencyLimit: 2, // Limits zlib concurrency for perf.
        threshold: 128, // Size (in bytes) below which messages
      // should not be compressed if context takeover is disabled.
      },
      headers: {
        'X-Flux-Capabilities': FLUX_CAPABILITIES.join(','),
        'X-Flux-Version': FLUX_VERSION,
        'X-Flux-Uptime': String(Math.floor(process.uptime())),
      },
    };
    const offsetMs = fluxNetworkHelper.getLocalClockOffsetMs();
    if (offsetMs !== null) {
      options.headers['X-Flux-Clock-Offset'] = String(offsetMs);
    }
    if (source === PEER_SOURCE.RECONNECT) {
      options.headers['X-Flux-Reconnect'] = 'true';
    }
    const wsuri = `ws://${ip}:${port}/ws/flux/${myPort}`;
    const websocket = new WebSocket(wsuri, options);
    wsMetadata.set(websocket, {
      ip, port, source, onSettle, settled: false,
    });
    websocket.on('error', onOutboundError);
    websocket.on('close', onOutboundClose);
    websocket.on('upgrade', onOutboundUpgrade);
    websocket.onopen = onOutboundOpen;
  } catch (error) {
    const catchKey = `${ip}:${port}`;
    peerManager.clearPending(catchKey);
    if (onSettle) onSettle(DIAL_RESULT.NO_DIAL);
    log.error(error);
  }
}

/**
 * Open an ephemeral connection to a peer. Returns a promise that resolves
 * with the FluxPeerSocket once connected, or null on failure.
 * @param {string} connection - IP or IP:port
 * @returns {Promise<FluxPeerSocket|null>}
 */
function openEphemeralConnection(connection) {
  return new Promise((resolve) => {
    const ip = extractIp(connection);
    const port = extractPort(connection);
    try {
      const key = `${ip}:${port}`;
      if (peerManager.isPending(key)) {
        log.info(`Ephemeral connection to ${key} skipped: pending`);
        resolve(null);
        return;
      }
      peerManager.markPending(key);
      if (!myPort) {
        peerManager.clearPending(key);
        log.warn(`Ephemeral connection to ${key} skipped: myPort not set`);
        resolve(null);
        return;
      }
      const options = {
        handshakeTimeout: config.fluxapps.wsHandshakeTimeoutMs ?? 10000,
        headers: {
          'X-Flux-Capabilities': FLUX_CAPABILITIES.join(','),
          'X-Flux-Version': FLUX_VERSION,
          'X-Flux-Uptime': String(Math.floor(process.uptime())),
        },
      };
      const offsetMs = fluxNetworkHelper.getLocalClockOffsetMs();
      if (offsetMs !== null) {
        options.headers['X-Flux-Clock-Offset'] = String(offsetMs);
      }
      const wsuri = `ws://${ip}:${port}/ws/flux/${myPort}`;
      const websocket = new WebSocket(wsuri, options);
      const meta = { ip, port };
      let settled = false;

      websocket.on('upgrade', (response) => {
        if (response.headers['x-flux-capabilities']) {
          meta.remoteCapabilities = response.headers['x-flux-capabilities'].split(',').map((s) => s.trim()).filter(Boolean);
        }
        const clockHeader = response.headers['x-flux-clock-offset'];
        if (clockHeader !== undefined) {
          meta.remoteClockOffsetMs = Number(clockHeader);
        }
      });

      websocket.on('error', (error) => {
        if (settled) return;
        settled = true;
        peerManager.clearPending(key);
        log.warn(`Ephemeral connection to ${key} failed: ${error.message}`);
        resolve(null);
      });

      websocket.on('close', (code, reason) => {
        if (settled) return;
        settled = true;
        peerManager.clearPending(key);
        log.warn(`Ephemeral connection to ${key} closed before open: ${code} ${reason}`);
        resolve(null);
      });

      websocket.onopen = () => {
        if (settled) return;
        settled = true;
        const peer = peerManager.addEphemeral(websocket, meta.ip, meta.port, {
          remoteCapabilities: meta.remoteCapabilities,
          remoteClockOffsetMs: meta.remoteClockOffsetMs,
        });
        resolve(peer);
      };
    } catch (error) {
      peerManager.clearPending(`${ip}:${port}`);
      log.error(error);
      resolve(null);
    }
  });
}

/**
 * To add a peer by specifying the IP address. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function addPeer(req, res) {
  try {
    let { ip } = req.params;
    ip = ip || req.query.ip;

    const authorized = await verificationHelper.verifyPrivilege(
      Privilege.NODE_OPERATOR_OR_FLUX_TEAM,
      authOf(req),
    );

    if (authorized !== true) {
      const message = messageHelper.errUnauthorizedMessage();
      res.json(message);
      return;
    }

    const parsed = parseSocketAddress(ip);

    if (!parsed) {
      const unparsableError = messageHelper.createErrorMessage(
        'Unparsable `ip` parameter',
      );
      res.json(unparsableError);
      return;
    }

    const { ip: peerIp, port: peerPort } = parsed;

    if (peerManager.has(`${peerIp}:${peerPort}`)) {
      const errMessage = messageHelper.createErrorMessage(`Already connected to ${peerIp}:${peerPort}`);
      res.json(errMessage);
      return;
    }

    setImmediate(() => initiateAndHandleConnection(ip, PEER_SOURCE.MANUAL));

    const message = messageHelper.createSuccessMessage(
      `Outgoing connection to ${peerIp}:${peerPort} initiated`,
    );

    res.json(message);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Function to be called by FluxNodes without the minimum Incoming connections.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function addOutgoingPeer(req, res) {
  try {
    if (!nodeConfirmationService.isConfirmed()) {
      const errMessage = messageHelper.createErrorMessage('Node is not confirmed.');
      return res.json(errMessage);
    }
    let { ip } = req.params;
    ip = ip || req.query.ip;
    if (ip === undefined || ip === null) {
      const errMessage = messageHelper.createErrorMessage('No IP address specified.');
      return res.json(errMessage);
    }
    const peerIp = extractIp(ip);
    const peerPort = extractPort(ip);

    const remoteIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.headers['x-forwarded-for'];

    const remoteIP4 = remoteIP.replace('::ffff:', '');

    if (peerIp !== remoteIP4) {
      const errMessage = messageHelper.createErrorMessage(`Request ip ${remoteIP4} of ${remoteIP} doesn't match the ip: ${peerIp} to connect.`);
      return res.json(errMessage);
    }

    if (peerManager.has(`${peerIp}:${peerPort}`)) {
      const errMessage = messageHelper.createErrorMessage(`Already connected to ${peerIp}:${peerPort}`);
      return res.json(errMessage);
    }

    const nodeList = await fluxCommunicationUtils.deterministicFluxList();
    const fluxNode = nodeList.find((node) => socketAddressesMatch(node.ip, ip));
    if (!fluxNode) {
      const errMessage = messageHelper.createErrorMessage(`FluxNode ${peerIp}:${peerPort} is not confirmed on the network.`);
      return res.json(errMessage);
    }

    initiateAndHandleConnection(ip, PEER_SOURCE.DETERMINISTIC);
    const message = messageHelper.createSuccessMessage(`Outgoing connection to ${peerIp}:${peerPort} initiated`);
    return res.json(message);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

function startDiscovery() {
  if (discoveryRunning) return;
  discoveryRunning = true;
  nodeDownService.start({
    dial: (socketAddress, { witness } = {}) => new Promise((resolve) => {
      // Reciprocal duties mean both ends often owe the same pair a dial at
      // the same instant (a fleet boot, a shared drop). A small random
      // delay breaks the symmetry so the crossing race — both connections
      // establishing at once, both losing to the first-wins rule — cannot
      // repeat in lockstep. The reference sim jitters every dial the same
      // way.
      setTimeout(() => {
        initiateAndHandleConnection(
          socketAddress,
          witness ? PEER_SOURCE.DETERMINISTIC : PEER_SOURCE.RANDOM,
          { onSettle: resolve },
        );
      }, Math.floor(Math.random() * DIAL_JITTER_MS));
    }),
    openEphemeralConnection,
    sendSignedMessage: fluxCommunicationMessagesSender.sendSignedMessage,
    broadcastMessageToAll: fluxCommunicationMessagesSender.broadcastMessageToAll,
    closePeer: (socketAddress, reason) => {
      const peer = peerManager.get(socketAddress);
      if (peer) peer.close(CLOSE_CODES.CLOSED_OUTBOUND, reason);
    },
    peerManager,
  });
  // Driven by the node list arriving rather than by a retry that happens to
  // land after it. A peer holds one socket in either direction, so peers that
  // dial us while we are waiting take the very sockets we would have dialled
  // them on, and a late first pass then has nothing left to connect to.
  networkStateService.onReady(fluxDiscovery);
}

async function startDiscoveryApi(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.FLUX_TEAM, authOf(req));
    if (authorized !== true) {
      return res.json(messageHelper.errUnauthorizedMessage());
    }
    startDiscovery();
    return res.json(messageHelper.createSuccessMessage('Discovery started'));
  } catch (error) {
    log.error(error);
    return res.json(messageHelper.createErrorMessage(error.message || error));
  }
}

// The discovery pass's last logged position/peer-count line, so an unchanged
// pass logs nothing
let lastDiscoveryStatus = null;

/**
 * To discover and connect to other randomly selected FluxNodes. Maintains connections with 1-2% of nodes on the Flux network. Ensures that FluxNode connections are not duplicated.
 */
async function fluxDiscovery() {
  try {
    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    if (!syncStatus.data.synced) {
      throw new Error('Daemon not yet synced. Flux discovery is awaiting.');
    }

    if (!nodeConfirmationService.isConfirmed()) {
      throw new Error('Node not confirmed. Flux discovery is awaiting.');
    }

    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();

    if (!localSocketAddr) {
      throw new Error('Flux IP not detected. Flux discovery is awaiting.');
    }

    // An unknown node list and an empty one are the same value below, and acting
    // on the second when it is really the first sizes both deterministic loops
    // to zero - the node then connects to nobody and reports no error.
    if (!networkStateService.isReady()) {
      throw new Error('Network state not yet known. Flux discovery is awaiting.');
    }

    // Selection is the ring reconciler's: duties are a pure function of the
    // committed list, so there is nothing to discover — this loop is the
    // housekeeping backstop (pruning, a sweep for missed events). The
    // reconciler is the ONE engine that initiates connections: it re-dials
    // lost duties and top-ups on its own pass with per-target backoff, so
    // there is no reconnect queue — a second dialing engine is a second
    // opinion about who to hold, and two opinions fight.
    peerManager.numberOfFluxNodes = networkStateService.nodeCount();

    // one line per discovery pass, and only when something changed since the
    // last pass - steady state stays out of the journal
    const discoveryStatus = `Discovery: ${peerManager.numberOfFluxNodes} nodes, ${peerManager.outboundCount} outgoing, ${peerManager.inboundCount} incoming`;
    if (discoveryStatus !== lastDiscoveryStatus) {
      log.info(discoveryStatus);
      lastDiscoveryStatus = discoveryStatus;
    }

    // Prune expired unstable node entries periodically
    peerManager.pruneUnstableList();

    await nodeDownService.sweep();

    setTimeout(() => {
      fluxDiscovery();
    }, config.fluxapps.discoveryRetryMs ?? 60000);
  } catch (error) {
    log.warn(error.message || error);
    setTimeout(() => {
      fluxDiscovery();
    }, config.fluxapps.discoveryFailRetryMs ?? 120000);
  }
}

function initializeDiscovery() {
  nodeConfirmationService.onConfirmationChange((confirmed) => {
    if (!confirmed) {
      log.info('fluxDiscovery - Confirmation lost, disconnecting all peers');
      peerManager.disconnectAll();
      return;
    }

    // Confirmed is not the same as ready to peer. Every message an inbound peer
    // sends is checked against the node list, so a peer that arrives before the
    // list does is refused however legitimate it is - there is nothing to
    // validate it against. The two facts come from different calls to the same
    // daemon, one carrying a single record and one carrying every node, so the
    // list lands well after the confirmation and that gap is the whole of the
    // window peers were being turned away in.
    //
    // Only the first open waits: once the list is here isReady() is true and
    // this runs inline, so regaining confirmation reconnects immediately.
    networkStateService.onReady(() => {
      // The wait is not instant, and confirmation can be lost inside it. Without
      // this the callback would re-open the door straight after disconnectAll().
      if (!nodeConfirmationService.isConfirmed()) return;

      peerManager.allowConnections();
    });
  });
}

/**
 * Get detailed peer info for a single peer.
 * @param {FluxPeerSocket} peer
 * @returns {object}
 */
function peerToDetailedInfo(peer) {
  return {
    ip: peer.ip,
    port: peer.port,
    direction: peer.direction,
    latency: peer.latency,
    missedPongs: peer.missedPongs,
    lastPingTime: peer.lastPingTime,
    lastPongTime: peer.lastPongTime,
    connectedAt: peer.connectedAt,
    uptime: Date.now() - peer.connectedAt,
    source: peer.source,
    isAlive: peer.isAlive,
    badMessages: peer.badMessageTimestamps.length,
    capabilities: [...peer.remoteCapabilities],
    remoteClockOffsetMs: peer.remoteClockOffsetMs,
    lastTransmissionDelay: peer.lastTransmissionDelay,
    messagesReceived: peer.messagesReceived,
    messagesSent: peer.messagesSent,
    bytesReceived: peer.bytesReceived,
    bytesSent: peer.bytesSent,
    remoteVersion: peer.remoteVersion,
    reconnects: peer.reconnects,
  };
}

/**
 * Get peers, optionally filtered by direction or specific key.
 * GET /flux/peers — all peers
 * GET /flux/peers/outbound — outbound only
 * GET /flux/peers/inbound — inbound only
 * GET /flux/peers/:ip:port — specific peer detail
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function getPeers(req, res) {
  const { filter } = req.params;

  if (filter === 'outbound') {
    const peers = [...peerManager.outboundValues()].map(peerToDetailedInfo);
    return res.json(messageHelper.createDataMessage(peers));
  }

  if (filter === 'inbound') {
    const peers = [...peerManager.inboundValues()].map(peerToDetailedInfo);
    return res.json(messageHelper.createDataMessage(peers));
  }

  if (filter && filter.includes('.')) {
    // Specific peer lookup by ip:port
    const peer = peerManager.get(filter);
    if (!peer) {
      return res.json(messageHelper.createErrorMessage(`Peer ${filter} not found`));
    }
    return res.json(messageHelper.createDataMessage(peerToDetailedInfo(peer)));
  }

  // All peers
  const peers = [...peerManager.allValues()].map(peerToDetailedInfo);
  return res.json(messageHelper.createDataMessage(peers));
}

/**
 * Get list of nodes flagged as unstable (5+ disconnects in 2 hours).
 * GET /flux/unstablenodes
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function getUnstableNodes(req, res) {
  const unstable = [];
  for (const [key, entry] of peerManager.unstableEntries()) {
    if (entry.disconnects >= 5) {
      unstable.push({
        ip: extractIp(key),
        port: String(extractPort(key)),
        disconnects: entry.disconnects,
        firstDisconnect: entry.firstDisconnect,
      });
    }
  }
  return res.json(messageHelper.createDataMessage(unstable));
}

/**
 * Get peer connection history from the ring buffer.
 * GET /flux/peerhistory — all events
 * GET /flux/peerhistory?ip=75.6.52 — filter by IP prefix
 * GET /flux/peerhistory?code=4004 — filter by close code
 * GET /flux/peerhistory?event=disconnected — filter by event type
 * GET /flux/peerhistory?limit=50 — limit results (most recent)
 * GET /flux/peerhistory?since=1773520000000 — events after timestamp
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getPeerHistory(req, res) {
  const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
  if (authorized !== true) {
    return res.json(messageHelper.errUnauthorizedMessage());
  }
  const { ip, code, event, limit, since } = req.query;
  const filters = {};
  if (since) filters.since = Number(since);
  if (ip) filters.ip = ip;
  if (code) filters.code = Number(code);
  if (event) filters.event = event;
  if (limit) filters.limit = Number(limit);
  const events = peerManager.getFilteredHistory(filters);
  return res.json(messageHelper.createDataMessage(events));
}

/**
 * Get peer exchange topology — what peers our peers have reported.
 * GET /flux/topology
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function getTopology(req, res) {
  const topology = {};
  for (const [reporter, entry] of peerManager.topologyEntries()) {
    topology[reporter] = {
      outbound: [...entry.outbound],
      inbound: [...entry.inbound],
    };
  }
  const data = {
    reporters: peerManager.peerTopologySize,
    knownPeers: peerManager.knownPeers.size,
    topology,
  };
  return res.json(messageHelper.createDataMessage(data));
}

/**
 * Get network health status and diagnosis history.
 * GET /flux/networkhealth
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function getNetworkHealth(req, res) {
  const data = {
    status: networkHealthMonitor.getStatus(),
    inSteadyState: networkHealthMonitor.isInSteadyState(),
    history: networkHealthMonitor.getDiagnosisHistory(),
  };
  return res.json(messageHelper.createDataMessage(data));
}

function logSockets() {
  const inboundMessages = { requestHash: 0, newHash: 0 };
  const outboundMessages = { requestHash: 0, newHash: 0 };

  for (const peer of peerManager.inboundValues()) {
    inboundMessages.requestHash += peer.msgMap.get('requestHash');
    inboundMessages.newHash += peer.msgMap.get('newHash');
    peer.msgMap = new Map([['requestHash', 0], ['newHash', 0]]);
  }
  for (const peer of peerManager.outboundValues()) {
    outboundMessages.requestHash += peer.msgMap.get('requestHash');
    outboundMessages.newHash += peer.msgMap.get('newHash');
    peer.msgMap = new Map([['requestHash', 0], ['newHash', 0]]);
  }

  const { requestHash: inboundRequest, newHash: inboundNew } = inboundMessages;
  const { requestHash: outboundRequest, newHash: outboundNew } = outboundMessages;

  log.info('Inbound socket info. Hash Requests: '
    + `${inboundRequest}, New Hashes: ${inboundNew}`);

  log.info('Outbound socket info. Hash Requests: '
    + `${outboundRequest}, New Hashes: ${outboundNew}`);
}

function logSocketsEvery(intervalMs) {
  // do this properly
  setInterval(logSockets, intervalMs);
}

module.exports = {
  connectedPeers,
  removePeer,
  removeIncomingPeer,
  connectedPeersInfo,
  peerResponsiveness,
  keepConnectionsAlive,
  fluxDiscovery,
  startDiscovery,
  initializeDiscovery,
  startDiscoveryApi,
  handleAppMessages,
  addPeer,
  logSocketsEvery,
  handleAppRunningMessage,
  handleAppInstallingMessage,
  handleTempSyncResponse,
  handleAppRunningSyncResponse,
  handleAppInstallingSyncResponse,
  handleAppInstallingErrorsSyncResponse,
  handleIPChangedMessage,
  handleAppRemovedMessage,
  handleNodeSigtermMessage,
  initiateAndHandleConnection,
  addOutgoingPeer,
  getPeers,
  getUnstableNodes,
  getPeerHistory,
  getTopology,
  getNetworkHealth,
  openEphemeralConnection,
};
