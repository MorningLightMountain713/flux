'use strict';

const config = require('config');
const https = require('https');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const dockerService = require('../dockerService');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const syncthingService = require('../syncthingService');
const registryManager = require('../appDatabase/registryManager');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appQueryService = require('../appQuery/appQueryService');
const appReconciler = require('../appMonitoring/appReconciler');
const peerFolderLiveness = require('../appMonitoring/peerFolderLiveness');
const peerComponent = require('../appMonitoring/peerComponent');

const { PeerComponent } = peerComponent;
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const appCaches = require('../utils/appCaches');
const fluxEventBus = require('../utils/fluxEventBus');
const globalState = require('../utils/globalState');
const operationRegistry = require('../utils/operationRegistry');
const { compareInstanceSeniority } = require('../utils/instanceOrdering');
const { getSpecBackend } = require('../utils/specLibs');
const { extractIp, extractPort, ipsMatch } = require('../utils/socketAddressUtils');
const mastershipGrantGate = require('./mastershipGrantGate');
const primaryRole = require('./primaryRole');
const primaryRoleChanges = require('./primaryRoleChanges');
const appGiveUp = require('./appGiveUp');

// The activeStandby election: which holder of an app runs its activeStandby
// components. Who should run them comes from the grant plane when it is open for
// the app, otherwise from FDM; every start and stop of a role goes through
// primaryRole, and every question to another holder through peerComponent.
//
// An app's activeStandby components are elected together: its primary runs all
// of them on one node, and every other holder runs none. A component is named by
// its identifier, and its folder by `syncFolderId` - an app registered before v9
// keeps its 8.x folder name. A peer is asked about both names.

// The primary each anchor identifier was last read to have, and when each
// verdict - a primary, or none - was read.
const primaryByIdentifier = new Map();
const electionCheckedAt = new Map();
// How long an election record is worth reading: ten election cycles, so one missed
// pass does not turn every verdict into "cannot say".
const PRIMARY_ELECTION_STALE_MS = config.get('fluxapps.masterSlaveIntervalMs') * 10;
// When a staggered standby is booked to start.
const scheduledStart = new Map();
// Reporting latches: each exclusion is stated once on entry.
const operatorStoppedAnnounced = new Set();
const standDownAnnounced = new Set();
const noPrimaryAnnounced = new Set();

/**
 * The FDM index an app's name falls under (1-4).
 * @param {string} appName
 * @returns {number}
 */
function getFdmIndex(appName) {
  const firstLetter = appName.substring(0, 1).toLowerCase();
  if (firstLetter.match(/[h-n]/)) return 2;
  if (firstLetter.match(/[o-u]/)) return 3;
  if (firstLetter.match(/[v-z]/)) return 4;
  return 1;
}

/**
 * The primary FDM names for an app, asking each region in turn.
 * @param {string} appName
 * @param {object} axiosOptions
 * @returns {Promise<{ip: string|null, fdmOk: boolean}>} the IP FDM names (no
 *   port; compare with ipsMatch), and whether any region answered. A region that
 *   could not be reached, or was still starting, answered nothing.
 */
async function getMasterIpFromFdm(appName, axiosOptions) {
  const fdmIndex = getFdmIndex(appName);
  const fdmRegions = config.get('fdm.regions').map((region) => ({
    name: region.name,
    baseUrl: region.baseUrlTemplate.replace('%i', fdmIndex),
  }));
  let answered = false;
  for (const region of fdmRegions) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await serviceHelper.axiosGet(`${region.baseUrl}/appips/${appName}`, axiosOptions);
      if (response.data && response.data.status === 'success' && response.data.data) {
        answered = true;
        const { ips } = response.data.data;
        if (ips && ips.length > 0) {
          const ip = extractIp(ips[0]);
          log.debug(`getMasterIpFromFdm: Got IP ${ip} for app ${appName} from ${region.name} FDM`);
          return { ip, fdmOk: true };
        }
      }
      log.debug(`getMasterIpFromFdm: No IPs returned from ${region.name} FDM for app ${appName}`);
    } catch (error) {
      if (error.response && error.response.status === 404) {
        answered = true;
        log.debug(`getMasterIpFromFdm: App ${appName} not found in ${region.name} FDM`);
      } else if (error.response && error.response.status === 503) {
        log.debug(`getMasterIpFromFdm: ${region.name} FDM service starting up for app ${appName}`);
      } else {
        log.error(`getMasterIpFromFdm: Failed to reach ${region.name} FDM for app ${appName}: ${error.message}`);
      }
    }
  }
  return { ip: null, fdmOk: answered };
}

