// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import {
  execInContainer, requireAppContainerName, restartFluxos,
} from '../framework/container.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';

// The §13.7 boot hole, pinned at its boundary: membership history is
// IN-MEMORY, so a fleet-wide FluxOS restart inside a founding window leaves
// every grantor unable to resolve the registration-height fingerprint the
// founding photo pinned — pre-boot fingerprints answer unknown, and the rule
// is absolute: unknown fp = refuse, NEVER a current-list substitution
// (reachability-based re-pin is forbidden). The documented consequence is
// that founding STAYS PENDING until the mitigation lands (deterministic
// pin-expiry-in-blocks, or the certificates boot back-fill). This suite pins
// the safe half — no container is ever told yes on a fingerprint nobody can
// verify — and inherits the recovery assert when the mitigation is built.

const COMPONENT = 'meshcomp';

describe('the membership boot hole: a fleet-wide restart inside the founding window', function () {
  let env;
  let name;
  let appImage;

  function componentSpec(compName, hostPort) {
    return {
      name: compName,
      description: 'boot-hole test component',
      image: appImage,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort } },
    };
  }

  async function askFounder(clientIndex) {
    try {
      const containerName = await requireAppContainerName(
        env.clients[clientIndex].container, name, COMPONENT,
      );
      const { stdout } = await execInContainer(
        env.clients[clientIndex].container,
        `docker exec ${containerName} /bin/busybox wget -qO- --post-data='' http://fluxnode.service:16101/mesh/founder`,
      );
      const parsed = JSON.parse(stdout);
      return parsed?.data?.answer ?? null;
    } catch {
      return null;
    }
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      zmqTopics: ALL_ZMQ_TOPICS,
      arcane: true,
      configOverrides: {
        fluxapps: {
          meshReconcileIntervalMs: 15000,
          minOutgoing: 1,
          minIncoming: 1,
          quorumGrantMaxTtlMs: 30000,
          quorumGrantDrainMs: 20000,
          quorumGrantLockDelayMs: 10000,
          quorumGrantAskTimeoutMs: 3000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });

    name = `e2ehole${Date.now()}`;
    await pushBusybox(name);
    appImage = `${REGISTRY_REPO_HOST}/${name}:v1`;

    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name,
      instances: 3,
      components: { [COMPONENT]: componentSpec(COMPONENT, 31000) },
      specOverrides: { network: { mesh: true } },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);

    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(name).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === name);
    }, { timeout: 120000, interval: 3000, label: `global spec for ${name} on all nodes` });
    await Promise.all(env.clients.map((c) => waitForAppInstalled(c, name, 240000)));
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('after every FluxOS restarts, no founder is ever told yes on an unverifiable fingerprint', async function () {
    this.timeout(600000);

    // The window: registration pinned the committee at its anchor height.
    // Restart EVERY node's FluxOS — the in-memory membership history now
    // begins after that height on every grantor, so the pinned fingerprint
    // is unresolvable fleet-wide.
    await Promise.all(env.clients.map((c) => restartFluxos(c.container)));

    // Fail safe means fail CLOSED: the founder question keeps answering
    // wait/no — never yes — for as long as nobody can verify the committee.
    // Sample across multiple ask rounds; a single non-yes read proves
    // nothing (one input is not a probe), and a round only counts when EVERY
    // node produced a real answer: a null is an unasked question (container
    // missing, endpoint down), so a suite that accepted nulls could go green
    // without asking anything. A yes fails even in a partial round.
    const rounds = [];
    await waitFor(async () => {
      const answers = await Promise.all(env.clients.map((_, i) => askFounder(i)));
      expect(answers.filter((a) => a === 'yes'), `no yes may ever be issued (round ${rounds.length + 1}: ${answers})`).to.deep.equal([]);
      if (answers.some((a) => a === null)) return false;
      rounds.push(answers);
      console.log(`# 1215 round ${rounds.length}: ${answers.join(' ')}`);
      // Keep sampling until we have held the line across 6 full rounds (~60s).
      return rounds.length >= 6;
    }, { timeout: 300000, interval: 10000, label: 'six full rounds of real non-yes founder answers' });

    // And no register anywhere holds a founder grant — asked of every node,
    // with every node required to answer: an unreachable register is not an
    // empty one, so a fetch failure here is a red, not a null.
    const cells = await Promise.all(env.clients.map(async (client, i) => {
      const res = await fetch(
        `${client.url}/flux/quorumgrant/record?key=${encodeURIComponent(`${name}/founder`)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      expect(res.ok, `node ${i} answers the record query`).to.equal(true);
      const body = await res.json();
      return body?.data?.accepted ?? null;
    }));
    expect(cells.filter(Boolean), 'no founder grant exists anywhere').to.deep.equal([]);
  });
});
