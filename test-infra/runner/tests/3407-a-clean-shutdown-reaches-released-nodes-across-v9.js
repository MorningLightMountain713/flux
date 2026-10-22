// fleet: 3
// base-image: FLUX_E2E_BASE_TAG
/*
 * RELEASED-FLEET COMPATIBILITY: delete with appMessaging/releasedFleetSigterm.
 *
 * A v9 node whose machine shuts down cleanly tells released nodes, which learn a
 * stop only from a fluxnodesigterm broadcast: a released node that holds the
 * stopping node's location rows shortens them to sigtermExpiryS (420 s) rather
 * than letting them live out locationTtlS (7500 s).
 *
 * The released node (FLUX_E2E_BASE_TAG) can reach the stopping v9 node only
 * through a second v9 node - its traffic to and from the stopping node is
 * dropped - so the broadcast reaches it only if v9 passes it on.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deliverAppMessage } from '../framework/app-delivery.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { execInContainer, holdFluxosDown, releaseFluxos } from '../framework/container.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { dbClient } from '../framework/db-client.js';
import { waitFor, waitForInstallSettled } from '../framework/wait.js';

const BASE_TAG = process.env.FLUX_E2E_BASE_TAG;
const NODES = 3;
const STOPPING = 0; // v9, runs the app, its machine shuts down
const RELAY = 1; // v9, the released node's only path to the stopping node
const RELEASED = 2;
const SIGTERM_EXPIRY_MS = 420_000; // the released default
// The harness's own row lifetime (180 s) is shorter than the sigterm expiry, so
// there would be nothing to shorten: this suite runs a lifetime the expiry is
// well inside, as production's 7500 s is.
const LOCATION_TTL_S = 3600;

describe('a clean shutdown reaches released nodes across v9', function () {
  let env;
  let held = false;
  const name = `sigtermacross${Date.now()}`;
  const nodeIp = (index) => getSubnetConfig().nodeIp(index + 1);
  const rowsOnReleased = () => dbClient(RELEASED + 1).releasedLocationRows(nodeIp(STOPPING));

  before(async function () {
    this.timeout(900000);
    if (!BASE_TAG) {
      throw new Error('FLUX_E2E_BASE_TAG names the node image of released FluxOS: build it with FLUX_E2E_TAG=<base-tag> ./test-infra/build-release-image.sh v8.21.1');
    }
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      nodeImageTags: { [RELEASED]: BASE_TAG },
      configOverrides: { fluxapps: { locationTtlS: LOCATION_TTL_S } },
      tickerAutostart: false,
    });

    // Peered as a whole first: each node attains the peer floor (two), and keeps it
    // with the one peer the cut below leaves it (it is lost only under one).
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });

    // Then the released node and the stopping node are cut apart, both ways, with
    // a reset so the connection they hold ends now rather than at its dead-peer
    // timeout. The relay is the released node's only path to the stopping node.
    const stopping = nodeIp(STOPPING);
    const cut = await execInContainer(env.clients[RELEASED].container,
      `iptables -I INPUT -s ${stopping} -p tcp -j REJECT --reject-with tcp-reset `
      + `&& iptables -I OUTPUT -d ${stopping} -p tcp -j REJECT --reject-with tcp-reset `
      + `&& iptables -C INPUT -s ${stopping} -p tcp -j REJECT --reject-with tcp-reset && echo cut`);
    expect(cut.stdout.trim(), `the released node is cut off from the stopping node: ${cut.output}`).to.equal('cut');
    const holds = async (from, to) => {
      const [outgoing, incoming] = await Promise.all([env.clients[from].getPeers(), env.clients[from].getIncomingPeers()]);
      return [...(outgoing.data ?? []), ...(incoming.data ?? [])].some((p) => String(p.ip ?? p).startsWith(nodeIp(to)));
    };
    await waitFor(async () => !(await holds(RELEASED, STOPPING)) && !(await holds(STOPPING, RELEASED)), {
      timeout: 120000, interval: 2000, label: 'the released and stopping nodes hold no connection with each other',
    });
    expect(await holds(RELEASED, RELAY), 'the released node still holds the relay').to.equal(true);
    expect(await holds(STOPPING, RELAY), 'the stopping node still holds the relay').to.equal(true);

    await pushImage(name, 'v1');
    const app = await buildSeedableApp({
      name,
      pinnedTo: [STOPPING],
      instances: 1,
      compose: [{
        name,
        description: 'a clean shutdown told to released nodes',
        repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
        ports: [],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: '/appdata',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      }],
    });
    await deliverAppMessage(env, app.message, [STOPPING]);
    await waitForInstallSettled(env.clients[STOPPING], name, 300000);

    // The released node holds the stopping node's rows, learned across the relay,
    // with their full lifetime.
    await waitFor(async () => (await rowsOnReleased()).some((row) => row.name === name), {
      timeout: 300000, interval: 3000, label: 'the released node holds the stopping node\'s location row',
    });
  });

  after(async function () {
    this.timeout(180000);
    if (held) await releaseFluxos(env.clients[STOPPING].container).catch(() => {});
    await env?.teardown();
  });

  it('shortens the stopping node\'s rows on the released node to the sigterm expiry', async function () {
    this.timeout(600000);
    const before = await rowsOnReleased();
    const row = before.find((r) => r.name === name);
    expect(new Date(row.expireAt).getTime() - Date.now(), 'the row starts well past the sigterm expiry')
      .to.be.greaterThan(SIGTERM_EXPIRY_MS + 15 * 60_000);
    expect(await dbClient(RELEASED + 1).appStateEvents('sigterm', nodeIp(STOPPING)), 'no stop told yet').to.deep.equal([]);

    const container = env.clients[STOPPING].container;
    await execInContainer(container, 'mkdir -p /run/systemd/shutdown && touch /run/systemd/shutdown/scheduled');
    const stoppedAt = Date.now();
    await holdFluxosDown(container);
    held = true;

    let events = [];
    await waitFor(async () => {
      events = await dbClient(RELEASED + 1).appStateEvents('sigterm', nodeIp(STOPPING));
      return events.length > 0;
    }, { timeout: 120000, interval: 1000, label: 'the released node is told of the stop' });
    // Stored as a date by a released node.
    const broadcastedAt = new Date(events[0].broadcastedAt).getTime();
    expect(broadcastedAt).to.be.within(stoppedAt - 5000, Date.now());

    const after = (await rowsOnReleased()).find((r) => r.name === name);
    expect(new Date(after.expireAt).getTime(), 'the row now expires at the sigterm expiry')
      .to.be.at.most(broadcastedAt + SIGTERM_EXPIRY_MS + 1000);
  });
});
