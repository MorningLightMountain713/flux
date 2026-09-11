'use strict';

/* eslint-disable no-underscore-dangle */
const config = require('config');
const { decodeWIF, privKeyToPubKey } = require('./utils/fluxCryptoUtils');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { EventEmitter, once } = require('events');
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
const fluxEventBus = require('./utils/fluxEventBus');
const cacheManager = require('./utils/cacheManager').default;
const nodeDosState = require('./nodeDosState');
const { NON_PUBLIC_IPV4 } = require('./utils/nonPublicNetworks');
const ufw = require('./utils/ufw');
const ufwHelper = require('./utils/ufwHelper');
const { UDP_PROBE_MAGIC, UDP_PROBE_BYTES } = require('./utils/fluxUdpTestServer');
const {
  normalizeSocketAddress, socketAddressesMatch, parseSocketAddress,
} = require('./utils/socketAddressUtils');
const globalState = require('./utils/globalState');


// Who may hold this node back from placement. An owner is an IDENTITY, not a
// message: the reason is what an operator reads, and the owner is what a release
// is checked against. Adding a feature that holds placement means adding a value
// here, which is the point - an unknown owner is refused rather than accepted as
// a new one.
const PlacementHoldOwner = Object.freeze({
  RESIDENTIAL_DOS: 'residentialDos',
  DATABASE_SUSPECT: 'databaseSuspect',
  HOST_STALL: 'hostStall',
});

// Stops the node taking on NEW apps without declaring it unfit for the ones it
// already runs. DOS conflates those: isNodeDos() makes appSpawner refuse
// installs AND makes nodeStatusMonitor and appStartupManager delete every app on
// the box. A node that must stop growing but keep its customer volumes needs
// only the first, so this is a separate flag whose only consumer is the spawner.
//
// owner -> reason, rather than one slot. A single slot cannot express two
// owners: a second hold OVERWROTE the first, and whoever cleared next released
// both - so the node resumed taking apps for a condition that had not lifted.
// Checking ownership on a single slot only moves the failure, because the
// overwritten owner can then never clear and the node stays held forever. The
// node is held while any owner holds it.
const placementHolds = new Map();

let storedFluxBenchAllowed = null;

const { lruRateLimit } = require('./utils/rateLimit');
const { AsyncGate } = require('./utils/asyncGate');
const { Privilege, authOf } = require('./utils/privileges');

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
// An address reserved for documentation (TEST-NET-3, RFC 5737). No network
// routes it on its own, so the route to it is the route this node's internet
// traffic takes. A well-known address can have a route of its own: a VPN
// client's DNS leak protection sends just its DNS resolver through the tunnel.
const EGRESS_TARGET = '203.0.113.1';
// The last address this node learned. A benchmark that does not answer clears
// localSocketAddress but gives the node no new address, so this keeps it.
let lastKnownSocketAddress = null;
// Emits 'change' with the new address when the node learns one that differs
// from lastKnownSocketAddress, and 'known' with it when the node has an address
// after having none.
const localSocketAddressEvents = new EventEmitter();
// Open while localSocketAddress holds an address.
const localSocketAddressGate = new AsyncGate();

/**
 * The device an os.networkInterfaces() entry is bound on. A labelled address
 * is listed under its label (`eth0:1`), and a label always begins with its
 * device's name followed by a colon.
 * @param {string} name - An os.networkInterfaces() key
 * @returns {string} The device name
 */
function interfaceDevice(name) {
  return name.split(':')[0];
}

/**
 * The device this node's traffic to an address leaves by, as the kernel routes
 * it, every policy rule and routing table included. A UDP connect resolves the
 * route and fixes the source address without sending a packet; the source
 * address names the device. That is the device holding the source address: a
 * route that takes its source from an address on a dummy device or lo names
 * that device, not the one the packets leave through.
 * @param {string} [target] - An IPv4 address; by default one no network routes
 *   on its own, so the answer is the device internet traffic leaves by
 * @returns {Promise<string|null>} The device, or null when the route cannot be
 *   resolved or its source address is on no running interface.
 */
async function egressDevice(target = EGRESS_TARGET) {
  const socket = dgram.createSocket('udp4');
  try {
    // Any port: nothing is sent.
    socket.connect(53, target);
    await once(socket, 'connect');
    const source = socket.address().address;
    const name = Object.entries(os.networkInterfaces())
      .find(([, addresses]) => addresses.some((a) => a.family === 'IPv4' && a.address === source))?.[0];
    return name ? interfaceDevice(name) : null;
  } catch {
    return null;
  } finally {
    socket.close();
  }
}

/**
 * Gets the first routable IPv4 address assigned to a network interface,
 * including addresses bound under a label on it. An interface can carry a
 * private primary and a public secondary; stopping at the first non-internal
 * address would answer for whichever the kernel lists first rather than for
 * the interface.
 * @param {string} interfaceName - The name of the network interface
 * @returns {string|null} The routable IPv4 address or null if none is bound
 */
function getInterfaceIp(interfaceName) {
  const addresses = Object.entries(os.networkInterfaces())
    .filter(([name]) => interfaceDevice(name) === interfaceName)
    .flatMap(([, entries]) => entries);

  for (const addr of addresses) {
    if (addr.family === 'IPv4' && !addr.internal && !serviceHelper.isNonRoutableAddress(addr.address)) {
      return addr.address;
    }
  }
  return null;
}

/**
 * Whether this node holds a public address on the device its traffic leaves by:
 * directly connected, with no NAT between it and the internet.
 * @returns {Promise<boolean|null>} Null when the device cannot be named - no
 *   route out, or its source address on no running interface - which is not
 *   the same answer as "there is none".
 */
async function hasPublicIpOnInterface() {
  const device = await egressDevice();
  if (device === null) {
    log.error('hasPublicIpOnInterface - cannot name the device this node\'s traffic leaves by');
    return null;
  }
  const ip = getInterfaceIp(device);
  if (ip) log.info(`Public IP ${ip} found on ${device}, the device this node's traffic leaves by`);
  return ip !== null;
}

/**
 * To get if port belongs to enterprise range
 * @returns {boolean} Returns true if enterprise
 */