/**
 * Whether THIS node is the elected primary for an app. Three-state:
 *
 *   true   this node is the primary - it is the one writing
 *   false  another node provably is
 *   null   the election cannot say. NOT "there is no primary": a caller that
 *          treats it as false hands an app back from under a writer.
 *
 * Read from the election's own records of the app's activeStandby component
 * identifiers, and only while a record is recent enough to mean anything.
 *
 * @param {string[]} identifiers the app's activeStandby component identifiers
 * @param {string} localSocketAddr
 * @param {number} [now]
 * @param {{primaries: Map<string, string>, checkedAt: Map<string, number>}} [records]
 * @returns {boolean|null}
 */
function isElectedPrimaryHere(identifiers, localSocketAddr, now = Date.now(), records = {
  primaries: primaryByIdentifier, checkedAt: electionCheckedAt,
}) {
  let decided = false;
  for (const identifier of identifiers) {
    const checkedAt = records.checkedAt.get(identifier);
    if (checkedAt === undefined || now - checkedAt > PRIMARY_ELECTION_STALE_MS) continue;
    decided = true;
    const primary = records.primaries.get(identifier);
    if (primary && ipsMatch(primary, localSocketAddr)) return true;
  }
  return decided ? false : null;
}

/**
 * isElectedPrimaryHere at this node's address.
 * @param {string} _appName
 * @param {string[]} identifiers the app's activeStandby component identifiers
 * @returns {Promise<boolean|null>}
 */
async function isElectedPrimary(_appName, identifiers) {
  return isElectedPrimaryHere(identifiers, await fluxNetworkHelper.getLocalSocketAddress());
}

/**
 * How long a standby waits for each place it stands down the election order.
 * @param {number} places how far down the order, 0 for no wait
 * @returns {number} milliseconds
 */
function staggerMs(places) {
  return places * config.get('fluxapps.activeStandbyStaggerMs');
}

/**
 * An app's activeStandby components as the election decides them, in compose
 * order, each with its operator stop lock. `free` is a component the election
 * may run here: not locked, or locked and started by its operator.
 * Throws when a stop lock cannot be read.
 * @param {object} deployment installed DeploymentSpec
 * @returns {Promise<Array<{identifier: string, folderId: string, component: object, stop: object, free: boolean}>>}
 */
async function electedMembers(deployment) {
  const components = deployment.componentEntries()
    .map(([, component]) => component)
    .filter((component) => component.hasActiveStandbySyncthing());
  const stops = await Promise.all(components.map((component) => appsRuntimeState.operatorStopState(component.identifier)));
  return components.map((component, index) => ({
    identifier: component.identifier,
    folderId: component.syncFolderId,
    component,
    stop: stops[index],
    free: !stops[index].stopped || stops[index].startRequested,
  }));
}

/**
 * Every name a peer may hold an app's activeStandby components under: each
 * one's identifier and its folder id.
 * @param {object[]} members
 * @returns {string[]}
 */
function namesOf(members) {
  return [...new Set(members.flatMap((member) => [member.identifier, member.folderId]))];
}

/**
 * Whether this node holds a component: it runs here, a promotion to run it is
 * in progress, or the reconciler has been asked to run it.
 * @param {{identifier: string}} member
 * @param {string[]} runningIdentifiers
 * @returns {boolean}
 */
function holdsMemberHere(member, runningIdentifiers) {
  return runningIdentifiers.includes(member.identifier)
    || primaryRole.inTransition(member.identifier) === primaryRole.Role.PROMOTING
    || appReconciler.committedIdentifiers().includes(member.identifier);
}

/**
 * The components whose copy here is not yet one this node may run them on. A
 * copy is ready when the syncthing monitor has marked its folder synced on the
 * volume mounted now, or its folder already sends here - which covers a mark
 * lost with the process.
 * @param {string} appName
 * @param {object[]} members
 * @returns {Promise<string[]>} identifiers of the components not ready
 */
async function unreadyMembers(appName, members) {
  const marks = await Promise.all(members.map((member) => appCaches.syncedMark(globalState.receiveOnlySyncthingAppsCache, member.folderId)));
  const unmarked = members.filter((member, index) => marks[index]?.restarted !== true);
  if (!unmarked.length) return [];
  let folders = [];
  try {
    const configured = await syncthingService.getConfigFolders();
    if (Array.isArray(configured)) folders = configured;
  } catch (error) {
    log.error(`activeStandby: Failed to check syncthing folder status for ${appName}: ${error.message}`);
  }
  return unmarked
    .filter((member) => {
      const sending = folders.some((folder) => folder.id === member.folderId && folder.type === 'sendreceive');
      if (sending) log.info(`activeStandby: app:${appName} folder ${member.folderId} is already in sendreceive mode, treating as ready`);
      return !sending;
    })
    .map((member) => member.identifier);
}

