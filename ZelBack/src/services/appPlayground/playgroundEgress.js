'use strict';

const config = require('config');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');

// The playground's egress policy and rate cap: everything that talks to the
// kernel's firewall and traffic control, and nothing that talks to docker.
//
// Split from playgroundNetwork for a hard reason, not tidiness. fluxNetworkHelper
// has to restore the DOCKER-USER jump after it flushes that chain, and
// dockerService requires fluxNetworkHelper - so anything fluxNetworkHelper
// imports must not reach dockerService or the cycle closes. This module depends
// on serviceHelper alone, which depends on neither.
//
// Both the policy and the jump are written ONCE, against an interface-name
// pattern, and never touched per session. That comes from naming the bridges
// ourselves: docker normally derives br-<12 hex> from the network id, which is
// unknowable until the network exists, so rules keyed on it would have to be
// added and removed per session - and every one of those is a leak when a
// teardown fails.
//
// Matching the INTERFACE rather than the source subnet is what makes the policy
// hold. A source address can be spoofed from inside a container, and a spoofed
// packet would miss a `-s <subnet>` jump and fall through to the ordinary app
// rules, which allow the internet. The interface a packet arrived on cannot be
// forged by the sender.

const CHAIN = 'FLUX-PLAYGROUND';
const BRIDGE_PREFIX = 'flxpg';
// iptables interface wildcard: matches flxpg0, flxpg1, ... and nothing else on
// the node, because no other network uses this prefix.
const BRIDGE_MATCH = `${BRIDGE_PREFIX}+`;

function egressRateKbit() {
  return config.fluxapps.playgroundEgressKbit ?? 1000;
}

async function iptables(params) {
  return serviceHelper.runCommand('iptables', { runAsRoot: true, logError: false, params });
}

async function tc(params) {
  return serviceHelper.runCommand('tc', { runAsRoot: true, logError: false, params });
}

/**
 * Build the playground's own egress chain, and hang it off DOCKER-USER.
 *
 * Its own chain rather than rules inside DOCKER-USER, because
 * fluxNetworkHelper.removeDockerContainerAccessToNonRoutable flushes that chain
 * wholesale (`iptables -F DOCKER-USER`) and rebuilds it every time an app
 * network is created - which a playground session itself triggers. Rules placed
 * there would be wiped, possibly by the very next session. A separate chain
 * survives the flush untouched; only the jump has to be re-added, which that
 * function now does.
 *
 * Idempotent: the chain is created if absent and always flushed and rewritten,
 * so a partial previous run cannot leave a half-policy in place.
 *
 * @returns {Promise<boolean>} whether the policy is in force
 */
async function ensureEgressPolicy() {
  const { error: missing } = await iptables(['--version']);
  if (missing) {
    log.error('playground: iptables not available; refusing to claim an egress policy');
    return false;
  }

  const { error: chainMissing } = await iptables(['-L', CHAIN]);
  if (chainMissing) {
    const { error: createError } = await iptables(['-N', CHAIN]);
    if (createError) {
      log.error(`playground: could not create the ${CHAIN} chain: ${createError}`);
      return false;
    }
  }

  const { error: flushError } = await iptables(['-F', CHAIN]);
  if (flushError) {
    log.error(`playground: could not flush the ${CHAIN} chain: ${flushError}`);
    return false;
  }

  // Ordered deliberately: the accepts are appended in turn and the drop last,
  // so anything not named above it is refused. This is a default-deny policy —
  // the DROP is the rule, and the four above it are the exceptions.
  const rules = [
    // Components of one session talk to each other. Without this the session's
    // own database is unreachable from its own web container.
    ['-A', CHAIN, '-i', BRIDGE_MATCH, '-o', BRIDGE_MATCH, '-j', 'ACCEPT'],
    // Replies to connections the session itself opened.
    ['-A', CHAIN, '-i', BRIDGE_MATCH, '-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'],
    // DNS, both transports — TCP is not optional, it is what a resolver falls
    // back to for large answers, and an app that cannot resolve looks broken
    // for a reason that has nothing to do with the app.
    ['-A', CHAIN, '-i', BRIDGE_MATCH, '-p', 'udp', '--dport', '53', '-j', 'ACCEPT'],
    ['-A', CHAIN, '-i', BRIDGE_MATCH, '-p', 'tcp', '--dport', '53', '-j', 'ACCEPT'],
    ['-A', CHAIN, '-i', BRIDGE_MATCH, '-p', 'tcp', '--dport', '80', '-j', 'ACCEPT'],
    ['-A', CHAIN, '-i', BRIDGE_MATCH, '-p', 'tcp', '--dport', '443', '-j', 'ACCEPT'],
    ['-A', CHAIN, '-i', BRIDGE_MATCH, '-j', 'DROP'],
  ];

  // eslint-disable-next-line no-restricted-syntax
  for (const rule of rules) {
    // eslint-disable-next-line no-await-in-loop
    const { error } = await iptables(rule);
    if (error) {
      log.error(`playground: could not add egress rule ${rule.join(' ')}: ${error}`);
      return false;
    }
  }

  return ensureEgressJump();
}

