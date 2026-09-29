'use strict';

const fs = require('node:fs');

const axios = require('axios').default;

const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const serviceManager = require('./serviceManager');
const upnpService = require('./upnpService');
const capabilities = require('./utils/capabilities');
const globalState = require('./utils/globalState');
const fluxEventBus = require('./utils/fluxEventBus');
const nodeDosState = require('./nodeDosState');
const requestHistoryStore = require('./utils/requestHistory');
const dockerService = require('./dockerService');
const syncthingService = require('./syncthingService');
const syncthingFolderWrites = require('./appMonitoring/syncthingFolderWrites');
const { PM2_KILL_TIMEOUT_MS } = require('./fluxService');
const { startFlushTimer } = require('./analyticsService');
const { AppSyncOrchestrator } = require('./appMessaging/appSyncOrchestrator');
const { peerManager } = require('./utils/FluxPeerManager');
const { CLOSE_CODES } = require('./utils/FluxPeerSocket');
const verifyPool = require('./utils/verifyPool');

/**
 * The node process once its API is listening: what apiServer starts after the
 * servers are up, with the services loaded.
 */

// How long the stop waits for its close frames to leave before exiting.
const STOP_FLUSH_MS = 2000;

// How long a stop may take, from the signal to the exit. pm2 kills FluxOS
// PM2_KILL_TIMEOUT_MS after it signals, and Arcane's systemd 90 s after;
// SHUTDOWN_EXIT_MS of pm2's timeout is left for what follows the drain.
const SHUTDOWN_EXIT_MS = 5000;
const SHUTDOWN_BUDGET_MS = PM2_KILL_TIMEOUT_MS - SHUTDOWN_EXIT_MS;
// How much of SHUTDOWN_EXIT_MS pausing the folders may take.
const SHUTDOWN_PAUSE_MS = 3000;

let requestHistory = null;
let axiosDefaultsSet = false;

function setAxiosDefaults(socketIoServers) {
  if (axiosDefaultsSet) return;

  axiosDefaultsSet = true;

  log.info('setting axios defaults');
  axios.defaults.timeout = 20_000;

  if (!globalThis.userconfig.initial.debug) return;

  log.info('User defined debug set, setting up socket.io for debug.');
  requestHistory = new requestHistoryStore.RequestHistory({ maxAge: 60_000 * 60 });

  const rooms = [];
  const requestRoom = 'outboundHttp';

  socketIoServers.forEach((server) => {
    const debugRoom = server.getRoom(requestRoom, { namespace: 'debug' });
    rooms.push(debugRoom);

    const debugAdapter = server.getAdapter('debug');
    debugAdapter.on('join-room', (room, id) => {
      if (room !== requestRoom) return;

      const socket = server.getSocketById('debug', id);
      socket.emit('addHistory', requestHistory.allHistory);
    });
  });

  requestHistory.on('requestAdded', (request) => {
    rooms.forEach((room) => room.emit('addRequest', request));
  });

  requestHistory.on('requestRemoved', (request) => {
    rooms.forEach((room) => room.emit('removeRequest', request));
  });

  axios.interceptors.request.use(
    (conf) => {
      const {
        baseURL, url, method, timeout,
      } = conf;

      const fullUrl = baseURL ? `${baseURL}${url}` : url;

      const requestData = {
        url: fullUrl, verb: method.toUpperCase(), timeout, timestamp: Date.now(),
      };
      requestHistory.storeRequest(requestData);

      return conf;
    },
    (error) => Promise.reject(error),
  );
}

/**
 * Map this node's ports via UPnP when it is configured to.
 *
 * Probes only when the operator asked for UPnP, so a node behind a UPnP-capable
 * router is not opportunistically switched into a mode it never requested.
 *
 * Failure marks the node DOS rather than exiting. Exiting looked decisive but is
 * a permanent crash loop under `Restart=on-failure`/`RestartSec=30` — with the API
 * down throughout, so the operator has nothing to diagnose from. DOS has the same
 * practical effect (the node takes no app assignments) and stays inspectable, and
 * the refresh interval clears it once the mapping succeeds.
 */
async function loadUpnpIfRequired(apiPort) {
  try {
    if (!upnpService.isUPNP()) return;
    const mapped = capabilities.claim('upnpMapped', 'upnpService');
    mapped.starting(`mapping port ${apiPort} on the router`);

    const verifyUpnp = await upnpService.verifyUPNPsupport(apiPort);
    const setupUpnp = verifyUpnp ? await upnpService.setupUPNP(apiPort) : false;

    if (verifyUpnp !== true) {
      const message = `UPnP is enabled for this node but the router did not answer on port ${apiPort}`;
      log.error(message);
      mapped.lower(message);
      nodeDosState.addDosState(11);
      nodeDosState.setDosMessage(message);
      return;
    }
    if (setupUpnp !== true) {
      const message = `UPnP is enabled for this node but mapping port ${apiPort} failed`;
      log.error(message);
      mapped.lower(message);
      nodeDosState.addDosState(11);
      nodeDosState.setDosMessage(message);
      return;
    }
    nodeDosState.setDosMessage(null);
    mapped.raise(`port ${apiPort} mapped on the router`);
  } catch (error) {
    log.error(error);
  }
}

