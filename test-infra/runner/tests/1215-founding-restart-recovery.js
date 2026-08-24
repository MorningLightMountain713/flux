// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { ALL_ZMQ_TOPICS } from '../framework/fluxd-conf.js';
import { bootAndPeer, restartAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import {
  queueAppTx, advanceBlocks, advanceBlock, removeFromNodeList,
} from '../framework/daemon-control.js';
import {
  execInContainer, requireAppContainerName,
} from '../framework/container.js';
import { waitFor, waitForAppInstalled, waitForUp } from '../framework/wait.js';

// Founding survives a fleet-wide FluxOS restart — §13.7 is CLOSED and this
// suite pins the closure, not the hole. The founding photo is the pin made
// durable: minted at registration processing by every node that saw the spec,
// surviving restarts, and founder asks verify against the PHOTO
// (selfOnFoundingCommittee compares the ask's basis to the photo's own
// fingerprint) — never against the in-memory membership history. So a
// fleet-wide restart inside the founding window is a RECOVERY case, not a
// wedge: after the rejoin drain the scramble completes and exactly one
// founder is seated (test 1). Membership churn between the anchor and the
// restart changes nothing (test 2): the committee is registration-height
// pinned, re-pinning to the current list is forbidden, and founding can only
// complete at the photo's own basis — a grantor refuses any other
// fingerprint — so completion at the anchored key IS the no-drift proof.
// The residual liveness gap lives elsewhere: a node that never photographed
// the registration (the aging-app committee problem, doc §8.4) — a different
// suite once that mechanism is decided.
//
// Anti-vacuity discipline (this suite's first version went green in a window
// where nothing had happened yet): a second yes fails the exactly-one count
// immediately, even in a partial round; a round only counts toward
// completion when every listed node produced a real answer; the counted
// answers are logged into the TAP; the record sweep requires every cell to
// answer the query — an unreachable register is not an empty one.

const COMPONENT = 'meshcomp';

describe('founding recovers through a fleet-wide restart', function () {
  let env;

  function componentSpec(compName, appImage, hostPort) {
    return {
      name: compName,
      description: 'restart-recovery test component',
      image: appImage,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort } },
    };
  }

  async function askFounder(clientIndex, appName) {
    try {
      const containerName = await requireAppContainerName(
        env.clients[clientIndex].container, appName, COMPONENT,
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

  async function registerAndInstall(appName, hostPort) {
    await pushBusybox(appName);
    const appImage = `${REGISTRY_REPO_HOST}/${appName}:v1`;
    const reg = await registerEncryptedV9App(env.clients[0].url, {
      name: appName,
      instances: 3,
      components: { [COMPONENT]: componentSpec(COMPONENT, appImage, hostPort) },
      specOverrides: { network: { mesh: true } },
    });
    expect(reg.status, JSON.stringify(reg)).to.equal('success');
    await queueAppTx(reg.data);
    await advanceBlocks(3);
    await waitFor(async () => {
      const rows = await Promise.all(env.clients.map((c) => c.getAppSpecs(appName).catch(() => null)));
      return rows.every((r) => r && r.status === 'success' && r.data && r.data.name === appName);
    }, { timeout: 120000, interval: 3000, label: `global spec for ${appName} on all nodes` });
    await Promise.all(env.clients.map((c) => waitForAppInstalled(c, appName, 240000)));
    // Installed is not running: v9's installer hands the container start to
    // the reconciler, and a restart landing inside the create-to-start window
    // strands the container in Created with its volume never mounted (the
    // 48c5c41ca red). The founding window is open until something asks — a
    // running fleet is the honest starting state, not a mid-install one.
    await Promise.all(env.clients.map((c) => waitForUp(c, appName, `${appName} up on all nodes`)));
  }

  // A fleet-wide FluxOS restart is only over when every node has finished its
  // own boot recovery — boot:settled is that signal, and before it the node
  // is still judging which installed apps it keeps. afterId markers are
  // captured pre-kill so the PREVIOUS boot's settled event cannot satisfy
  // the wait from the buffer. Returns the markers for later peer waits.
  // Ask every node each round until one full round shows exactly one yes.
  // requiredNonNull are the nodes whose answers must be real for a round to
  // count (a delisted node's app may be mid-teardown; its yes still counts
  // against exactly-one, but its silence must not stall the clock). The
  // yes-set accumulates ACROSS rounds: two different nodes ever answering
  // yes — even in different rounds — is a second founder and fails.
  async function sampleUntilOneFounder(appName, requiredNonNull, label) {
    const yesNodes = new Set();
    let counted = 0;
    let winner = null;
    await waitFor(async () => {
      const answers = await Promise.all(env.clients.map((_, i) => askFounder(i, appName)));
      answers.forEach((a, i) => { if (a === 'yes') yesNodes.add(i); });
      expect([...yesNodes], `at most one node may ever answer yes (${label}: ${answers})`).to.have.lengthOf.at.most(1);
      if (requiredNonNull.some((i) => answers[i] === null)) return false;
      counted += 1;
      console.log(`# 1215 ${label} round ${counted}: ${answers.join(' ')}`);
      if (answers.filter((a) => a === 'yes').length !== 1) return false;
      [winner] = [...yesNodes];
      return true;
    }, { timeout: 240000, interval: 10000, label });
    // Idempotence: the verdict re-reads stably on the winner.
    expect(await askFounder(winner, appName), 'the founder verdict is stable').to.equal('yes');
    return winner;
  }

  // The founder register key is rung-salted (<app>/founder-<world>@<rung>)
  // and the suite must never re-derive that arithmetic itself: the winner's
  // founded event names the key the founding actually used.
  async function foundedGrant(winner, appName, afterId) {
    const entry = await env.clients[winner].waitForEvent(
      'quorumGrant:founded',
      (d) => typeof d.key === 'string' && d.key.startsWith(`${appName}/founder-`),
      30000,
      { afterId },
    );
    return entry.data;
  }

  // Every cell must ANSWER the record query (an unreachable register is not
  // an empty one); the founder grant must stand on a quorum of cells and
  // every copy must name the same grantee — the one the founded event named.
  async function assertOneRecordedFounder(key, founder) {
    const cells = await Promise.all(env.clients.map(async (client, i) => {
      const res = await fetch(
        `${client.url}/flux/quorumgrant/record?key=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      expect(res.ok, `node ${i} answers the record query`).to.equal(true);
      const body = await res.json();
      return body?.data?.accepted ?? null;
    }));
    const accepted = cells.filter(Boolean);
    expect(accepted.length, 'the founder grant stands on a quorum of cells').to.be.at.least(2);
    expect(new Set(accepted.map((a) => a.grantee)), 'every cell names the same founder').to.have.lengthOf(1);
    expect(accepted[0].grantee, 'the recorded grantee is the founded founder').to.equal(founder);
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
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('a fleet-wide restart inside the founding window recovers: exactly one founder', async function () {
    this.timeout(600000);
    const name = `e2erecover${Date.now()}`;
    await registerAndInstall(name, 31000);

    // Restart EVERY node's FluxOS before anything has asked the founder
    // question — the founding window is open, no founder grant exists, and
    // the in-memory membership history is wiped fleet-wide.
    const restartMarkers = await restartAndPeer(env, [0, 1, 2]);

    // The photo survived, so after the rejoin drain the scramble completes:
    // exactly one node is ever told yes, and the verdict is stable.
    const winner = await sampleUntilOneFounder(name, [0, 1, 2], 'stable-fleet');
    const founded = await foundedGrant(winner, name, restartMarkers[winner]);
    await assertOneRecordedFounder(founded.key, founded.founder);
  });

  it('membership churn between the anchor and the restart does not wedge founding', async function () {
    this.timeout(600000);
    const name = `e2echurn${Date.now()}`;
    await registerAndInstall(name, 31001);

    // The churn: the anchor's membership stops being the current membership.
    // After the fleet-wide restart no node's in-memory history covers the
    // anchor fingerprint — the world the old membership-history hole feared.
    // The photo is the durable basis: grantors refuse every OTHER
    // fingerprint, so founding completing at the anchored key is also the
    // proof the committee never re-pinned to the churned list.
    await removeFromNodeList(`${env.clients[2].ip}:16127`);
    await advanceBlock();
    // Only the listed nodes gate settling: a delisted node reboots into a
    // world that may refuse its dials, and nothing downstream requires it.
    const churnMarkers = await restartAndPeer(env, [0, 1]);

    // The delisted node keeps its photo and its seat (registration-height
    // pinning); its app container may not survive delisting, so only the
    // listed nodes gate the round count — but a yes anywhere still counts
    // against exactly-one.
    const winner = await sampleUntilOneFounder(name, [0, 1], 'churned-fleet');
    const founded = await foundedGrant(winner, name, churnMarkers[winner]);
    await assertOneRecordedFounder(founded.key, founded.founder);
  });
});
