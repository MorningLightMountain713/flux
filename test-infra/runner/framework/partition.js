'use strict';

import { execInContainer } from './container.js';
import { getSubnetConfig } from './subnet-config.js';

// A network partition, done where production feels it: inside the pocket
// nodes' own netfilter. The block-list is OTHER FLEET NODES plus (by
// default) the chain feed — "blocks stop arriving" is exactly what a real
// partition does to a node's chain view. The shared infra containers
// (mongo, syncthing stub, registry) are deliberately NEVER cut: they stand
// in for services a real node runs ON-BOX, and a partition that cut them
// would test a failure mode production cannot have (David's fidelity rule,
// 2026-08-19). The runner's own observability rides the gateway address and
// is untouched, so a partitioned node still reports its events.
//
// Rules live in a dedicated chain hooked into INPUT, OUTPUT and FORWARD
// (app-container traffic the node routes traverses FORWARD, not OUTPUT), so
// healing is one flush and never disturbs docker's own rules.

const CHAIN = 'FLUXTEST_PARTITION';

export async function partition(env, pocketIndexes, { cutChain = true } = {}) {
  const cfg = getSubnetConfig();
  const pocket = new Set(pocketIndexes);
  const targets = env.clients
    .map((unused, i) => i)
    .filter((i) => !pocket.has(i))
    .map((i) => cfg.nodeIp(i + 1));
  if (cutChain) targets.push(cfg.daemon);

  for (const i of pocketIndexes) {
    const hook = `iptables -N ${CHAIN} 2>/dev/null; `
      + `iptables -C INPUT -j ${CHAIN} 2>/dev/null || iptables -I INPUT -j ${CHAIN}; `
      + `iptables -C OUTPUT -j ${CHAIN} 2>/dev/null || iptables -I OUTPUT -j ${CHAIN}; `
      + `iptables -C FORWARD -j ${CHAIN} 2>/dev/null || iptables -I FORWARD -j ${CHAIN}`;
    const drops = targets
      .map((ip) => `iptables -A ${CHAIN} -d ${ip} -j DROP && iptables -A ${CHAIN} -s ${ip} -j DROP`)
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
