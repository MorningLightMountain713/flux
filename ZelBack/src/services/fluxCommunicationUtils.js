'use strict';

const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const verificationHelper = require('./verificationHelper');
const networkStateService = require('./networkStateService');
const { CLOCK_SKEW_ALLOWANCE_MS } = require('./utils/appConstants');

/**
 * @typedef {{
 *   version: number,
 *   timestamp: number,
 *   pubKey: string,
 *   signature: string,
 *   data : object,
 * }} FluxNetworkMessage
 */

/**
 * To get deterministc Flux list from network state manager
 * @param {string} filter Filter. Can only be a publicKey.
 * @param {{filter?: string, sort?: boolean, addressOnly?: boolean}} options
 * @returns {Promise<Array<Fluxnode>}
 */
async function deterministicFluxList(options = {}) {
  const filter = options.filter || '';
  const sort = options.sort || false;
  const addressOnly = options.addressOnly || false;

  await networkStateService.waitStarted();

  if (!filter) {
    const state = networkStateService.networkState({ sort });

    if (!addressOnly) return state;

    return state.reduce((filtered, node) => {
      if (node.ip) filtered.push(node.ip);

      return filtered;
    }, []);
  }

  const filtered = await networkStateService.getFluxnodesByPubkey(filter);

  if (!filtered) return [];

  const asArray = Array.from(filtered.values());

  return asArray;
}

async function getNodeCount() {
  await networkStateService.waitStarted();

  const count = networkStateService.nodeCount();

  return count;
}

/**
 *
 * @param {string} socketAddress
 * @returns {Proimse<Fluxnode | null}
 */
async function getFluxnodeFromFluxList(socketAddress) {
  await networkStateService.waitStarted();

  const node = await networkStateService.getFluxnodeBySocketAddress(socketAddress);

  return node;
}

/**
 *
 * @param {string} socketAddress
 * @returns {Proimse<boolean>}
 */
async function socketAddressInFluxList(socketAddress) {
  await networkStateService.waitStarted();

  const found = await networkStateService.socketAddressInNetworkState(socketAddress);

  return found;
}

let counter = 0;
let lastUpdate = 0;

/**
 * To verify a Flux broadcast message.
 * @param {FluxNetworkMessage} broadcast Flux network layer message containing public key, timestamp, signature and version.
 * @returns {Promise<boolean>} False unless message is successfully verified.
 */
const VerifyResult = Object.freeze({
  OK: 'ok',
  MALFORMED: 'malformed',
  NODE_NOT_FOUND: 'nodeNotFound',
  BAD_SIGNATURE: 'badSignature',
  PUBKEY_MISMATCH: 'pubkeyMismatch',
});

/**
 * Resolve which node in the deterministic list a broadcast claims to come from, and
 * confirm the signer holds that node's registered key.
 *
 * The single definition of "who sent this". Both the per-message and the batched
 * verification paths route through here so the per-type address selection and the
 * pubkey binding cannot drift apart, and so callers can consume the resolved node
 * rather than re-deriving identity from the payload's address string.
 *
 * @param {object} payload Broadcast data object.
 * @param {string} pubKey Public key the envelope was signed with.
 * @returns {Promise<{result: string, announcer: object|null}>} announcer is the list
 *   entry for address-addressed message types, and null for types that can only be
 *   attributed to a pubkey — which is owner-granular, since one key serves a fleet.
 */
async function resolveBroadcastAnnouncer(payload, pubKey) {
  const { type: msgType } = payload;

  let target;
  switch (msgType) {
    case 'fluxapprunning':
    case 'fluxappinstalling':
    case 'fluxappinstallingerror':
    case 'fluxappremoved':
    case 'fluxnodesigterm':
    case 'fluxmasterlease':
    case 'fluxgrantgeneration':
      target = payload.ip;
      break;

    // Verified against the address being left, not the one being taken: the new
    // address is not in the deterministic list yet, so it can prove nothing.
    case 'fluxipchanged':
      target = payload.oldIP;
      break;

    // zelappregister zelappupdate fluxappregister fluxappupdate fluxapprequest
    default:
      target = await networkStateService.getFluxnodesByPubkey(pubKey);
  }

  if (!target) {
    log.warn(`No node belonging to ${pubKey} found for ${msgType}`);
    return { result: VerifyResult.NODE_NOT_FOUND, announcer: null };
  }

  // A Map means the pubkey lookup above: the key is in the network, but it maps to
  // many nodes, so there is no single announcer to name.
  if (target instanceof Map) return { result: VerifyResult.OK, announcer: null };

  const announcer = await networkStateService.getFluxnodeBySocketAddress(target);
  if (!announcer) {
    // Most of these are our deterministic list being a couple of minutes stale.
    log.warn(`Invalid ${msgType} message, target: ${target} pubkey: ${pubKey}`);
    return { result: VerifyResult.NODE_NOT_FOUND, announcer: null };
  }
  if (announcer.pubkey !== pubKey) {
    log.warn(`Sender pubkey ${pubKey} does not match node at ${target}`);
    return { result: VerifyResult.PUBKEY_MISMATCH, announcer: null };
  }

  return { result: VerifyResult.OK, announcer };
}

