// fleet: 1
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import {
  waitForDaemonReady, bootDecision,
} from '../framework/wait.js';
import {
  clearAllNodeStatus,
} from '../framework/daemon-control.js';
import { getSubnetConfig } from '../framework/subnet-config.js';

const subnet = getSubnetConfig();

// Assertion conventions in this suite:
// - Boot-context FACTS (firstBoot / machineRebooted / cleanShutdown) are
//   asserted on the orchestrator:started event payload — the contract-grade
//   observable — never via log substrings.
// - The branch the boot took (which removal or wait path) is asserted on the
//   boot:settled payload, read once per block in before(). Tests are
//   order-independent.

// Suite 1: FluxOS-only restart (bootContext='running')
//
// The FluxOS process restarted but the machine did NOT reboot. There is no skip/fast-path:
// reconcileAppsOnBoot runs on every boot (71588a001 removed the machineRebooted gate so a
// container that exited while FluxOS was down still gets restarted), so the boot path here
// is identical to a machine reboot and settles via the same daemon->confirm->db->reconcile
// sequence (hence the same ~50s settle window as the 'rebooted' suite below). This suite
// therefore only asserts what is UNIQUE to a FluxOS-only restart: the boot context is
// detected as machineRebooted=false and, with near-zero downtime, locations are not expired
// (apps are not removed) — the cleanShutdown=false branch that suite 19 doesn't cover.
// Exited-container recovery / running-container-not-bounced is covered by suites 23 and 40.

describe('Boot manager: FluxOS-only restart', function () {
  let env;
  let settled;

  before(async function () {
    this.timeout(120000);
    env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false, bootContext: 'running' });
    await waitForDaemonReady(env.clients[0]);
    settled = await bootDecision(env);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('detects machineRebooted=false', async function () {
    this.timeout(10000);
    const event = await env.clients[0].waitForEvent('orchestrator:started', () => true, 5000);
    expect(event.data.bootContext.machineRebooted).to.equal(false);
  });

  it('does not expire locations (near-zero downtime)', function () {
    expect(settled.decision).to.be.a('string').and.not.equal('locationsExpired');
  });
});

// Suite 2: Machine reboot with clean shutdown (bootContext='rebooted')

describe('Boot manager: machine reboot with clean shutdown', function () {
  let env;
  let settled;

  before(async function () {
    this.timeout(120000);
    env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false, bootContext: 'rebooted' });
    await waitForDaemonReady(env.clients[0]);
    settled = await bootDecision(env);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should detect machineRebooted=true with cleanShutdown=true', async function () {
    this.timeout(10000);
    const event = await env.clients[0].waitForEvent('orchestrator:started', () => true, 5000);
    expect(event.data.bootContext.machineRebooted).to.equal(true);
    expect(event.data.bootContext.cleanShutdown).to.equal(true);
    expect(event.data.bootContext.firstBoot).to.equal(false);
  });

  it('should not report locations expired (downtime within SIGTERM window)', function () {
    expect(settled.decision).to.be.a('string').and.not.equal('locationsExpired');
  });
});

// Suite 3: First boot (no heartbeat)

describe('Boot manager: first boot', function () {
  let env;
  let settled;

  before(async function () {
    this.timeout(120000);
    env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false, bootContext: 'firstBoot' });
    await waitForDaemonReady(env.clients[0]);
    settled = await bootDecision(env);
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should detect firstBoot=true', async function () {
    this.timeout(10000);
    const event = await env.clients[0].waitForEvent('orchestrator:started', () => true, 5000);
    expect(event.data.bootContext.firstBoot).to.equal(true);
    expect(event.data.bootContext.machineRebooted).to.equal(true);
  });

  it('should take the wait-for-sync branch', function () {
    expect(settled.firstBoot).to.equal(true);
    expect(settled.decision).to.be.a('string').and.not.equal('locationsExpired');
  });
});

// Suite 4: Daemon timeout during boot
//
// The daemon RPC fails for this node, so the boot path is: daemon wait times
// out → removeAllApps('Daemon timeout') → settle (the finally block always
// settles). Settle is anchored in before(); the test asserts the branch.

describe('Boot manager: daemon timeout', function () {
  let env;
  let settled;

  before(async function () {
    this.timeout(120000);
    // arcane:false is this describe's premise: the daemon-timeout removal branch
    // is LEGACY boot behavior. An Arcane node fail-closes instead - the capability
    // verdict polls the dead daemon channel and never latches, so app functions
    // (deliberately) never start and this suite's subject is never reached.
    env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false, bootContext: 'rebooted', rpcFailures: [subnet.nodeIp(1)], arcane: false });
    settled = await bootDecision(env, 0, { timeout: 60000 });
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should remove all apps when daemon times out', function () {
    expect(settled.decision).to.equal('daemonTimeout');
  });
});

// Suite 5: Not confirmed at boot

describe('Boot manager: not confirmed', function () {
  let env;
  let settled;

  before(async function () {
    this.timeout(120000);
    env = await createTestEnv({ hookCtx: this,
      nodes: 1,
      tickerAutostart: false,
      bootContext: 'rebooted',
      nodeStatusOverrides: { [subnet.nodeIp(1)]: 'EXPIRED' },
    });
    settled = await bootDecision(env, 0, { timeout: 60000 });
  });

  after(async function () {
    this.timeout(30000);
    await clearAllNodeStatus();
    await env?.teardown();
  });

  it('should remove all apps when node not confirmed at boot', function () {
    expect(settled.decision).to.equal('notConfirmed');
  });
});

// Suite 6: Stale shutdownReason clearing — sigterm → boot → clear → kill → boot → unclean

describe('Boot manager: shutdownReason sequence', function () {
  describe('clean shutdown (SIGTERM writes shutdownReason)', function () {
    let env;

    before(async function () {
      this.timeout(120000);
      env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false, bootContext: 'rebooted' });
      await waitForDaemonReady(env.clients[0]);
    });

    after(async function () {
      this.timeout(30000);
      await env?.teardown();
    });

    it('should detect cleanShutdown=true on boot after SIGTERM', async function () {
      this.timeout(60000);
      const event = await env.clients[0].waitForEvent('orchestrator:started', () => true, 50000);
      expect(event.data.bootContext.cleanShutdown).to.equal(true);
      expect(event.data.bootContext.machineRebooted).to.equal(true);
    });
  });

  describe('unclean shutdown (no shutdownReason in heartbeat)', function () {
    let env;

    before(async function () {
      this.timeout(120000);
      env = await createTestEnv({ hookCtx: this,
        nodes: 1,
        tickerAutostart: false,
        bootContext: { downtimeMs: 60000, machineBootId: 'old-boot-id' },
      });
      await waitForDaemonReady(env.clients[0]);
    });

    after(async function () {
      this.timeout(30000);
      await env?.teardown();
    });

    it('should detect cleanShutdown=false when shutdownReason absent', async function () {
      this.timeout(60000);
      const event = await env.clients[0].waitForEvent('orchestrator:started', () => true, 50000);
      expect(event.data.bootContext.cleanShutdown).to.equal(false);
      expect(event.data.bootContext.machineRebooted).to.equal(true);
    });
  });
});