/**
 * Check if the system is shutting down or rebooting.
 * Uses multiple detection methods for reliability.
 * @returns {Promise<boolean>} True if system appears to be shutting down/rebooting
 */
async function isSystemShuttingDown() {
  // Method 1: Check for systemd scheduled shutdown file (most reliable for scheduled shutdowns)
  try {
    if (fs.existsSync('/run/systemd/shutdown/scheduled')) {
      log.info('System shutdown detected via /run/systemd/shutdown/scheduled');
      return true;
    }
  } catch (e) {
    // Ignore errors
  }

  // Method 2: Check systemd's current state
  const { stdout: systemState } = await serviceHelper.runCommand('systemctl', {
    params: ['is-system-running'],
    timeout: 5000,
    logError: false,
  });
  if (systemState && systemState.trim() === 'stopping') {
    log.info('System shutdown detected via systemctl is-system-running (stopping)');
    return true;
  }

  // Method 3: Check for active shutdown/reboot jobs in systemd
  const { stdout: jobs } = await serviceHelper.runCommand('systemctl', {
    params: ['list-jobs', '--no-pager'],
    timeout: 5000,
    logError: false,
  });
  if (jobs && (jobs.includes('shutdown.target') || jobs.includes('reboot.target') || jobs.includes('poweroff.target') || jobs.includes('halt.target'))) {
    log.info('System shutdown detected via systemctl list-jobs');
    return true;
  }

  // Method 4: Check for running shutdown/reboot processes
  const { stdout: shutdownPid } = await serviceHelper.runCommand('pgrep', {
    params: ['-x', 'shutdown'],
    timeout: 5000,
    logError: false,
  });
  if (shutdownPid && shutdownPid.trim()) {
    log.info('System shutdown detected via running shutdown process');
    return true;
  }

  // Method 5: Check runlevel (0 = halt, 6 = reboot)
  const { stdout: runlevel } = await serviceHelper.runCommand('runlevel', {
    timeout: 5000,
    logError: false,
  });
  if (runlevel) {
    const trimmedRunlevel = runlevel.trim();
    if (trimmedRunlevel.endsWith(' 0') || trimmedRunlevel.endsWith(' 6')) {
      log.info(`System shutdown detected via runlevel: ${trimmedRunlevel}`);
      return true;
    }
  }

  // Method 6: Check for /run/nologin (created during shutdown, but NOT /etc/nologin which can be manual)
  try {
    if (fs.existsSync('/run/nologin')) {
      log.info('System shutdown detected via /run/nologin file');
      return true;
    }
  } catch (e) {
    // Ignore errors
  }

  return false;
}

/**
 * Stops every running Flux app container, each with a 9 s grace before a kill.
 * @returns {Promise<void>}
 */
async function stopFluxAppContainers() {
  try {
    let containers = await dockerService.dockerListContainers(false);
    containers = containers || [];
    containers = containers.filter((c) => c.Names[0].slice(1, 4) === 'zel' || c.Names[0].slice(1, 5) === 'flux');

    if (containers.length > 0) {
      log.info(`Gracefully stopping ${containers.length} Flux app containers...`);
      // Fire all stop requests in parallel. Each sends SIGTERM and falls back
      // to force-kill after 9 seconds. Promise.allSettled waits for every
      // container to finish, so total shutdown time is ~9s (not N * 9s).
      const stopPromises = containers.map((container) => {
        const containerName = container.Names[0].slice(1);
        return dockerService.appDockerStop(containerName, 9)
          .then(() => {
            log.info(`Container ${containerName} stopped`);
          })
          .catch(async (stopErr) => {
            log.warn(`Graceful stop failed for ${containerName}: ${stopErr.message}, force killing...`);
            try {
              await dockerService.appDockerKill(containerName);
              log.info(`Container ${containerName} force killed`);
            } catch (killErr) {
              log.warn(`Failed to kill container ${containerName}: ${killErr.message}`);
            }
          });
      });
      await Promise.allSettled(stopPromises);
      log.info(`Shutdown stop completed for ${containers.length} Flux app containers`);
    } else {
      log.info('No running Flux app containers to stop');
    }
  } catch (error) {
    log.error(`Error stopping containers during shutdown: ${error.message}`);
  }
}

/**
 * Pauses every syncthing folder, within SHUTDOWN_PAUSE_MS. Publishes
 * shutdown:paused with the folders paused, those that failed, and whether the
 * time ran out first.
 * @returns {Promise<void>}
 */
