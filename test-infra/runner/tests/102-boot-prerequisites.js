// fleet: 1
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { waitForDaemonReady, waitFor } from '../framework/wait.js';
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

  // Boot starts every owner at once, so these lines arrive in no fixed order
  // relative to the daemon's: each check waits for its own line.
  const logged = (line) => waitFor(
    () => env.nodeHasLog(0, line),
    { timeout: 60000, interval: 250, label: `'${line}' log line` },
  );

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

  it('should prepare local database collections', async function () {
    await logged('Local database prepared');
  });

  it('should prepare temporary database', async function () {
    await logged('Temporary database prepared');
  });

  it('should prepare global app collections', async function () {
    // Where an app runs is derived from this event log; there is no materialized
    // locations collection to prepare.
    await logged('App state events collection prepared');
  });

  it('should wait for daemon RPC before proceeding', async function () {
    await logged('Daemon Sync status');
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

  it('should start Docker daemon inside container', async function () {
    await logged('dockerd is ready');
  });

  it('should initialize app spawner', async function () {
    await logged('App Spawner initialized');
  });

  it('should start Flux Discovery', async function () {
    await logged('Flux Discovery started');
  });

  it('should not log any config-related errors', async function () {
    const count = env.nodeLogCount(0, 'Cannot parse config|Cannot find module.*config');
    expect(count).to.equal(0);
  });
});
