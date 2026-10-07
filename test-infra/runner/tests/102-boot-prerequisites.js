// fleet: 1
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import {
  waitForDaemonReady, waitForCapabilityUp, waitForBootSettled, waitFor,
} from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { getSubnetConfig } from '../framework/subnet-config.js';

const subnet = getSubnetConfig();

let env;

describe('Boot: prerequisites', function () {
  before(async function () {
    this.timeout(120000);
    env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false, discoveryAutostart: true });
    await waitForDaemonReady(env.clients[0]);
  });

  // Boot starts every owner at once, so these arrive in no fixed order
  // relative to the daemon's: each check waits for its own signal.

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('should connect to MongoDB', async function () {
    const db = dbClient(1);
    const height = await db.explorerHeight();
    expect(height).to.be.a('number');
    expect(height).to.be.greaterThan(0);
  });

  it('should prepare the local, temporary and global app collections', async function () {
    // localDbPrepared is raised once every collection and index is prepared,
    // the app state event log among them.
    await waitForCapabilityUp(env.clients[0], 'localDbPrepared');
  });

  it('should wait for daemon RPC before proceeding', async function () {
    await env.clients[0].waitForEvent('daemon:polled', () => true, 60000);
  });

  it('should report daemon as synced', async function () {
    const res = await env.clients[0].getBlockchainInfo();
    expect(res.status).to.equal('success');
    expect(res.data.blocks).to.be.greaterThan(0);
  });

  it('should load geolocation from database', async function () {
    const db = dbClient(1);
    const geo = await db.geolocation();
    expect(geo).to.not.be.null;
    expect(geo.geolocation.ip).to.equal(subnet.nodeIp(1));
  });

  it('should reach the Docker daemon inside the container', async function () {
    await waitForCapabilityUp(env.clients[0], 'dockerReachable');
  });

  it('should run the app spawner', async function () {
    await waitFor(
      async () => ((await env.clients[0].getTestCounters())['spawner:pass'] ?? 0) > 0,
      { timeout: 120000, interval: 2000, label: 'a spawner pass ran' },
    );
  });

  it('should start Flux Discovery', async function () {
    await env.clients[0].waitForEvent('discovery:started', () => true, 60000);
  });

  it('should boot on the config it was given', async function () {
    // A node that cannot read its config never reaches the end of its boot.
    await waitForBootSettled(env.clients[0], 120000);
  });
});