function isPortEnterprise(port) {
  const enterprisePorts = config.get('fluxapps.enterprisePorts');
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
  const bannedPorts = config.get('fluxapps.bannedPorts');
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
  const upnpBannedPorts = config.get('fluxapps.upnpBannedPorts');
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
 * The most a peer will hand back from a port it was asked to read.
 *
 * A DISCLOSURE bound, and only that. The port may be forwarded to a neighbour at
 * the same public address, so what comes back can be a stranger's response, and
 * nobody should be askable to shuttle a payload. Choose it on that question
 * alone.
 *
 * It is NOT what makes the proof survive. The test server writes its secret into
 * the first response header, so the thing the requester has to find sits at byte
 * 67 of an answer that server authors in full - inside this prefix however large
 * the rest of what a port says turns out to be. The two were entangled once: the
 * token was last in the body, and any 48 bytes appearing before it silently
 * turned every install on the network into "a neighbour holds this port".
 */
const MAX_ECHO_BYTES = 256;

/**
 * What a port answered, capped, for the requester to judge.
 *
 * The requester published a secret on its own test server and did NOT tell us
 * what it is: we fetch whatever is on that port and hand it back verbatim, and
 * the requester decides. That direction is the point. This check exists because
 * a peer cannot tell the requester's application from a neighbour's at the same
 * address - so a peer is not in a position to judge, and one that is old,
 * broken or lying cannot manufacture a secret it was never given.
 *
 * Bounded by MAX_ECHO_BYTES, because this relays bytes read from a stranger's
 * port and nobody can be asked to shuttle a payload. That bound cannot cost the
 * requester its answer: the secret is in the first header of a reply the test
 * server writes in full, so it is inside any prefix this returns.
 *
 * @param {string} ip - the requester's address
 * @param {number} port - the port to read
 * @param {object} options - { timeout }
 * @returns {Promise<string|null>} what it answered, or null if nothing did
 */
async function portAnswered(ip, port, options = {}) {
  const timeout = options.timeout || 5_000;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let received = '';
    let settled = false;

    const done = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };

    const timer = setTimeout(() => done(received || null), timeout);

    socket.connect(port, ip, () => {
      socket.write(`GET / HTTP/1.1\r\nHost: ${ip}:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.length >= MAX_ECHO_BYTES) done(received.slice(0, MAX_ECHO_BYTES));
    });
    socket.on('end', () => done(received || null));
    socket.on('error', () => done(null));
  });
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
 * When each datagram of a UDP probe is sent, in ms from the first. UDP drops
 * packets and loss comes in bursts, so the sends are spread rather than sent
 * together.
 */
const UDP_PROBE_SCHEDULE_MS = [0, 250, 750, 1750];

/** How long a UDP probe waits for a reply after its first datagram. */
const UDP_PROBE_DEADLINE_MS = 3_000;

/**
 * What a UDP port answered, capped, for the requester to judge - the UDP twin
 * of portAnswered.
 *
 * UDP has no handshake, so silence is all a closed port and a lost datagram
 * ever say. The requester's test server answers a probe with its secret, and
 * only that tells the requester the port is reachable; this hands back what
 * came, and the requester compares.
 *
 * The reply is taken from whatever source port it arrives from: a NAT in front
 * of the requester may rewrite it.
 *
 * @param {string} ip - the requester's address
 * @param {number} port - the port to probe
 * @param {{schedule?: number[], deadline?: number}} [options]
 * @returns {Promise<string|null|undefined>} what it answered; null when probes
 *   went out and nothing came back; undefined when no probe could be sent, which
 *   says nothing about the port
 */
async function portAnsweredUdp(ip, port, options = {}) {
  const schedule = options.schedule ?? UDP_PROBE_SCHEDULE_MS;
  const deadline = options.deadline ?? UDP_PROBE_DEADLINE_MS;

  const probe = Buffer.alloc(UDP_PROBE_BYTES);
  probe.write(UDP_PROBE_MAGIC, 'latin1');

  const socket = dgram.createSocket('udp4');

  return new Promise((resolve) => {
    const timers = [];
    let settled = false;
    let sent = 0;
    let failed = 0;

    const done = (answer) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      socket.close();
      resolve(answer);
    };

    const afterSend = (error) => {
      if (!error) {
        sent += 1;
        return;
      }
      failed += 1;
      if (failed === schedule.length) done(undefined);
    };

    socket.on('message', (message, rinfo) => {
      if (rinfo.address.replace(/^::ffff:/i, '') !== ip) return;
      done(message.subarray(0, MAX_ECHO_BYTES).toString('utf8'));
    });
    socket.on('error', () => done(undefined));

    schedule.forEach((at) => {
      timers.push(setTimeout(() => socket.send(probe, port, ip, afterSend), at));
    });
    timers.push(setTimeout(() => done(sent ? null : undefined), deadline));
  });
}

/**
 * Runs `task` once per item, at most `limit` at a time.
 * @param {Array} items
 * @param {number} limit
 * @param {function(*): Promise<void>} task
 * @returns {Promise<void>}
 */
async function forEachLimited(items, limit, task) {
  const queue = [...items];
  async function worker() {
    while (queue.length) {
      // eslint-disable-next-line no-await-in-loop
      await task(queue.shift());
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * To perform a basic check of current FluxOS version.
 * @param {string} ip IP address.
 * @param {string} port Port. Defaults to config.server.apiport.
 * @returns {Promise<boolean>} False unless FluxOS version meets or exceeds the minimum allowed version.
 */
async function isFluxAvailable(ip, port = config.get('server.apiport')) {
  const axiosConfig = {
    timeout: 5000,
  };

  try {
    const ipchars = /^[0-9.]+$/;
    if (!ipchars.test(ip)) {
      throw new Error('Invalid IP');
    }
    if (!config.get('server.allowedPorts').includes(+port)) {
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
    const versionMinOK = serviceHelper.semverAtLeast(fluxVersion, config.get('minimumFluxOSAllowedVersion'));
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
/**
 * Whether a signed body - asked or answered - carries a signature from a
 * Fluxnode on the deterministic list, over its own contents.
 *
 * Extracted rather than written twice. Two copies of a signature check is the
 * one duplication that must not drift - whichever copy is corrected, the other
 * keeps accepting what it always did, and nothing points at it.
 *
 * The body is verified as it arrived minus the signature itself, which is how
 * the sender built the message it signed.
 *
 * `socketAddress` binds the signer to a place, and the two directions need
 * different answers. For a request, "some listed Fluxnode signed this" is the
 * whole question - any node on the list may ask. For an ANSWER it is not enough:
 * we dialled one address, and what comes back has to be from the node that lives
 * there rather than a signature made by, or relayed from, somewhere else.
 *
 * @param {object} processedBody The parsed body, carrying pubKey and signature
 * @param {{socketAddress?: string}} [options] The address the signer must hold
 * @returns {Promise<boolean>} True when a listed Fluxnode signed this body
 */
async function verifySignedFluxnodeMessage(processedBody, options = {}) {
  if (!processedBody || !processedBody.pubKey || !processedBody.signature) return false;

  const { pubKey, signature } = processedBody;

  const nodes = await fluxCommunicationUtils.deterministicFluxList({ filter: pubKey });
  if (!nodes.length) return false;

  const { socketAddress = null } = options;
  if (socketAddress && !nodes.some((node) => socketAddressesMatch(node.ip, socketAddress))) return false;

  const dataToVerify = { ...processedBody };
  delete dataToVerify.signature;

  return verificationHelper.verifyMessage(JSON.stringify(dataToVerify), pubKey, signature) === true;
}

/**
 * The most ports one request may ask this node to test.
 *
 * An application is capped at maxComponents (10) components of ports (5) each in
 * appValidator, so 50 is the largest honest ask. The bound exists because the
 * ports are tested one after another, each for up to a full connect timeout.
 */
const MAX_TESTABLE_PORTS = 50;

// Every installed application's ports plus the four node service ports the
// keep-alive caller adds - maxAppsPerNode x MAX_TESTABLE_PORTS + 4. A bound on
// how long one request can keep this node poking, and nothing tighter: the
// honest list really can be that long.
const NODE_SERVICE_PORTS_KEPT_ALIVE = 4;

/**
 * How many of one request's ports a peer probes at once, where it probes them
 * in parallel: UDP always, TCP when asked for every port's answer. A port that
 * never answers costs a full probe timeout, and 50 of them one after another
 * would outlast the requester's wait.
 */
const PORT_PROBE_CONCURRENCY = 16;
const MAX_KEEPALIVE_PORTS = config.get('fluxapps.maxAppsPerNode') * MAX_TESTABLE_PORTS + NODE_SERVICE_PORTS_KEPT_ALIVE;

/**
 * The address a peer endpoint acts on: the one the caller connected from, or the
 * one it named when it holds the privilege to name one.
 *
 * Never an input otherwise. A caller that names the address chooses where this
 * node connects, which makes the endpoint a probe aimed at anything the caller
 * likes - the loopback and the RFC1918 side of its own router included. The
 * honest caller never needed it: it is asking about ITS OWN ports, so the
 * address it means is the one it is connecting from. That is the rule
 * /flux/addpeer already applies, and every inbound peer is already identified by
 * its socket address - a Fluxnode whose egress differed from its declared
 * address could not hold a peer slot anywhere on the network, so nothing
 * legitimate is lost by insisting on it.
 *
 * An IPv4 connection to a dual-stack listener arrives as ::ffff:a.b.c.d, and an
 * address that does not match itself would refuse every honest caller.
 *
 * @param {object} req
 * @param {string|undefined} namedAddress - what the body says, if anything
 * @param {boolean} mayName - whether this caller may choose the address
 * @returns {string} the address, or '' when there is none to act on
 */
function addressToProbe(req, namedAddress, mayName) {
  const remoteIp = (req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  return mayName === true ? (namedAddress || remoteIp) : remoteIp;
}

async function checkAppAvailability(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      // The other way in. This endpoint's caller is a Fluxnode proving itself by
      // signature; this is for a PERSON driving it by hand instead, and the only
      // thing a person gets out of it is naming the address to probe below -
      // asking whether the ports are open on the machine they happen to be
      // sitting at answers nothing anyone wants. Skipping the signature and
      // choosing the address are therefore one question, and it is asked once.
      //
      // Not the node operator. NODE_OPERATOR_OR_FLUX_TEAM reads node-local and is
      // not: it is thousands of separate credentials, one per node, holding what
      // is a Flux team diagnostic. An operator wanting to dial out of their own
      // box has a shell on it, and their node still reaches this endpoint the way
      // every node does - by signing.
      const authorized = await verificationHelper.verifyPrivilege(Privilege.FLUX_TEAM, authOf(req));

      const processedBody = serviceHelper.ensureObject(body);

      const { ports } = processedBody;

      const ipPort = processedBody.port;

      // pubkey of the message has to be on the list
      const verified = await verifySignedFluxnodeMessage(processedBody);
      if (!verified && authorized !== true) {
        throw new Error('Unable to verify request authenticity');
      }

      // The address to probe is NOT an input - see addressToProbe. Here the
      // stakes are highest: the echo below hands back the first bytes of what
      // answered, so a body-supplied address turns every Flux node into a fetch
      // primitive aimed at anything a signed peer likes. The range guard does
      // not help: portMin is 1 and portMax is 65535, and bannedPorts names this
      // node's own services rather than a database's.
      //
      // Flux team may still name one, which is the whole of what the privilege
      // above is for: see it.
      const ip = addressToProbe(req, processedBody.ip, authorized);

      if (!ip) {
        throw new Error('Unable to determine which address to test');
      }

      if (!Array.isArray(ports)) {
        throw new Error('No ports to test');
      }

      // A valid application cannot hold more ports than the specification allows
      // it: maxComponents (10) x ports per component (5) = 50, both in
      // appValidator. Bounded at all because each port below costs up to a full
      // connect timeout and they are tested in sequence.
      if (ports.length > MAX_TESTABLE_PORTS) {
        throw new Error(`Too many ports to test. Maximum of ${MAX_TESTABLE_PORTS} allowed.`);
      }

      const minPort = config.get('fluxapps.portMin');
      const maxPort = config.get('fluxapps.portMax');

      // A requester that wants proof asks for it. One that does not - an older
      // node - gets exactly the check it always got.
      const echo = processedBody.echo === true;
      // Every port read and answered for, a port that did not answer reading
      // null, rather than the test ending at the first port that failed. Only
      // with echo: the answers are what it returns.
      const everyPort = echo && processedBody.everyPort === true;
      // The protocols to test each port over. TCP alone when the caller names
      // none; with both, UDP is probed once TCP has passed.
      const protocols = processedBody.protocols ?? ['tcp'];
      if (!Array.isArray(protocols) || !protocols.length || !protocols.every((protocol) => protocol === 'tcp' || protocol === 'udp')) {
        throw new Error('Protocols to test must be tcp, udp or both');
      }
      const tcp = protocols.includes('tcp');
      const udp = protocols.includes('udp');
      const answered = {};

      const testable = ports.filter((port) => {
        const iBP = isPortBanned(+port);
        const portNum = +port;
        const withinRange = portNum >= minPort && portNum <= maxPort;
        if (!withinRange || iBP) {
          log.error(`Flux App port ${port} is outside allowed range. minPort: ${minPort}, maxPort: ${maxPort}, isBanned: ${iBP}`);
        }
        return withinRange && !iBP;
      });

      if (tcp && everyPort) {
        await forEachLimited(testable, PORT_PROBE_CONCURRENCY, async (port) => {
          answered[port] = await portAnswered(ip, port);
        });
      } else if (tcp) {
        // eslint-disable-next-line no-restricted-syntax
        for (const port of testable) {
          if (echo) {
            // Read rather than merely reached. The requester compares.
            // eslint-disable-next-line no-await-in-loop
            const answer = await portAnswered(ip, port);
            if (answer === null) {
              throw new Error(`Flux Applications on ${ip}:${ipPort} are not available. Failed port: ${port}`);
            }
            answered[port] = answer;
          } else {
            // eslint-disable-next-line no-await-in-loop
            const isOpen = await isPortOpen(ip, port);
            if (!isOpen) {
              throw new Error(`Flux Applications on ${ip}:${ipPort} are not available. Failed port: ${port}`);
            }
          }
        }
      }

      // A port this node could not send to is left out: that says nothing about
      // the port, and the requester reads an absent port as no proof.
      const udpAnswered = {};
      if (udp) {
        await forEachLimited(testable, PORT_PROBE_CONCURRENCY, async (port) => {
          const reply = await portAnsweredUdp(ip, +port);
          if (reply !== undefined) udpAnswered[port] = reply;
        });
      }
      const successResponse = messageHelper.createSuccessMessage(`Flux Applications on ${ip}:${ipPort} are available.`);
      // `answered` present at all is how the requester knows this peer READ the
      // ports rather than merely reaching them. Absent means no proof is
      // available from this peer, which is not the same as the ports being bad.
      // Added as a field rather than through createSuccessMessage, whose second
      // and third parameters are name and code.
      if (echo && tcp) successResponse.data.answered = answered;
      // Present at all says this peer probed UDP, as `answered` does for TCP.
      if (udp) successResponse.data.udpAnswered = udpAnswered;
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
/**
 * POST /flux/keepupnpportsopen - poke the caller's ports so its router keeps the
 * UPnP mappings for them alive.
 *
 * The address poked is the one the caller connected from, never one it names -
 * the rule /flux/checkappavailability applies, for the reason on addressToProbe.
 * Naming one by hand is the same single privilege as skipping the signature:
 * Flux team, not one every node operator holds. The API port stays the caller's
 * to name, being a port on the address just bound.
 *
 * NO range or banned-port filter on the ports, deliberately, and unlike the
 * availability endpoint beside this one. The caller sends its own service ports
 * alongside its application ports - the API port minus one, minus five, plus one
 * and plus two - and every one of those sits inside the banned 16100-16299
 * block. The filter that is right there would silently end the keep-alive here.
 *
 * @param {object} req
 * @param {object} res
 */
async function keepUPNPPortsOpen(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.FLUX_TEAM, authOf(req));

    const { body } = req;
    const processedBody = serviceHelper.ensureObject(body);

    const { apiPort, ports, timestamp } = processedBody;

    const now = Math.floor(Date.now() / 1000);

    // allow 10 minutes for clock drift. Prevent packet from being replayed.
    if (!Number.isInteger(timestamp) || timestamp + 600 < now) {
      res.status(422).end();
      return;
    }

    if (!apiPort) {
      res.status(422).end();
      return;
    }

    if (!Array.isArray(ports) || ports.length > MAX_KEEPALIVE_PORTS) {
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
    const verified = await verifySignedFluxnodeMessage(processedBody);
    if (!verified && authorized !== true) {
      res.status(401).end();
      throw new Error('Unable to verify request authenticity');
    }

    const ip = addressToProbe(req, processedBody.ip, authorized);
    if (!ip) {
      res.status(422).end();
      return;
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
  const wasKnown = localSocketAddressGate.ready;
  localSocketAddress = value ? normalizeSocketAddress(value) : null;
  // (Re)set the freshness deadline whenever the value changes, so getLocalSocketAddress
  // serves it without a benchmark RPC until it goes stale (cleared when set to null).
  localSocketAddressFreshUntil = localSocketAddress ? process.hrtime.bigint() + LOCAL_SOCKET_ADDRESS_TTL_NS : 0n;
  if (localSocketAddress) localSocketAddressGate.open();
  else localSocketAddressGate.close();
  // Told here because this is the one place the node learns what it is. The
  // peer manager needs it to keep this node out of its own peer draws - a node
  // that syncs from itself learns nothing, and it spends one of very few
  // attempts doing so. Optional because the unit suite stubs peerState.
  peerManager.setOwnSocketAddress?.(localSocketAddress);
  if (localSocketAddress && localSocketAddress !== lastKnownSocketAddress) {
    lastKnownSocketAddress = localSocketAddress;
    localSocketAddressEvents.emit('change', localSocketAddress);
  }
  if (localSocketAddress && !wasKnown) localSocketAddressEvents.emit('known', localSocketAddress);
}

/**
 * @returns {string|null} The last address this node learned (ip:port), without
 *   asking the benchmark; null before the first.
 */
function getKnownLocalSocketAddress() {
  return lastKnownSocketAddress;
}

/**
 * This node's socket address, once it has one. Resolves as soon as benchmark
 * reports an address to any caller of getLocalSocketAddress; while none is known
 * the own-standing watch keeps asking for one.
 * @returns {Promise<string>} ip:port
 */
async function waitForLocalSocketAddress() {
  let address = await getLocalSocketAddress();
  while (!address) {
    // eslint-disable-next-line no-await-in-loop
    await localSocketAddressGate.wait();
    address = localSocketAddress;
  }
  return address;
}

/**
 * @param {function(string): void} listener Called with the new address (ip:port)
 *   each time the node learns an address that differs from the last one.
 * @returns {void}
 */
function onLocalSocketAddressChange(listener) {
  localSocketAddressEvents.on('change', listener);
}

/**
 * @param {function(string): void} listener
 * @returns {void}
 */
function offLocalSocketAddressChange(listener) {
  localSocketAddressEvents.off('change', listener);
}

/**
 * @param {function(string): void} listener Called with the address each time the
 *   node has one after having none.
 * @returns {void}
 */
function onLocalSocketAddressKnown(listener) {
  localSocketAddressEvents.on('known', listener);
}



// Whether this node's ports answer over UDP, as the availability check last
// established it with a peer's proof or two peers' silence; null until it has.
let udpReachability = null;

/**
 * @param {{reachable: boolean, port?: number, peers?: string[]}|null} value
 */
function setUdpReachability(value) {
  udpReachability = value;
}

/**
 * @returns {{reachable: boolean, port?: number, peers?: string[]}|null}
 */
function getUdpReachability() {
  return udpReachability;
}





/**
 * The DOS state a reader sees. A held node reports the sticky verdict; an
 * unheld one reports what the availability checks have counted.
 * @returns {number}
 */
function effectiveDosState() {
  return nodeDosState.getDosStateValue();
}

/**
 * Hold this node back from new placements. Idempotent per owner.
 * @param {string} owner A PlacementHoldOwner value. An unknown one throws: it is
 * a caller that was never given an identity, and accepting it would create an
 * owner nothing can ever release.
 * @param {string} reason Logged and reported.
 */
function setPlacementHold(owner, reason) {
  if (!Object.values(PlacementHoldOwner).includes(owner)) {
    throw new Error(`setPlacementHold: unknown owner ${owner}`);
  }
  if (placementHolds.get(owner) === reason) return;
  placementHolds.set(owner, reason);
  log.info(`Placement hold set by ${owner}: ${reason}`);
  fluxEventBus.publish('placementHold:set', { owner, reason });
}

/**
 * Release one owner's hold. Any other owner's hold stands, and the node stays
 * held until every one of them has released - so a feature clearing its own
 * condition can never speak for a condition it knows nothing about.
 * @param {string} owner A PlacementHoldOwner value.
 */
function clearPlacementHold(owner) {
  const reason = placementHolds.get(owner);
  if (reason === undefined) return;
  placementHolds.delete(owner);
  log.info(`Placement hold cleared by ${owner} (was: ${reason})`);
  fluxEventBus.publish('placementHold:cleared', { owner, reason });
}

/**
 * @returns {string|null} Why the node is held, or null when it is not.
 */
function getPlacementHold() {
  if (!placementHolds.size) return null;
  // Every reason, not an arbitrary one: the spawner logs this to say why the
  // node is not installing, and naming one of two holds would send an operator
  // to lift a condition that would not release the node.
  return [...placementHolds.values()].join('; ');
}

/**
 * @returns {boolean} True when this node must not take on new apps.
 */
function isPlacementHeld() {
  return placementHolds.size > 0;
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
async function getLocalSocketAddress(options = {}) {
  // A CALLER THAT IS PROBING, NOT IDENTIFYING, ASKS FOR `fresh`. The cache answers
  // "what is this node's address", and for the callers below that is all the
  // question is. It is not all of it for a caller reading the ANSWER'S ABSENCE as a
  // fact about the benchmark daemon: served from memory, a null that meant "the
  // daemon did not answer" becomes the last address it ever gave, and the caller
  // reads a dead daemon as a live one for as long as the window lasts.
  const { fresh = false } = options;

  // Serve the cached own-IP without a benchmark RPC while it is still fresh. A batch
  // cancel/install issues this call once per app on a hot serialized path (the explorer
  // block loop) and the value is invariant across the batch, so this collapses N RPCs to
  // one. A null (unresolved) value is never cached. The IP-change detector
  // (checkMyFluxAvailability) reads the module-scoped localSocketAddress + getPublicIp()
  // DIRECTLY, not through this function, so a <=TTL reflect-lag here after a (rate-limited)
  // IP change is harmless — the next benchmark resolve updates the value and the deadline.
  if (!fresh && localSocketAddress && process.hrtime.bigint() < localSocketAddressFreshUntil) {
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
    localSocketAddressEvents.emit('unresolved');
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
  if (privatekey) return privatekey;
  // flux.conf is a local file, and deriving this node's key from it needs no daemon. Asked
  // for here rather than assumed: nothing parses it at boot, so before this the value was
  // available only once some other code had made an RPC and loaded the config on the way
  // past - which made a key that was always on disk look like a daemon that was not up.
  await daemonServiceUtils.ensureConfigLoaded();
  return daemonServiceUtils.getConfigValue('zelnodeprivkey');
}

/**
 * To get FluxNode public key.
 * @param {string} privatekey Private key.
 * @returns {string} Public key.
 */
async function getFluxNodePublicKey(privatekey) {
  try {
    const pkWIF = await getFluxNodePrivateKey(privatekey);
    const { privateKey, compressed } = decodeWIF(pkWIF);
    const pubKey = privKeyToPubKey(privateKey, compressed);
    return pubKey;
  } catch (error) {
    // Null, not the Error. An Error here is the worst of both: truthy, so a
    // guard on the value passes; not a string, so nothing type-based notices;
    // and `{}` once JSON.stringify reaches it - which is how a node with a
    // briefly unavailable key went on broadcasting messages that every peer
    // silently refused. Said out loud too, because it was silent at the point
    // it happened and loud only at the far end.
    log.error(`getFluxNodePublicKey - unable to derive this node's public key: ${error.message || error}`);
    return null;
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
  // Evicted rather than closed: the caller asked for this peer to be gone, and
  // until it leaves the map it still fills a slot no reconnect is dialled for
  // and is still offered as a sync source.
  peerManager.evict(key, CLOSE_CODES.CLOSED_OUTBOUND, 'purposefully closed');
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
  peerManager.evict(key, CLOSE_CODES.CLOSED_INBOUND, 'purposefully closed');
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
 * Whether the NodeJS this process runs on meets the network minimum. FluxOS
 * calls runtime APIs that do not exist below it, so such a node cannot serve
 * correctly however healthy the rest of it looks.
 *
 * Asked once, at startup: the version is a property of the running process and
 * cannot change under it, so re-asking costs work to learn what is already
 * known. The verdict is a STICKY hold for the same reason - a good availability
 * pass ends in setDosMessage(null), which would clear an ordinary message and
 * let the node walk back into service on a runtime that cannot run the code.
 * A hold survives that, and is held by this check alone, so the answer is
 * stated once and stands until the node boots on a runtime that satisfies it.
 * @returns {boolean} True if the runtime is allowed. Otherwise false.
 */
function checkNodeJsVersionAllowed() {
  const minimumVersion = config.minimumNodeJsAllowedVersion;
  // No floor configured is not a failing node. This runs bare in
  // startFluxFunctions, whose catch re-enters it after 15s, so a throw here is
  // a boot loop rather than an error - and the safe direction for a missing
  // floor is to allow, never to take the fleet out of service.
  if (!minimumVersion) {
    log.error('checkNodeJsVersionAllowed - no minimum NodeJS version configured, skipping the check');
    return true;
  }
  const nodeJsVersion = process.versions.node;
  if (serviceHelper.semverAtLeast(nodeJsVersion, minimumVersion)) {
    return true;
  }
  nodeDosState.setStickyDos(
    nodeDosState.StickyDosOwner.NODEJS_FLOOR,
    `NodeJS Version Error. Current lower version allowed is v${minimumVersion} found v${nodeJsVersion}`,
  );
  return false;
}

/**
 * Whether the Docker this node runs meets the network minimum: the oldest
 * release FluxOS supports, whose networking rules the container firewall and
 * the app port rules are tested against.
 *
 * Asked once, when Docker first answers at startup. Upgrading Docker restarts
 * Docker, not FluxOS, so the verdict stands until FluxOS next starts, and the
 * message says so. A version that could not be read, or is not a SemVer
 * version, gives no verdict: a Docker API failing for a moment, or a build
 * naming itself oddly, is not a node below the floor. A pre-release is below
 * its release (28.1.1-rc.1 < 28.1.1).
 * @param {?string} dockerVersion The version Docker reports, or null when it
 *   could not be read.
 * @returns {boolean} True unless the version is known and below the floor.
 */
function checkDockerVersionAllowed(dockerVersion) {
  const minimumVersion = config.minimumDockerAllowedVersion;
  // As with the NodeJS floor: no floor configured allows, never refuses.
  if (!minimumVersion) {
    log.error('checkDockerVersionAllowed - no minimum Docker version configured, skipping the check');
    return true;
  }
  if (!dockerVersion) {
    log.error('checkDockerVersionAllowed - Docker did not report its version, no verdict');
    return true;
  }
  if (!serviceHelper.parseSemver(dockerVersion)) {
    log.error(`checkDockerVersionAllowed - Docker reported ${dockerVersion}, which is not a SemVer version, no verdict`);
    return true;
  }
  if (serviceHelper.semverAtLeast(dockerVersion, minimumVersion)) {
    return true;
  }
  nodeDosState.setStickyDos(
    nodeDosState.StickyDosOwner.DOCKER_FLOOR,
    `Docker Version Error. Current lower version allowed is v${minimumVersion} found v${dockerVersion}. Upgrade Docker and restart FluxOS`,
  );
  return false;
}

/**
 * Whether this node's cgroups are the ones FluxOS runs apps in: cgroup v2,
 * a kernel that can kill a whole cgroup (cgroup.kill, Linux 5.14), and Docker
 * placing containers through systemd. App slices, CPU burst and the kill a
 * host stall makes all rely on the three.
 *
 * Asked once, when Docker first answers at startup. The kernel's answers are
 * read from the cgroup filesystem: cgroup.kill is asked of FluxOS's own cgroup,
 * which /proc/self/cgroup names and which is never the root, the one cgroup
 * without the file. A driver that could not be read gives no verdict on the
 * driver.
 * @param {?string} cgroupDriver The cgroup driver Docker reports, or null when
 *   it could not be read.
 * @param {{cgroupRoot?: string, selfCgroupFile?: string}} [paths] Where the
 *   cgroup filesystem is mounted, and the file naming this process's cgroup.
 * @returns {Promise<boolean>} True unless a requirement is known to be unmet.
 */
async function checkCgroupsAllowed(cgroupDriver, { cgroupRoot = '/sys/fs/cgroup', selfCgroupFile = '/proc/self/cgroup' } = {}) {
  const exists = (file) => fs.access(path.join(cgroupRoot, file)).then(() => true, () => false);
  // cgroup v2 lists one line, 0::<path>
  const ownCgroup = (await fs.readFile(selfCgroupFile, 'utf8').catch(() => '')).match(/^0::(\/.*)$/m)?.[1];
  const unmet = [];
  if (!await exists('cgroup.controllers')) unmet.push('cgroup v2');
  else if (!ownCgroup || !await exists(path.join(ownCgroup, 'cgroup.kill'))) unmet.push('cgroup.kill (Linux 5.14 or later)');
  if (cgroupDriver === null) {
    log.error('checkCgroupsAllowed - Docker did not report its cgroup driver, no verdict on it');
  } else if (cgroupDriver !== 'systemd') {
    unmet.push(`Docker's systemd cgroup driver (found ${cgroupDriver})`);
  }
  if (!unmet.length) return true;
  nodeDosState.setStickyDos(
    nodeDosState.StickyDosOwner.CGROUP_FLOOR,
    `Cgroup Error. FluxOS requires cgroup v2, cgroup.kill and Docker's systemd cgroup driver; missing: ${unmet.join(', ')}. Fix the host and restart FluxOS`,
  );
  return false;
}

/**
 * Whether the MongoDB this node runs meets the network minimum: the oldest
 * release FluxOS supports.
 *
 * Asked once, when MongoDB first answers at startup. Upgrading MongoDB
 * restarts mongod, not FluxOS, so the verdict stands until FluxOS next starts,
 * and the message says so. A version that could not be read, or is not a
 * SemVer version, gives no verdict. A pre-release is below its release.
 * @param {?string} mongoDbVersion The version MongoDB reports, or null when it
 *   could not be read.
 * @returns {boolean} True unless the version is known and below the floor.
 */
function checkMongoDbVersionAllowed(mongoDbVersion) {
  const minimumVersion = config.minimumMongoDbAllowedVersion;
  if (!minimumVersion) {
    log.error('checkMongoDbVersionAllowed - no minimum MongoDB version configured, skipping the check');
    return true;
  }
  if (!mongoDbVersion) {
    log.error('checkMongoDbVersionAllowed - MongoDB did not report its version, no verdict');
    return true;
  }
  if (!serviceHelper.parseSemver(mongoDbVersion)) {
    log.error(`checkMongoDbVersionAllowed - MongoDB reported ${mongoDbVersion}, which is not a SemVer version, no verdict`);
    return true;
  }
  if (serviceHelper.semverAtLeast(mongoDbVersion, minimumVersion)) {
    return true;
  }
  nodeDosState.setStickyDos(
    nodeDosState.StickyDosOwner.MONGODB_FLOOR,
    `MongoDB Version Error. Current lower version allowed is v${minimumVersion} found v${mongoDbVersion}. Upgrade MongoDB and restart FluxOS`,
  );
  return false;
}

const FLUXBENCH_VERSION_MESSAGE_PREFIX = 'Fluxbench Version Error.';

/**
 * Ends the node's DOS when the message standing is one `owns` recognises.
 * @param {function(string): boolean} owns
 * @returns {void}
 */
function releaseDosOwnedBy(owns) {
  if (!nodeDosState.getRawDosMessage() || !owns(nodeDosState.getRawDosMessage())) return;
  nodeDosState.setDosStateValue(0);
  nodeDosState.setDosMessage(null);
}

/**
 * To check if Flux benchmark version is allowed.
 * @returns {boolean} True if version is verified as allowed. Otherwise false.
 */
async function checkFluxbenchVersionAllowed() {
  if (storedFluxBenchAllowed) {
    const versionOK = serviceHelper.semverAtLeast(storedFluxBenchAllowed, config.get('minimumFluxBenchAllowedVersion'));
    if (versionOK) releaseDosOwnedBy((message) => message.startsWith(FLUXBENCH_VERSION_MESSAGE_PREFIX));
    return versionOK;
  }
  try {
    const benchmarkInfoResponse = await benchmarkService.getInfo();
    if (benchmarkInfoResponse.status === 'success') {
      const benchmarkVersion = benchmarkInfoResponse.data.version;
      log.info(`Running benchmark version: ${benchmarkVersion}`);
      setStoredFluxBenchAllowed(benchmarkVersion);
      const versionOK = serviceHelper.semverAtLeast(benchmarkVersion, config.get('minimumFluxBenchAllowedVersion'));
      if (versionOK) {
        releaseDosOwnedBy((message) => message.startsWith(FLUXBENCH_VERSION_MESSAGE_PREFIX));
        return true;
      }
      nodeDosState.addDosState(11);
      nodeDosState.setDosMessage(`Fluxbench Version Error. Current lower version allowed is v${config.get('minimumFluxBenchAllowedVersion')} found v${benchmarkVersion}`);
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
  const { outboundCount, inboundCount } = peerManager;
  let message;
  if (outboundCount < config.get('fluxapps.minOutgoing')) { // easier to establish
    message = messageHelper.createErrorMessage(`Not enough outgoing connections established to Flux network. Minimum required ${config.get('fluxapps.minOutgoing')} found ${outboundCount}`);
  } else if (inboundCount < config.get('fluxapps.minIncoming')) { // depends on other nodes successfully connecting to my node, todo enforcement
    message = messageHelper.createErrorMessage(`Not enough incoming connections from Flux network. Minimum required ${config.get('fluxapps.minIncoming')} found ${inboundCount}`);
  } else {
    const uniqueOutboundIps = new Set();
    for (const peer of peerManager.outboundValues()) uniqueOutboundIps.add(peer.ip);
    if (uniqueOutboundIps.size < config.get('fluxapps.minUniqueIpsOutgoing')) {
      message = messageHelper.createErrorMessage(`Not enough outgoing unique ip's connections established to Flux network. Minimum required ${config.get('fluxapps.minUniqueIpsOutgoing')} found ${uniqueOutboundIps.size}`);
    } else {
      const uniqueInboundIps = new Set();
      for (const peer of peerManager.inboundValues()) uniqueInboundIps.add(peer.ip);
      if (uniqueInboundIps.size < config.get('fluxapps.minUniqueIpsIncoming')) {
        message = messageHelper.createErrorMessage(`Not enough incoming unique ip's connections from Flux network. Minimum required ${config.get('fluxapps.minUniqueIpsIncoming')} found ${uniqueInboundIps.size}`);
      } else {
        message = messageHelper.createSuccessMessage('Communication to Flux network is properly established');
      }
    }
  }
  return res ? res.json(message) : message;
}

// How far back the limit on IP changes counts, and how many changes it allows
// in that time.

/**
 * To get DOS state.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
function getDOSState(req, res) {
  const data = {
    dosState: effectiveDosState(),
    dosMessage: nodeDosState.getDosMessage(),
  };
  const message = messageHelper.createDataMessage(data);
  return res ? res.json(message) : message;
}

async function setDOSStateApi(req, res) {
  if (!config.has('testEventStream') || config.get('testEventStream') !== true) {
    return res.status(404).json({ status: 'error', data: { message: 'Not available' } });
  }
  const authorized = await verificationHelper.verifyPrivilege(Privilege.FLUX_TEAM, authOf(req));
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
  return res.json(messageHelper.createSuccessMessage({ dosState: nodeDosState.getDosStateValue(), dosMessage: nodeDosState.getRawDosMessage() }));
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
  const ran = await ufw.runUfw(['allow', String(port)]);
  if (ran.locked) {
    cmdStat.message = 'ufw is locked by another ufw command';
    return cmdStat;
  }
  const cmdres = ran.stdout + ran.stderr;
  cmdStat.message = cmdres;
  if (cmdres.includes('updated') || cmdres.includes('added')) {
    cmdStat.status = true;
  } else if (cmdres.includes('existing')) {
    cmdStat.status = true;
    cmdStat.message = 'existing';
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

// The ufw rule that admits IPv4 clients of one protocol to a port FluxOS opens
// for a moment, to test it from outside, and nothing else. ufw counts a rule that
// names no protocol as the same rule as the matching half of an app port's
// `allow <port>`, so a test that opened and deleted one would delete that half;
// a rule naming its protocol is a rule of its own.
const testPortRule = (port, protocol) => ['proto', protocol, 'from', '0.0.0.0/0', 'to', 'any', 'port', String(port)];

const TEST_PORT_PROTOCOLS = ['tcp', 'udp'];

/**
 * Opens a port to IPv4 clients of one protocol while FluxOS tests it from
 * outside: the only rule for the port that deleteTestPortRule deletes.
 * @param {number|string} port Port.
 * @param {string} [protocol] 'tcp' or 'udp'.
 * @returns {Promise<{status: boolean, message: (string|null)}>}
 */
async function allowTestPort(port, protocol = 'tcp') {
  if (Number.isNaN(+port)) return { status: false, message: 'Port needs to be a number' };
  if (!TEST_PORT_PROTOCOLS.includes(protocol)) return { status: false, message: 'Protocol needs to be tcp or udp' };
  const ran = await ufw.runUfw(['allow', ...testPortRule(port, protocol)]);
  if (ran.locked) return { status: false, message: 'ufw is locked by another ufw command' };
  const cmdres = ran.stdout + ran.stderr;
  return { status: /added|updated|existing/.test(cmdres), message: cmdres };
}

/**
 * Deletes the rule allowTestPort writes for a protocol, and no other rule for
 * the port. A rule already gone counts as deleted.
 * @param {number|string} port Port.
 * @param {string} [protocol] 'tcp' or 'udp'.
 * @returns {Promise<{status: boolean, message: (string|null)}>}
 */
async function deleteTestPortRule(port, protocol = 'tcp') {
  if (Number.isNaN(+port)) return { status: false, message: 'Port needs to be a number' };
  if (!TEST_PORT_PROTOCOLS.includes(protocol)) return { status: false, message: 'Protocol needs to be tcp or udp' };
  const ran = await ufw.runUfw(['delete', 'allow', ...testPortRule(port, protocol)]);
  if (ran.locked) return { status: false, message: 'ufw is locked by another ufw command' };
  const cmdres = ran.stdout + ran.stderr;
  return { status: cmdres.includes('delete'), message: cmdres };
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
  if (portBanned || +port < config.get('fluxapps.portMin') || +port > config.get('fluxapps.portMax')) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const ran = await ufw.runUfw(['deny', String(port)]);
  if (ran.locked) {
    cmdStat.message = 'ufw is locked by another ufw command';
    return cmdStat;
  }
  const cmdres = ran.stdout + ran.stderr;
  cmdStat.message = cmdres;
  if (cmdres.includes('updated') || cmdres.includes('added')) {
    cmdStat.status = true;
  } else if (cmdres.includes('existing')) {
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
  if (portBanned || +port < config.get('fluxapps.portMin') || +port > config.get('fluxapps.portMax')) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const ran = await ufw.runUfw(['delete', 'allow', String(port)]);
  if (ran.locked) {
    cmdStat.message = 'ufw is locked by another ufw command';
    return cmdStat;
  }
  const cmdres = ran.stdout + ran.stderr;
  cmdStat.message = cmdres;
  if (cmdres.includes('delete')) { // Rule deleted or Could not delete non-existent rule both ok
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
  if (portBanned || +port < config.get('fluxapps.portMin') || +port > config.get('fluxapps.portMax')) {
    cmdStat.message = 'Port out of deletable app ports range';
    return cmdStat;
  }
  const ran = await ufw.runUfw(['delete', 'deny', String(port)]);
  if (ran.locked) {
    cmdStat.message = 'ufw is locked by another ufw command';
    return cmdStat;
  }
  const cmdres = ran.stdout + ran.stderr;
  cmdStat.message = cmdres;
  if (cmdres.includes('delete')) { // Rule deleted or Could not delete non-existent rule both ok
    cmdStat.status = true;
  } else {
    cmdStat.status = false;
  }
  return cmdStat;
}

/**
 * Whether a port is in the range FluxOS gives apps, and so one FluxOS may open
 * and delete a rule for.
 * @param {number|string} port Port.
 * @returns {boolean}
 */
function isAppPort(port) {
  return !Number.isNaN(+port) && !isPortBanned(+port) && +port >= config.get('fluxapps.portMin') && +port <= config.get('fluxapps.portMax');
}

/**
 * Opens an app's published ports to every client, IPv4 and IPv6, in one ufw
 * batch: `allow <port>`. Docker forwards a connection from outside the node to
 * a published port ahead of ufw's inbound rules, but an IPv6 one, and on some
 * Docker releases a container's connection to a published port at the node's
 * own address, it answers through docker-proxy on the host, behind them. ufw
 * keeps the rules across restarts, so they are written when the app is
 * installed and deleted when it is removed. Nothing is written while ufw is
 * disabled.
 * @param {Array<number|string>} ports Ports.
 * @returns {Promise<{failed: Array<{rule: string, error: string}>, locked: boolean}>}
 */
async function allowAppPorts(ports) {
  if (!await ufw.ufwEnabled()) return { failed: [], locked: false };
  return ufw.runUfwCommands(ports.filter(isAppPort).map((port) => ['allow', String(port)]));
}

/**
 * Deletes the rules allowAppPorts writes for an app's ports, in one ufw batch.
 * A rule already gone counts as deleted.
 * @param {Array<number|string>} ports Ports.
 * @returns {Promise<{failed: Array<{rule: string, error: string}>, locked: boolean}>}
 */
async function deleteAppPortRules(ports) {
  return ufw.runUfwCommands(ports.filter(isAppPort).map((port) => ['delete', 'allow', String(port)]));
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
  const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));

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

const ufwDefaultsPath = '/etc/default/ufw';
// /etc/default/ufw exactly as the ufw package ships it on Ubuntu 20.04 to 26.04.
const ufwDefaultsSource = path.join(__dirname, '../../../helpers/ufw/default');
// ufw refuses to run, and ufw-init refuses to start the firewall at boot, when
// any of these is missing.
const ufwPolicies = ['INPUT', 'OUTPUT', 'FORWARD', 'APPLICATION'];

/**
 * Keeps /etc/default/ufw whole and its outbound policy ACCEPT. A file missing
 * any policy is replaced by ufw's own defaults; one that denies outbound has
 * that line set to ACCEPT. The new file is renamed over the old, so it is never
 * seen part-written, and an enabled firewall is reloaded to take it up - which
 * also starts one that could not start at boot. ufw's own `default` command
 * rewrites the file in place and is never used.
 * @returns {Promise<void>}
 */
async function ensureUfwDefaults() {
  const ufwConf = await fs.readFile('/etc/ufw/ufw.conf', 'utf8').catch(() => null);
  if (ufwConf === null) return;
  const current = await fs.readFile(ufwDefaultsPath, 'utf8').catch(() => '');

  const whole = ufwPolicies.every((policy) => new RegExp(`^DEFAULT_${policy}_POLICY=`, 'm').test(current));
  let desired;
  if (!whole) {
    desired = await fs.readFile(ufwDefaultsSource, 'utf8');
  } else if (!/^DEFAULT_OUTPUT_POLICY="ACCEPT"$/m.test(current)) {
    desired = current.replace(/^DEFAULT_OUTPUT_POLICY=.*$/m, 'DEFAULT_OUTPUT_POLICY="ACCEPT"');
  } else {
    return;
  }

  const staged = `${ufwDefaultsPath}.flux-new`;
  let tempDir = null;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-ufw-'));
    const source = path.join(tempDir, 'ufw');
    await fs.writeFile(source, desired, { mode: 0o644 });
    const { error: stageError } = await serviceHelper.runCommand('install', {
      runAsRoot: true, logError: false, params: ['-m', '0644', '-o', 'root', '-g', 'root', source, staged],
    });
    const { error: renameError } = stageError ? { error: stageError } : await serviceHelper.runCommand('mv', {
      runAsRoot: true, logError: false, params: ['-f', staged, ufwDefaultsPath],
    });
    if (renameError) {
      log.error(`Firewall defaults not written: ${renameError.message}`);
      return;
    }
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
  log.info(whole ? 'Firewall outbound policy set to ACCEPT' : 'Firewall defaults restored');

  if (/^ENABLED=yes$/m.test(ufwConf)) {
    const { error, locked } = await ufw.runUfw(['reload']);
    if (locked) log.error('Firewall not reloaded: ufw is locked by another ufw command');
    else if (error) log.error(`Firewall not reloaded: ${error.message}`);
  }
  fluxEventBus.publish('firewall:defaultsWritten', { restored: !whole });
}

// The docker networks app containers are on.
const fluxAppDockerNetworks = '172.23.0.0/16';
/**
 * Reports a firewall step that stopped because another ufw command held ufw's lock.
 */
function reportUfwLocked() {
  log.error('Firewall not adjusted: ufw is locked by another ufw command');
  fluxEventBus.publish('firewall:locked', {});
}

/**
 * The node's own firewall rules, each the arguments of one ufw command, in the
 * order they are applied.
 * @returns {Promise<string[][]>}
 */
async function nodeFirewallRules() {
  const apiPort = userconfig.initial.apiport || config.server.apiport;
  const ports = [apiPort, +apiPort - 1, +apiPort + 1, +apiPort + 2, 80, 443, 16125, ...config.server.allowedPorts];
  const rules = [['delete', 'allow', 'in', 'proto', 'udp', 'to', 'any', 'port', '53']];
  // this should also be limit, but existing nodes use allow (needs to be updated)
  if (globalState.isArcane()) rules.push(['prepend', 'allow', 'to', 'any', 'app', 'FluxadmSSH']);
  // the OpenSSH profile exists only where openssh-server is installed
  rules.push(['prepend', 'limit', 'to', 'any', 'app', 'OpenSSH']);

  const { stdout: routes } = await serviceHelper.runCommand('ip', { logError: false, params: ['route'] });
  const routerIP = serviceHelper.ensureString(routes).split('\n')[0].trim().split(/\s+/)[2] || '';
  if (serviceHelper.validIpv4Address(routerIP)
    && (routerIP.startsWith('192.168.') || routerIP.startsWith('10.') || routerIP.startsWith('172.16.')
      || routerIP.startsWith('100.64.') || routerIP.startsWith('198.18.') || routerIP.startsWith('169.254.'))) {
    rules.push(['prepend', 'allow', 'from', routerIP, 'to', 'any', 'proto', 'udp']);
  }
  ports.forEach((port) => rules.push(['allow', String(port)]));
  // app containers reach the fluxnode service; the rest of loopback is refused
  // by allowOnlyDockerNetworksToFluxNodeService, as ufw does not filter loopback
  rules.push(['allow', 'from', fluxAppDockerNetworks, 'proto', 'tcp', 'to', `${config.server.fluxNodeServiceAddress}/32`, 'port', '16101']);
  return rules;
}

/**
 * Applies the node's own firewall rules. Outbound traffic is governed by the
 * default policy alone, so every outbound rule is removed, whoever added it;
 * then the node's own inbound rules are applied. Both happen in one pass under
 * ufw's lock (helpers/ufw/apply-node-firewall.py), and ufw is reloaded only
 * when outbound rules were removed. Where ufw's library cannot be used, the
 * rules are applied one ufw command each.
 *
 * Every ufw command waits on ufw's lock for as long as another holds it, so a
 * lock held past ufw.UFW_LOCK_WAIT_MS stops the step: no ufw command is run, the
 * firewall is left as it is, and the next start applies it.
 */
async function adjustFirewall() {
  try {
    if (!await ufw.ufwEnabled()) {
      log.info('Firewall is not active. Adjusting not applied');
      return;
    }
    const rules = await nodeFirewallRules();

    const { stdout, stderr, error } = await ufw.oneAtATime(async () => serviceHelper.runCommand('python3', {
      runAsRoot: true,
      logError: false,
      params: [await ufwHelper.path(), '--wait', String(ufw.UFW_LOCK_WAIT_MS / 1000), '--rules', JSON.stringify(rules)],
      timeout: 2 * ufw.UFW_LOCK_WAIT_MS,
    }));
    if (error?.code === ufw.UFW_LOCK_UNAVAILABLE) {
      reportUfwLocked();
      return;
    }
    let result = null;
    if (!error) {
      try {
        result = JSON.parse(serviceHelper.ensureString(stdout));
      } catch {
        log.warn(`Firewall applier answered unreadably: ${serviceHelper.ensureString(stdout).trim()}`);
      }
    } else {
      log.warn(`Firewall applier failed: ${serviceHelper.ensureString(stderr).trim() || error.message}`);
    }

    const outboundRemoved = result?.removed ?? 0;
    let failed = result?.failed ?? [];
    if (!result?.applied) {
      if (result?.reason) log.warn(`Firewall rules applied one ufw command each: ${result.reason}`);
      failed = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const rule of rules) {
        // eslint-disable-next-line no-await-in-loop
        const ran = await ufw.runUfw(rule);
        if (ran.locked) {
          reportUfwLocked();
          return;
        }
        if (ran.error) failed.push({ rule: rule.join(' '), error: ran.stderr.trim() || ran.error.message });
      }
    }
    // a delete finds nothing to delete once the rule is gone
    failed = failed.filter(({ rule, error: why }) => !(rule.startsWith('delete ') && /non-existent rule/.test(why)));
    failed.forEach(({ rule, error: why }) => log.warn(`Firewall rule not applied: ufw ${rule}: ${why}`));

    if (outboundRemoved) {
      const reload = await ufw.runUfw(['reload']);
      if (reload.locked) {
        reportUfwLocked();
        return;
      }
      if (reload.error) log.error(`Firewall not reloaded after removing outbound rules: ${reload.error.message}`);
      log.info(`Firewall outbound rules removed: ${outboundRemoved}`);
    }
    fluxEventBus.publish('firewall:adjusted', {
      outboundRemoved, rulesFailed: failed.map(({ rule }) => rule), appliedBy: result?.applied ? 'library' : 'commands',
    });
  } catch (error) {
    log.error(error);
  }
}

/**
 * To clean a firewall deny policies, and delete them from it.
 */
async function purgeUFW() {
  try {
    const firewallActive = await ufw.isFirewallActive();
    if (firewallActive) {
      const status = await ufw.runUfw(['status']);
      const cmdresB = status.stdout.split('\n').filter((line) => line.includes('DENY')).join('\n');
      if (cmdresB.includes('DENY')) {
        const deniedPorts = cmdresB.split('\n'); // split by new line
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
    } else {
      log.info('Firewall is not active. Purging UFW not necessary');
    }
  } catch (error) {
    log.error(error);
  }
}

// The bridges a container's traffic can come from: the default one and every
// user-defined docker network.
const containerBridges = ['docker0', 'br-+'];
// Addresses an app container may not reach beyond its own node: every
// non-public IPv4 range, the node owner's private networks and a cloud host's
// metadata service among them. fluxnode.service lives on this node's loopback,
// so a container reaches it through INPUT and these FORWARD rules never see it.
const containerBlockedNetworks = NON_PUBLIC_IPV4;

/**
 * The DOCKER-USER chain, as `iptables -S DOCKER-USER` prints it.
 *
 * Traffic into a container is let through only on FluxOS's own networks (the
 * default bridge docker0 and each network FluxOS creates): traffic that stays
 * on the network it came from, and connections to a published port, whose
 * destination Docker has rewritten to the container's (conntrack state DNAT).
 * Everything else headed into any docker network is dropped: one app network
 * reaches another only through a published port at the node's address, and a
 * network FluxOS did not create receives nothing it did not ask for. These
 * rules name each bridge, so a host interface named like a docker bridge gets
 * no exception, and they hold whether or not Docker's own isolation rules are
 * present and whether or not the br_netfilter kernel module sends bridged
 * traffic through iptables.
 *
 * Traffic from a container to anywhere else is matched by the bridge it comes
 * from, never by its source address, so a container cannot leave the drops by
 * forging its source; every non-public range is dropped. DNS stays open to
 * every private address, for a node owner who runs their own resolver.
 *
 * No rule uses the physdev match: the kernel loads br_netfilter the first time
 * a physdev rule is added, which sends bridged traffic on every bridge on the
 * host - an operator's VMs included - through iptables.
 * @param {{fluxBridges: string[], dockerBridges: string[]}} bridges fluxBridges:
 *   the bridge of each network FluxOS creates, docker0 aside. dockerBridges: the
 *   bridge of every docker bridge network, docker0 included.
 * @returns {string[]}
 */
function containerEgressRules({ fluxBridges, dockerBridges }) {
  const rules = ['-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN'];
  ['docker0', ...fluxBridges].forEach((bridge) => {
    rules.push(`-A DOCKER-USER -i ${bridge} -o ${bridge} -j RETURN`);
    rules.push(`-A DOCKER-USER -o ${bridge} -m conntrack --ctstate DNAT -j RETURN`);
  });
  dockerBridges.forEach((bridge) => rules.push(`-A DOCKER-USER -o ${bridge} -j DROP`));
  containerBridges.forEach((bridge) => {
    ['udp', 'tcp'].forEach((proto) => rules.push(`-A DOCKER-USER -i ${bridge} -p ${proto} -m ${proto} --dport 53 -j RETURN`));
  });
  containerBridges.forEach((bridge) => {
    containerBlockedNetworks.forEach((network) => rules.push(`-A DOCKER-USER -d ${network} -i ${bridge} -j DROP`));
  });
  rules.push('-A DOCKER-USER -j RETURN');
  return rules;
}

/**
 * Keeps app containers off private and link-local networks and off each
 * other's networks. The DOCKER-USER chain is replaced in one iptables-restore
 * transaction, so no moment passes without its rules, and is left untouched
 * when it already matches. Docker never writes DOCKER-USER, and its FORWARD
 * jump is put back if missing.
 * @param {{fluxBridges: string[], dockerBridges: string[]}} bridges As
 *   containerEgressRules takes them.
 * @returns {Promise<boolean>} True when the chain is in place. Never rejects.
 */
async function applyContainerEgressRules(bridges) {
  const desired = containerEgressRules(bridges);
  const { stdout: current, error: readError } = await serviceHelper.runCommand('iptables', {
    runAsRoot: true, logError: false, params: ['-S', 'DOCKER-USER'],
  });
  const currentRules = serviceHelper.ensureString(current).split('\n').map((line) => line.trim()).filter((line) => line.startsWith('-A '));
  const inPlace = !readError && currentRules.length === desired.length && currentRules.every((rule, i) => rule === desired[i]);

  if (!inPlace) {
    let tempDir = null;
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-docker-user-'));
      const rulesFile = path.join(tempDir, 'rules');
      await fs.writeFile(rulesFile, ['*filter', ':DOCKER-USER - [0:0]', ...desired, 'COMMIT', ''].join('\n'), { mode: 0o644 });
      const { error } = await serviceHelper.runCommand('iptables-restore', {
        runAsRoot: true, logError: false, params: ['--noflush', rulesFile],
      });
      if (error) {
        log.error(`IPTABLES: DOCKER-USER rules not applied: ${error.message}`);
        return false;
      }
      log.info('IPTABLES: DOCKER-USER rules applied');
      fluxEventBus.publish('firewall:containerEgressApplied', {});
    } catch (error) {
      log.error(`IPTABLES: DOCKER-USER rules not applied: ${error.message}`);
      return false;
    } finally {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const { error: jumpMissing } = await serviceHelper.runCommand('iptables', {
    runAsRoot: true, logError: false, params: ['-C', 'FORWARD', '-j', 'DOCKER-USER'],
  });
  if (jumpMissing) {
    const { error } = await serviceHelper.runCommand('iptables', {
      runAsRoot: true, logError: false, params: ['-I', 'FORWARD', '-j', 'DOCKER-USER'],
    });
    if (error) {
      log.error(`IPTABLES: FORWARD jump to DOCKER-USER not restored: ${error.message}`);
      return false;
    }
    log.info('IPTABLES: FORWARD jump to DOCKER-USER restored');
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
 * Refuses the fluxnode service's address on loopback to everything but the app
 * containers' networks. ufw does not filter loopback, so this is an iptables
 * rule; the containers' own allow is one of the node's firewall rules.
 * @returns {Promise<void>}
 */
async function allowOnlyDockerNetworksToFluxNodeService() {
  if (!await ufw.ufwEnabled()) return;

  const { fluxNodeServiceAddress } = config.server;
  const denyRule = ['INPUT', '-i', 'lo', '!', '-s', fluxAppDockerNetworks, '-d', `${fluxNodeServiceAddress}/32`, '-j', 'DROP'];

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

/**
 * Allow app containers to reach the mesh resolver (flux-dnsd). Both rules are
 * DESTINATION-scoped to the resolver's address: adjustFirewall deletes the
 * blanket inbound "udp to any port 53" allow on every run, and an unscoped
 * rule here would be eaten with it.
 * @returns {Promise<void>}
 */
async function allowDockerNetworksToFluxDnsd() {
  if (!await ufw.ufwEnabled()) return;

  const { fluxDnsdServiceAddress } = config.get('server');
  // eslint-disable-next-line no-restricted-syntax
  for (const proto of ['udp', 'tcp']) {
    // eslint-disable-next-line no-await-in-loop
    const ran = await ufw.runUfw(['allow', 'from', fluxAppDockerNetworks, 'proto', proto, 'to', `${fluxDnsdServiceAddress}/32`, 'port', '53']);
    const out = `${ran.stdout}${ran.stderr}`;
    if (!ran.locked && (out.includes('updated') || out.includes('existing') || out.includes('added'))) {
      log.info(`Firewall adjusted for ${proto}/53 from ${fluxAppDockerNetworks} to ${fluxDnsdServiceAddress}`);
    } else {
      log.warn(`Failed to adjust firewall for ${proto}/53 from ${fluxAppDockerNetworks} to ${fluxDnsdServiceAddress}`);
    }
  }
}
module.exports = {
  isFluxAvailable,
  checkFluxAvailability,
  getLocalSocketAddress,
  getKnownLocalSocketAddress,
  waitForLocalSocketAddress,
  onLocalSocketAddressChange,
  offLocalSocketAddressChange,
  onLocalSocketAddressKnown,
  getCachedLocalSocketAddress,
  getFluxNodePrivateKey,
  getFluxNodePublicKey,
  MAX_KEEPALIVE_PORTS,
  getIncomingConnections,
  getIncomingConnectionsInfo,
  getDOSState,
  setDOSStateApi,
  getNumberOfPeers,
  egressDevice,
  interfaceDevice,
  hasPublicIpOnInterface,
  denyPort,
  deleteAllowPortRule,
  allowAppPorts,
  allowTestPort,
  deleteAppPortRules,
  deleteTestPortRule,
  allowPortApi,
  adjustFirewall,
  ensureUfwDefaults,
  purgeUFW,
  closeConnection,
  closeIncomingConnection,
  checkFluxbenchVersionAllowed,
  checkNodeJsVersionAllowed,
  checkDockerVersionAllowed,
  checkCgroupsAllowed,
  checkMongoDbVersionAllowed,
  allowPort,
  isFirewallActive: ufw.isFirewallActive,
  // Exports for testing purposes
  resetNtpSource,
  parseChronyOffset,
  parseTimesyncOffset,
  setStoredFluxBenchAllowed,
  getStoredFluxBenchAllowed,
  setLocalSocketAddress,
  getUdpReachability,
  setUdpReachability,
  PlacementHoldOwner,
  setPlacementHold,
  clearPlacementHold,
  getPlacementHold,
  isPlacementHeld,
  fluxUptime,
  fluxSystemUptime,
  isCommunicationEstablished,
  lruRateLimit,
  isPortOpen,
  portAnswered,
  MAX_ECHO_BYTES,
  portAnsweredUdp,
  checkAppAvailability,
  verifySignedFluxnodeMessage,
  isPortEnterprise,
  isPortBanned,
  isPortUPNPBanned,
  allowNodeToBindPrivilegedPorts,
  applyContainerEgressRules,
  containerEgressRules,
  removeDockerContainerAccessToNonRoutable,
  allowOnlyDockerNetworksToFluxNodeService,
  allowDockerNetworksToFluxDnsd,
  addFluxNodeServiceIpToLoopback,
  keepUPNPPortsOpen,
  clockDrift,
  getClockDrift,
  initClockOffsetCache,
  getLocalClockOffsetMs,
};
