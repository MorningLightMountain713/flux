// fleet: 3
// base-image: FLUX_E2E_BASE_TAG
/*
 * A node upgraded onto resources that hold when it took each instance dates every
 * instance it already holds at what it last announced for it, so the instance keeps
 * the place the network gives it. Its announcements are filed under its address,
 * and a node can come up without one: until benchmark reports it, the node dates
 * nothing (app:placementRecorded); once it has it, the instance is dated at the
 * node's own last announcement (source announcement), and the node's next
 * announcement carries that date to its peers.
 *
 * Node 0 boots the released FluxOS (FLUX_E2E_BASE_TAG, built by
 * test-infra/build-release-image.sh from the release's ref), whose spawner installs
 * the app from the registration and announces it. Its address is held back, node 0
 * is upgraded in place to the run's image, and the address is released. Nodes 1
 * and 2 run the run's image throughout; a three-node ring is the smallest whose
 * registration door opens, and the registration goes in at its middle.
 *
 * Without FLUX_E2E_BASE_TAG the suite fails before booting, naming the build it needs.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { buildAppSpec, registerAndConfirm } from '../framework/app-helper.js';
import { nodeKey } from '../framework/keys.js';
import { IMAGE_TAG } from '../framework/flux-spec-vendor.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { waitForBootSettled, waitForInstallSettled, assertNoEvent } from '../framework/wait.js';
import { setBenchmarkUnresolved } from '../framework/daemon-control.js';
import { socketAddr } from '../framework/state-events.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

const BASE_TAG = process.env.FLUX_E2E_BASE_TAG;
const UPGRADED = 0;
const REGISTRAR = 1;
const OTHERS = [1, 2];
// Production's location lifetime, so the node's own last announcement still
// stands while it has no address.
const LOCATION_TTL_S = 30 * 60;
// Long enough that the node is not out of service while the case holds its
// address back, at the harness's 15 s ask interval.
const PUBLIC_IP_ASKS_BEFORE_DOS = 40;
// A node removes its apps when it has not synced within this: long enough to hold
// the address back and keep the app.
const BOOT_SYNC_TIMEOUT_MS = 300000;
// One harness ask interval and three confirmation polls: a dating that ran without
// the address has written by then.
const UNRESOLVED_WINDOW_MS = 20000;
const bare = (address) => String(address).replace(/:16127$/, '');

describe('a node that boots without its address dates its records once it has one', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const appName = `e2enoaddress${Date.now()}`;
  let node;
  let address;
  // The runningSince the released node announced for the app, as its peers stored it.
  let releasedSince;

  const runningSinceIn = (data) => {
    const entry = data.apps?.find((a) => a.name === appName);
    return entry ? new Date(entry.runningSince).getTime() : null;
  };
  const storedFromNode = (i, afterId, timeout = 240000) => env.clients[i].waitForEvent(
    'network:apprunning',
    (d) => bare(d.ip) === bare(address) && d.apps?.some((a) => a.name === appName),
    timeout,
    { afterId },
  ).then(({ data }) => runningSinceIn(data));

  before(async function () {
    this.timeout(900000);
    if (!BASE_TAG) {
      throw new Error('FLUX_E2E_BASE_TAG names the node image of the released FluxOS the node upgrades from: build it with FLUX_E2E_TAG=<base-tag> ./test-infra/build-release-image.sh <release ref>');
    }
    if (BASE_TAG === IMAGE_TAG) throw new Error('FLUX_E2E_BASE_TAG must name another build than FLUX_E2E_TAG: the suite upgrades from the one to the other');
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      nodeImageTags: { [UPGRADED]: BASE_TAG },
      tickerAutostart: false,
      configOverrides: {
        fluxapps: { locationTtlS: LOCATION_TTL_S, publicIpAsksBeforeDos: PUBLIC_IP_ASKS_BEFORE_DOS },
        system: { bootSyncTimeoutMs: BOOT_SYNC_TIMEOUT_MS },
      },
    });
    await bootAndPeer(env);
    node = env.clients[UPGRADED];
    address = socketAddr(UPGRADED + 1);
    const registrar = env.clients[REGISTRAR];
    await registrar.waitForEvent('orchestrator:stateChanged', (d) => d.to === 'READY', 300000);

    const spec = buildAppSpec({
      name: appName,
      compose: [{
        name: 'web',
        description: 'dated across the upgrade',
        repotag: `${REGISTRY_REPO_HOST}/e2e-pause:v1`,
        ports: [],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: '/data',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      }],
    });
    const installMark = node.getLastEventId();
    const announcedMark = env.clients[REGISTRAR].getLastEventId();
    const registered = await registerAndConfirm(registrar.url, nodeKey(REGISTRAR + 1), spec, env.clients);
    expect(registered.status, JSON.stringify(registered)).to.equal('success');
    // The released node takes the app the way a node takes one from the network:
    // its own spawner places it from the registration it holds.
    await waitForInstallSettled(node, appName, 300000, { afterId: installMark });
    releasedSince = await storedFromNode(REGISTRAR, announcedMark);
    expect(releasedSince, 'fixture: the released node announced the app').to.be.a('number');
  });

  after(async function () {
    this.timeout(60000);
    if (address) await setBenchmarkUnresolved(address, false).catch(() => {});
    await env?.teardown();
  });

  it('dates nothing while it has no address, then dates the app at its own last announcement and announces that', async function () {
    this.timeout(900000);
    await setBenchmarkUnresolved(address, true);
    const afterId = node.getLastEventId();
    await env.upgradeNode(UPGRADED, { tag: IMAGE_TAG });

    await assertNoEvent(node, 'app:placementRecorded', (d) => d.name === appName, UNRESOLVED_WINDOW_MS, { afterId });

    const resolvedId = node.getLastEventId();
    const storedIds = env.clients.map((c) => c.getLastEventId());
    await setBenchmarkUnresolved(address, false);
    await waitForBootSettled(node, 420000, { afterId });
    const { data: recorded } = await node.waitForEvent('app:placementRecorded', (d) => d.name === appName, 240000, { afterId: resolvedId });
    expect(recorded.source, 'the instance was not dated from the node\'s own announcement').to.equal('announcement');
    expect(new Date(recorded.placedAt).getTime(), 'the date is not what the released node announced').to.equal(releasedSince);

    const stored = await Promise.all(OTHERS.map((i) => storedFromNode(i, storedIds[i])));
    expect(stored, 'a peer stored a different runningSince').to.deep.equal(OTHERS.map(() => releasedSince));
  });
});
