'use strict';

import { execInContainer } from './container.js';
import { getSubnetConfig } from './subnet-config.js';
import { ZMQ_NODE_PORT_BASE } from './fluxd-conf.js';

// A network partition, done where production feels it: inside the pocket
// nodes' own netfilter. The block-list is OTHER FLEET NODES plus (by
// default) the chain feed — the daemon-stub's ZMQ publisher ports ONLY.
// "Blocks stop arriving" is what a real partition does to a node's chain
// view; the node's fluxd itself is ON-BOX and stays reachable, so the RPC
// ports are never cut — a wholesale daemon cut reads as daemon-unreachable,
// a failure mode production partitions cannot produce. A dropped publisher
// stalls the feed without an RPC fallback: daemonSubscriptionService acts
// only on RECONNECT, which a dropped port never completes. The shared infra
// containers (mongo, syncthing stub, registry) are deliberately NEVER cut:
// they stand in for services a real node runs ON-BOX (David's fidelity
// rule, 2026-08-19). The runner's own observability rides the gateway
// address and is untouched, so a partitioned node still reports its events.
//
// Rules live in a dedicated chain hooked into INPUT, OUTPUT and FORWARD
// (app-container traffic the node routes traverses FORWARD, not OUTPUT), so
// healing is one flush and never disturbs docker's own rules.

const CHAIN = 'FLUXTEST_PARTITION';

// The shared publisher (renderFluxdConf default) plus the per-node socket
// range (ZMQ_NODE_PORT_BASE + node number; 50 covers any harness fleet).
const SHARED_ZMQ_PORT = 16123;
const NODE_ZMQ_PORT_RANGE = `${ZMQ_NODE_PORT_BASE}:${ZMQ_NODE_PORT_BASE + 50}`;

export async function partition(env, pocketIndexes, { cutChain = true } = {}) {
  const cfg = getSubnetConfig();
  const pocket = new Set(pocketIndexes);
  const targets = env.clients
    .map((unused, i) => i)
    .filter((i) => !pocket.has(i))
    .map((i) => cfg.nodeIp(i + 1));

  for (const i of pocketIndexes) {
    const hook = `iptables -N ${CHAIN} 2>/dev/null; `
      + `iptables -C INPUT -j ${CHAIN} 2>/dev/null || iptables -I INPUT -j ${CHAIN}; `
      + `iptables -C OUTPUT -j ${CHAIN} 2>/dev/null || iptables -I OUTPUT -j ${CHAIN}; `
      + `iptables -C FORWARD -j ${CHAIN} 2>/dev/null || iptables -I FORWARD -j ${CHAIN}`;
    const drops = targets
      .map((ip) => `iptables -A ${CHAIN} -d ${ip} -j DROP && iptables -A ${CHAIN} -s ${ip} -j DROP`)
      .concat(cutChain ? [
        `iptables -A ${CHAIN} -d ${cfg.daemon} -p tcp --dport ${SHARED_ZMQ_PORT} -j DROP`,
        `iptables -A ${CHAIN} -s ${cfg.daemon} -p tcp --sport ${SHARED_ZMQ_PORT} -j DROP`,
        `iptables -A ${CHAIN} -d ${cfg.daemon} -p tcp --dport ${NODE_ZMQ_PORT_RANGE} -j DROP`,
        `iptables -A ${CHAIN} -s ${cfg.daemon} -p tcp --sport ${NODE_ZMQ_PORT_RANGE} -j DROP`,
      ] : [])
      .join(' && ');
    // eslint-disable-next-line no-await-in-loop
    await execInContainer(env.clients[i].container, `${hook}; ${drops}`);
  }
}

export async function healPartition(env, pocketIndexes) {
  for (const i of pocketIndexes) {
    // eslint-disable-next-line no-await-in-loop
    await execInContainer(env.clients[i].container, `iptables -F ${CHAIN} 2>/dev/null || true`);
  }
}
