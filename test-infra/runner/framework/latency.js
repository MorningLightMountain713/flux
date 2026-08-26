'use strict';

import { execInContainer } from './container.js';
import { getSubnetConfig } from './subnet-config.js';

// Production-shaped wire latency, applied where production feels it: a netem
// qdisc on each node's own egress. The harness bridge delivers a broadcast in
// well under a millisecond, so any race the product runs against its own
// gossip (claims elections, coverage sieves) is decided before a second node
// can enter it. Production always has a blind window - WAN propagation - and
// this helper puts it back, per node.
//
// Scope: ONLY node-to-node traffic is shaped. Filters steer packets destined
// for the other fleet nodes into the netem band; everything else (mongo,
// registry, stubs, the runner's own observability on the gateway) stays at
// bridge speed, so assertions and event streams never inflate.
//
// Egress-only: A->B latency is A's egress delay; B->A is B's. Per-node
// overrides therefore model asymmetric geography. Composes with partition.js
// (delay and drop are independent mechanisms on independent hooks).

const ROOT_HANDLE = '1:';
const NETEM_BAND = '1:4';

// Resolve the container interface carrying the node's fleet address - the
// qdisc must land on the fleet-facing device, whatever docker named it.
function findDevCmd(ownIp) {
  return `DEV=$(ip -o addr show | awk -v ip="${ownIp}/" '$4 ~ ip {print $2; exit}'); `
    + `[ -n "$DEV" ] || { echo "no fleet interface for ${ownIp}" >&2; exit 1; }`;
}

/**
 * Shape every node's egress toward its fleet peers, to the wire the suite declared
 * in createTestEnv's `timing.wireLatency`.
 *
 * The spec is NOT an argument. A shaped wire raises the floor under peer liveness
 * and under every cadence the suite races against it, and those are boot-time
 * config — so the wire has to be known before the fleet starts, and taking it here
 * as well would be a second copy free to disagree with the first. That is exactly
 * how this call came to run an 8.4s round trip against a 4s liveness budget.
 *
 * @param {object} env - the suite's test env, carrying the declared wire
 */
export async function setLatency(env) {
  const wire = env?.wire;
  if (!wire) {
    throw new Error(
      'setLatency: this suite shapes the wire but never declared it. Pass '
      + "timing: { wireLatency: { delay: '80ms 20ms' } } to createTestEnv, so the peer-liveness "
      + 'budget and anything else derived from the round trip move with it.',
    );
  }
  const { delay, perNode = {}, loss = null } = wire;
  const cfg = getSubnetConfig();
  const n = env.clients.length;
  for (let i = 0; i < n; i += 1) {
    const spec = perNode[i] ?? delay;
    const netem = `delay ${spec}${loss ? ` loss ${loss}` : ''}`;
    const peers = [];
    for (let j = 0; j < n; j += 1) {
      if (j !== i) peers.push(cfg.nodeIp(j + 1));
    }
    // prio with 4 bands: the default priomap only ever selects bands 1-3, so
    // band 4 is reachable ONLY through the per-peer filters - non-fleet
    // traffic never traverses the netem qdisc.
    const qdiscs = `tc qdisc add dev $DEV root handle ${ROOT_HANDLE} prio bands 4 && `
      + `tc qdisc add dev $DEV parent ${NETEM_BAND} handle 40: netem ${netem}`;
    const filters = peers
      .map((ip) => `tc filter add dev $DEV parent ${ROOT_HANDLE} protocol ip prio 1 u32 match ip dst ${ip}/32 flowid ${NETEM_BAND}`)
      .join(' && ');
    // execInContainer surfaces failure only through exitCode - a dropped tc
    // error here is a suite that silently runs at bridge speed, so apply and
    // read back in one guarded command and refuse anything but a live netem.
    // eslint-disable-next-line no-await-in-loop
    const applied = await execInContainer(env.clients[i].container,
      `${findDevCmd(cfg.nodeIp(i + 1))} && ${qdiscs} && ${filters} && tc qdisc show dev $DEV`);
    if (applied.exitCode !== 0 || !/netem/.test(applied.stdout ?? '')) {
      throw new Error(`latency: netem did not apply on node ${i}: rc=${applied.exitCode} ${applied.stderr || applied.stdout || ''}`);
    }
  }
}

// Remove the shaping; the device falls back to its default qdisc.
export async function clearLatency(env) {
  const cfg = getSubnetConfig();
  for (let i = 0; i < env.clients.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await execInContainer(env.clients[i].container,
      `${findDevCmd(cfg.nodeIp(i + 1))} && (tc qdisc del dev $DEV root 2>/dev/null || true)`);
  }
}