/**
 * Point DOCKER-USER at the playground chain.
 *
 * Separate from building the chain because it has a second caller: the
 * DOCKER-USER rebuild flushes this jump away along with everything else in that
 * chain, and has to put it back. Inserted at the head so the playground policy
 * is decided before the ordinary app rules get a say — those end in an ACCEPT
 * for traffic between flux interfaces, which would otherwise let a session out.
 *
 * Idempotent: checked with -C first, since iptables will happily add a
 * duplicate every time it is asked.
 */
async function ensureEgressJump() {
  // A node whose playground has never built the chain (feature unused) has
  // nothing to point at and no session rules to confine - the jump insert
  // could only fail. ensureEgressPolicy builds the chain and re-runs this.
  const { error: chainMissing } = await iptables(['-nL', CHAIN]);
  if (chainMissing) return true;

  const jump = ['DOCKER-USER', '-i', BRIDGE_MATCH, '-j', CHAIN];

  const { error: absent } = await iptables(['-C', ...jump]);
  if (!absent) return true;

  const { error } = await iptables(['-I', ...jump]);
  if (error) {
    log.error(`playground: could not jump DOCKER-USER to ${CHAIN}: ${error}`);
    return false;
  }

  log.info(`playground: DOCKER-USER now jumps to ${CHAIN} for ${BRIDGE_MATCH}`);
  return true;
}

/**
 * Cap what a session can move, in both directions.
 *
 * Egress out of the bridge is shaped with tbf, which queues; ingress is
 * POLICED, which drops over-rate rather than queueing. Policing is the cruder
 * of the two and needs no IFB device to redirect through — and for a cap whose
 * purpose is to make abuse unattractive rather than to deliver smooth service,
 * dropping is the better behaviour anyway.
 *
 * Applied per session because it lives on the session's own bridge, but nothing
 * has to remove it: qdiscs belong to the device, and the device disappears with
 * the network at teardown.
 */
async function shapeBridge(bridge) {
  const rate = `${egressRateKbit()}kbit`;

  const { error: rootError } = await tc([
    'qdisc', 'add', 'dev', bridge, 'root', 'tbf',
    'rate', rate, 'burst', '32kbit', 'latency', '400ms',
  ]);
  if (rootError) {
    log.error(`playground: could not shape egress on ${bridge}: ${rootError}`);
    return false;
  }

  const { error: ingressError } = await tc(['qdisc', 'add', 'dev', bridge, 'handle', 'ffff:', 'ingress']);
  if (ingressError) {
    log.error(`playground: could not add the ingress qdisc on ${bridge}: ${ingressError}`);
    return false;
  }

  const { error: policeError } = await tc([
    'filter', 'add', 'dev', bridge, 'parent', 'ffff:', 'protocol', 'ip',
    'prio', '1', 'u32', 'match', 'u32', '0', '0',
    'police', 'rate', rate, 'burst', '10k', 'drop', 'flowid', ':1',
  ]);
  if (policeError) {
    log.error(`playground: could not police ingress on ${bridge}: ${policeError}`);
    return false;
  }

  log.info(`playground: ${bridge} capped at ${rate} each way`);
  return true;
}

module.exports = {
  CHAIN,
  BRIDGE_PREFIX,
  BRIDGE_MATCH,
  ensureEgressPolicy,
  ensureEgressJump,
  shapeBridge,
};
