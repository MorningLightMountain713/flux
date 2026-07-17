import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import { isAppContainerRunning } from '../framework/container.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

// Installing claims (fluxappinstalling v2): a spawn attempt's seat reservation is
// released the moment the attempt ends — the winners' rows by their running
// broadcasts, election losers' and aborted attempts' by cleared claims — never by
// waiting out the TTL.
//
// The suite pins installingTtlS at 3600s, so the TTL cannot release anything
// inside the test window: an empty appsinstallinglocations after convergence is
// attributable ONLY to released seats. The scenario is a pinned-contended app
// (4 candidate pins, 2 instances) because that path announces deterministically:
// every pinned node stores + broadcasts its claim BEFORE parking on the collision
// window, so loser claims are guaranteed to exist and only a cleared broadcast
// can remove them.

const subnet = getSubnetConfig();
const nodeIp = (num) => subnet.nodeIp(num);

describe('installing claims: election losers release their seats by cleared broadcast, not TTL', function () {
  let env;

  const appName = `claims${Date.now()}`;

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: {
        fluxapps: {
          minOutgoing: 2,
          // The load-bearing override: with a one-hour row lifetime, nothing in
          // this suite's window expires — every removed row was actively
          // released. Renewal is pushed out with it (it must undercut the TTL).
          installingTtlS: 3600,
          installingRenewalS: 3000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });

    await pushImage(appName, 'v1');

    const res = await registerEncryptedV9App(env.clients[0].url, {
      name: appName,
      // Candidate pins on nodes 1-4 with 2 instances: pins > instances is the
      // pinned-contended path, where every candidate announces its claim before
      // parking on the collision window. Node 5 stays an uninvolved observer
      // whose DB sees the claims purely via gossip.
      placement: {
        targetIps: {
          [nodeIp(1)]: null, [nodeIp(2)]: null, [nodeIp(3)]: null, [nodeIp(4)]: null,
        },
      },
      instances: 2,
      components: {
        web: {
          name: 'web',
          description: 'installing claims component',
          image: `${REGISTRY_REPO_HOST}/${appName}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
          ports: { game: { containerPort: 8080, hostPort: 35060 } },
          env: {},
        },
      },
    });
    expect(res.status, `register ${appName}`).to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);
  });

  after(async function () {
    this.timeout(30000);
    await closeDb();
    await env?.teardown();
  });

  it('claims are announced by every contender, and every seat is released without the TTL', async function () {
    this.timeout(300000);

    // Sample the observer node's view of the claims while the contention plays
    // out. Claims persist through the collision park (seconds), so a 500ms
    // sampler cannot miss concurrent contenders.
    const observer = dbClient(env.clients[4].num);
    let maxConcurrentClaims = 0;
    let samplerRunning = true;
    const sampler = (async () => {
      while (samplerRunning) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await observer.getAppInstallingLocations(appName);
        if (rows.length > maxConcurrentClaims) maxConcurrentClaims = rows.length;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 500); });
      }
    })();

    // The app settles on exactly 2 of the 4 pinned nodes.
    await waitFor(
      async () => {
        const states = await Promise.all(
          env.clients.map((c) => isAppContainerRunning(c.container, appName)),
        );
        const runningIdx = states.flatMap((r, i) => (r ? [i] : []));
        return runningIdx.length === 2 && runningIdx.every((i) => i <= 3);
      },
      { timeout: 240000, interval: 3000, label: `${appName} running on exactly 2 pinned nodes` },
    );
    samplerRunning = false;
    await sampler;

    // Contention was real: more contenders claimed than seats exist. Every
    // pinned node announces before parking, so fewer than 3 concurrent claims
    // means the path under test did not run.
    expect(maxConcurrentClaims, 'at least one election loser must have claimed').to.be.at.least(3);

    // The load-bearing assertion: every node's view drains to zero although the
    // TTL is an hour away. The winners' rows die by their running broadcasts;
    // the losers' rows can ONLY die by the cleared claim broadcast.
    await waitFor(
      async () => {
        const rows = await Promise.all(
          env.clients.map((c) => dbClient(c.num).getAppInstallingLocations(appName)),
        );
        return rows.every((r) => r.length === 0);
      },
      { timeout: 60000, interval: 2000, label: `${appName} claims all released without TTL` },
    );

    // The cleared message itself was seen on the wire: receivers republish it
    // on the event bus (harness observability of the v2 clear).
    const clearedSeen = env.clients.some((c) => c.getEventBuffer().some(
      (e) => e.event === 'network:appinstalling' && e.data?.name === appName && e.data?.cleared === true,
    ));
    expect(clearedSeen, 'some node must have received a cleared claim broadcast').to.equal(true);
  });
});
