'use strict';

const config = require('config');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const nodeIdentityRepository = require('./appDatabase/nodeIdentityRepository');
const ownAddressRepository = require('./appDatabase/ownAddressRepository');
const nodeDosState = require('./nodeDosState');
const benchmarkService = require('./benchmarkService');
const networkStateService = require('./networkStateService');
const fluxCommunicationUtils = require('./fluxCommunicationUtils');
const geolocationService = require('./geolocationService');
const daemonStatus = require('./daemonService/daemonStatus');
const nodeConfirmationService = require('./nodeConfirmationService');
const fluxEventBus = require('./utils/fluxEventBus');
const daemonServiceFluxnodeRpcs = require('./daemonService/daemonServiceFluxnodeRpcs');
const {
  normalizeSocketAddress, extractIp, extractPort, socketAddressesMatch, ipsMatch,
} = require('./utils/socketAddressUtils');
// App-lifecycle dependencies. This service sits above both the network
// primitives (fluxNetworkHelper) and app-lifecycle, so it requires the
// orchestrators directly at the top level.
const appUninstaller = require('./appLifecycle/appUninstaller');
const registryManager = require('./appDatabase/registryManager');
const appRecords = require('./appDatabase/appRecords');

// IP-change monitoring state.
const IP_CHANGE_WINDOW_MS = 20 * 60 * 60 * 1000;
let dosTooManyIpChanges = false;
let maxNumberOfIpChanges = 0;

// Fired with the apps that survived an address change, after the node's public IP
// has moved, and the move's key. serviceManager wires it to
// appReconciler.requestRestartOf.
let onAddressChanged = null;

function setOnAddressChanged(callback) {
  onAddressChanged = callback;
}

// Fired with a move of this node's own address. serviceManager wires it to
// fluxCommunication.handleOwnAddressMove.
let onOwnAddressMoved = null;

function setOnOwnAddressMoved(callback) {
  onOwnAddressMoved = callback;
}

// The installed apps the network lists at a socket address. serviceManager wires
// it to appQueryService.installedAppsListedAt.
let installedAppsListedAt = null;

function setInstalledAppsListedAt(callback) {
  installedAppsListedAt = callback;
}

/**
 * Whether this node ran apps at `socketAddress`: an app installed here is one the
 * network lists there. A configuration names an address, and a machine started on
 * a copy of another's names that machine's; only apps left there show this node
 * held it. `null` when that cannot be read.
 * @param {string} socketAddress
 * @returns {Promise<boolean|null>}
 */
async function ranAppsAt(socketAddress) {
  if (!installedAppsListedAt) return false;
  try {
    return (await installedAppsListedAt(socketAddress)).length > 0;
  } catch (error) {
    log.warn(`own address - whether this node ran apps at ${socketAddress} cannot be read: ${error.message}`);
    return null;
  }
}

/**
 * Judges the IP changes made inside the window. Over the limit every hosted app is
 * removed and the node is held in DOS.
 * @param {number} ipChanges How many IP changes the window holds.
 * @returns {Promise<boolean>} True if the IP changed more than once in the last 20h
 */
async function ipChangesOverLimit(ipChanges) {
  maxNumberOfIpChanges = ipChanges;
  if (ipChanges < 2) return false;
  let names = [];
  try {
    names = await appRecords.hostedInstances().names();
  } catch (error) {
    log.error(`ipChangesOverLimit - cannot list the hosted apps: ${error.message}`);
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const name of names) {
    log.warn(`REMOVAL REASON: Too many IP changes - ${name} being removed due to ${ipChanges} IP changes in 20 hours`);
    // eslint-disable-next-line no-await-in-loop
    await appUninstaller.uninstallApplication(name, { forceKill: true }).catch((error) => log.error(error)); // we will not broadcast it, the node is going DOS
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(500);
  }
  dosTooManyIpChanges = true;
  return true;
}

function setDosTooManyIpChanges(value) {
  dosTooManyIpChanges = value;
}

function getMaxNumberOfIpChanges() {
  return maxNumberOfIpChanges;
}

/**
 * Adopts the address this node holds now in place of the one it held: the move is
 * recorded as this node's own address record, and the node brought to it by
 * reconcileOwnMove. With `announceMove` the move is also told to the network,
 * which carries the node's rows at the old address to the new one.
 * @param {string} previous The socket address the node held.
 * @param {string} current The socket address it holds now.
 * @param {object} [options]
 * @param {boolean} [options.announceMove] Whether the change is told as a move.
 * @returns {Promise<void>}
 */