/**
 * Begins making this node the primary of a component - see primaryRole.
 * @param {object} member
 * @returns {boolean} Whether a promotion began
 */
function startAsPrimary(member) {
  if (primaryRole.promote(member.identifier, member.folderId)) return true;
  fluxEventBus.count('masterSlave:decision', member.identifier, 'startInFlight');
  return false;
}

/**
 * Starts a component its operator has started, and lifts its stop lock, in one
 * hold of the reconciler's per-key slot - the slot the operator's own writes go
 * through, so a stop given since this pass read the lock withdraws the start.
 * The lock is lifted once this node holds the component by commitment, so it is
 * never held by nothing; a lock that could not be lifted stays, and the next
 * pass decides again.
 * @param {object} member
 * @returns {Promise<boolean>} Whether a promotion was begun.
 */
async function startOperatorStarted(member) {
  const { identifier } = member;
  let begun = false;
  let released = false;
  try {
    await appReconciler.applyIntent(identifier, async () => {
      if (!(await appsRuntimeState.operatorStopState(identifier)).startRequested) return;
      begun = startAsPrimary(member);
      const committed = appReconciler.committedIdentifiers().includes(identifier)
        || primaryRoleChanges.promotingIdentifiers().includes(identifier);
      if (committed) released = await appsRuntimeState.releaseOperatorStart(identifier);
    });
  } catch (error) {
    log.error(`activeStandby: the stop lock of ${identifier} could not be lifted (it starts here); the next pass decides again: ${error.message}`);
    return begun;
  }
  if (released) {
    log.info(`activeStandby: lifted the stop lock of ${identifier} - it starts here`);
    fluxEventBus.publish('masterSlave:operatorStartSettled', { identifier, outcome: 'it starts here' });
  }
  return begun;
}

/**
 * Lifts the stop lock of a component its operator has started, once the
 * election has decided another node runs it. Written through the reconciler's
 * per-key slot, so a stop given after the start was asked for is never lifted.
 * @param {string} identifier
 * @param {string} outcome What the election decided.
 * @returns {Promise<void>}
 */
async function settleOperatorStart(identifier, outcome) {
  let released = false;
  try {
    await appReconciler.applyIntent(identifier, async () => {
      released = await appsRuntimeState.releaseOperatorStart(identifier);
    });
  } catch (error) {
    log.error(`activeStandby: the stop lock of ${identifier} could not be lifted (${outcome}); the next pass decides again: ${error.message}`);
    return;
  }
  if (!released) return;
  log.info(`activeStandby: lifted the stop lock of ${identifier} - ${outcome}`);
  fluxEventBus.publish('masterSlave:operatorStartSettled', { identifier, outcome });
}

async function settleOperatorStarts(members, outcome) {
  for (const member of members) {
    // eslint-disable-next-line no-await-in-loop
    if (member.stop.startRequested) await settleOperatorStart(member.identifier, outcome);
  }
}

/**
 * Begins the start of each given component this node may run, in compose order:
 * an operator-started one through its stop lock, any other as primary.
 * @param {object[]} members
 * @param {string[]} runningIdentifiers
 * @returns {Promise<boolean>} Whether a start was begun for any of them.
 */
async function startMembers(members, runningIdentifiers) {
  let begun = false;
  for (const member of members) {
    if (!member.free || runningIdentifiers.includes(member.identifier)) continue;
    const started = member.stop.startRequested
      // eslint-disable-next-line no-await-in-loop
      ? await startOperatorStarted(member)
      : startAsPrimary(member);
    begun = started || begun;
  }
  return begun;
}

/**
 * Starts the components of an app that this node, as its primary, does not hold
 * yet. A node holding none of them is taking the app over, and starts once every
 * copy is ready; a node already holding some starts each missing one once its
 * own copy is ready. Either way it asks every other holder first, unless the
 * grant plane named it.
 * @param {string} appName
 * @param {object[]} members
 * @param {string[]} runningIdentifiers
 * @param {object} options
 * @param {() => Promise<string>} options.othersHold the PeerComponent state of
 *   the other holders
 * @param {boolean} [options.namedPrimary] FDM or the grant plane names this node.
 *   A holder this node cannot rule out then does not stop the start.
 * @returns {Promise<boolean>} Whether a start was begun.
 */
