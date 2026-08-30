'use strict';

/* eslint-disable no-underscore-dangle */
const config = require('config');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const verificationHelper = require('./verificationHelper');
const messageHelper = require('./messageHelper');
const dbHelper = require('./dbHelper');
const { peerManager } = require('./utils/peerState');
const cacheManager = require('./utils/cacheManager').default;
const { serialiseAndSignFluxBroadcast, getFluxMessageSignature } = require('./utils/fluxBroadcastHelper');
const fluxEventBus = require('./utils/fluxEventBus');
const appEventVerifier = require('./appMessaging/appEventVerifier');
const appsRepository = require('./appDatabase/appsRepository');

const myMessageCache = cacheManager.tempMessageCache;



/**
 * Sign and send a message to a peer.
 * @param {object} message Message to sign and send.
 * @param {import('./utils/FluxPeerSocket').FluxPeerSocket} peer Peer to send to.
 */
async function sendSignedMessage(message, peer, options = {}) {
  try {
    const messageSigned = await serialiseAndSignFluxBroadcast(message);
    if (options.awaitDrain) {
      await peer.sendAsync(messageSigned);
    } else {
      peer.send(messageSigned);
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To respond with app message.
 * @param {object} msgObj Message object with data.type and hashes.
 * @param {import('./utils/FluxPeerSocket').FluxPeerSocket} peer Peer that requested the message.
 * @returns {void}
 */
async function respondWithAppMessage(msgObj, peer) {
  try {
    // check if we have it database of permanent appMessages
    const appsMessages = [];
    if (!msgObj.data) {
      throw new Error('Invalid Flux App Request message');
    }

    const message = msgObj.data;

    if (message.version !== 1 && message.version !== 2) {
      throw new Error(`Invalid Flux App Request message, version ${message.version} not supported`);
    }

    if (message.version === 1) {
      if (typeof message.hash !== 'string') {
        throw new Error('Invalid Flux App Request message, hash propery is mandatory on version 1');
      }
      appsMessages.push(message.hash);
    }

    if (message.version === 2) {
      if (!message.hashes || !Array.isArray(message.hashes) || message.hashes.length > 500) {
        throw new Error('Invalid Flux App Request v2 message');
      }
      for (let i = 0; i < message.hashes.length; i += 1) {
        if (typeof message.hashes[i] !== 'string') {
          throw new Error('Invalid Flux App Request v2 message');
        }
        appsMessages.push(message.hashes[i]);
      }
    }

    fluxEventBus.publish('hashRequest:received', { peer: peer.key, count: appsMessages.length });

    let found = 0;
    // eslint-disable-next-line no-restricted-syntax
    for (const hash of appsMessages) {
      if (myMessageCache.has(hash)) {
        const tempMesResponse = myMessageCache.get(hash);
        if (tempMesResponse) {
          sendSignedMessage(tempMesResponse, peer);
          found += 1;
          // eslint-disable-next-line no-continue
          continue;
        }
      }
      let temporaryAppMessage = null;
      // eslint-disable-next-line no-await-in-loop
      const appMessage = await appsRepository.getPermanentMessage(hash) || await appsRepository.getTempMessage(hash);
      if (appMessage) {
        // The event class owns the wire shape: it round-trips every field the
        // requester's deserialize needs and ignores the row's storage/chain extras.
        try {
          // eslint-disable-next-line no-await-in-loop
          const appEvent = await appEventVerifier.deserializeTempMessage(appMessage);
          temporaryAppMessage = appEvent.serialize();
          sendSignedMessage(temporaryAppMessage, peer);
          found += 1;
        } catch (error) {
          log.warn(`respondWithAppMessage - stored message ${hash} failed to deserialize, not served: ${error.message}`);
        }
      }
      myMessageCache.set(hash, temporaryAppMessage);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(150);
    }

    fluxEventBus.publish('hashRequest:responded', { peer: peer.key, requested: appsMessages.length, found });
    // else do nothing. We do not have this message. And this Flux would be requesting it from other peers soon too.
  } catch (error) {
    log.error(error);
  }
}

/**
 * Relay a message to all connected peers (both directions), excluding the sender.
 * @param {string} data Serialised message data.
 * @param {string} [excludeKey] Peer key (ip:port) to exclude (the sender).
 */
async function relay(data, excludeKey) {
  await peerManager.broadcast(data, { exclude: excludeKey });
}

/**
 * Sign once, send to all connected peers (both directions).
 * @param {object} dataToBroadcast Data to broadcast.
 * @param {object} [options]
 * @param {string} [options.requireCapability] Only send to peers advertising this capability.
 */
async function broadcastMessageToAll(dataToBroadcast, options = {}) {
  const serialisedData = await serialiseAndSignFluxBroadcast(dataToBroadcast);
  await peerManager.broadcast(serialisedData, { requireCapability: options.requireCapability });
  return JSON.parse(serialisedData);
}

/**
 * Sign and send to one random held peer — direction-free, because the
 * outbound label is a dial-race outcome and a node that lost its races is
 * fully peered. Randomness over all held peers is what spreads load.
 * @param {object} dataToBroadcast Data to broadcast.
 */
async function broadcastMessageToRandomPeer(dataToBroadcast) {
  const serialisedData = await serialiseAndSignFluxBroadcast(dataToBroadcast);
  const peer = peerManager.getRandomPeer();
  if (peer) peer.send(serialisedData);
}

/**
 * @deprecated Use broadcastMessageFromUser instead. Sends to all peers.
 */
async function broadcastMessageToOutgoingFromUser(req, res) {
  log.warn('broadcastMessageToOutgoingFromUser is deprecated, use broadcastMessageFromUser');
  return broadcastMessageFromUser(req, res);
}

/**
 * @deprecated Use broadcastMessageFromUserPost instead. Sends to all peers.
 */
async function broadcastMessageToOutgoingFromUserPost(req, res) {
  log.warn('broadcastMessageToOutgoingFromUserPost is deprecated, use broadcastMessageFromUserPost');
  return broadcastMessageFromUserPost(req, res);
}

/**
 * @deprecated Use broadcastMessageFromUser instead. Sends to all peers.
 */
async function broadcastMessageToIncomingFromUser(req, res) {
  log.warn('broadcastMessageToIncomingFromUser is deprecated, use broadcastMessageFromUser');
  return broadcastMessageFromUser(req, res);
}

/**
 * @deprecated Use broadcastMessageFromUserPost instead. Sends to all peers.
 */
async function broadcastMessageToIncomingFromUserPost(req, res) {
  log.warn('broadcastMessageToIncomingFromUserPost is deprecated, use broadcastMessageFromUserPost');
  return broadcastMessageFromUserPost(req, res);
}

/**
 * To broadcast message from user. Handles messages to outgoing and incoming peers. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function broadcastMessageFromUser(req, res) {
  try {
    let { data } = req?.params || {};
    data = data || req?.query?.data;
    if (data === undefined || data === null) {
      throw new Error('No message to broadcast attached.');
    }
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);

    let message;

    if (authorized === true) {
      await broadcastMessageToAll(data);
      message = messageHelper.createSuccessMessage('Message successfully broadcasted to Flux network');
    } else {
      message = messageHelper.errUnauthorizedMessage();
    }
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
 * To broadcast message from user after data is processed. Handles messages to outgoing and incoming peers. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function broadcastMessageFromUserPost(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      if (body === undefined || body === '') {
        throw new Error('No message to broadcast attached.');
      }
      const processedBody = serviceHelper.ensureObject(body);
      const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);

      let message;

      if (authorized === true) {
        await broadcastMessageToAll(processedBody);
        message = messageHelper.createSuccessMessage('Message successfully broadcasted to Flux network');
      } else {
        message = messageHelper.errUnauthorizedMessage();
      }
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
  });
}

// how long can this take?
/**
 * To broadcast temporary app message.
 * @param {object} message Message.
 */
async function broadcastTemporaryAppMessage(message) {
  /* message object
  * @param type string
  * @param version number
  * @param appSpecifications object
  * @param hash string - messageHash(type + version + JSON.stringify(appSpecifications) + timestamp + signature))
  * @param timestamp number
  * @param signature string
  */
  // no verification of message before broadcasting. Broadcasting happens always after data have been verified and are stored in our db. It is up to receiving node to verify it and store and rebroadcast.
  if (typeof message !== 'object' || typeof message.type !== 'string' || typeof message.version !== 'number' || typeof message.appSpecifications !== 'object' || typeof message.signature !== 'string' || typeof message.timestamp !== 'number' || typeof message.hash !== 'string') {
    throw new Error('Invalid Flux App message for storing');
  }
  // sign once, send to both directions
  await broadcastMessageToAll(message);
}

/**
 * Broadcast a node's ingress attestation (where a register/update entered the
 * network). The inner attestation is already signed by the ingress node; the
 * outer broadcast envelope is re-signed by each relaying node as usual.
 * @param {object} record - IngressAttestation.serialize() output
 */
async function broadcastIngressAttestation(record) {
  await broadcastMessageToAll({ type: 'fluxappingress', version: 1, ...record });
}

/**
 * Step 1 of the two-step ingress-attestation reconcile: serve this node's K bucket
 * digests of its confirmed attestation set (setReconciler) — fixed size regardless of
 * set size, so a catching-up peer can diff digests and fetch only the buckets that differ.
 */
async function respondWithIngressIndex(peer) {
  try {
    const digests = await appsRepository.listIngressAttestationDigests();
    await sendSignedMessage({ type: 'fluxappingressindex', digests, done: true }, peer, { awaitDrain: true });
  } catch (error) {
    log.error(error);
  }
}

/**
 * Step 2 of the two-step ingress-attestation reconcile: serve the full attestation
 * records that fall in the buckets a peer asked for (`msgObj.data.buckets`). Each record
 * carries its own node signature, verified by the requester in the fluxappingresssync
 * receive path — no rebroadcast, this is a targeted backfill.
 */
async function respondWithIngressAttestations(msgObj, peer) {
  try {
    const buckets = msgObj && msgObj.data && msgObj.data.buckets;
    if (!Array.isArray(buckets) || buckets.length === 0 || buckets.length > 256) {
      await sendSignedMessage({ type: 'fluxappingresssync', messages: [], done: true }, peer, { awaitDrain: true });
      return;
    }
    const records = await appsRepository.listIngressAttestationsForBuckets(buckets);

    const batchSize = 2000;
    if (records.length === 0) {
      await sendSignedMessage({ type: 'fluxappingresssync', messages: [], done: true }, peer, { awaitDrain: true });
      return;
    }
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const done = i + batchSize >= records.length;
      // eslint-disable-next-line no-await-in-loop
      await sendSignedMessage({ type: 'fluxappingresssync', messages: batch, done }, peer, { awaitDrain: true });
    }
  } catch (error) {
    log.error(error);
  }
}

async function respondWithTempMessages(peer, sinceTimestamp = 0) {
  try {
    const globalAppsTempMessages = config.database.appsglobal.collections.appsTemporaryMessages;
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    const query = sinceTimestamp > 0 ? { receivedAt: { $gt: new Date(sinceTimestamp) } } : {};
    const cursor = database.collection(globalAppsTempMessages)
      .find(query, { projection: { _id: 0, receivedAt: 0, expireAt: 0 } })
      .sort({ receivedAt: 1 });

    const batchSize = 2000;
    let batch = [];
    let total = 0;
    for await (const msg of cursor) {
      // The row is served whole: messageStore writes it from the typed event's
      // serialize() and the projection strips the storage-only fields, so the
      // row IS the wire shape — no field list to drift from the event class.
      batch.push(msg);
      if (batch.length >= batchSize) {
        log.info(`respondWithTempMessages - Sending chunk of ${batch.length} to ${peer.key}`);
        await sendSignedMessage({ type: 'fluxapptempsync', version: 1, messages: batch, done: false }, peer, { awaitDrain: true });
        total += batch.length;
        batch = [];
      }
    }
    log.info(`respondWithTempMessages - Sending final ${batch.length} to ${peer.key} (total: ${total + batch.length})`);
    await sendSignedMessage({ type: 'fluxapptempsync', version: 1, messages: batch, done: true }, peer, { awaitDrain: true });
  } catch (error) {
    log.error(error);
  }
}

async function streamBatchedSync(peer, { sinceTimestamp, collectionName, validityMs, query, projection, messageType, label, batchSize = 2000 }) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);

    const adjustedTimestamp = sinceTimestamp > 0
      ? new Date(sinceTimestamp - (peer.remoteClockOffsetMs || 0))
      : new Date(0);
    const validAfter = new Date(Date.now() - validityMs);
    const minTimestamp = adjustedTimestamp > validAfter ? adjustedTimestamp : validAfter;

    const finalQuery = query ? query(minTimestamp) : { broadcastedAt: { $gt: minTimestamp } };
    const finalProjection = projection ?? { _id: 0, expireAt: 0 };
    const cursor = database.collection(collectionName)
      .find(finalQuery, { projection: finalProjection })
      .sort({ broadcastedAt: 1 });

    let batch = [];
    let total = 0;
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= batchSize) {
        log.info(`${label} - Sending chunk of ${batch.length} to ${peer.key}`);
        await sendSignedMessage({ type: messageType, messages: batch, done: false }, peer, { awaitDrain: true });
        total += batch.length;
        batch = [];
      }
    }
    log.info(`${label} - Sending final ${batch.length} to ${peer.key} (total: ${total + batch.length})`);
    await sendSignedMessage({ type: messageType, messages: batch, done: true }, peer, { awaitDrain: true });
  } catch (error) {
    log.error(error);
  }
}

