'use strict';

const axios = require('axios');
const log = require('../../lib/log');
const fluxEventBus = require('../utils/fluxEventBus');
const peerFolderLiveness = require('../appMonitoring/peerFolderLiveness');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');

/**
 * Three outcomes, because the difference between them decides whether a second
 * writer is created on a shared volume.
 *
 * NOT_RUNNING is the ONLY one that clears a start. UNKNOWN holds it exactly as
 * RUNNING does: this probe guards a g: primary start, and with
 * SYNCTHING_MAX_CONFLICTS = 0 whichever of two writers loses is discarded.
 */
const PeerComponent = Object.freeze({ RUNNING: 'running', NOT_RUNNING: 'notRunning', UNKNOWN: 'unknown' });

// Bounded so a slow peer cannot hold a promotion open, and deliberately NOT
// shortened: a peer cut short answers UNKNOWN and holds the start, so a tighter
// budget buys nothing and costs availability.
const PEER_PROBE_TIMEOUT_MS = 10 * 1000;

/**
 * Whether ANY peer's verdict holds this node's start.
 *
 * Only a definite NOT_RUNNING from EVERY peer clears it. Named and exported
 * rather than inlined in the election loop because this one line IS the
 * two-writer rule: read as `some(v => v === RUNNING)` it silently treats every
 * UNKNOWN as a clearance, which is the exact behaviour that created a second
 * writer, and the difference is one token.
 *
 * @param {string[]} verdicts one PeerComponent per peer
 * @returns {boolean} true when the start must be held
 */
function anyPeerHoldsComponent(verdicts) {
  return verdicts.some((v) => v !== PeerComponent.NOT_RUNNING);
}

/**
 * What one peer is doing with a component, as far as this node can establish.
 *
 * At module level rather than inside the election loop so the judgement can be
 * exercised directly - the loop reaches it through several gates (grant intent,
 * FDM, index ordering), and a rule about not creating a second writer should not
 * only be reachable through all of them.
 *
 * @param {{appId: string, folderId?: string, aliases?: string[], identifier: string,
 *   appName: string, peerSocketAddr: string, label: string, liveness: object}} params -
 *   appId is the component's docker name here; folderId its syncthing folder id,
 *   the docker name when not given; aliases the other names a peer may hold it
 *   under, the 8.x name of an app registered before v9
 * @returns {Promise<string>} one of PeerComponent
 */
