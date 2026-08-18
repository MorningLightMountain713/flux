'use strict';

const config = require('config');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const generalService = require('../generalService');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const registryManager = require('../appDatabase/registryManager');
const { extractIp } = require('../utils/socketAddressUtils');
const signedEnvelope = require('./signedEnvelope');
const grantClient = require('./grantClient');
const mastershipGrantGate = require('../appLifecycle/mastershipGrantGate');
const log = require('../../lib/log');

// The holder-to-holder face of the grant plane: the witness poll and the
// relay. Both exist so a master's safety never depends on ITS OWN path to
// the committee — a standby that can see both sides carries the renewals,
// and when nobody can, the standbys' unanimous word is what lets the master
// keep running.
//
// Neither surface can be made to lie usefully. A witness reply only ever
// REMOVES the master's permission to coast (any non-affirming answer ends
// it), so a dishonest witness can force a failover it would legitimately win
// anyway — never two masters. A relay carries end-to-end signed asks it
// cannot alter, to a committee it computes for itself; the worst carrier is
// a silent one.
//
// Both answer only to their own kind: the caller must be a listed node, and
// for the relay this node must itself hold the app whose ask it carries —
// a node has no business relaying for apps it is not part of.

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/[a-zA-Z0-9-]{1,64}(@\d{1,10})?$/;

const PEER_WINDOW_MS = 60 * 1000;
const peerAsks = new Map(); // host -> { windowStart, count }

function peerMaxAsks() {
  return config.fluxapps.quorumGrantPeerAsksPerMinute ?? 600;
}

function peerAllowed(host) {
  const now = Date.now();
  const seen = peerAsks.get(host);
  if (!seen || now - seen.windowStart >= PEER_WINDOW_MS) {
    peerAsks.set(host, { windowStart: now, count: 1 });
    return true;
  }
  seen.count += 1;
  return seen.count <= peerMaxAsks();
}

function callerHost(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

async function callerIsListed(host) {
  const nodes = await fluxCommunicationUtils.deterministicFluxList();
  return (nodes || []).some((node) => extractIp(node.ip) === host);
}

async function selfHoldsApp(key) {
  const appName = key.slice(0, key.indexOf('/'));
  const rows = await registryManager.appLocation(appName);
  const nodes = await fluxCommunicationUtils.deterministicFluxList();
  // location rows carry addresses, so holdership is answered by this node's
  // own listed address, resolved through its collateral
  const self = await generalService.obtainNodeCollateralInformation();
  const selfNode = (nodes || []).find(
    (node) => node.txhash === self.txhash && String(node.outidx) === String(self.txindex),
  );
  if (!selfNode) return false;
  const selfHost = extractIp(selfNode.ip);
  return (rows || []).some((row) => extractIp(row.ip) === selfHost);
}

/**
 * The witness poll: what this node is doing about a key, plus whether it can
 * currently reach the key's committee. The master's coast lives and dies on
 * these answers, so the handler answers from live checks, never from cache.
 */
async function witness(req, res) {
  try {
    const host = callerHost(req);
    if (!peerAllowed(host)) {
      return res.status(429).json(messageHelper.createErrorMessage('too many witness asks'));
    }
    const body = serviceHelper.ensureObject(req.body) ?? {};
    const { key } = body;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed key'));
    }
    if (!(await callerIsListed(host))) {
      return res.status(403).json(messageHelper.createErrorMessage('caller is not a listed node'));
    }

    const answer = await grantClient.witnessAnswer(key);
    // The self-fence attestation rides the same answer: "my folder for this
    // app is demoted and reverted, as of my time T" — what a fencing master
    // waits for before re-admitting this node's device.
    const appName = key.slice(0, key.indexOf('/'));
    answer.folderDemotedAt = mastershipGrantGate.folderDemotedAt(appName);
    return res.json(messageHelper.createDataMessage(answer));
  } catch (error) {
    log.error(`quorumGrant witness: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

/**
 * The relay: carry one end-to-end signed ask to its key's committee and
 * bring back the replies. The committee is computed HERE, from the ask —
 * never taken from the caller — and only for apps this node itself holds.
 */
async function relay(req, res) {
  try {
    const host = callerHost(req);
    if (!peerAllowed(host)) {
      return res.status(429).json(messageHelper.createErrorMessage('too many relay asks'));
    }
    const body = serviceHelper.ensureObject(req.body) ?? {};
    const { type, ask, signature } = body;

    if (!signedEnvelope.TYPES.includes(type)) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed type'));
    }
    const askObject = serviceHelper.ensureObject(ask) ?? {};
    if (typeof askObject.key !== 'string' || !KEY_PATTERN.test(askObject.key)) {
      return res.status(400).json(messageHelper.createErrorMessage('malformed key'));
    }
    if (typeof signature !== 'string' || !signature) {
      return res.status(400).json(messageHelper.createErrorMessage('missing signature'));
    }
    if (!(await callerIsListed(host))) {
      return res.status(403).json(messageHelper.createErrorMessage('caller is not a listed node'));
    }
    if (!(await selfHoldsApp(askObject.key))) {
      return res.status(403).json(messageHelper.createErrorMessage('not a holder of that app'));
    }

    const carried = await grantClient.carryAsk(type, askObject, signature);
    return res.json(messageHelper.createDataMessage(carried));
  } catch (error) {
    log.error(`quorumGrant relay: ${error.message}`);
    return res.status(500).json(messageHelper.createErrorMessage(error.message));
  }
}

/** Test seam. */
function reset() {
  peerAsks.clear();
}

module.exports = {
  witness,
  relay,
  reset,
};