async function respondWithAppRunningMessages(peer, sinceTimestamp = 0) {
  return streamBatchedSync(peer, {
    sinceTimestamp,
    collectionName: config.database.appsglobal.collections.appStateEvents,
    validityMs: 125 * 60 * 1000,
    // The freshness floor fits the hourly apprunning gossip; masterlease and
    // grantgeneration records are DURABLE and published once (change-driven),
    // so a floor that ages them out would silently exclude exactly the rows a
    // rejoining node can never re-receive any other way — the record of any
    // term older than two hours would be unsyncable forever. One row per
    // app/role bounds the unconditional stream. A nodedown certificate stands
    // for six hours and is broadcast once per incident, so the floor would
    // blind a booting node to any certificate older than the floor; the
    // record TTL bounds those rows, and the intake refuses a lapsed one the
    // TTL sweep has not yet deleted.
    query: (min) => ({
      $or: [
        { broadcastedAt: { $gt: min } },
        { createdAt: { $gt: min } },
        { type: { $in: ['masterlease', 'grantgeneration', 'nodedown'] } },
      ],
    }),
    projection: { _id: 0, expireAt: 0 },
    messageType: 'fluxapprunningsync',
    label: 'respondWithAppRunningMessages',
    // A mesh-enabled entry carries its authority bundle and voucher (~600
    // bytes), so chunks are a quarter of the old count to keep the frame
    // size where it was.
    batchSize: 500,
  });
}

