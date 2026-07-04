import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitForDown } from '../framework/wait.js';
import { getAppContainerStatus } from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { shutdowndControl, waitForShutdowndCall } from '../framework/shutdownd-control.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// The graceful-stop routing (M7) for the PRODUCTION shape: an encrypted v9 app with
// a native `shutdown.gracefulTimeout` component field. This exercises a code path the
// cleartext-v8 suite (59) skips — the deployment is built from the DECRYPTED spec
// (deploymentProvider resolves the sealed spec, DeploymentSpec.fromSpec projects
// resolved.spec), so the daemon-routed stop only fires if decrypt → shutdown-field →
// appRequiresDaemonShutdown all hold on the encrypted path.
//
// Deploy goes through the REAL v9 submission (registerEncryptedV9App: sealed spec,
// no content) + on-chain confirm + spawner install, mirroring the content suites.
// arcane:true makes the node accept the v9 app and run the benchmark crypto;
// shutdowndMock stands up the daemon socket the stop routes to.
const NODES = 5;
const GRACEFUL_S = 3;

const ownerKey = appOwnerKey();
const owner = ownerKey.zelid;

function gracefulComponents(name) {
  return {
    web: {
      name: 'web',
      description: 'graceful v9 component',
      image: `${REGISTRY_REPO_HOST}/${name}:v1`,
      cpu: 0.1,
      memory: 100,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 1, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      env: { EXIT_CODE: '0' },
      shutdown: { gracefulTimeout: GRACEFUL_S },
    },
  };
}

describe('per-app graceful stop routes through flux-shutdownd on Arcane (encrypted v9)', function () {
  let env;
  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: true, shutdowndMock: true,
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1, pricing: true });
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  // Register an encrypted v9 graceful app, confirm it on chain, and wait for the
  // spawner to install it somewhere. Returns the installed node index + its client.
  async function deployGracefulV9(name) {
    await pushTestApp(name);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name, owner, ownerKey, components: gracefulComponents(name), instances: 3,
    });
    expect(res.status).to.equal('success');
    const appHash = res.data;

    await queueAppTx(appHash);
    await advanceBlocks(3);

    const winner = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, name, 200000);
      return i;
    }));
    return { idx: winner, client: env.clients[winner] };
  }

  it('encrypted-v9 graceful app drains via the daemon on expiry, then removes', async function () {
    this.timeout(300000);
    const name = `egsexpiry${Date.now()}`;
    const { idx, client } = await deployGracefulV9(name);
    const control = shutdowndControl(idx + 1);

    // decrypt → shutdown field → plan pushed at install time
    const state = await control.getState();
    expect(state.plans).to.include(`${owner}:${name}`);

    await control.reset();
    const auth = await authenticate(client.url, ownerKey);
    await client.removeApp(name, { zelidauth: auth.zelidauth });

    const call = await waitForShutdowndCall(control, (c) => c.method === 'begin_app_stop' && c.app === name);
    expect(call.reason).to.equal('ttl-expired');
    expect(call.force).to.equal(false);
    const now = Math.floor(Date.now() / 1000);
    expect(call.deadline).to.be.within(now - 5, now + GRACEFUL_S + 5);

    expect(await getAppContainerStatus(client.container, name, { all: true })).to.equal(null);
  });

  it('encrypted-v9 reconciler stop-but-keep routes to the daemon without removing', async function () {
    this.timeout(300000);
    const name = `egskeep${Date.now()}`;
    const { idx, client } = await deployGracefulV9(name);
    const control = shutdowndControl(idx + 1);
    await control.reset();

    const auth = await authenticate(client.url, ownerKey);
    const res = await client.getAuthed(`/apps/appstop/${name}`, auth.zelidauth);
    expect(res.status).to.equal('success');

    const call = await waitForShutdowndCall(control, (c) => c.method === 'begin_app_stop' && c.app === name);
    expect(call.force).to.equal(false);
    expect(call.reason).to.equal('user-cancel');

    await waitForDown(client, name, `${name} stopped by the daemon`);
    const installed = await client.getInstalledApps();
    expect(installed.data.some((a) => a.name === name)).to.equal(true);
  });
});
