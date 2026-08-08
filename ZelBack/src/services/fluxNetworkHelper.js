/* eslint-disable no-underscore-dangle */
const config = require('config');
const { WIFToPrivKey, privKeyToPubKey } = require('./utils/fluxCryptoUtils');
const fs = require('fs').promises;
const os = require('os');
const dgram = require('dgram');
const net = require('net');
const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const messageHelper = require('./messageHelper');
const daemonServiceUtils = require('./daemonService/daemonServiceUtils');
const benchmarkService = require('./benchmarkService');
const verificationHelper = require('./verificationHelper');
const playgroundEgress = require('./appPlayground/playgroundEgress');
const fluxCommunicationUtils = require('./fluxCommunicationUtils');
const { peerManager } = require('./utils/peerState');
const { CLOSE_CODES, DIRECTION } = require('./utils/FluxPeerSocket');
const nodeDosState = require('./nodeDosState');
const { normalizeSocketAddress, parseSocketAddress } = require('./utils/socketAddressUtils');
const globalState = require('./utils/globalState');

let storedFluxBenchAllowed = null;

const { lruRateLimit } = require('./utils/rateLimit');

// This node's socket address (ip:port) from benchmark
let localSocketAddress = null;
// Freshness deadline (monotonic ns, process.hrtime.bigint) for the cached
// localSocketAddress: getLocalSocketAddress returns the cached value without a fresh
// benchmark RPC until this passes. The own IP is invariant except on a (rare, rate-limited
// ~1/20h) IP reassignment, so a short window collapses a batch of calls (e.g. an N-app
// cancel's per-app broadcasts) to one RPC. Monotonic, not wall-clock, so an NTP/manual
// clock step never serves the cache stale or expires it early.
let localSocketAddressFreshUntil = 0n;
const LOCAL_SOCKET_ADDRESS_TTL_NS = 60n * 1_000_000_000n;

// Whether ufw reports "Status: active", with a monotonic freshness deadline. The
// answer only changes when an operator toggles ufw by hand, yet periodic callers
// (the availability checker alone asks every couple of minutes) each fork a
// sudo+ufw probe for it, so one measurement is shared until the deadline passes.
// A probe failure is never cached.
let firewallActive = null;
let firewallActiveFreshUntil = 0n;
const FIREWALL_ACTIVE_TTL_NS = 15n * 60n * 1_000_000_000n;

/**
 * Converts a hexadecimal IP address (as found in /proc/net/route) to dotted decimal format.
 * The hex format is little-endian, so bytes are reversed.
 * @param {string} hex - Hexadecimal IP address (8 characters)
 * @returns {string} Dotted decimal IP address
 */