async function pauseFoldersForShutdown() {
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SHUTDOWN_PAUSE_MS); });
  try {
    const result = await Promise.race([syncthingFolderWrites.pauseAllFolders(), timedOut]);
    if (!result) {
      log.warn(`Shutdown: pausing the syncthing folders did not finish within ${SHUTDOWN_PAUSE_MS}ms`);
      fluxEventBus.publish('shutdown:paused', { paused: [], failed: [], timedOut: true });
      return;
    }
    if (result.failed.length) log.warn(`Shutdown: ${result.failed.length} syncthing folder(s) could not be paused: ${result.failed.join(', ')}`);
    log.info(`Shutdown: paused ${result.paused.length} syncthing folder(s)`);
    fluxEventBus.publish('shutdown:paused', { ...result, timedOut: false });
  } catch (error) {
    log.warn(`Shutdown: the syncthing folders could not be paused: ${error.message}`);
    fluxEventBus.publish('shutdown:paused', { paused: [], failed: [], timedOut: false });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stops FluxOS. Whether the machine is going down or only this process, the
 * connections this node holds are closed with the reason, so the jurors
 * holding them read the drop as announced and wait the grace for it before
 * they look. Nothing is broadcast: only those jurors need to know, and if this
 * node is not back in time their certificate tells the fleet. A restart of the
 * service alone exits once the connections are closed, leaving the containers
 * running.
 *
 * On a system shutdown or reboot the app containers stop first: on Arcane the
 * shutdown daemon stops them, draining each by the plan FluxOS handed it, so
 * FluxOS stopping them as well would cut those drains short; elsewhere FluxOS
 * stops them. Then every sendreceive folder is drained to the connected peers
 * and every folder paused before exiting, so the next start sends nothing until
 * each folder's role is decided.
 * @returns {Promise<void>}
 */
async function shutDown() {
  const deadline = performance.now() + SHUTDOWN_BUDGET_MS;
  log.info('SIGTERM received, checking if system is shutting down...');

  // Small delay to allow systemd to update its state before we check
  await serviceHelper.delay(100);

  const systemShuttingDown = await isSystemShuttingDown();
  const code = systemShuttingDown ? CLOSE_CODES.SHUTTING_DOWN : CLOSE_CODES.RESTARTING;

  await AppSyncOrchestrator.writeShutdownReason(systemShuttingDown ? 'sigterm' : 'restart');

  try {
    const closed = await peerManager.closeAllForStop(code, { flushMs: STOP_FLUSH_MS });
    log.info(`Closed ${closed} held connections with ${systemShuttingDown ? 'SHUTTING_DOWN' : 'RESTARTING'}`);
  } catch (error) {
    log.error(`Error announcing the stop on held connections: ${error.message}`);
  }

  if (!systemShuttingDown) {
    log.info('System is not shutting down (service restart detected), exiting');
    verifyPool.stop();
    process.exit(0);
    return;
  }

  log.info('System shutdown/reboot detected, initiating graceful shutdown...');
  fluxEventBus.publish('shutdown:started', {});
  globalState.setShutdownInProgressTrue();

  if (globalState.isArcane()) {
    log.info('Arcane: the shutdown daemon stops the apps');
  } else {
    // A start already under way when the flag was set can land after the first
    // list is taken; the second pass stops it.
    await stopFluxAppContainers();
    await stopFluxAppContainers();
  }

  // The peers can only take over from what they hold, and syncthing is stopped
  // right after this process exits. The drain has what is left of the budget.
  try {
    const incomplete = await syncthingService.drainFoldersToPeers(Math.max(0, deadline - performance.now()));
    fluxEventBus.publish('shutdown:drained', { complete: incomplete.length === 0, incomplete });
    if (incomplete.length) {
      log.warn(`Shutdown drain reached its deadline with ${incomplete.length} folder(s) not yet complete on a peer: ${incomplete.join(', ')}`);
    } else {
      log.info('Shutdown drain complete: every sendreceive folder is complete on its connected peers');
    }
  } catch (error) {
    log.warn(`Shutdown drain failed: ${error.message}`);
  }

  // syncthing keeps a folder's pause across its own restart, so the next start
  // sends nothing until the election has decided who holds each folder.
  await pauseFoldersForShutdown();

  verifyPool.stop();
  log.info('Graceful shutdown complete, exiting...');
  process.exit(0);
}

let shutdownInFlight = null;

/**
 * The SIGTERM and SIGINT handler. One stop can arrive several times: pm2
 * signals every process in its tree at once, and the processes between pm2 and
 * this one pass the signal on again. A signal that arrives while a shutdown is
 * under way joins it.
 * @returns {Promise<void>}
 */
function handleSigterm() {
  if (!shutdownInFlight) {
    shutdownInFlight = shutDown().finally(() => { shutdownInFlight = null; });
  }
  return shutdownInFlight;
}

/**
 * Everything the process runs once its API is listening: the outbound HTTP
 * defaults, UPnP beside the API, the stop handler, the analytics flush and every
 * service.
 * @param {{apiPort: number, socketIoServers: object[]}} servers
 */
function start({ apiPort, socketIoServers }) {
  setAxiosDefaults(socketIoServers);
  // Beside the API, not in front of it: listening needs no mapping, and only
  // other nodes reaching this one from outside waits on `upnpMapped`.
  loadUpnpIfRequired(apiPort);
  process.on('SIGTERM', handleSigterm);
  // pm2 stops its processes with SIGINT, systemd with SIGTERM.
  process.on('SIGINT', handleSigterm);
  startFlushTimer();
  serviceManager.startFluxFunctions();
}

module.exports = {
  handleSigterm,
  isSystemShuttingDown,
  start,
};