async function startMissingMembers(appName, members, runningIdentifiers, { othersHold, namedPrimary = false }) {
  const { identifier } = members[0];
  const missing = members.filter((member) => member.free && !holdsMemberHere(member, runningIdentifiers));
  if (!missing.length) return false;
  const holdsHere = members.some((member) => holdsMemberHere(member, runningIdentifiers));
  const unready = await unreadyMembers(appName, missing);
  const toStart = holdsHere ? missing.filter((member) => !unready.includes(member.identifier)) : [];
  if (!holdsHere && !unready.length) toStart.push(...missing);
  if (unready.length) {
    fluxEventBus.count('masterSlave:decision', identifier, 'notReady');
    log.info(`activeStandby: app:${appName} is ${namedPrimary ? 'named this node\'s' : 'held here'} but not ready yet (syncthing not synced${members.length > 1 ? ` for ${unready.join(', ')}` : ''}), skipping start for this cycle`);
  }
  if (!toStart.length) return false;
  const others = await othersHold();
  if (others === PeerComponent.RUNNING || (!namedPrimary && others === PeerComponent.UNKNOWN)) {
    fluxEventBus.count('masterSlave:decision', identifier, 'namedButHeldElsewhere');
    log.info(`activeStandby: not starting app:${appName} - a peer ${others === PeerComponent.RUNNING ? 'holds it' : 'could not be ruled out'}`);
    return false;
  }
  const begun = await startMembers(toStart, runningIdentifiers);
  if (begun) log.info(`activeStandby: starting docker component:${toStart.map((member) => member.identifier).join(', ')}`);
  return begun;
}

/**
 * The decision for an app no primary is named for, on a node that does not run
 * it: who starts, in the election order, once no other holder runs it.
 * @returns {Promise<void>}
 */