async function adjustExternalIp(previous, current, { announceMove = true } = {}) {
  if (typeof previous !== 'string' || typeof current !== 'string') {
    log.warn(`Gathered address ${current} is not a valid format`);
    return;
  }
  const previousSocket = normalizeSocketAddress(previous);
  const currentSocket = normalizeSocketAddress(current);
  const ip = extractIp(currentSocket);
  // https://github.com/sindresorhus/ip-regex/blob/master/index.js#L8
  const v4 = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)){3}';
  const v4exact = new RegExp(`^${v4}$`);
  if (!v4exact.test(ip)) {
    log.warn(`Gathered IP ${ip} is not a valid format`);
    return;
  }
  if (socketAddressesMatch(previousSocket, currentSocket)) return;
  log.info(`New public Ip detected: ${currentSocket}, old Ip: ${previousSocket} , updating the FluxNode info on the network`);
  await recordOwnMove(previousSocket, currentSocket, announceMove);
  await reconcileOwnMove();
}

/**
 * Removes the installed apps that cannot follow this node to a new IP and returns
 * the rest: a static-IP app, and one another instance already holds at the new IP.
 * `complete` is false when an app could not be judged or removed, so the next pass
 * judges again. An app already removed is no longer installed, so a pass repeated
 * removes nothing twice.
 * @param {string} previousSocket This node's former socket address.
 * @param {string} currentSocket Its new socket address.
 * @returns {Promise<{staying: object[], complete: boolean}>}
 */