async function verifyFluxBroadcast(broadcast) {
  const {
    pubKey, timestamp, signature, version, data: payload,
  } = broadcast;

  const malformed = { result: VerifyResult.MALFORMED, announcer: null };

  if (version !== 1) return malformed;

  const message = serviceHelper.ensureString(payload);

  if (!message) return malformed;

  const { type: msgType } = payload;

  if (!msgType) return malformed;

  const now = Date.now();

  // message was broadcasted in the future; allow for clock disagreement
  if (now < timestamp - CLOCK_SKEW_ALLOWANCE_MS) {
    log.error('VerifyBroadcast: Message from future, rejecting');
    return malformed;
  }

  counter += 1;
  if (!lastUpdate) lastUpdate = process.hrtime.bigint();

  // log message rate every 1000 messages. As of 090725 - approx 1-2 MSG/s
  if (counter % 1000 === 0) {
    counter = 0;
    const nowHrtime = process.hrtime.bigint();
    const elapsed = Number(nowHrtime - lastUpdate) / 1000_000_000;
    const rate = 1000 / elapsed;
    // rounds to 2dp
    const rounded = Math.round((rate + Number.EPSILON) * 100) / 100;
    lastUpdate = nowHrtime;

    log.info(`Receiving broadcast message rate: ${rounded} MSG/s`);
  }

  const { result: lookup, announcer } = await resolveBroadcastAnnouncer(payload, pubKey);
  if (lookup !== VerifyResult.OK) return { result: lookup, announcer: null };

  const messageToVerify = version + message + timestamp;
  const verified = verificationHelper.verifyMessage(
    messageToVerify,
    pubKey,
    signature,
  );

  if (!verified) return { result: VerifyResult.BAD_SIGNATURE, announcer: null };

  return { result: VerifyResult.OK, announcer };
}

/**
 * To verify timestamp in Flux broadcast.
 * @param {object} data Data.
 * @param {number} currentTimeStamp Current timestamp.
 * @returns {boolean} False unless current timestamp is within 5 minutes of the data object's timestamp.
 */
function verifyTimestampInFluxBroadcast(data, currentTimeStamp, maxOld = 300_000) {
  // eslint-disable-next-line no-param-reassign
  const dataObj = serviceHelper.ensureObject(data);
  const { timestamp } = dataObj; // ms

  if (!timestamp) return false;

  // eslint-disable-next-line no-param-reassign
  currentTimeStamp = currentTimeStamp || Date.now(); // ms
  if (currentTimeStamp < (timestamp + maxOld)) { // not older than 5 mins
    return true;
  }
  const age = Math.round((currentTimeStamp - timestamp) / 1_000);
  const maxAge = maxOld / 1_000;
  log.warn('Unable to verify mesage. Timestamp '
    + `${timestamp} is too old: ${age}s, Max: ${maxAge}`);

  return false;
}

/**
 * To verify original Flux broadcast. Extends verifyFluxBroadcast by not allowing request older than 5 mins.
 * @param {object} data Data.
 * @param {object[]} obtainedFluxNodeList List of FluxNodes.
 * @param {number} currentTimeStamp Current timestamp.
 * @returns {Promise<boolean>} False unless message is successfully verified.
 */
async function verifyOriginalFluxBroadcast(data, currentTimeStamp) {
  const timeStampOK = verifyTimestampInFluxBroadcast(data, currentTimeStamp);
  if (timeStampOK) {
    return verifyFluxBroadcast(data);
  }
  return { result: VerifyResult.MALFORMED, announcer: null };
}

module.exports = {
  VerifyResult,
  getNodeCount,
  verifyTimestampInFluxBroadcast,
  verifyOriginalFluxBroadcast,
  deterministicFluxList,
  socketAddressInFluxList,
  getFluxnodeFromFluxList,
  verifyFluxBroadcast,
  resolveBroadcastAnnouncer,
};