async function decideUnnamed({
  appName, members, identifier, runningIdentifiers, localSocketAddr, liveness, resumingMembers,
}) {
  const resuming = resumingMembers.length > 0;
  const unready = await unreadyMembers(appName, members.filter((member) => member.free));
  if (unready.length) {
    fluxEventBus.count('masterSlave:decision', identifier, 'notReady');
    log.info(`activeStandby: app:${appName} is not ready yet (syncthing not synced${members.length > 1 ? ` for ${unready.join(', ')}` : ''}), skipping primary selection for this cycle`);
    return;
  }
  const runningAppList = await registryManager.appLocation(appName);
  runningAppList.sort(compareInstanceSeniority);
  const index = runningAppList.findIndex((x) => ipsMatch(x.ip, localSocketAddr));

  // The remembered primary is this node, but it does not run the app: the memory
  // is stale, and keeping it would leave the last primary unelectable.
  if (primaryByIdentifier.has(identifier) && ipsMatch(primaryByIdentifier.get(identifier), localSocketAddr)) {
    primaryByIdentifier.delete(identifier);
    log.info(`activeStandby: cleared this node's stale primary record for ${identifier} - it is not running here`);
    fluxEventBus.publish('activeStandby:decided', { identifier, action: 'stalePrimaryEvicted' });
  }

  const probeCtx = {
    appIds: namesOf(members), identifier, appName, liveness, logPrefix: 'activeStandby',
  };
  // Every other holder is asked, whatever this node's place in the order: the
  // order decides who goes first, not who can have started. A peer that does not
  // answer is UNKNOWN, not free.
  const checkPeersRunning = async () => {
    const peers = runningAppList
      .map((location, i) => ({ ip: location.ip, label: `index ${i}` }))
      .filter((peer, i) => i !== index);
    const state = await peerComponent.componentStateOnPeers(peers, probeCtx);
    if (state === PeerComponent.RUNNING && resuming) await settleOperatorStarts(members, 'a peer holds it');
    return state;
  };
  const start = () => startMembers(members, runningIdentifiers);
  const peerWords = (state) => (state === PeerComponent.RUNNING ? 'is already running it' : 'could not be ruled out');

  if (resumingMembers.some((member) => member.stop.asPrimary)) {
    // Its operator started an app this node was the primary of when it was
    // stopped: the start returns it here, whatever this node's place in the order.
    const peerState = await checkPeersRunning();
    if (peerState !== PeerComponent.NOT_RUNNING) {
      log.info(`activeStandby: not resuming app:${appName} as its primary - a peer ${peerWords(peerState)}`);
    } else if (await start()) {
      fluxEventBus.count('masterSlave:decision', identifier, 'primaryResumed');
      log.info(`activeStandby: resuming docker component:${identifier} as its primary, index: ${index}`);
    }
    scheduledStart.delete(identifier);
    return;
  }
  if (index === 0 && !primaryByIdentifier.has(identifier)) {
    const peerState = await checkPeersRunning();
    if (peerState !== PeerComponent.NOT_RUNNING) {
      log.info(`activeStandby: not starting app:${appName} index: ${index} - a peer ${peerWords(peerState)}`);
      fluxEventBus.publish('activeStandby:decided', { identifier, action: 'peerProbeBlocked', index });
    } else if (await start()) {
      log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
      fluxEventBus.publish('activeStandby:decided', { identifier, action: 'primaryPromoted', index });
    }
    return;
  }
  if (!scheduledStart.has(identifier) && primaryByIdentifier.has(identifier)) {
    // A previous primary - not this node - that FDM no longer names. FDM dropping
    // a primary is not evidence that it stopped, so it is asked as any other
    // holder is, and one that cannot be read keeps the app.
    const previousPrimary = primaryByIdentifier.get(identifier);
    const previousNode = runningAppList.find((x) => ipsMatch(x.ip, previousPrimary));
    const askedAt = previousNode ? previousNode.ip : previousPrimary;
    const previousState = await peerComponent.peerComponentState(`${extractIp(askedAt)}:${extractPort(askedAt)}`, { ...probeCtx, label: 'previous primary' });
    if (previousState !== PeerComponent.NOT_RUNNING) {
      if (resuming && previousState === PeerComponent.RUNNING) await settleOperatorStarts(members, 'the previous primary runs it');
      return;
    }
    if (index === 0) {
      const peerState = await checkPeersRunning();
      if (peerState !== PeerComponent.NOT_RUNNING) {
        log.info(`activeStandby: not starting app:${appName} index: ${index} - a peer ${peerWords(peerState)}`);
      } else if (await start()) {
        log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
      }
      return;
    }
    if (index < 0) {
      log.info(`activeStandby: not starting app:${appName} - this node holds no location for it yet`);
      return;
    }
    const previousIndex = runningAppList.findIndex((x) => ipsMatch(x.ip, previousPrimary));
    const places = previousIndex >= 0 && index > previousIndex ? index - 1 : index;
    const startAt = Date.now() + staggerMs(places);
    if (startAt <= Date.now()) {
      const peerState = await checkPeersRunning();
      if (peerState === PeerComponent.NOT_RUNNING) {
        if (await start()) {
          fluxEventBus.count('masterSlave:decision', identifier, 'staggeredStart');
          log.info(`activeStandby: starting docker component:${identifier} index: ${index}`);
        }
      } else {
        log.info(`activeStandby: not starting app:${appName} index: ${index} - a peer ${peerWords(peerState)}`);
      }
    } else {
      fluxEventBus.count('masterSlave:decision', identifier, 'staggerBooked');
      log.info(`activeStandby: will start docker app:${appName} at ${startAt.toString()}`);
      scheduledStart.set(identifier, startAt);
    }
    return;
  }
  if (scheduledStart.has(identifier) && scheduledStart.get(identifier) <= Date.now()) {
    const peerState = await checkPeersRunning();
    if (peerState === PeerComponent.NOT_RUNNING) {
      if (await start()) {
        fluxEventBus.count('masterSlave:decision', identifier, 'staggeredStart');
        log.info(`activeStandby: starting docker component:${identifier} index: ${index} that was scheduled to start at ${scheduledStart.get(identifier).toString()}`);
      }
      scheduledStart.delete(identifier);
    } else if (peerState === PeerComponent.RUNNING) {
      log.info(`activeStandby: not starting app:${appName} index: ${index} - a peer is already running it`);
      scheduledStart.delete(identifier);
    } else {
      // Kept: its due time has passed, so the next pass starts the moment the
      // peer can be ruled out.
      log.info(`activeStandby: holding the scheduled start of app:${appName} index: ${index} - a peer could not be ruled out`);
    }
    return;
  }
  if (index > 0 && !primaryByIdentifier.has(identifier) && !scheduledStart.has(identifier)) {
    // No history: the turn is counted from the pass that finds no holder running it.
    const peerState = await checkPeersRunning();
    if (peerState === PeerComponent.NOT_RUNNING) {
      const startAt = Date.now() + staggerMs(index);
      fluxEventBus.count('masterSlave:decision', identifier, 'staggerBooked');
      log.info(`activeStandby: scheduling app:${appName} index: ${index} to start at ${startAt.toString()}`);
      scheduledStart.set(identifier, startAt);
    } else {
      log.info(`activeStandby: not scheduling app:${appName} index: ${index} - a peer ${peerState === PeerComponent.RUNNING ? 'is running it' : 'could not be ruled out'}`);
    }
    return;
  }
  log.info(`activeStandby: not starting app:${appName} index: ${index} - conditions not met for primary selection`);
}