async function peerComponentState({
  appId, folderId = appId, aliases = [], identifier, appName, peerSocketAddr, label, liveness,
}) {
  // Docker reports names with a leading slash, and getAppIdentifier yields exactly
  // the container name for this component. Compare WHOLE names: a substring test
  // also matches a longer app whose name merely begins the same way - myapp
  // against myapp2 - and a false positive here means the component is never
  // started at all. A peer that has not moved the app onto its identity, or runs
  // 8.x, holds it under its 8.x name, which the caller passes as an alias.
  const names = new Set([appId, ...aliases]);
  const peerRunsThisComponent = (appsRunning) => appsRunning.some(
    (app) => (app.Names || []).some((name) => names.has(name.replace(/^\//, ''))),
  );
  const ipToCheck = extractIp(peerSocketAddr);
  const portToCheck = extractPort(peerSocketAddr);
  const { CancelToken } = axios;
  const source = CancelToken.source();
  // Cleared once the request settles: every probe otherwise leaves a live 10s
  // timer behind, for each peer, on every pass until the component runs locally.
  const cancelTimer = setTimeout(() => source.cancel('Operation canceled by timeout.'), PEER_PROBE_TIMEOUT_MS);
  const timeout = PEER_PROBE_TIMEOUT_MS;

  try {
    // heldcomponents, not listrunningapps. The promotion path commits, then flips
    // the folder to receiveonly, chowns the data and flips back, and only THEN
    // starts a container. For that whole window the holder has committed and has
    // no container, so a peer asked what it is RUNNING is truthfully told the
    // component is free - and starts beside it. Nothing resolves that: a standby
    // only stands down when FDM names a different primary, and with FDM silent
    // there is no demotion path at all. heldcomponents answers containers PLUS
    // committed identifiers plus the durable operator stop, which is the question
    // actually being asked, and it is uncached for the same reason -
    // listrunningapps carries 15 seconds, which reopens the window on its own.
    const heldResponse = await axios
      .get(`http://${ipToCheck}:${portToCheck}/apps/heldcomponents`, { timeout, cancelToken: source.token })
      .catch((error) => {
        // A STATUS is an answer: the peer is alive and merely too old for this
        // route, so fall through to the container list. No reply at all is the
        // case the handler below exists to judge.
        if (!error.response) throw error;
        return null;
      });
    const held = heldResponse?.data?.data;
    if (Array.isArray(held)) {
      if (held.some((name) => names.has(name))) {
        fluxEventBus.count('masterSlave:decision', identifier, 'heldOnPeer');
        log.info(`activeStandby: component:${identifier} is held on peer (${label}) at ${ipToCheck}, will not start`);
        return PeerComponent.RUNNING;
      }
      return PeerComponent.NOT_RUNNING;
    }
    // The peer HAS the route and it failed. FluxOS answers errors in band, so that
    // arrives as a 200 carrying an error object rather than a list. Falling
    // through would answer from the container list a question the peer has just
    // said it cannot answer - and that list cannot see the durable stop lock at
    // all, so a primary its owner stopped to work on reads as free and this node
    // elects itself over them. Alive and unreadable is UNKNOWN.
    if (heldResponse?.data?.status === 'error') {
      log.info(`activeStandby: peer (${label}) at ${ipToCheck} could not answer what it holds for app:${appName} - alive, cannot be ruled out, will not start`);
      return PeerComponent.UNKNOWN;
    }

    const response = await axios.get(`http://${ipToCheck}:${portToCheck}/apps/listrunningapps`, { timeout, cancelToken: source.token });
    const appsRunning = response.data?.data;
    // A reply this node cannot read is not a clearance. The peer answered, so it
    // is alive; what it runs is simply unknown.
    if (!Array.isArray(appsRunning)) {
      log.info(`activeStandby: peer (${label}) at ${ipToCheck} is alive but did not list what it runs for app:${appName}, will not start`);
      return PeerComponent.UNKNOWN;
    }
    if (peerRunsThisComponent(appsRunning)) {
      log.info(`activeStandby: component:${identifier} is running on peer (${label}) at ${ipToCheck}, will not start`);
      return PeerComponent.RUNNING;
    }
    return PeerComponent.NOT_RUNNING;
  } catch (error) {
    if (error.response) {
      log.info(`activeStandby: peer (${label}) at ${ipToCheck} answered ${error.response.status} for app:${appName} - alive, cannot be ruled out, will not start`);
      return PeerComponent.UNKNOWN;
    }
    // Silence. This used to count as not-running and START, which is the wrong way
    // round: FluxOS and the container fail independently, so a node whose API is
    // down still holds its volume and still writes to it. Silence is the strongest
    // reason to suspect a peer IS running the component, not a clearance to start
    // beside it.
    //
    // Acted on only with evidence, and it is the same evidence the election
    // already demands before dropping a holder: this node's own syncthing showing
    // the peer's connection to the folder gone, read on a node that can still see
    // the fleet.
    const verdict = await peerFolderLiveness.silenceVerdict(folderId, peerSocketAddr, liveness);
    if (verdict === peerFolderLiveness.SilenceVerdict.GONE) {
      log.info(`activeStandby: peer (${label}) at ${ipToCheck} is silent and this node's syncthing shows its connection for ${folderId} gone - the component is free there`);
      return PeerComponent.NOT_RUNNING;
    }
    log.info(`activeStandby: peer (${label}) at ${ipToCheck} is silent for app:${appName} (${verdict}), will not start`);
    return PeerComponent.UNKNOWN;
  } finally {
    clearTimeout(cancelTimer);
  }
}

module.exports = {
  PeerComponent,
  anyPeerHoldsComponent,
  peerComponentState,
};