async function appsStayingThroughIpMove(previousSocket, currentSocket) {
  const staying = [];
  let complete = true;
  // Gone, or never there: either way not installed here now.
  const removed = async (appName) => {
    const outcome = await appUninstaller.uninstallApplication(appName, { forceKill: true, skipGuard: true, broadcastRemoval: true })
      .catch((error) => { log.error(error); return null; });
    return outcome?.status === appUninstaller.UninstallStatus.REMOVED || outcome?.status === appUninstaller.UninstallStatus.SKIPPED;
  };
  let apps;
  try {
    apps = (await appRecords.hostedInstances().apps()).map((record) => record.record);
  } catch (error) {
    log.error(`own address - the installed apps cannot be read: ${error.message}`);
    return { staying, complete: false };
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const app of apps) {
    // An app that requires a static IP cannot stay once the IP changes. Every
    // version's record answers this from its placement, which an encrypted spec
    // carries in the clear.
    if (app.placement.staticIp === true) {
      log.info(`Application ${app.name} requires static IP but node IP has changed, uninstalling app`);
      log.warn(`REMOVAL REASON: Static IP required - ${app.name} requires static IP but node IP changed from ${previousSocket} to ${currentSocket}`);
      // eslint-disable-next-line no-await-in-loop
      if (!await removed(app.name)) complete = false;
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const runningAppList = await registryManager.appLocation(app.name);
    // An instance at this IP means the ports are taken and this node cannot run the
    // app: one instance per IP is enforced by the host port mapping, so a UPnP
    // sibling on another port holds them just as surely as a node that owns the
    // address alone. That is why the address is compared at IP granularity.
    //
    // This node's OWN row is not that: it stores its own running-app row at the
    // address benchmark reports. Own-ness is the full socket address, which is what
    // separates it from the sibling that shares only the IP.
    const duplicateInstance = runningAppList.find((instance) => ipsMatch(instance.ip, currentSocket)
      && !socketAddressesMatch(instance.ip, currentSocket));
    if (duplicateInstance) {
      log.info(`Aplication: ${app.name}, was found on the network already running under the same ip, uninstalling app`);
      log.warn(`REMOVAL REASON: Duplicate IP detected - ${app.name} already running on network with IP ${extractIp(currentSocket)} (after IP change)`);
      // eslint-disable-next-line no-await-in-loop
      if (!await removed(app.name)) complete = false;
    } else {
      staying.push(app);
    }
  }
  return { staying, complete };
}

/**
 * Adopts `socketAddress` as this node's own without a move.
 * @param {string} socketAddress
 * @returns {Promise<void>}
 */
async function writeOwnAddressRecord(socketAddress) {
  fluxNetworkHelper.noteOwnAddress(socketAddress, null);
  await ownAddressRepository.adopt(socketAddress);
}

/**
 * Records this node's move from `previousSocket` to `currentSocket` as its own
 * address record, before anything acts on it: the one decision a move makes. A
 * move to an address the record already holds as a move is decided already, so a
 * second caller decides nothing, and the IP change is counted once however often
 * the move is acted on.
 * @param {string} previousSocket
 * @param {string} currentSocket
 * @param {boolean} announce Whether the move is told to the network.
 * @returns {Promise<void>}
 */
async function recordOwnMove(previousSocket, currentSocket, announce) {
  const record = await ownAddressRepository.read();
  if (record?.movedFrom && socketAddressesMatch(record.socketAddress, currentSocket)) return;
  const movedAt = Date.now();
  const ipChanged = !ipsMatch(previousSocket, currentSocket);
  const recentIpChanges = (record?.recentIpChanges ?? []).filter((at) => movedAt - at < IP_CHANGE_WINDOW_MS);
  if (ipChanged) recentIpChanges.push(movedAt);
  fluxNetworkHelper.noteOwnAddress(currentSocket, previousSocket);
  await ownAddressRepository.recordMove({
    socketAddress: currentSocket, movedFrom: previousSocket, movedAt, ipChanged, announce, recentIpChanges,
  });
  if (ipChanged && await ipChangesOverLimit(recentIpChanges.length) && fluxNetworkHelper.fluxUptime() > config.get('fluxapps.minUpTime')) {
    log.info('IP changes over the limit allowed, one in 20 hours');
    nodeDosState.addDosState(11);
    nodeDosState.setDosMessage('IP changes over the limit allowed, one in 20 hours');
    log.error(nodeDosState.getRawDosMessage());
  }
}

/**
 * Whether the chain lists this node at its new address, and if not, asks for a
 * confirmation that lists it there, once per move: a refused one is asked for
 * again on the next pass.
 * @param {object} record This node's own address record.
 * @returns {Promise<boolean>} Whether the chain lists it there.
 */
async function confirmOwnAddress(record) {
  const status = await daemonServiceFluxnodeRpcs.getFluxNodeStatus();
  const listed = status?.status === 'success' ? status.data?.ip : null;
  if (listed && socketAddressesMatch(listed, record.socketAddress)) return true;
  if (record.confirmationAcceptedAt === record.movedAt) return false;
  const { value, reason } = await daemonServiceFluxnodeRpcs.createConfirmationTransaction();
  if (value && value.status !== 'Fail to send') {
    log.info(`createConfirmationTransaction: ${JSON.stringify(value)}`);
    await ownAddressRepository.update({ confirmationAcceptedAt: record.movedAt });
  } else {
    log.warn(`own address - the confirmation of ${record.socketAddress} was refused, asked again on the next pass: ${JSON.stringify(reason ?? value)}`);
  }
  return false;
}

/**
 * Brings this node to the move its own address record holds, doing only what is
 * not yet so: its last known IP written, its address confirmed on chain, the apps
 * the move cannot keep removed and the rest restarted, the move recorded and told
 * to the network, its geolocation refreshed. Each step either reads what is so
 * before acting or is keyed to the move, so a pass repeated - on each change of
 * this node's address, each node list refresh, and boot - finishes a move a
 * failure or a restart left part done and does nothing twice.
 *
 * The chain is how the network durably learns the new address, and it needs no
 * peers: it is asked first, so nothing below can delay it. The move is settled once
 * the chain lists the new address and every app has been handled. Runs only on the
 * own-address queue.
 * @returns {Promise<void>}
 */
async function reconcileOwnMove() {
  const record = await ownAddressRepository.read();
  if (!record?.movedFrom || !record.movedAt || record.settledAt === record.movedAt) return;
  const {
    socketAddress: to, movedFrom: from, movedAt, ipChanged, announce,
  } = record;
  await fluxEventBus.checkpoint(fluxEventBus.Checkpoint.OWN_ADDRESS_BEFORE_RECONCILE, to);
  const ip = extractIp(to);
  if (ipChanged && ip !== await nodeIdentityRepository.getLastKnownIp()) {
    log.info(`Adjusting External IP to ${ip}`);
    await nodeIdentityRepository.setLastKnownIp(ip);
  }
  const confirmed = await confirmOwnAddress(record);
  const appsDue = ipChanged && record.appsHandledAt !== movedAt;
  // Before the move is recorded: until then this node's own rows are at the old
  // address, which is what keeps them from reading as another instance at the new
  // one.
  const apps = appsDue ? await appsStayingThroughIpMove(from, to) : null;
  // The seam records and tells a move once whatever this node's record says, so a
  // pass that told it and stopped before writing announcedAt repeats nothing.
  if (announce && onOwnAddressMoved && record.announcedAt !== movedAt) {
    await onOwnAddressMoved(from, to, movedAt);
    await ownAddressRepository.update({ announcedAt: movedAt });
  }
  let appsHandled = !appsDue;
  if (appsDue) {
    let restarted = true;
    if (apps.staying.length && onAddressChanged) {
      const asked = await onAddressChanged(apps.staying, `node ip changed to ${ip}`, `ownMove:${movedAt}`);
      restarted = Boolean(asked) && asked.asked === asked.components;
    }
    appsHandled = apps.complete && restarted;
    if (appsHandled) await ownAddressRepository.update({ appsHandledAt: movedAt });
    else log.warn(`own address - not every app was handled for the move to ${to}; the next pass handles the rest`);
  }
  if (ipChanged && record.geolocatedAt !== movedAt) {
    // Update geolocation service to track IP change and update static IP status
    geolocationService.setNodeGeolocation();
    await ownAddressRepository.update({ geolocatedAt: movedAt });
  }
  // Settled only once its apps are handled too: a settled move is not reconciled
  // again.
  if (confirmed && appsHandled) await ownAddressRepository.update({ settledAt: movedAt });
}

// Work on this node's own address, one piece at a time in the order it came.
let ownAddressWork = Promise.resolve();
function serialiseOwnAddressWork(work) {
  const run = ownAddressWork.then(work).catch((error) => log.error(`own address - ${error.message}`));
  ownAddressWork = run;
  return run;
}

/**
 * The address this node held before `reported`, for a node that has adopted no
 * address yet: its last known IP when `reported` is on another IP, at the port the
 * network lists this node's collateral at on that IP or else the reported port;
 * `reported` itself otherwise.
 * @param {string} reported
 * @returns {Promise<string>}
 */
async function configuredFormerAddress(reported) {
  const knownIp = await nodeIdentityRepository.getLastKnownIp();
  if (!knownIp || ipsMatch(knownIp, reported)) return reported;
  const status = await daemonServiceFluxnodeRpcs.getFluxNodeStatus().catch(() => null);
  const listed = status?.status === 'success' ? status.data?.ip : null;
  if (listed && ipsMatch(listed, knownIp)) return normalizeSocketAddress(listed);
  return normalizeSocketAddress(`${knownIp}:${extractPort(reported)}`);
}

/**
 * Whether a Flux node answers at `socketAddress`.
 * @param {string} socketAddress
 * @returns {Promise<boolean>}
 */
async function fluxAnswersAt(socketAddress) {
  let answered = true;
  await serviceHelper.axiosGet(`http://${extractIp(socketAddress)}:${extractPort(socketAddress)}/flux/version`, { timeout: 5000 })
    .catch(() => { answered = false; });
  return answered;
}

// How long a node that does not answer is given to come back before it is judged
// gone: a restart.
const ANSWER_GRACE_MS = 60 * 1000;

/**
 * Whether a Flux node answers at `socketAddress`, now or once the grace a
 * restarting node is given has passed.
 * @param {string} socketAddress
 * @returns {Promise<boolean>}
 */
async function fluxStillAnswersAt(socketAddress) {
  if (await fluxAnswersAt(socketAddress)) return true;
  await serviceHelper.delay(ANSWER_GRACE_MS);
  return fluxAnswersAt(socketAddress);
}

// How many peers must find nothing at an address before this node judges the node
// there gone, and how many it draws to find them.
const PEERS_FINDING_NOTHING = 2;
const PEER_DRAWS = 5;

/**
 * Whether peers find nothing at `socketAddress`: this node's own view of one
 * address can fail where the network's does not. Asks distinct random peers, as
 * the availability check does. False as soon as one reaches a Flux node there.
 * @param {string} socketAddress
 * @returns {Promise<boolean>}
 */
async function peersFindNothingAt(socketAddress) {
  const asked = [socketAddress];
  let foundNothing = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (let draw = 0; draw < PEER_DRAWS && foundNothing < PEERS_FINDING_NOTHING; draw += 1) {
    // eslint-disable-next-line no-await-in-loop
    const peer = await networkStateService.getRandomExternalObserver(fluxNetworkHelper.getCachedLocalSocketAddress(), { exclude: asked });
    if (!peer) break;
    asked.push(peer);
    const url = `http://${extractIp(peer)}:${extractPort(peer)}/flux/checkfluxavailability?ip=${extractIp(socketAddress)}&port=${extractPort(socketAddress)}`;
    // eslint-disable-next-line no-await-in-loop
    const answer = await serviceHelper.axiosGet(url, { timeout: 15_000 }).catch(() => null);
    const status = answer?.data?.status;
    if (status === 'success') {
      log.info(`${peer} reaches a Flux node at ${socketAddress}`);
      return false;
    }
    if (status === 'error') foundNothing += 1;
  }
  return foundNothing >= PEERS_FINDING_NOTHING;
}

/**
 * Whether the Flux node at `socketAddress` is gone: nothing answers this node
 * there, now or once a restart's grace has passed, and peers find nothing there
 * either.
 * @param {string} socketAddress
 * @returns {Promise<boolean>}
 */
async function fluxGoneFrom(socketAddress) {
  if (await fluxStillAnswersAt(socketAddress)) return false;
  return peersFindNothingAt(socketAddress);
}

/**
 * Adopts `current` in place of `previous`, the configured address, which this node
 * has no record of leaving. Told to the network as a move only when this node ran
 * apps there. While that cannot be read nothing is adopted: the collision check
 * that calls this finds the same listing on its next pass and asks again.
 * @param {string} previous
 * @param {string} current
 * @returns {Promise<void>}
 */
function leaveConfiguredAddress(previous, current) {
  return serialiseOwnAddressWork(async () => {
    const from = normalizeSocketAddress(previous);
    const ran = await ranAppsAt(from);
    if (ran === null) return;
    await adjustExternalIp(from, current, { announceMove: ran });
  });
}

// How long an adoption deferred on an unreadable database waits before this node's
// address is acted on again; the retry pending, while one is.
const OWN_ADDRESS_RETRY_MS = 60 * 1000;
let ownAddressRetry = null;

/**
 * Acts on an address reported as this node's own. One that differs from the address
 * the node last adopted is a move, whichever way it came and whether or not the
 * chain has already listed the node there. A node that has adopted none compares
 * it with its last known address, which a machine started on a copy of another's
 * data shares with that machine: until the Flux node there is gone (fluxGoneFrom) it
 * adopts the reported address and the collision check judges it; once it is, it
 * adopts the reported address in place of the former one, told as a move only when
 * it ran apps there. While that cannot be read it adopts nothing, and acts on the
 * address it knows again after OWN_ADDRESS_RETRY_MS.
 * @param {string} current The reported socket address.
 * @returns {Promise<void>}
 */
function handleOwnAddress(current) {
  return serialiseOwnAddressWork(async () => {
    const reported = normalizeSocketAddress(current);
    if (!reported) return;
    const record = await ownAddressRepository.read();
    if (record) fluxNetworkHelper.noteOwnAddress(record.socketAddress, record.movedFrom);
    const previous = record ? record.socketAddress : await configuredFormerAddress(reported);
    if (!socketAddressesMatch(previous, reported)) {
      if (!record && !await fluxGoneFrom(previous)) {
        log.warn(`own address - a Flux node is at ${previous}, the configured address, so ${reported} is not a move from it`);
        await writeOwnAddressRecord(reported);
        return;
      }
      const announceMove = record ? true : await ranAppsAt(previous);
      if (announceMove === null) {
        ownAddressRetry ??= setTimeout(() => {
          ownAddressRetry = null;
          handleOwnAddress(fluxNetworkHelper.getKnownLocalSocketAddress() || reported);
        }, OWN_ADDRESS_RETRY_MS);
        return;
      }
      await adjustExternalIp(previous, reported, { announceMove });
    } else if (!record) {
      await writeOwnAddressRecord(reported);
    } else {
      await reconcileOwnMove();
    }
  });
}

/**
 * Brings this node to the move its own address record holds, on the own-address
 * queue.
 * @returns {Promise<void>}
 */
function requestOwnMoveReconcile() {
  return serialiseOwnAddressWork(reconcileOwnMove);
}

// The listener watching this node's own address, while one is, and the node list
// listener that finishes a move.
let ownAddressListener = null;
let stopListUpdates = null;

/**
 * Acts on every change of this node's own address from here on, and on the one it
 * already knows, and reconciles a move on each node list refresh. Watches once
 * however often it is called: a boot that is run again does not add a second
 * watcher.
 * @returns {function(): void} Stops the watch.
 */
function startOwnAddressWatch() {
  if (!ownAddressListener) {
    ownAddressListener = (address) => { handleOwnAddress(address); };
    fluxNetworkHelper.onLocalSocketAddressChange(ownAddressListener);
    stopListUpdates = networkStateService.onUpdated(requestOwnMoveReconcile);
    const known = fluxNetworkHelper.getKnownLocalSocketAddress();
    if (known) handleOwnAddress(known);
  }
  return () => {
    if (ownAddressListener) fluxNetworkHelper.offLocalSocketAddressChange(ownAddressListener);
    ownAddressListener = null;
    if (stopListUpdates) stopListUpdates();
    stopListUpdates = null;
    clearTimeout(ownAddressRetry);
    ownAddressRetry = null;
  };
}

/**
 * To check user's FluxNode availability.
 * @param {number} retryNumber Number of retries.
 * @returns {Promise<boolean>} Return value is only for testing
 */
async function checkMyFluxAvailability(retryNumber = 0) {
  if (dosTooManyIpChanges) {
    nodeDosState.addDosState(11);
    nodeDosState.setDosMessage('IP changes over the limit allowed, one in 20 hours');
    return false;
  }

  const localSocketAddress = fluxNetworkHelper.getCachedLocalSocketAddress();
  if (localSocketAddress === null) return false;

  const fluxBenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();
  if (!fluxBenchVersionAllowed) {
    return false;
  }

  // An external observer. This asks a peer whether it can reach US, and a Flux
  // node sharing our public address cannot answer: reaching us means leaving the
  // router and being sent straight back in, which most consumer routers do not
  // do. Asking one produced a false "unreachable" and two points of dosState,
  // on exactly the shared-address topology this release is about.
  const randomSocketAddress = await networkStateService.getRandomExternalObserver(
    fluxNetworkHelper.getCachedLocalSocketAddress(),
  );

  // Nobody outside this address to ask, so nothing is learned and nothing is
  // concluded - dosState is deliberately untouched here, unlike every failure
  // path below it. The next cycle asks again.
  if (!randomSocketAddress) {
    log.warn('checkMyFluxAvailability - no Flux node outside this address could be asked; skipping this pass');
    return false;
  }

  const remoteIp = extractIp(randomSocketAddress);
  const remotePort = extractPort(randomSocketAddress);

  const axiosConfig = {
    timeout: 7000,
  };

  const localIp = extractIp(fluxNetworkHelper.getCachedLocalSocketAddress());
  const localApiPort = extractPort(fluxNetworkHelper.getCachedLocalSocketAddress());

  const url = `http://${remoteIp}:${remotePort}/flux/`
    + `checkfluxavailability?ip=${localIp}&port=${localApiPort}`;

  const resMyAvailability = await serviceHelper.axiosGet(url, axiosConfig).catch(
    (error) => {
      log.error(`checkMyFluxAvailability - ${remoteIp}:${remotePort}`
        + ` is not reachable. ${error.message}`);

      return null;
    },
  );

  if (!resMyAvailability) {
    nodeDosState.addDosState(2);
    if (nodeDosState.getDosStateValue() > 10) {
      nodeDosState.setDosMessage(nodeDosState.getRawDosMessage() || 'Flux communication is limited, other nodes on the network cannot reach yours through API calls');
      log.error(nodeDosState.getRawDosMessage());
      return false;
    }
    if (retryNumber <= 6) {
      const newRetryIndex = retryNumber + 1;
      return checkMyFluxAvailability(newRetryIndex);
    }
    return false;
  }
  if (resMyAvailability.data.status === 'error' || resMyAvailability.data.data.message.includes('not')) {
    log.error(`My Flux unavailability detected from: ${remoteIp}:${remotePort}`);
    // Asked Flux cannot reach me lets check if ip changed
    if (retryNumber === 4 || nodeDosState.getDosStateValue() > 10) {
      log.info('Getting publicIp from FluxBench');
      const { value: benchIp, reason } = await benchmarkService.getPublicIp();
      if (!reason) {
        log.info(`FluxBench reported public IP: ${benchIp}`);
        const benchMyIP = benchIp.length > 5 ? benchIp : null;
        if (benchMyIP && extractIp(benchMyIP) !== localIp) {
          log.info('New IP found... updating network');
          nodeDosState.setDosStateValue(0);
          nodeDosState.setDosMessage(null);
          // Read afresh: a new address is a change of this node's own address, which
          // its one handler acts on.
          await fluxNetworkHelper.getLocalSocketAddress({ fresh: true });
          return true;
        } if (benchMyIP && extractIp(benchMyIP) === localIp) {
          log.info('FluxBench reported the same Ip that was already in use');
        } else {
          log.info('FluxBench reported a invalid IP');
          nodeDosState.setDosMessage('Error getting publicIp from FluxBench');
          nodeDosState.addDosState(15);
          log.error('FluxBench wasnt able to detect flux node public ip');
        }
      } else {
        log.info('FluxBench reported returned error on getpublicipcall');
        nodeDosState.setDosMessage('Error getting publicIp from FluxBench');
        nodeDosState.addDosState(15);
        log.error(nodeDosState.getRawDosMessage());
        return false;
      }
    }
    nodeDosState.addDosState(2);
    if (nodeDosState.getDosStateValue() > 10) {
      nodeDosState.setDosMessage(nodeDosState.getRawDosMessage() || 'Flux is not available for outside communication');
      log.error(nodeDosState.getRawDosMessage());
      return false;
    }
    if (retryNumber <= 6) {
      const newRetryIndex = retryNumber + 1;
      return checkMyFluxAvailability(newRetryIndex);
    }
    return false;
  }
  const measuredUptime = fluxNetworkHelper.fluxUptime();
  if (measuredUptime > config.get('fluxapps.minUpTime')) { // node has been running for 30 minutes. Upon starting a node, there can be dos that needs resetting
    const found = await fluxCommunicationUtils.getFluxnodeFromFluxList(fluxNetworkHelper.getCachedLocalSocketAddress());
    const nodeCount = await fluxCommunicationUtils.getNodeCount();

    if (nodeCount > config.get('fluxapps.minIncoming') + config.get('fluxapps.minOutgoing') && found) { // our node MUST be in confirmed list in order to have some peers
      // check sufficient connections
      const communication = fluxNetworkHelper.isCommunicationEstablished();
      if (!communication.established) {
        nodeDosState.addDosState(0.13); // slow increment, DOS after ~75 minutes. 0.13 per minute. This check depends on other nodes being able to connect to my node
        if (nodeDosState.getDosStateValue() > 10) {
          nodeDosState.setDosMessage(communication.reason);
          log.error(nodeDosState.getRawDosMessage());
          return false;
        }
        return true; // availability ok
      }
    }
  }
  nodeDosState.setDosStateValue(0);
  nodeDosState.setDosMessage(null);
  return true;
}

/**
 * To check deterministic node collisions (i.e. if multiple FluxNode instances detected).
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function checkDeterministicNodesCollisions() {
  const axiosConfig = {
    timeout: 5000,
  };

  try {
    // After the work on this node's own address already asked for: a move it is
    // recording is its own, not a collision.
    await ownAddressWork;
    // get my external ip address
    // get node list with filter on this ip address
    // if it returns more than 1 object, shut down.
    // another precatuion might be comparing node list on multiple nodes. evaulate in the future
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (localSocketAddr) {
      const syncStatus = daemonStatus.daemonSyncState();
      if (!syncStatus.synced) {
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 120 * 1000);
        return;
      }
      // Same shape as the daemon check above, for the same reason. The list
      // accessors wait for the list to arrive, and this loop only re-arms once
      // it has finished - so awaiting in here would retire it for the life of
      // the process rather than delay it, and this is the only thing that ever
      // clears this node's DOS state. Reading an unknown list instead is no
      // better: it makes every branch below conclude this node is not in the
      // confirmed list, log that as the reason, and skip the availability check
      // that would have cleared the DOS.
      if (!networkStateService.isReady()) {
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 120 * 1000);
        return;
      }
      // Both halves of this check — the node list and our own status — come from the
      // daemon. Without a current answer it would only re-derive the conclusion it
      // reached last time, so there is nothing to gain by running it.
      if (!nodeConfirmationService.isDaemonReachable()) {
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 60 * 1000);
        return;
      }
      const nodeList = await fluxCommunicationUtils.deterministicFluxList();
      const result = nodeList.filter((node) => socketAddressesMatch(node.ip, localSocketAddr));
      const nodeStatus = nodeConfirmationService.getNodeStatus();
      if (nodeStatus) { // different scenario is caught elsewhere
        const myCollateral = nodeStatus.collateral;
        const myNode = result.find((node) => node.collateral === myCollateral);
        const nodeCollateralDifferentIp = nodeList.find((node) => node.collateral === myCollateral && !socketAddressesMatch(node.ip, localSocketAddr));
        if (result.length > 1) {
          log.warn('Multiple Flux Node instances detected');
          if (myNode) {
            const myBlockHeight = myNode.readded_confirmed_height || myNode.confirmed_height; // todo we may want to introduce new readded heights and readded confirmations
            const filterEarlierSame = result.filter((node) => (node.readded_confirmed_height || node.confirmed_height) <= myBlockHeight);
            // keep running only older collaterals
            if (filterEarlierSame.length >= 1) {
              log.error(`Flux earlier collision detection on ip:${localSocketAddr}`);
              nodeDosState.setDosStateValue(100);
              nodeDosState.setDosMessage(`Flux earlier collision detection on ip:${localSocketAddr}`);
              setTimeout(() => {
                checkDeterministicNodesCollisions();
              }, 60 * 1000);
              return;
            }
          }
          // prevent new activation
        } else if (result.length === 1) {
          if (!myNode) {
            log.error('Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.');
            nodeDosState.setDosStateValue(100);
            nodeDosState.setDosMessage('Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.');
            setTimeout(() => {
              checkDeterministicNodesCollisions();
            }, 60 * 1000);
            return;
          }
        }
        // A listing at the address this node recorded moving from is its own move,
        // waiting for its confirmation: nothing to judge.
        const ownRecord = nodeCollateralDifferentIp ? await ownAddressRepository.read() : null;
        const movedFromHere = Boolean(ownRecord?.movedFrom) && socketAddressesMatch(ownRecord.movedFrom, nodeCollateralDifferentIp?.ip);
        if (nodeStatus.status === 'CONFIRMED' && nodeCollateralDifferentIp && !movedFromHere) {
          let errorCall = false;
          const askingIP = extractIp(nodeCollateralDifferentIp.ip);
          const askingIpPort = extractPort(nodeCollateralDifferentIp.ip);
          log.info(`Detected same collateral on different IP: ${askingIP}:${askingIpPort}. Checking if other node is reachable...`);

          // First reachability check
          await serviceHelper.axiosGet(`http://${askingIP}:${askingIpPort}/flux/version`, axiosConfig).catch(() => { errorCall = true; });
          if (!errorCall) {
            // Other node is reachable and confirmed - this is a collision
            log.error(`Flux collision detection. Node at ${askingIP}:${askingIpPort} is confirmed and reachable on flux network with the same collateral transaction information.`);
            nodeDosState.setDosStateValue(100);
            nodeDosState.setDosMessage(`Flux collision detection. Node at ${askingIP}:${askingIpPort} is confirmed and reachable on flux network with the same collateral transaction information.`);
            setTimeout(() => {
              checkDeterministicNodesCollisions();
            }, 60 * 1000);
            return;
          }

          // First check failed - wait 60 seconds before confirming the other node is truly offline
          // This grace period prevents false positives from temporary network issues or node restarts
          log.info(`Other node at ${askingIP}:${askingIpPort} appears unreachable. Waiting 60 seconds to verify before taking over...`);
          errorCall = false;
          await serviceHelper.delay(60 * 1000);

          // Second reachability check after grace period
          await serviceHelper.axiosGet(`http://${askingIP}:${askingIpPort}/flux/version`, axiosConfig).catch(() => { errorCall = true; });
          // The collateral listed at the IP this node last knew as its own, and nothing
          // answering there: not another machine, but this node, which has moved and
          // has no record of where it was. Handled as the move it is, recorded and told
          // to the network before the new address is confirmed.
          if (errorCall && askingIP === await nodeIdentityRepository.getLastKnownIp()) {
            const formerSocket = normalizeSocketAddress(`${askingIP}:${askingIpPort}`);
            log.info(`Our collateral is listed at ${formerSocket}, this node's own former address - handling the move to ${localSocketAddr}`);
            await leaveConfiguredAddress(formerSocket, localSocketAddr);
          } else if (errorCall) {
            // Other node is confirmed offline after grace period - take over the collateral
            log.info(`Other node at ${askingIP}:${askingIpPort} confirmed offline. Creating confirmation transaction to take over collateral...`);
            const daemonResult = await daemonServiceFluxnodeRpcs.createConfirmationTransaction();
            log.info(`node was confirmed on a different machine ip - createConfirmationTransaction: ${JSON.stringify(daemonResult)}`);
            // Clear any previous DOS state related to this collision
            if (nodeDosState.getDosMessage() && nodeDosState.getDosMessage().includes('is confirmed and reachable on flux network')) {
              log.info('Clearing previous collision DOS state - this node has successfully taken over the collateral');
              nodeDosState.setDosStateValue(0);
              nodeDosState.setDosMessage(null);
            }
          } else {
            // Other node came back online during grace period
            log.warn(`Node at ${askingIP}:${askingIpPort} came back online during grace period. Collision still exists.`);
          }
        }
      }
      // If this node is not CONFIRMED, or our current IP isn't in the confirmed
      // list (e.g. IP recently changed), remote nodes will reject the availability
      // check via the confirmed-list gate in isFluxAvailable. Skip to avoid
      // spamming the network with requests that will always fail.
      const isConfirmed = nodeStatus?.status === 'CONFIRMED';
      const inConfirmedList = await fluxCommunicationUtils.socketAddressInFluxList(localSocketAddr);
      if (!isConfirmed || !inConfirmedList) {
        const reason = !isConfirmed
          ? `Node status is ${nodeStatus?.status}`
          : `Our IP ${localSocketAddr} is not in the confirmed flux list`;
        log.warn(`${reason}. Skipping remote availability check.`);
        setTimeout(() => {
          checkDeterministicNodesCollisions();
        }, 60 * 1000);
        return;
      }
      // early stages of the network or testnet
      if (nodeList.length > config.get('fluxapps.minIncoming') + config.get('fluxapps.minOutgoing')) {
        await checkMyFluxAvailability();
      } else { // sufficient amount of nodes has to appear on the network within 6 hours
        const measuredUptime = fluxNetworkHelper.fluxUptime();
        if (measuredUptime > (config.get('fluxapps.minUpTime') * 12)) {
          await checkMyFluxAvailability();
        }
      }
    } else {
      nodeDosState.addDosState(1);
      if (nodeDosState.getDosStateValue() > 10) {
        nodeDosState.setDosMessage(nodeDosState.getRawDosMessage() || 'Flux IP detection failed');
        log.error(nodeDosState.getRawDosMessage());
      } else {
        const measuredUptime = fluxNetworkHelper.fluxUptime();
        if (measuredUptime > config.get('fluxapps.minUpTime')) {
          const { value: benchIp, reason } = await benchmarkService.getPublicIp();
          if (!reason) {
            log.info(`FluxBench was previoulsy without ip and now reported public IP: ${benchIp}`);
          }
        }
      }
    }
    setTimeout(() => {
      checkDeterministicNodesCollisions();
    }, 60 * 1000);
  } catch (error) {
    log.error(error);
    setTimeout(() => {
      checkDeterministicNodesCollisions();
    }, 120 * 1000);
  }
}

/** Test seam: forgets every IP change seen, so a test starts with none on record. */
function resetForTests() {
  maxNumberOfIpChanges = 0;
  dosTooManyIpChanges = false;
  maxNumberOfIpChanges = 0;
}

module.exports = {
  resetForTests,
  setOnAddressChanged,
  ipChangesOverLimit,
  setDosTooManyIpChanges,
  getMaxNumberOfIpChanges,
  adjustExternalIp,
  handleOwnAddress,
  leaveConfiguredAddress,
  requestOwnMoveReconcile,
  setInstalledAppsListedAt,
  setOnOwnAddressMoved,
  startOwnAddressWatch,
  checkMyFluxAvailability,
  checkDeterministicNodesCollisions,
};