/**
 * The decision for an app a primary is named for. With the grant plane open the
 * grant is final: a node it does not name stands down, and the node it names
 * starts, asking nobody. Otherwise the named primary is FDM's, and a holder asks
 * the others before it starts or stands down.
 * @returns {Promise<void>}
 */
async function decideNamed({
  appName, members, identifier, runningIdentifiers, localSocketAddr, liveness, resuming, ip, granted,
}) {
  fluxEventBus.count('masterSlave:decision', identifier, 'primaryObserved');
  noPrimaryAnnounced.delete(identifier);
  primaryByIdentifier.set(identifier, ip);
  if (scheduledStart.has(identifier)) {
    log.info(`activeStandby: app:${appName} removed from the scheduled starts, already started on another standby node`);
    scheduledStart.delete(identifier);
  }
  const probeCtx = {
    appIds: namesOf(members), identifier, appName, liveness, logPrefix: 'activeStandby',
  };
  const othersHold = granted
    ? async () => PeerComponent.NOT_RUNNING
    : () => peerComponent.componentStateOnOtherHolders((name) => registryManager.appLocation(name), localSocketAddr, probeCtx, { also: [ip] });

  if (!ipsMatch(localSocketAddr, ip)) {
    if (resuming) await settleOperatorStarts(members, `${granted ? 'the grant' : 'FDM'} names ${ip} its primary`);
    const holdsHere = members.some((member) => holdsMemberHere(member, runningIdentifiers));
    // FDM also names a node that only holds the app, while nothing runs it
    // anywhere: one that has not decided gives way to one that has.
    if (!granted && holdsHere && await peerComponent.peerUndecided(`${extractIp(ip)}:${extractPort(ip)}`, { ...probeCtx, label: 'FDM primary' })) {
      log.info(`activeStandby: keeping app:${appName} - FDM names ip:${ip}, which has not decided it holds it`);
      return;
    }
    // Only the activeStandby components stand down; their siblings keep running,
    // and one held down by its operator stays as its lock keeps it.
    const standbyHolders = granted ? async () => PeerComponent.RUNNING : othersHold;
    for (const member of members.filter((each) => each.free)) {
      if (primaryRole.standDown(member.identifier, member.folderId, { running: runningIdentifiers.includes(member.identifier) })) {
        log.info(`activeStandby: standing down as primary of component:${member.identifier} - ip:${ip} is named, localSocketAddr is: ${localSocketAddr}`);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await primaryRole.holdAsStandby(member.identifier, member.folderId, { othersHold: standbyHolders });
      }
    }
    return;
  }
  for (const member of members.filter((each) => runningIdentifiers.includes(each.identifier))) {
    // eslint-disable-next-line no-await-in-loop
    await primaryRole.holdAsPrimary(member.identifier, member.folderId);
  }
  await startMissingMembers(appName, members, runningIdentifiers, { othersHold, namedPrimary: true });
}

/**
 * Drops the records of identifiers no installed app holds any more.
 * @param {Set<string>} validIdentifiers
 */
function forgetRemoved(validIdentifiers) {
  for (const records of [primaryByIdentifier, electionCheckedAt, scheduledStart]) {
    for (const identifier of records.keys()) {
      if (!validIdentifiers.has(identifier)) records.delete(identifier);
    }
  }
  for (const latch of [operatorStoppedAnnounced, standDownAnnounced, noPrimaryAnnounced]) {
    for (const identifier of latch) {
      if (!validIdentifiers.has(identifier)) latch.delete(identifier);
    }
  }
}

/**
 * Decides one installed app.
 * @returns {Promise<void>}
 */
