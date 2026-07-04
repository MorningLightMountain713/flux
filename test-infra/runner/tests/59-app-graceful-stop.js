import {
  describe, it, before, after, beforeEach,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { buildSeedableGracefulV8App, buildSeedableTestApp } from '../framework/seed-helper.js';
import { pushTestApp } from '../framework/registry-helper.js';
import { getAppContainerStatus } from '../framework/container.js';
import { waitForUp, waitForDown, waitFor } from '../framework/wait.js';
import {
  shutdowndControl, waitForShutdowndCall, assertNoShutdowndCall,
} from '../framework/shutdownd-control.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// Per-app graceful-stop (M7): on an Arcane node the stop is routed through
// flux-shutdownd — a graceful drain, or a zero-budget force — rather than a local
// appDockerKill, and FluxOS awaits the daemon before removing the container. This
// suite stands up an Arcane fleet with the mock flux-shutdownd (shutdowndMock) and
// drives each routing case, asserting on the mock's call log (the daemon-side view)
// plus container/installed state. A cleartext v8 graceful app carries the legacy
// `gracefulShutdownSec:<n>` description token (AppComponentV8 parses it); suite 60
// covers the encrypted-v9 native-`shutdown` shape through the decrypt path.
//
// The teardown reasons: a non-force /apps/appremove writes no reason, so the
// teardown defaults to `ttl-expired` — the same route real expiry and cancel take
// (they differ only upstream of the teardown, which M7 did not change), so this
// covers the expiry/cancel headline without an infeasible 22000-block advance.
//
// Fleet size / peering thresholds may need tuning on the runner; a small Arcane
// fleet only reaches ~2 outbound (see reconciler-suite bootAndPeer notes).
const NODES = 5;
const NODE_IDX = 0; // install + drive every scenario on node 0
const GRACEFUL_S = 3;

const owner = appOwnerKey().zelid;

describe('per-app graceful stop routes through flux-shutdownd on Arcane (v8)', function () {
  let env;
  let client;
  let control;
  dumpLogsOnFailure(() => env);

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: true, shutdowndMock: true,
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1 });
    client = env.clients[NODE_IDX];
    control = shutdowndControl(NODE_IDX + 1);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  // Each scenario installs its own uniquely-named app, then resets the mock's call
  // log + behaviour so assertions see only this scenario's traffic (plans persist
  // across reset, so a pushed plan is still observable via getState).
  beforeEach(async () => {
    await control.reset();
  });

  async function installGraceful(name) {
    await pushTestApp(name);
    const app = await buildSeedableGracefulV8App({ name, gracefulSec: GRACEFUL_S, exitCode: 0 });
    await installOnNodes(env, app, [NODE_IDX]);
    await waitForUp(client, name, `${name} running before stop`);
  }

  async function installPlain(name) {
    await pushTestApp(name);
    const app = await buildSeedableTestApp({ name, exitCode: 0 });
    await installOnNodes(env, app, [NODE_IDX]);
    await waitForUp(client, name, `${name} running before stop`);
  }

  const ownerAuth = () => authenticate(client.url, appOwnerKey());
  const isRemoved = async (name) =>
    !(await getAppContainerStatus(client.container, name, { all: true }));

  it('graceful app expiry drains via the daemon, then removes (no local kill)', async function () {
    this.timeout(180000);
    const name = `gsexpiry${Date.now()}`;
    await installGraceful(name);

    // a graceful app gets a plan pushed at install time (survives control.reset)
    const state = await control.getState();
    expect(state.plans).to.include(`${owner}:${name}`);

    await control.reset();
    const auth = await ownerAuth();
    await client.removeApp(name, { zelidauth: auth.zelidauth });

    const call = await waitForShutdowndCall(control, (c) => c.method === 'begin_app_stop' && c.app === name);
    expect(call.reason).to.equal('ttl-expired');
    expect(call.force).to.equal(false);
    const now = Math.floor(Date.now() / 1000);
    expect(call.deadline).to.be.within(now - 5, now + GRACEFUL_S + 5);

    expect(await isRemoved(name)).to.equal(true);
  });

  it('reconciler stop-but-keep routes to the daemon; container stops, app is NOT removed', async function () {
    this.timeout(180000);
    const name = `gskeep${Date.now()}`;
    await installGraceful(name);
    await control.reset();

    const auth = await ownerAuth();
    const res = await client.getAuthed(`/apps/appstop/${name}`, auth.zelidauth);
    expect(res.status).to.equal('success');

    const call = await waitForShutdowndCall(control, (c) => c.method === 'begin_app_stop' && c.app === name);
    expect(call.force).to.equal(false);
    // operatorStopped maps to user-cancel (condemn would be eviction)
    expect(call.reason).to.equal('user-cancel');

    await waitForDown(client, name, `${name} stopped by the daemon`);
    // stop-but-keep: still installed
    const installed = await client.getInstalledApps();
    expect(installed.data.some((a) => a.name === name)).to.equal(true);
  });

  it('node-pipeline defer: a -32010 reject leaves the app installed (teardown stays owed)', async function () {
    this.timeout(180000);
    const name = `gsdefer${Date.now()}`;
    await installGraceful(name);
    await control.reset();
    await control.setBehavior(name, 'reject');

    const auth = await ownerAuth();
    await client.removeApp(name, { zelidauth: auth.zelidauth });

    await waitForShutdowndCall(control, (c) => c.method === 'begin_app_stop' && c.app === name);
    // deferred: the container and install survive (the node-wide pipeline owns the stop)
    await new Promise((r) => { setTimeout(r, 4000); });
    expect(await isRemoved(name)).to.equal(false);
  });

  it('daemon-unreachable fallback: the app still removes via a local graceful stop', async function () {
    this.timeout(180000);
    const name = `gsunreach${Date.now()}`;
    await installGraceful(name);
    await control.reset();
    await control.refuse(true);
    try {
      const auth = await ownerAuth();
      await client.removeApp(name, { zelidauth: auth.zelidauth });
      // the socket refused, so no begin_app_stop was answered — yet the local graceful
      // fallback stops AND removes the app (it never lingers stopped-but-present)
      await waitFor(() => isRemoved(name), { timeout: 60000, label: `${name} removed via local fallback` });
    } finally {
      await control.refuse(false);
    }
  });

  it('plain app on Arcane still routes the stop through the daemon', async function () {
    this.timeout(180000);
    const name = `gsplain${Date.now()}`;
    await installPlain(name);
    await control.reset();

    const auth = await ownerAuth();
    await client.removeApp(name, { zelidauth: auth.zelidauth });

    const call = await waitForShutdowndCall(control, (c) => c.method === 'begin_app_stop' && c.app === name);
    expect(call.reason).to.equal('ttl-expired');
    expect(call.force).to.equal(false);
    expect(await isRemoved(name)).to.equal(true);
  });

  it('operator force-remove sends a forceful begin_app_stop (near-now deadline)', async function () {
    this.timeout(180000);
    const name = `gsforce${Date.now()}`;
    await installGraceful(name);
    await control.reset();

    const auth = await ownerAuth();
    await client.removeApp(name, { force: true, zelidauth: auth.zelidauth });

    const call = await waitForShutdowndCall(control, (c) => c.method === 'begin_app_stop' && c.app === name);
    expect(call.force).to.equal(true);
    const now = Math.floor(Date.now() / 1000);
    expect(call.deadline).to.be.within(now - 5, now + 5); // force budget is 0
    expect(await isRemoved(name)).to.equal(true);
  });

  it('operator force preempts an in-flight drain; a non-operator removal does not', async function () {
    this.timeout(240000);
    const name = `gspreempt${Date.now()}`;
    await installGraceful(name);
    await control.reset();
    // hold the drain open so it is genuinely in-flight
    await control.setBehavior(name, 'hang');

    const auth = await ownerAuth();
    // start a non-force removal; its begin_app_stop hangs in the mock
    const draining = client.removeApp(name, { zelidauth: auth.zelidauth });
    await waitForShutdowndCall(control, (c) => c.method === 'begin_app_stop' && c.app === name);

    // a second NON-operator (non-force) removal must defer, never escalate
    await client.removeApp(name, { zelidauth: auth.zelidauth }).catch(() => {});
    await assertNoShutdowndCall(control, (c) => c.method === 'force_app_stop' && c.app === name, 4000);

    // the operator force-remove escalates the in-flight drain via force_app_stop
    await client.removeApp(name, { force: true, zelidauth: auth.zelidauth });
    const forced = await waitForShutdowndCall(control, (c) => c.method === 'force_app_stop' && c.app === name);
    expect(forced.app).to.equal(name);

    await draining.catch(() => {}); // the hung begin_app_stop resolves 'forced'
    expect(await isRemoved(name)).to.equal(true);
  });
});
