// The shared shape of the 14xx policy suites: a three-node Arcane fleet whose
// chain grants nothing until the suite puts a policy on it, and one
// registration per node, so every node's gate answers for itself. Every
// registration is an encrypted v9 spec (registerEncryptedV9App), so the sealed
// case is the case throughout.
import { expect } from 'chai';
import { createTestEnv } from './test-env.js';
import { bootAndPeer } from './reconciler-suite.js';
import { registerEncryptedV9App, updateEncryptedV9App } from './content-helper.js';
import { pushBusybox } from './registry-helper.js';
import { REGISTRY_REPO_HOST } from './subnet-config.js';

export async function bootPolicyFleet(hookCtx, { seedPolicyGrant = false, nodes = 3 } = {}) {
  const env = await createTestEnv({
    hookCtx,
    nodes,
    tickerAutostart: false,
    arcane: true,
    seedPolicyGrant,
    configOverrides: { fluxapps: { minOutgoing: 1, minIncoming: 1 } },
  });
  await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
  return env;
}

let sequence = 0;
export function appName(prefix = 'e2epol') {
  sequence += 1;
  return `${prefix}${Date.now()}${sequence}`;
}

let nextPort = 31300;
export function components(name) {
  nextPort += 1;
  return {
    web: {
      name: 'web',
      description: 'policy suite echo component',
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      cpu: 0.1,
      memory: 100,
      rootFsGb: 1,
      entrypoint: ['/bin/busybox', 'sh', '-c', 'while true; do /bin/busybox nc -l -p 8080 -e /bin/busybox echo POL-OK; done'],
      ports: { echo: { containerPort: 8080, hostPort: nextPort } },
    },
  };
}

/**
 * Register one app at one node. `mesh` makes it use the mesh feature (bit 16,
 * gated); `dependencies` an app-relationship edge (bits 24 and, with
 * network:true on the edge, 17); neither is a plain spec no gate applies to.
 */
export async function register(client, {
  name = appName(), mesh = false, dependencies = null, ownerKey = undefined, extraOverrides = {},
} = {}) {
  await pushBusybox(name);
  const specOverrides = {
    ...(mesh ? { network: { mesh: true } } : {}),
    ...(dependencies ? { dependencies } : {}),
    ...extraOverrides,
  };
  const reg = await registerEncryptedV9App(client.url, {
    name, instances: 1, ownerKey, components: components(name), specOverrides,
  });
  return { ...reg, name };
}

export async function update(client, { name, mesh = false, ttl = undefined, ownerKey = undefined }) {
  return updateEncryptedV9App(client.url, {
    name, instances: 1, ownerKey, ttl, components: components(name), ...(mesh ? { specOverrides: { network: { mesh: true } } } : {}),
  });
}

export function expectAccepted(reg, what) {
  expect(reg.status, `${what}: ${JSON.stringify(reg)}`).to.equal('success');
}

export function expectRefused(reg, feature, what) {
  expect(reg.status, `${what}: ${JSON.stringify(reg)}`).to.equal('error');
  expect(reg.data?.code, `${what}: the gate's code`).to.equal('FEATURE_NOT_ENTITLED');
  expect(reg.data?.message, `${what}: names the feature`).to.include(feature);
}