function hexToIp(hex) {
  const bytes = [];
  for (let i = 0; i < 8; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  // Reverse because the hex is little-endian
  return bytes.reverse().join('.');
}

/**
 * Checks if a network interface is operationally up by reading its sysfs operstate.
 * @param {string} interfaceName - The name of the network interface
 * @returns {Promise<boolean>} True if the interface is up
 */
async function isInterfaceUp(interfaceName) {
  try {
    const operstatePath = `/sys/class/net/${interfaceName}/operstate`;
    const state = await fs.readFile(operstatePath, 'utf8');
    return state.trim() === 'up';
  } catch {
    return false;
  }
}

/**
 * Gets the IP address assigned to a specific network interface.
 * @param {string} interfaceName - The name of the network interface
 * @returns {string|null} The IPv4 address or null if not found
 */
function getInterfaceIp(interfaceName) {
  const interfaces = os.networkInterfaces();
  const iface = interfaces[interfaceName];
  if (!iface) return null;

  for (const addr of iface) {
    if (addr.family === 'IPv4' && !addr.internal) {
      return addr.address;
    }
  }
  return null;
}

/**
 * Checks if the node has a public IP directly configured on the default route interface.
 * This is a strong indicator of a static IP (data center/VPS/dedicated server).
 * Uses the Linux routing table to find the default route interface, then checks
 * if that interface has a public IP assigned.
 * @returns {Promise<boolean>} True if a public IP is configured on the default route interface
 */
async function hasPublicIpOnInterface() {
  try {
    // Read the routing table from /proc/net/route
    const routeData = await fs.readFile('/proc/net/route', 'utf8');
    const lines = routeData.trim().split('\n');

    // Skip header line
    if (lines.length < 2) {
      return false;
    }

    // Find default routes (destination 0.0.0.0)
    const defaultRoutes = [];
    for (let i = 1; i < lines.length; i += 1) {
      const fields = lines[i].split('\t');
      if (fields.length < 11) {
        // eslint-disable-next-line no-continue
        continue;
      }

      const [iface, destination, gateway, flags, , , metric] = fields;

      // Check if this is a default route (destination is 0.0.0.0)
      if (destination === '00000000') {
        // Check if the route is up (flag 0x1) and has a gateway (flag 0x2)
        // eslint-disable-next-line no-bitwise
        const flagsNum = parseInt(flags, 16);
        // eslint-disable-next-line no-bitwise
        if ((flagsNum & 0x1) && (flagsNum & 0x2)) {
          defaultRoutes.push({
            iface,
            gateway: hexToIp(gateway),
            metric: parseInt(metric, 10),
          });
        }
      }
    }

    if (defaultRoutes.length === 0) {
      return false;
    }

    // Sort by metric (lowest first) and pick the best default route
    defaultRoutes.sort((a, b) => a.metric - b.metric);

    // Find the first interface that is operationally up
    for (const route of defaultRoutes) {
      // eslint-disable-next-line no-await-in-loop
      const isUp = await isInterfaceUp(route.iface);
      if (isUp) {
        const ip = getInterfaceIp(route.iface);
        if (ip && !serviceHelper.isNonRoutableAddress(ip)) {
          log.info(`Public IP ${ip} found on default route interface ${route.iface}`);
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    log.error(`Failed to check network interfaces via routing table: ${error.message}`);
    return false;
  }
}

/**
 * To get if port belongs to enterprise range
 * @returns {boolean} Returns true if enterprise
 */
function isPortEnterprise(port) {
  const { enterprisePorts } = config.fluxapps;
  let portEnterprise = false;
  enterprisePorts.forEach((portOrInterval) => {
    if (typeof portOrInterval === 'string') { // '0-10'
      const minPort = Number(portOrInterval.split('-')[0]);
      const maxPort = Number(portOrInterval.split('-')[1]);
      if (+port >= minPort && +port <= maxPort) {
        portEnterprise = true;
      }
    } else if (portOrInterval === +port) {
      portEnterprise = true;
    }
  });
  return portEnterprise;
}

/**
 * To get if port belongs to banned range
 * @returns {boolean} Returns true if port is banned
 */
function isPortBanned(port) {
  const { bannedPorts } = config.fluxapps;
  let portBanned = false;

  bannedPorts.forEach((portOrInterval) => {
    if (typeof portOrInterval === 'string') { // '0-10'
      const minPort = Number(portOrInterval.split('-')[0]);
      const maxPort = Number(portOrInterval.split('-')[1]);
      if (+port >= minPort && +port <= maxPort) {
        portBanned = true;
      }
    } else if (portOrInterval === +port) {
      portBanned = true;
    }
  });

  return portBanned;
}

/**
 * To get if port belongs to banned upnp range
 * @returns {boolean} Returns true if port is banned
 */
function isPortUPNPBanned(port) {
  let portBanned = false;
  const { upnpBannedPorts } = config.fluxapps;
  upnpBannedPorts.forEach((portOrInterval) => {
    if (typeof portOrInterval === 'string') { // '0-10'
      const minPort = Number(portOrInterval.split('-')[0]);
      const maxPort = Number(portOrInterval.split('-')[1]);
      if (+port >= minPort && +port <= maxPort) {
        portBanned = true;
      }
    } else if (portOrInterval === +port) {
      portBanned = true;
    }
  });
  return portBanned;
}

/**
 * To perform a basic check if TCP port on an ip is open. I.e. that we receive a
 * SYN-ACK in response to a SYN. If connected, we send an RST and close the port.
 * @param {string} ip IP address
 * @param {number} port Port
 * @param {{timeout?:Number}} options
 * @returns {Promise<boolean>} Returns true if opened, otherwise false
 */
async function isPortOpen(ip, port, options = {}) {
  const timeout = options.timeout || 5_000;

  const call = new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const cleanup = (success) => {
      if (settled) return;

      settled = true;

      clearTimeout(timer);

      if (success) {
        socket.resetAndDestroy();
        resolve(true);
      } else {
        socket.destroy();
        reject();
      }
    };

    const timer = setTimeout(() => {
      cleanup(false);
    }, timeout);

    socket.connect(port, ip, () => {
      cleanup(true);
    });

    socket.on('error', () => {
      cleanup(false);
    });
  });

  const connected = await call.catch(() => false);

  return connected;
}

/**
 * To perform a basic check of current FluxOS version.
 * @param {string} ip IP address.
 * @param {string} port Port. Defaults to config.server.apiport.
 * @returns {Promise<boolean>} False unless FluxOS version meets or exceeds the minimum allowed version.
 */
async function isFluxAvailable(ip, port = config.server.apiport) {
  const axiosConfig = {
    timeout: 5000,
  };

  try {
    const ipchars = /^[0-9.]+$/;
    if (!ipchars.test(ip)) {
      throw new Error('Invalid IP');
    }
    if (!config.server.allowedPorts.includes(+port)) {
      throw new Error('Invalid Port');
    }
    const socketAddress = normalizeSocketAddress(`${ip}:${port}`);
    const isConfirmedNode = await fluxCommunicationUtils.socketAddressInFluxList(socketAddress);
    if (!isConfirmedNode) {
      return false;
    }
    const fluxResponse = await serviceHelper.axiosGet(`http://${ip}:${port}/flux/version`, axiosConfig);
    if (fluxResponse.data.status !== 'success') return false;

    const fluxVersion = fluxResponse.data.data;
    const versionMinOK = serviceHelper.minVersionSatisfy(fluxVersion, config.minimumFluxOSAllowedVersion);
    if (!versionMinOK) return false;

    const homePort = +port - 1;
    // There is a new /health endpoint on the frontend express server. Since we have a catch-all route,
    // nodes on older versions will just return the index.html, so no change. Once all nodes on >= 6.6.1,
    // remove the title check (and this comment)
    const fluxResponseUi = await serviceHelper.axiosGet(`http://${ip}:${homePort}/health`, axiosConfig);
    const { data: UiPayload = '' } = fluxResponseUi;
    const uiAvailable = UiPayload === 'OK' || UiPayload.includes('<title>');
    if (!uiAvailable) return false;

    const syncthingPort = +port + 2;
    const portOpen = await isPortOpen(ip, syncthingPort);
    return portOpen;
  } catch (e) {
    log.error(e);
    return false;
  }
}

/**
 * To check Flux availability for specific IP address/port.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function checkFluxAvailability(req, res) {
  let { ip } = req.params;
  ip = ip || req.query.ip;
  let { port } = req.params;
  port = port || req.query.port;
  if (ip === undefined || ip === null) {
    const errMessage = messageHelper.createErrorMessage('No ip specified.');
    return res.json(errMessage);
  }

  const available = await isFluxAvailable(ip, port);

  let message;

  if (available === true) {
    message = messageHelper.createSuccessMessage('Asking Flux is available');
  } else {
    message = messageHelper.createErrorMessage('Asking Flux is not available');
  }
  return res.json(message);
}

/**
 * To check if application is available
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function checkAppAvailability(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);

      const processedBody = serviceHelper.ensureObject(body);

      const {
        ip, ports, pubKey, signature,
      } = processedBody;

      const ipPort = processedBody.port;

      // pubkey of the message has to be on the list
      const nodes = await fluxCommunicationUtils.deterministicFluxList({ filter: pubKey });
      const dataToVerify = processedBody;
      delete dataToVerify.signature;
      const messageToVerify = JSON.stringify(dataToVerify);
      const verified = verificationHelper.verifyMessage(messageToVerify, pubKey, signature);
      if ((verified !== true || !nodes.length) && authorized !== true) {
        throw new Error('Unable to verify request authenticity');
      }

      const { fluxapps: { portMin: minPort, portMax: maxPort } } = config;

      // eslint-disable-next-line no-restricted-syntax
      for (const port of ports) {
        const iBP = isPortBanned(+port);
        const portNum = +port;
        const withinRange = portNum >= minPort && portNum <= maxPort;

        if (withinRange && !iBP) {
          // eslint-disable-next-line no-await-in-loop
          const isOpen = await isPortOpen(ip, port);
          if (!isOpen) {
            throw new Error(`Flux Applications on ${ip}:${ipPort} are not available. Failed port: ${port}`);
          }
        } else {
          log.error(`Flux App port ${port} is outside allowed range. minPort: ${minPort}, maxPort: ${maxPort}, isBanned: ${iBP}`);
        }
      }
      const successResponse = messageHelper.createSuccessMessage(`Flux Applications on ${ip}:${ipPort} are available.`);
      res.json(successResponse);
    } catch (error) {
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      res.json(errorResponse);
    }
  });
}

/**
 * Connects to a TCP socket with timeout. Immediately sends RST and ends the connection
 * Solely used to keep a UPnP mapping open
 * @param {string} host The ip we are connecting to
 * @param {string} port The port we are connecting to
 * @param {number} timeout The connect timeout in ms
 * @returns {void}
 */
function tcpConnectAndDestroy(host, port, timeout) {
  const socket = new net.Socket();

  const timer = setTimeout(() => {
    socket.destroy();
  }, timeout);

  socket.connect(port, host, () => {
    clearTimeout(timer);
    socket.resetAndDestroy();
  });

  socket.on('error', () => {
    clearTimeout(timer);
  });
}

/**
 * Used to keep UPNP ports open because with miniupnpd after 10m on a port
 * without traffic it can be automatically closed. (Depending on if miniupnpd has
 * set for clean_ruleset_interval)
 *
 * This function *should* only take a max of ~5 seconds to run. That would be for a
 * node that has 20 ports open. (The ports can take a max of 3 seconds to test, but that
 * is asynchronous)
 *
 * The way we are doing this is quite inefficient, app specs don't make a differentiation
 * between TCP/UDP (they should). So we have to test both protocols.
 * We should just check the mappings themselves - and refresh whatever is open.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function keepUPNPPortsOpen(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);

    const { body } = req;
    const processedBody = serviceHelper.ensureObject(body);

    const {
      ip, apiPort, ports, pubKey, timestamp, signature,
    } = processedBody;

    const now = Math.floor(Date.now() / 1000);

    // allow 10 minutes for clock drift. Prevent packet from being replayed.
    if (!Number.isInteger(timestamp) || timestamp + 600 < now) {
      res.status(422).end();
      return;
    }

    if (!ip || !apiPort || !pubKey || !signature) {
      res.status(422).end();
      return;
    }

    if (!Array.isArray(ports)) {
      res.status(422).end();
      return;
    }

    // eslint-disable-next-line no-restricted-syntax
    for (const port of ports) {
      if (!Number.isInteger(port)) {
        res.status(422).end();
        return;
      }
    }

    // pubkey of the message has to be on the list
    const nodes = await fluxCommunicationUtils.deterministicFluxList({ filter: pubKey });
    const dataToVerify = processedBody;
    delete dataToVerify.signature;
    const messageToVerify = JSON.stringify(dataToVerify);
    const verified = verificationHelper.verifyMessage(messageToVerify, pubKey, signature);
    if ((verified !== true || !nodes.length) && authorized !== true) {
      res.status(401).end();
      throw new Error('Unable to verify request authenticity');
    }

    // make sure that we can reach the api port first. This is in case of nodes that
    // are able to receive communcation from another node, but because of routing issues,
    // can connect back the other way. This has a timeout of 3 seconds, whereas the other end
    // has a 5 second timeout.
    await serviceHelper.axiosGet(`http://${ip}:${apiPort}/flux/uptime`, { timeout: 3_000 }).catch(() => {
      res.status(503).end();
      throw new Error('Unable to connect back to api port');
    });

    res.status(202).end();

    log.info(`keepUPNPPortsOpen - called from  ${ip} to test ports: ${ports}`);

    // eslint-disable-next-line no-restricted-syntax
    for (const port of ports) {
      tcpConnectAndDestroy(ip, port, 3_000);
      const udpSocket = dgram.createSocket('udp4');
      udpSocket.send('D', 0, 1, port, ip, () => {
        udpSocket.close();
      });
      // just add a small delay between requests here. As we can have quite a few
      // ports to open
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(250);
    }
  } catch (error) {
    log.error(`keepUPNPPortsOpen error - ${error}`);
  }
}

/**
 * Setter for localSocketAddress.
 * Main goal for this is testing availability.
 *
 * @param {string} value ip or ip:port to be set (normalized to ip:port)
 */
function setLocalSocketAddress(value) {
  localSocketAddress = value ? normalizeSocketAddress(value) : null;
  // (Re)set the freshness deadline whenever the value changes, so getLocalSocketAddress
  // serves it without a benchmark RPC until it goes stale (cleared when set to null).
  localSocketAddressFreshUntil = localSocketAddress ? process.hrtime.bigint() + LOCAL_SOCKET_ADDRESS_TTL_NS : 0n;
}

/**
 * Returns the cached local socket address without re-fetching from benchmark.
 * @returns {string|null} Normalized socket address (ip:port) or null.
 */
function getCachedLocalSocketAddress() {
  return localSocketAddress;
}

/**
 * Get this node's socket address (ip:port).
 * @returns {Promise<string|null>} Normalized socket address (always ip:port) or null.
 */
async function getLocalSocketAddress() {
  // Serve the cached own-IP without a benchmark RPC while it is still fresh. A batch
  // cancel/install issues this call once per app on a hot serialized path (the explorer
  // block loop) and the value is invariant across the batch, so this collapses N RPCs to
  // one. A null (unresolved) value is never cached. The IP-change detector
  // (checkMyFluxAvailability) reads the module-scoped localSocketAddress + getPublicIp()
  // DIRECTLY, not through this function, so a <=TTL reflect-lag here after a (rate-limited)
  // IP change is harmless — the next benchmark resolve updates the value and the deadline.
  if (localSocketAddress && process.hrtime.bigint() < localSocketAddressFreshUntil) {
    return localSocketAddress;
  }
  const benchmarkResponse = await benchmarkService.getBenchmarks();
  const { status, data: { ipaddress = null } = {} } = benchmarkResponse;
  // The benchmark IP can be a bare IP or ip:port depending on the node's API port,
  // and while fluxbench is still resolving it the value can be empty or a host-less
  // ":<port>" - the latter is truthy but useless. parseSocketAddress accepts a real
  // bare-IP or ip:port and rejects those unresolved forms, so callers (e.g. the
  // masterSlave election) never act on a bogus own-IP.
  if (status !== 'success' || !parseSocketAddress(ipaddress)) {
    setLocalSocketAddress(null);
    return null;
  }
  setLocalSocketAddress(ipaddress);
  return localSocketAddress;
}

/**
 * To get FluxNode private key.
 * @param {string} privatekey Private Key.
 * @returns {string} Private key, if already input as parameter or otherwise from the daemon config.
 */
async function getFluxNodePrivateKey(privatekey) {
  const privKey = privatekey || daemonServiceUtils.getConfigValue('zelnodeprivkey');
  return privKey;
}

/**
 * To get FluxNode public key.
 * @param {string} privatekey Private key.
 * @returns {string} Public key.
 */
async function getFluxNodePublicKey(privatekey) {
  try {
    const pkWIF = await getFluxNodePrivateKey(privatekey);
    const isCompressed = !pkWIF.startsWith('5');
    const privateKey = WIFToPrivKey(pkWIF);
    const pubKey = privKeyToPubKey(privateKey, isCompressed);
    return pubKey;
  } catch (error) {
    return error;
  }
}

/**
 * To close an outgoing connection.
 * @param {string} ip IP address.
 * @param {string} port node API port.
 * @returns {object} Message.
 */
async function closeConnection(ip, port) {
  if (!ip) return messageHelper.createWarningMessage('To close a connection please provide a proper IP number.');
  const key = `${ip}:${port}`;
  const peer = peerManager.get(key);
  if (!peer || peer.direction !== DIRECTION.OUTBOUND) {
    return messageHelper.createWarningMessage(`Connection to ${ip}:${port} does not exists.`);
  }
  peer.close(CLOSE_CODES.CLOSED_OUTBOUND, 'purposefully closed');
  log.info(`Connection to ${ip}:${port} closed with code ${CLOSE_CODES.CLOSED_OUTBOUND}`);
  return messageHelper.createSuccessMessage(`Outgoing connection to ${ip}:${port} closed`);
}

/**
 * To close an incoming connection.
 * @param {string} ip IP address.
 * @param {string} port node API port.
 * @param {object} expressWS Express web socket.
 * @param {object} clientToClose Web socket for client to close.
 * @returns {object} Message.
 */
async function closeIncomingConnection(ip, port) {
  if (!ip) return messageHelper.createWarningMessage('To close a connection please provide a proper IP number.');
  const key = `${ip}:${port}`;
  const peer = peerManager.get(key);
  if (!peer || peer.direction !== DIRECTION.INBOUND) {
    return messageHelper.createWarningMessage(`Connection from ${ip}:${port} does not exists.`);
  }
  peer.close(CLOSE_CODES.CLOSED_INBOUND, 'purposefully closed');
  log.info(`Connection from ${ip}:${port} closed with code ${CLOSE_CODES.CLOSED_INBOUND}`);
  return messageHelper.createSuccessMessage(`Incoming connection to ${ip}:${port} closed`);
}

/**
 * To get IP addresses for incoming connections.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
/**
 * @deprecated Use getPeers with direction=inbound instead.
 */
function getIncomingConnections(req, res) {
  const connections = [];
  for (const peer of peerManager.inboundValues()) connections.push(peer.ip);
  const message = messageHelper.createDataMessage(connections);
  res.json(message);
}

/**
 * @deprecated Use getPeers with direction=inbound instead.
 */
function getIncomingConnectionsInfo(req, res) {
  const connections = [...peerManager.inboundValues()].map((p) => p.toPeerInfo());
  const message = messageHelper.createDataMessage(connections);
  return res ? res.json(message) : message;
}

/**
 * Setter for storedFluxBenchAllowed.
 * Main goal for this is testing availability.
 *
 * @param {number} value
 */
function setStoredFluxBenchAllowed(value) {
  storedFluxBenchAllowed = value;
}

/**
 * Getter for storedFluxBenchAllowed.
 * Main goal for this is testing availability.
 *
 * @returns {number} storedFluxBenchAllowed
 */
function getStoredFluxBenchAllowed() {
  return storedFluxBenchAllowed;
}

/**
 * To check if Flux benchmark version is allowed.
 * @returns {boolean} True if version is verified as allowed. Otherwise false.
 */
async function checkFluxbenchVersionAllowed() {
  if (storedFluxBenchAllowed) {
    const versionOK = serviceHelper.minVersionSatisfy(storedFluxBenchAllowed, config.minimumFluxBenchAllowedVersion);
    return versionOK;
  }
  try {
    const benchmarkInfoResponse = await benchmarkService.getInfo();
    if (benchmarkInfoResponse.status === 'success') {
      log.info(benchmarkInfoResponse);
      const benchmarkVersion = benchmarkInfoResponse.data.version;
      setStoredFluxBenchAllowed(benchmarkVersion);
      const versionOK = serviceHelper.minVersionSatisfy(benchmarkVersion, config.minimumFluxBenchAllowedVersion);
      if (versionOK) {
        return true;
      }
      nodeDosState.addDosState(11);
      nodeDosState.setDosMessage(`Fluxbench Version Error. Current lower version allowed is v${config.minimumFluxBenchAllowedVersion} found v${benchmarkVersion}`);
      log.error(nodeDosState.getRawDosMessage());
      return false;
    }
    nodeDosState.addDosState(2);
    nodeDosState.setDosMessage('Fluxbench Version Error. Error obtaining FluxBench Version.');
    log.error(nodeDosState.getRawDosMessage());
    return false;
  } catch (err) {
    log.error(err);
    log.error(`Error on checkFluxBenchVersion: ${err.message}`);
    nodeDosState.addDosState(2);
    nodeDosState.setDosMessage('Fluxbench Version Error. Error obtaining Flux Version.');
    return false;
  }
}

/**
 * To get node uptime in seconds
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function fluxUptime(req, res) {
  let message;
  try {
    const ut = process.uptime();
    const measureUptime = Math.floor(ut);
    message = messageHelper.createDataMessage(measureUptime);
    return res ? res.json(message) : message;
  } catch (error) {
    log.error(error);
    message = messageHelper.createErrorMessage('Error obtaining uptime');
    return res ? res.json(message) : message;
  }
}

/**
 * To get system uptime in seconds
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function fluxSystemUptime(req, res) {
  let message;
  try {
    const uptime = os.uptime();
    const measureUptime = Math.floor(uptime);
    message = messageHelper.createDataMessage(measureUptime);
    return res ? res.json(message) : message;
  } catch (error) {
    log.error(error);
    message = messageHelper.createErrorMessage('Error obtaining uptime');
    return res ? res.json(message) : message;
  }
}

// NTP source detected once at first call, then reused
let ntpSource = null; // 'chrony' | 'timesyncd' | 'none'

function resetNtpSource() { ntpSource = null; }

/**
 * Detects which NTP source is available on this node.
 * @returns {Promise<string>} 'chrony', 'timesyncd', or 'none'
 */
async function detectNtpSource() {
  if (ntpSource !== null) return ntpSource;

  const { error: chronyError } = await serviceHelper.runCommand('chronyc', {
    params: ['tracking'],
    timeout: 5000,
    logError: false,
  });
  if (!chronyError) {
    ntpSource = 'chrony';
    log.info('NTP source detected: chrony');
    return ntpSource;
  }

  const { error: timedError } = await serviceHelper.runCommand('timedatectl', {
    params: ['timesync-status'],
    timeout: 5000,
    logError: false,
  });
  if (!timedError) {
    ntpSource = 'timesyncd';
    log.info('NTP source detected: timesyncd');
    return ntpSource;
  }

  ntpSource = 'none';
  log.info('NTP source detected: none');
  return ntpSource;
}

/**
 * Parses chrony offset from `chronyc tracking` output.
 * @param {string} stdout
 * @returns {number|null} offset in seconds
 */
function parseChronyOffset(stdout) {
  // "System time : 0.000001234 seconds slow of NTP time"
  const match = stdout.match(/System time\s*:\s*([\d.]+)\s+seconds\s+(slow|fast)/);
  if (!match) return null;
  return parseFloat(match[1]) * (match[2] === 'slow' ? -1 : 1);
}

/**
 * Parses timesyncd offset from `timedatectl timesync-status` output.
 * @param {string} stdout
 * @returns {number|null} offset in seconds
 */
function parseTimesyncOffset(stdout) {
  // "Offset: +1.234ms" or "Offset: -567us"
  const match = stdout.match(/Offset\s*:\s*([+-]?[\d.]+)(us|ms|s)/);
  if (!match) return null;
  let offset = parseFloat(match[1]);
  if (match[2] === 'us') offset /= 1e6;
  else if (match[2] === 'ms') offset /= 1e3;
  return offset;
}

/**
 * Gets NTP clock drift from the detected source.
 * @returns {Promise<{source: string, offset: number|null, time: number}>}
 */
async function getClockDrift() {
  const source = await detectNtpSource();
  const time = Math.floor(Date.now() / 1000);

  if (source === 'chrony') {
    const { error, stdout } = await serviceHelper.runCommand('chronyc', {
      params: ['tracking'],
      timeout: 5000,
      logError: false,
    });
    if (!error && stdout) {
      const offset = parseChronyOffset(stdout);
      if (offset !== null) return { source, offset, time };
    }
  } else if (source === 'timesyncd') {
    const { error, stdout } = await serviceHelper.runCommand('timedatectl', {
      params: ['timesync-status'],
      timeout: 5000,
      logError: false,
    });
    if (!error && stdout) {
      const offset = parseTimesyncOffset(stdout);
      if (offset !== null) return { source, offset, time };
    }
  }

  return { source, offset: null, time };
}

// Cached NTP clock offset in milliseconds. Refreshed every 5 minutes.
let localClockOffsetMs = null;
let clockOffsetInterval = null;

/**
 * Refresh the cached NTP clock offset from the system NTP source.
 */
async function refreshClockOffset() {
  try {
    const { offset } = await getClockDrift();
    localClockOffsetMs = offset !== null ? Math.round(offset * 1000) : null;
  } catch (e) {
    log.error(`Failed to refresh clock offset: ${e.message}`);
  }
}

/**
 * Start the clock offset cache. Call once during node startup.
 */
async function initClockOffsetCache() {
  await refreshClockOffset();
  if (!clockOffsetInterval) {
    clockOffsetInterval = setInterval(refreshClockOffset, 5 * 60 * 1000);
  }
}

/**
 * Returns the cached local NTP clock offset in milliseconds, or null if unavailable.
 * @returns {number|null}
 */
function getLocalClockOffsetMs() {
  return localClockOffsetMs;
}

/**
 * API handler for clock drift endpoint.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function clockDrift(req, res) {
  try {
    const data = await getClockDrift();
    const message = messageHelper.createDataMessage(data);
    return res ? res.json(message) : message;
  } catch (error) {
    log.error(error);
    const message = messageHelper.createErrorMessage('Error obtaining clock drift');
    return res ? res.json(message) : message;
  }
}

/**
 * To check if sufficient communication is established. Minimum number of outgoing and incoming peers must be met.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function isCommunicationEstablished(req, res) {
  const { outboundCount } = peerManager;
  const { inboundCount } = peerManager;
  let message;
  if (outboundCount < config.fluxapps.minOutgoing) { // easier to establish
    message = messageHelper.createErrorMessage(`Not enough outgoing connections established to Flux network. Minimum required ${config.fluxapps.minOutgoing} found ${outboundCount}`);
  } else if (inboundCount < config.fluxapps.minIncoming) { // depends on other nodes successfully connecting to my node, todo enforcement
    message = messageHelper.createErrorMessage(`Not enough incoming connections from Flux network. Minimum required ${config.fluxapps.minIncoming} found ${inboundCount}`);
  } else {
    const uniqueOutboundIps = new Set();
    for (const peer of peerManager.outboundValues()) uniqueOutboundIps.add(peer.ip);
    if (uniqueOutboundIps.size < config.fluxapps.minUniqueIpsOutgoing) {
      message = messageHelper.createErrorMessage(`Not enough outgoing unique ip's connections established to Flux network. Minimum required ${config.fluxapps.minUniqueIpsOutgoing} found ${uniqueOutboundIps.size}`);
    } else {
      const uniqueInboundIps = new Set();
      for (const peer of peerManager.inboundValues()) uniqueInboundIps.add(peer.ip);
      if (uniqueInboundIps.size < config.fluxapps.minUniqueIpsIncoming) {
        message = messageHelper.createErrorMessage(`Not enough incoming unique ip's connections from Flux network. Minimum required ${config.fluxapps.minUniqueIpsIncoming} found ${uniqueInboundIps.size}`);
      } else {
        message = messageHelper.createSuccessMessage('Communication to Flux network is properly established');
      }
    }
  }
  return res ? res.json(message) : message;
}

/**
 * To get DOS state.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
function getDOSState(req, res) {
  const message = messageHelper.createDataMessage(nodeDosState.getDosData());
  return res ? res.json(message) : message;
}

async function setDOSStateApi(req, res) {
  if (!config.has('testEventStream') || config.get('testEventStream') !== true) {
    return res.status(404).json({ status: 'error', data: { message: 'Not available' } });
  }
  const authorized = await verificationHelper.verifyPrivilege('fluxteam', req);
  if (authorized !== true) {
    const errMessage = messageHelper.errUnauthorizedMessage();
    return res.json(errMessage);
  }
  let { body } = req;
  if (typeof body !== 'object') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const newDosState = Number(body.dosState);
  if (Number.isNaN(newDosState)) {
    return res.json(messageHelper.createErrorMessage('dosState must be a number'));
  }
  nodeDosState.setDosMessage(body.dosMessage ?? null);
  nodeDosState.setDosStateValue(newDosState);
  return res.json(messageHelper.createSuccessMessage({
    dosState: nodeDosState.getDosStateValue(),
    dosMessage: nodeDosState.getRawDosMessage(),
  }));
}


/**
 * Runs ufw as root with the given arguments.
 *
 * Arguments are passed as a list rather than interpolated into a shell string, so ports and
 * addresses never reach a shell. LANG is pinned because callers match on ufw's human readable
 * outcome (added / updated / existing / deleted), which is localized.
 *
 * A failure is thrown rather than returned on the result: every caller either abandons the
 * rules that follow or lets the failure propagate, so a rule that could not be applied must
 * not read as one that was.
 * @param {(string|number)[]} params ufw arguments.
 * @returns {Promise<string>} ufw's stdout.
 */
async function runUfw(params) {
  const { error, stdout } = await serviceHelper.runCommand('ufw', {
    runAsRoot: true,
    logError: false,
    env: { ...process.env, LANG: 'en_US.UTF-8' },
    params,
  });

  if (error) throw error;

  return stdout;
}

/**
 * Run a ufw command whose failure must not stop the rules that follow it.
 *
 * ufw exits non-zero for ordinary conditions — deleting a rule that was never added, or
 * naming an app profile that is not installed — and the rules in a firewall pass are
 * independent of each other. Letting the first such exit abort the pass left every port
 * closed on a node whose OpenSSH profile happened to be missing.
 * @param {Array<string>} params ufw arguments
 * @returns {Promise<string>} Command output, or an empty string if it failed
 */
async function tryUfw(params) {
  // Captured before the call: runCommand prepends the binary to the array it is handed,
  // so reading it afterwards names a command that was never run.
  const attempted = params.join(' ');
  try {
    return await runUfw(params);
  } catch (error) {
    log.error(`ufw ${attempted} failed: ${error.message}`);
    return '';
  }
}

/**
 * To allow a port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function allowPort(port) {
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  // the out rule is only applied if the in rule lands, and the status covers both
  const inbound = await runUfw(['allow', `${port}`]);
  const outbound = await runUfw(['allow', 'out', `${port}`]);
  const cmdres = inbound + outbound;
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('updated') || serviceHelper.ensureString(cmdres).includes('added')) {
    cmdStat.status = true;
  } else if (serviceHelper.ensureString(cmdres).includes('existing')) {
    cmdStat.status = true;
    cmdStat.message = 'existing';
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To allow out a port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function allowOutPort(port) {
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const cmdres = await runUfw(['allow', 'out', `${port}`]);
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('updated') || serviceHelper.ensureString(cmdres).includes('added')) {
    cmdStat.status = true;
  } else if (serviceHelper.ensureString(cmdres).includes('existing')) {
    cmdStat.status = true;
    cmdStat.message = 'existing';
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To deny a port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function denyPort(port) {
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const portBanned = isPortBanned(+port);
  if (portBanned || +port < config.fluxapps.portMin || +port > config.fluxapps.portMax) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const inbound = await runUfw(['deny', `${port}`]);
  const outbound = await runUfw(['deny', 'out', `${port}`]);
  const cmdres = inbound + outbound;
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('updated') || serviceHelper.ensureString(cmdres).includes('added')) {
    cmdStat.status = true;
  } else if (serviceHelper.ensureString(cmdres).includes('existing')) {
    cmdStat.status = true;
    cmdStat.message = 'existing';
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To delete a ufw allow rule on port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function deleteAllowPortRule(port) {
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const portBanned = isPortBanned(+port);
  if (portBanned || +port < config.fluxapps.portMin || +port > config.fluxapps.portMax) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const inbound = await runUfw(['delete', 'allow', `${port}`]);
  const outbound = await runUfw(['delete', 'allow', 'out', `${port}`]);
  const cmdres = inbound + outbound;
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('delete')) { // Rule deleted or Could not delete non-existent rule both ok
    cmdStat.status = true;
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To delete a ufw deny rule on port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function deleteDenyPortRule(port) {
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const portBanned = isPortBanned(+port);
  if (portBanned || +port < config.fluxapps.portMin || +port > config.fluxapps.portMax) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const inbound = await runUfw(['delete', 'deny', `${port}`]);
  const outbound = await runUfw(['delete', 'deny', 'out', `${port}`]);
  const cmdres = inbound + outbound;
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('delete')) { // Rule deleted or Could not delete non-existent rule both ok
    cmdStat.status = true;
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To delete a ufw allow rule on port.
 * @param {string} port Port.
 * @returns {object} Command status.
 */
async function deleteAllowOutPortRule(port) {
  const cmdStat = {
    status: false,
    message: null,
  };
  if (Number.isNaN(+port)) {
    cmdStat.message = 'Port needs to be a number';
    return cmdStat;
  }
  const portBanned = isPortBanned(+port);
  if (portBanned || +port < config.fluxapps.portMin || +port > config.fluxapps.portMax) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const cmdres = await runUfw(['delete', 'allow', 'out', `${port}`]);
  cmdStat.message = cmdres;
  if (serviceHelper.ensureString(cmdres).includes('delete')) { // Rule deleted or Could not delete non-existent rule both ok
    cmdStat.status = true;
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * To allow a port via API. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function allowPortApi(req, res) {
  let { port } = req.params;
  port = port || req.query.port;
  if (port === undefined || port === null) {
    const errMessage = messageHelper.createErrorMessage('No Port address specified.');
    return res.json(errMessage);
  }
  if (!serviceHelper.validPort(port)) {
    return res.json(messageHelper.createErrorMessage('Port must be a whole number between 1 and 65535'));
  }
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);

  let message;

  if (authorized === true) {
    try {
      const portResponseOK = await allowPort(port);
      if (portResponseOK.status === true) {
        message = messageHelper.createSuccessMessage(portResponseOK.message, port, port);
      } else if (portResponseOK.status === false) {
        message = messageHelper.createErrorMessage(portResponseOK.message, port, port);
      } else {
        message = messageHelper.createErrorMessage(`Unknown error while opening port ${port}`);
      }
    } catch (error) {
      // allowPort reports its outcome on the returned status, but the ufw call beneath it
      // throws — an uninstalled ufw or a refused sudo. Unhandled, that rejects out of an
      // express handler, which ends the process rather than the request.
      log.error(error);
      message = messageHelper.createErrorMessage(`Unknown error while opening port ${port}`);
    }
  } else {
    message = messageHelper.errUnauthorizedMessage();
  }
  return res.json(message);
}

/**
 * To check if a firewall is active.
 * @returns {Promise<boolean>} True if a firewall is active. Otherwise false.
 */
async function isFirewallActive() {
  if (firewallActive !== null && process.hrtime.bigint() < firewallActiveFreshUntil) {
    return firewallActive;
  }
  try {
    // the status line is picked out of ufw's full status output
    const cmdresA = await runUfw(['status']);
    firewallActive = serviceHelper.ensureString(cmdresA).includes('Status: active');
    firewallActiveFreshUntil = process.hrtime.bigint() + FIREWALL_ACTIVE_TTL_NS;
    return firewallActive;
  } catch (error) {
    // command ufw not found is the most likely reason
    log.error(error);
    return false;
  }
}

/**
 * Discards the cached ufw status so the next isFirewallActive call probes ufw.
 * Main goal for this is testing.
 */
function resetFirewallActiveCache() {
  firewallActive = null;
  firewallActiveFreshUntil = 0n;
}

/**
 * To adjust a firewall to allow ports for Flux.
 */
async function adjustFirewall() {
  try {
    const apiPort = userconfig.initial.apiport || config.server.apiport;
    const homePort = +apiPort - 1;
    const apiSSLPort = +apiPort + 1;
    const syncthingPort = +apiPort + 2;
    let ports = [apiPort, homePort, apiSSLPort, syncthingPort, 80, 443, 16125];
    const fluxCommunicationPorts = config.server.allowedPorts;
    ports = ports.concat(fluxCommunicationPorts);
    const firewallActive = await isFirewallActive();
    if (firewallActive) {
      // set default allow outgoing
      await tryUfw(['default', 'allow', 'outgoing']);
      // allow speedtests
      await tryUfw(['insert', '1', 'allow', 'out', '5060']);
      await tryUfw(['insert', '1', 'allow', 'out', '8080']);
      // remove inbound DNS traffic. ufw prints "Could not delete non-existent rule" on a node
      // that never had it, so the output of this rule and the ssh and router ones is not used
      await tryUfw(['delete', 'allow', 'in', 'proto', 'udp', 'to', 'any', 'port', '53']);
      // allow outgoing DNS traffic
      await tryUfw(['insert', '1', 'allow', 'out', 'proto', 'udp', 'to', 'any', 'port', '53']);
      await tryUfw(['insert', '1', 'allow', 'out', 'proto', 'tcp', 'to', 'any', 'port', '53']);
      log.info('Firewall adjusted for DNS traffic');

      // fix up for ssh being misteriously removed (needs tracing)
      if (globalState.isArcane()) {
        // this should also be limit, but existing nodes use allow (needs to be updated)
        await tryUfw(['insert', '1', 'allow', 'to', 'any', 'app', 'FluxadmSSH']);
      }

      await tryUfw(['insert', '1', 'limit', 'to', 'any', 'app', 'OpenSSH']);

      // the gateway is the third field of the first route. A node with no default route, or
      // no ip binary, just gets no router rules, so the lookup is neither fatal nor logged
      const { stdout: routes } = await serviceHelper.runCommand('ip', {
        logError: false,
        params: ['route'],
      });
      const routerIP = (routes || '').split('\n')[0].trim().split(/\s+/)[2] || '';
      log.info(`Router IP: ${routerIP}`);
      if (serviceHelper.validIpv4Address(routerIP)
        && (routerIP.startsWith('192.168.') || routerIP.startsWith('10.') || routerIP.startsWith('172.16.')
          || routerIP.startsWith('100.64.') || routerIP.startsWith('198.18.') || routerIP.startsWith('169.254.'))) {
        await tryUfw(['insert', '1', 'allow', 'out', 'from', 'any', 'to', routerIP, 'proto', 'tcp']);
        await tryUfw(['insert', '1', 'allow', 'from', routerIP, 'to', 'any', 'proto', 'udp']);
        log.info(`Firewall adjusted for comms with router on local ip ${routerIP}`);
      }
      // eslint-disable-next-line no-restricted-syntax
      for (const port of ports) {
        // eslint-disable-next-line no-await-in-loop
        const cmdresB = await tryUfw(['allow', `${port}`]);
        if (serviceHelper.ensureString(cmdresB).includes('updated') || serviceHelper.ensureString(cmdresB).includes('existing') || serviceHelper.ensureString(cmdresB).includes('added')) {
          log.info(`Firewall adjusted for port ${port}`);
        } else {
          log.info(`Failed to adjust Firewall for port ${port}`);
        }

        // eslint-disable-next-line no-await-in-loop
        const cmdresC = await tryUfw(['allow', 'out', `${port}`]);
        if (serviceHelper.ensureString(cmdresC).includes('updated') || serviceHelper.ensureString(cmdresC).includes('existing') || serviceHelper.ensureString(cmdresC).includes('added')) {
          log.info(`Firewall out adjusted for port ${port}`);
        } else {
          log.info(`Failed to adjust Firewall out for port ${port}`);
        }
      }
    } else {
      log.info('Firewall is not active. Adjusting not applied');
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To clean a firewall deny policies, and delete them from it.
 */
async function purgeUFW() {
  try {
    const firewallActive = await isFirewallActive();
    if (firewallActive) {
      // the deny lines are picked out of ufw's full status output; a status that cannot be
      // read is treated as no deny rules rather than an error
      const status = await runUfw(['status']).catch(() => ''); // fail silently,
      const deniedPorts = status.split('\n').filter((line) => line.includes('DENY'));
      if (deniedPorts.length) {
        const portsToDelete = [];
        deniedPorts.forEach((port) => {
          const adjPort = port.substring(0, port.indexOf(' '));
          if (adjPort) {
            if (!portsToDelete.includes(adjPort)) {
              portsToDelete.push(adjPort);
            }
          }
        });
        // eslint-disable-next-line no-restricted-syntax
        for (const port of portsToDelete) {
          // eslint-disable-next-line no-await-in-loop
          await deleteDenyPortRule(port);
        }
        log.info('UFW app deny rules on ports purged');
      } else {
        log.info('No UFW deny on ports rules found');
      }
      const netscanNetworks = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '198.18.0.0/15', '169.254.0.0/16'];
      // eslint-disable-next-line no-restricted-syntax
      for (const network of netscanNetworks) {
        // eslint-disable-next-line no-await-in-loop
        await runUfw(['delete', 'deny', 'out', 'from', 'any', 'to', network]);
      }
      log.info('UFW app deny netscans rules purged');
    } else {
      log.info('Firewall is not active. Purging UFW not necessary');
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * This fix a docker security issue where docker containers can access private node operator networks, for example to create port forwarding on hosts.
 *
 * Docker should create a DOCKER-USER chain. If this doesn't exist - we create it, then jump to this chain immediately from the FORWARD CHAIN.
 * This allows rules to be added via -I (insert) and -A (append) to the DOCKER-USER chain individually, so we can ALWAYS append the
 * drop traffic rule, and insert the ACCEPT rules. If no matches are found in the DOCKER-USER chain, rule evaluation continues
 * from the next rule in the FORWARD chain.
 *
 * If needed in the future, we can actually create a JUMP from the DOCKER-USER chain to a custom chain. The reason why we MUST use the DOCKER-USER
 * chain is that whenever docker creates a new network, it re-jumps the DOCKER-USER chain at the head of the FORWARD chain.
 *
 * As can be seen in this example:
 *
 * Originally, was using the FLUX chain, but you can see docker inserted the br-72d1725e481c network ahead, as well as the JUMP to DOCKER-USER,
 * which invalidates any rules in the FLUX chain, as there is basically an accept any:
 *
 * FORWARD -i br-72d1725e481c ! -o br-72d1725e481c -j ACCEPT
 *
 * ```bash
 * -A INPUT -j ufw-track-input
 * -A FORWARD -j DOCKER-USER
 * -A FORWARD -j DOCKER-ISOLATION-STAGE-1
 * -A FORWARD -o br-72d1725e481c -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
 * -A FORWARD -o br-72d1725e481c -j DOCKER
 * -A FORWARD -i br-72d1725e481c ! -o br-72d1725e481c -j ACCEPT
 * -A FORWARD -i br-72d1725e481c -o br-72d1725e481c -j ACCEPT
 * -A FORWARD -j FLUX
 * -A FORWARD -o br-048fde111132 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
 * -A FORWARD -o br-048fde111132 -j DOCKER
 * -A FORWARD -i br-048fde111132 ! -o br-048fde111132 -j ACCEPT
 * -A FORWARD -i br-048fde111132 -o br-048fde111132 -j ACCEPT
 *```
 * This means if a user or someone was to delete a single rule, we are able to recover correctly from it.
 *
 * The other option - is just to Flush all rules on every run, and reset them all. This is what we are doing now.
 *
 * @param {string[]} fluxNetworkInterfaces The network interfaces, br-<12 character string>
 * @returns  {Promise<Boolean>}
 */
async function removeDockerContainerAccessToNonRoutable(fluxNetworkInterfaces) {
  // Arguments are passed as a list rather than interpolated into a shell string, so the
  // interfaces and networks never reach a shell. Every call site below reports its own
  // failure, so runCommand's own error logging is off.
  const iptables = (params) => serviceHelper.runCommand('iptables', {
    runAsRoot: true,
    logError: false,
    params,
  });

  const { error: iptablesMissing } = await iptables(['--version']);

  if (iptablesMissing) {
    log.error('Unable to find iptables binary');
    return false;
  }

  // check if rules have been created, as iptables is NOT idempotent.
  const { error: dockerUserChainMissing } = await iptables(['-L', 'DOCKER-USER']);

  if (dockerUserChainMissing) {
    const { error: addChainError } = await iptables(['-N', 'DOCKER-USER']);
    if (addChainError) {
      log.error('IPTABLES: Error adding DOCKER-USER chain');
      // if we can't add chain, we can't proceed
      return false;
    }
    log.info('IPTABLES: DOCKER-USER chain created');
  } else {
    log.info('IPTABLES: DOCKER-USER chain already created');
  }

  // iptables 1.8.4 prints nothing on a successful check, so the exit status is what decides
  const { error: jumpChainMissing } = await iptables(['-C', 'FORWARD', '-j', 'DOCKER-USER']);

  if (jumpChainMissing) {
    // Ubuntu 20.04 @ iptables 1.8.4 Error: "iptables: No chain/target/match by that name."
    // Ubuntu 22.04 @ iptables 1.8.7 Error: "iptables: Bad rule (does a matching rule exist in that chain?)."
    const { error: jumpChainError } = await iptables(['-I', 'FORWARD', '-j', 'DOCKER-USER']);
    if (jumpChainError) {
      log.error('IPTABLES: Error inserting FORWARD jump to DOCKER-USER chain');
      // if we can't jump, we need to bail out
      return false;
    }
    log.info('IPTABLES: New rule in FORWARD inserted to jump to DOCKER-USER chain');
  } else {
    log.info('IPTABLES: Jump to DOCKER-USER chain already enabled');
  }

  const rfc1918Networks = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
  const fluxSrc = '172.23.0.0/16';

  const dropParams = (dst) => ['-A', 'DOCKER-USER', '-s', fluxSrc, '-d', dst, '-j', 'DROP'];
  const allowToFluxNetworksParams = (int) => ['-I', 'DOCKER-USER', '-i', int, '-o', int, '-j', 'ACCEPT'];
  const allowEstablishedParams = (dst) => ['-I', 'DOCKER-USER', '-s', fluxSrc, '-d', dst, '-m', 'state', '--state', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'];
  const allowDnsParams = (dst) => ['-I', 'DOCKER-USER', '-s', fluxSrc, '-d', dst, '-p', 'udp', '--dport', '53', '-j', 'ACCEPT'];

  const { error: flushError } = await iptables(['-F', 'DOCKER-USER']);

  if (flushError) {
    log.error(`IPTABLES: Error flushing DOCKER-USER table. ${flushError}`);
    return false;
  }
  log.info('IPTABLES: DOCKER-USER table flushed');

  // add for legacy apps
  fluxNetworkInterfaces.push('docker0');

  // eslint-disable-next-line no-restricted-syntax
  for (const int of fluxNetworkInterfaces) {
    // if this errors, we need to bail, as if the deny succeedes, we may cut off access
    // eslint-disable-next-line no-await-in-loop
    const { error: fluxNetworkError } = await iptables(allowToFluxNetworksParams(int));
    if (fluxNetworkError) {
      log.error(`IPTABLES: Error allowing traffic on Flux interface ${int}. ${fluxNetworkError}`);
      return false;
    }
    log.info(`IPTABLES: Traffic on Flux interface ${int} accepted`);
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const network of rfc1918Networks) {
    // if any of these error, we need to bail, as if the deny succeedes, we may cut off access

    // eslint-disable-next-line no-await-in-loop
    const { error: establishedError } = await iptables(allowEstablishedParams(network));
    if (establishedError) {
      log.error(`IPTABLES: Error allowing access to Flux containers from ${network}. ${establishedError}`);
      return false;
    }
    log.info(`IPTABLES: Access to Flux containers from ${network} accepted`);

    // eslint-disable-next-line no-await-in-loop
    const { error: dnsError } = await iptables(allowDnsParams(network));
    if (dnsError) {
      log.error(`IPTABLES: Error allowing DNS access to ${network} from Flux containers. ${dnsError}`);
      return false;
    }
    log.info(`IPTABLES: DNS access to ${network} from Flux containers accepted`);

    // This always gets appended, so the drop is at the end
    // eslint-disable-next-line no-await-in-loop
    const { error: dropError } = await iptables(dropParams(network));
    if (dropError) {
      log.error(`IPTABLES: Error denying access to ${network} from Flux containers. ${dropError}`);
      return false;
    }
    log.info(`IPTABLES: Access to ${network} from Flux containers removed`);
  }

  const { error: returnError } = await iptables(['-A', 'DOCKER-USER', '-j', 'RETURN']);

  if (returnError) {
    log.error(`IPTABLES: Error adding explicit return to Forward chain. ${returnError}`);
    return false;
  }
  log.info('IPTABLES: DOCKER-USER explicit return to FORWARD chain added');

  // The flush above destroyed the jump to the playground's egress chain along
  // with everything else in DOCKER-USER. The chain itself survives - it is a
  // separate chain for exactly this reason - but without the jump nothing
  // reaches it, and a live session would silently regain unrestricted egress.
  // Re-added last so it sits at the head, ahead of the accepts above.
  const jumped = await playgroundEgress.ensureEgressJump();
  if (!jumped) {
    log.error('IPTABLES: playground egress jump could not be restored after the DOCKER-USER rebuild');
    return false;
  }

  return true;
}

// lruRateLimit has been extracted to ./utils/rateLimit.js
// Re-exported here for backward compatibility.

/**
 * Allow Node to bind to privileged without sudo
 */
async function allowNodeToBindPrivilegedPorts() {
  // setcap needs the path to the binary, so node is located first
  const { error, stdout: nodePath } = await serviceHelper.runCommand('which', {
    params: ['node'],
  });

  if (error) return;

  await serviceHelper.runCommand('setcap', {
    runAsRoot: true,
    params: ['cap_net_bind_service=+ep', nodePath.trim()],
  });
}

/**
 * docker network including mask to allow to verification. For example: 172.23.123.0/24
 * @returns {Promise<void>}
 */
async function allowOnlyDockerNetworksToFluxNodeService() {
  const firewallActive = await isFirewallActive();

  if (!firewallActive) return;

  const fluxAppDockerNetworks = '172.23.0.0/16';
  const { fluxNodeServiceAddress } = config.server;
  // have to use iptables here as ufw won't filter loopback
  const denyRule = ['INPUT', '-i', 'lo', '!', '-s', fluxAppDockerNetworks, '-d', `${fluxNodeServiceAddress}/32`, '-j', 'DROP'];

  try {
    const cmd = await runUfw(['allow', 'from', fluxAppDockerNetworks, 'proto', 'tcp', 'to', `${fluxNodeServiceAddress}/32`, 'port', '16101']);
    if (serviceHelper.ensureString(cmd).includes('updated') || serviceHelper.ensureString(cmd).includes('existing') || serviceHelper.ensureString(cmd).includes('added')) {
      log.info(`Firewall adjusted for network: ${fluxAppDockerNetworks} to address: ${fluxNodeServiceAddress}/32`);
    } else {
      log.warn(`Failed to adjust Firewall for network: ${fluxAppDockerNetworks} to address: ${fluxNodeServiceAddress}/32`);
    }
  } catch (err) {
    log.error(err);
  }

  // a matching rule makes -C exit zero without printing anything, so the exit status is what
  // decides whether the rule is already in place
  const { error: ruleCheckError } = await serviceHelper.runCommand('iptables', {
    runAsRoot: true,
    logError: false,
    params: ['-C', ...denyRule],
  });

  if (!ruleCheckError) {
    log.info(`Firewall already denying access to ${fluxNodeServiceAddress}/32`);
    return;
  }

  // "Bad rule" means the rule simply isn't there yet; anything else is not fixed by inserting it
  if (!ruleCheckError.message.includes('Bad rule')) return;

  const { error: insertError } = await serviceHelper.runCommand('iptables', {
    runAsRoot: true,
    params: ['-I', ...denyRule],
  });

  if (!insertError) log.info(`Firewall adjusted to deny access to: ${fluxNodeServiceAddress}/32`);
}

/**
 * Adds the 169.254 adddress to the loopback interface for use with the flux node service.
 */
async function addFluxNodeServiceIpToLoopback() {
  // could also check exists first with:
  //   ip -f inet addr show lo | grep 169.254.43.43/32
  const ip = config.server.fluxNodeServiceAddress;

  const { error } = await serviceHelper.runCommand('ip', {
    runAsRoot: true,
    logError: false,
    params: ['addr', 'add', `${ip}/32`, 'dev', 'lo'],
  });

  // the address already being on the interface is the normal outcome on a restart
  const ok = !error || error.message.includes('File exists') || error.message.includes('Address already assigned');

  if (ok) {
    log.info(`fluxNodeService IP: ${ip} added to loopback interface`);
    return;
  }

  log.error(error);
  log.warn(`Failed to add fluxNodeService IP ${ip} to loopback interface`);
}

/**
 * Return the number of peers this node is connected to
 */
function getNumberOfPeers() {
  return peerManager.getNumberOfPeers();
}

module.exports = {
  isFluxAvailable,
  checkFluxAvailability,
  getLocalSocketAddress,
  getCachedLocalSocketAddress,
  getFluxNodePrivateKey,
  getFluxNodePublicKey,
  getIncomingConnections,
  getIncomingConnectionsInfo,
  getDOSState,
  setDOSStateApi,
  getNumberOfPeers,
  hasPublicIpOnInterface,
  denyPort,
  deleteAllowPortRule,
  deleteAllowOutPortRule,
  allowPortApi,
  adjustFirewall,
  purgeUFW,
  closeConnection,
  closeIncomingConnection,
  checkFluxbenchVersionAllowed,
  allowPort,
  allowOutPort,
  isFirewallActive,
  resetFirewallActiveCache,
  // Exports for testing purposes
  resetNtpSource,
  parseChronyOffset,
  parseTimesyncOffset,
  setStoredFluxBenchAllowed,
  getStoredFluxBenchAllowed,
  setLocalSocketAddress,
  fluxUptime,
  fluxSystemUptime,
  isCommunicationEstablished,
  lruRateLimit,
  isPortOpen,
  checkAppAvailability,
  isPortEnterprise,
  isPortBanned,
  isPortUPNPBanned,
  allowNodeToBindPrivilegedPorts,
  removeDockerContainerAccessToNonRoutable,
  allowOnlyDockerNetworksToFluxNodeService,
  addFluxNodeServiceIpToLoopback,
  keepUPNPPortsOpen,
  clockDrift,
  getClockDrift,
  initClockOffsetCache,
  getLocalClockOffsetMs,
};