async function respondWithAppInstallingMessages(peer, sinceTimestamp = 0) {
  return streamBatchedSync(peer, {
    sinceTimestamp,
    collectionName: config.database.appsglobal.collections.appsInstallingBroadcasts,
    validityMs: 15 * 60 * 1000,
    messageType: 'fluxappinstallingsync',
    label: 'respondWithAppInstallingMessages',
  });
}

async function respondWithAppInstallingErrorsMessages(peer, sinceTimestamp = 0) {
  return streamBatchedSync(peer, {
    sinceTimestamp,
    collectionName: config.database.appsglobal.collections.appsInstallingErrorsBroadcasts,
    validityMs: 24 * 60 * 60 * 1000,
    projection: { _id: 0 },
    messageType: 'fluxappinstallingerrorssync',
    label: 'respondWithAppInstallingErrorsMessages',
  });
}

/**
 * Step 1 of the two-step manifest reconcile: serve this node's (appName, version) index
 * of every confirmed manifest — cheap (no bodies), so a requester can fan out to several
 * peers, union the indexes, and pull only the bodies it's missing/stale on.
 */
async function respondWithManifestIndex(peer) {
  try {
    const index = await appsRepository.listConfirmedContentManifestVersions();
    await sendSignedMessage({ type: 'fluxappcontentmanifestindex', index, done: true }, peer, { awaitDrain: true });
  } catch (error) {
    log.error(error);
  }
}