async function decideApp(deployment, {
  runningIdentifiers, liveness, axiosOptions,
}) {
  const { appName } = deployment;
  if (operationRegistry.isHeld(appName)) {
    log.info(`activeStandby: operation in progress for ${appName}, skipping`);
    fluxEventBus.count('masterSlave:decision', appName, 'skippedBusy');
    return;
  }
  // An app this node is removing, or has not yet confirmed it still holds, is
  // neither promoted nor stood down.
  if (globalState.departingApps.has(appName)) {
    fluxEventBus.count('masterSlave:decision', appName, 'skippedDeparting');
    return;
  }
  if (globalState.unconfirmedApps.has(appName)) {
    fluxEventBus.count('masterSlave:decision', appName, 'skippedUnconfirmed');
    return;
  }
  let members;
  try {
    members = await electedMembers(deployment);
  } catch (error) {
    // An unread stop lock is not a lifted one: not a candidate this pass.
    log.warn(`activeStandby: ${appName}: a stop lock could not be read - excluded from primary election this pass: ${error.message}`);
    return;
  }
  if (!members.length) return;
  const anchor = members[0];
  const { identifier } = anchor;
  fluxEventBus.count('masterSlave:decision', identifier, 'evaluated');

  // A component the give-up pass has stood down is not a candidate: this node
  // stopped it to hand the app back.
  const handedBack = members.find((member) => appGiveUp.isStandingDown(member.identifier));
  if (handedBack) {
    fluxEventBus.count('masterSlave:decision', handedBack.identifier, 'standingDown');
    if (!standDownAnnounced.has(identifier)) {
      standDownAnnounced.add(identifier);
      log.info(`activeStandby: ${handedBack.identifier} is standing down to be handed back - excluded from primary election`);
      fluxEventBus.publish('activeStandby:decided', { identifier: handedBack.identifier, action: 'standDownExcluded' });
    }
    return;
  }
  if (standDownAnnounced.delete(identifier)) {
    fluxEventBus.publish('activeStandby:decided', { identifier, action: 'standDownCleared' });
  }
  // Every component locked by its operator: not elected or acted on until one is started.
  if (!members.some((member) => member.free)) {
    fluxEventBus.count('masterSlave:decision', identifier, 'operatorStopped');
    if (!operatorStoppedAnnounced.has(identifier)) {
      operatorStoppedAnnounced.add(identifier);
      log.info(`activeStandby: ${members.map((member) => member.identifier).join(', ')} is operator-stopped - excluded from primary election until it is started`);
      fluxEventBus.publish('activeStandby:decided', { identifier, action: 'operatorStopExcluded' });
    }
    return;
  }
  if (operatorStoppedAnnounced.delete(identifier)) {
    fluxEventBus.publish('activeStandby:decided', { identifier, action: 'operatorStopCleared' });
  }
  const resumingMembers = members.filter((member) => member.stop.startRequested);
  if (resumingMembers.length) {
    fluxEventBus.count('masterSlave:decision', identifier, 'operatorStartPending');
    log.info(`activeStandby: ${resumingMembers.map((member) => member.identifier).join(', ')} was started by its operator - deciding it with the stop lock held`);
  }
  await fluxEventBus.checkpoint(fluxEventBus.Checkpoint.MASTERSLAVE_BEFORE_DECISION, identifier);

  // The grant plane, when open for this app, IS the intent source. No record yet
  // means no primary exists - becoming one goes through grant acquisition, which
  // the gate is pursuing, never through the no-primary election below.
  const grantIntent = await mastershipGrantGate.masterIntent(identifier, anchor.component);
  if (grantIntent && !grantIntent.ip) {
    if (!noPrimaryAnnounced.has(identifier)) {
      noPrimaryAnnounced.add(identifier);
      log.info(`activeStandby: app:${appName} has no granted primary yet, awaiting acquisition`);
    }
    return;
  }
  const { ip, fdmOk } = grantIntent ?? await getMasterIpFromFdm(appName, axiosOptions);
  if (!fdmOk) {
    log.warn(`activeStandby: All FDM services failed for app:${appName}, skipping primary selection for this cycle`);
    fluxEventBus.count('masterSlave:decision', appName, 'fdmUnreachable');
    return;
  }
  let localSocketAddr;
  try {
    localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  } catch (error) {
    log.error(`activeStandby: Failed to get my IP for app:${appName}, error: ${error.message}`);
    return;
  }
  if (!localSocketAddr) return;
  if (ip && typeof ip !== 'string') {
    log.error(`activeStandby: Invalid IP type for app:${appName}, got: ${typeof ip}`);
    return;
  }
  // A verdict - a primary or none - is what isElectedPrimaryHere reads.
  electionCheckedAt.set(identifier, Date.now());
  const ctx = {
    appName, members, identifier, runningIdentifiers, localSocketAddr, liveness,
  };
  if (ip) {
    await decideNamed({
      ...ctx, resuming: resumingMembers.length > 0, ip, granted: Boolean(grantIntent),
    });
    return;
  }
  if (!noPrimaryAnnounced.has(identifier)) {
    noPrimaryAnnounced.add(identifier);
    log.info(`activeStandby: app:${appName} has currently no primary set`);
  }
  const runsHere = members.some((member) => runningIdentifiers.includes(member.identifier));
  if (!runsHere) {
    await decideUnnamed({ ...ctx, resumingMembers });
    return;
  }
  // Runs here with no primary named: this node holds the app, and the election
  // leaves it running and starts what it does not yet run.
  for (const member of members) {
    if (runningIdentifiers.includes(member.identifier) && !appReconciler.hasControllerOpinion(member.identifier)) {
      // eslint-disable-next-line no-await-in-loop
      if (await appReconciler.adoptControllerDesired(member.identifier, 'running', 'masterSlave holder, no primary named')) {
        fluxEventBus.count('masterSlave:decision', member.identifier, 'adopted');
      }
    }
  }
  await startMissingMembers(appName, members, runningIdentifiers, {
    othersHold: () => peerComponent.componentStateOnOtherHolders((name) => registryManager.appLocation(name), localSocketAddr, {
      appIds: namesOf(members), identifier, appName, liveness, logPrefix: 'activeStandby',
    }),
  });
}