/**
 * Step 2 of the two-step manifest reconcile: serve the re-servable signed broadcasts for
 * the specific apps a peer asked for (`msgObj.data.appNames`). Only rows carrying a node
 * `envelope` are servable — re-served as { ...envelope, data } so the requester verifies
 * with batchVerifyBroadcasts on top of the manifest's intrinsic owner signature.
 */
async function respondWithContentManifests(msgObj, peer) {
  try {
    const appNames = msgObj && msgObj.data && msgObj.data.appNames;
    if (!Array.isArray(appNames) || appNames.length === 0 || appNames.length > 5000) {
      await sendSignedMessage({ type: 'fluxappcontentmanifestsync', messages: [], done: true }, peer, { awaitDrain: true });
      return;
    }
    const broadcasts = await appsRepository.listConfirmedContentManifestBroadcasts(appNames);

    const batchSize = 2000;
    if (broadcasts.length === 0) {
      await sendSignedMessage({ type: 'fluxappcontentmanifestsync', messages: [], done: true }, peer, { awaitDrain: true });
      return;
    }
    for (let i = 0; i < broadcasts.length; i += batchSize) {
      const batch = broadcasts.slice(i, i + batchSize);
      const done = i + batchSize >= broadcasts.length;
      log.info(`respondWithContentManifests - Sending ${batch.length} to ${peer.key} (done: ${done})`);
      // eslint-disable-next-line no-await-in-loop
      await sendSignedMessage({ type: 'fluxappcontentmanifestsync', messages: batch, done }, peer, { awaitDrain: true });
    }
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  relay,
  sendSignedMessage,
  respondWithAppMessage,
  respondWithTempMessages,
  respondWithAppRunningMessages,
  respondWithAppInstallingMessages,
  respondWithAppInstallingErrorsMessages,
  respondWithManifestIndex,
  respondWithContentManifests,
  serialiseAndSignFluxBroadcast,
  getFluxMessageSignature,
  broadcastMessageToOutgoingFromUser,
  broadcastMessageToOutgoingFromUserPost,
  broadcastMessageToIncomingFromUser,
  broadcastMessageToIncomingFromUserPost,
  broadcastMessageToAll,
  broadcastMessageFromUser,
  broadcastMessageFromUserPost,
  broadcastTemporaryAppMessage,
  broadcastIngressAttestation,
  respondWithIngressIndex,
  respondWithIngressAttestations,
  broadcastMessageToRandomPeer,
};