/**
 * One pass of the activeStandby election over every installed app.
 * @returns {Promise<void>}
 */
async function electionPass() {
  let coordinateToken = null;
  try {
    // The node-wide destructive sweeps and the installer's docker prune stand down
    // while this pass may be starting and stopping containers.
    coordinateToken = operationRegistry.acquire(operationRegistry.ACTIVE_STANDBY_COORDINATOR_KEY, 'coordinate', 'activeStandbyElection', 'activeStandby election cycle');
    // Backup and restore are skipped per app, below.
    if (operationRegistry.anyHeldOfType('install', 'remove', 'redeploy', 'rebuild', 'reconcile')) return;
    if (globalState.shutdownInProgress) return;
    // The syncthing monitor's first run performs the startup mount-safety check;
    // electing earlier could start a primary on an unmounted folder.
    if (globalState.syncthingAppsFirstRun) {
      log.info('activeStandby: syncthing first-run mount-safety not complete yet, skipping this cycle');
      return;
    }
    try {
      const syncthingHealth = await syncthingService.getHealth();
      if (syncthingHealth?.status !== 'OK') {
        log.warn('activeStandby: Syncthing is not available or not healthy, skipping this cycle');
        return;
      }
    } catch (syncthingError) {
      log.warn(`activeStandby: Failed to check syncthing health: ${syncthingError.message}, skipping this cycle`);
      return;
    }

    const deployments = await deploymentProvider.listInstalledDeployments();
    const runningContainers = await appQueryService.listRunningContainers();
    const { LABEL_KEYS, readLabel } = await getSpecBackend();
    const runningIdentifiers = runningContainers.map((container) => dockerService.containerIdentifier(
      { labels: container.Labels, name: container.Names?.[0] }, { LABEL_KEYS, readLabel },
    ));
    // One peer view for this pass, never carried into the next.
    const liveness = peerFolderLiveness.createPeerFolderLiveness();
    const axiosOptions = { timeout: 10_000, httpsAgent: new https.Agent({ rejectUnauthorized: false }) };

    forgetRemoved(new Set(deployments.flatMap((deployment) => deployment.componentEntries()
      .map(([, component]) => component)
      .filter((component) => component.hasActiveStandbySyncthing())
      .map((component) => component.identifier))));

    for (const deployment of deployments) {
      // eslint-disable-next-line no-await-in-loop
      await decideApp(deployment, { runningIdentifiers, liveness, axiosOptions });
    }
  } catch (error) {
    log.error(`activeStandby: ${error}`);
  } finally {
    operationRegistry.release(operationRegistry.ACTIVE_STANDBY_COORDINATOR_KEY, coordinateToken);
  }
}

/** Forgets every election record; for tests. */
function resetForTests() {
  forgetRemoved(new Set());
}

module.exports = {
  electionPass,
  getMasterIpFromFdm,
  isElectedPrimary,
  isElectedPrimaryHere,
  resetForTests,
};
