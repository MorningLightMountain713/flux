// fleet: 5
/*
 * A node with room for an app's new specification keeps the app through a
 * redeploy, though it has no room for the old and new specifications together.
 *
 * The redeploy removes the app's components and then checks the node can hold
 * the new specification before installing it. The app's database row still holds
 * the old specification at that moment - it is replaced only once the check has
 * passed - so a check that counted every installed row would count the app twice:
 * its old resources and its new ones. A node short of room for both refuses, and
 * the refusal removes the app from the node and tells the network.
 *
 * The node is sized so the difference decides it. A component of an app
 * registered before v9 takes its hdd plus the root filesystem flux-spec gives it
 * on the host; the room the node leaves for apps is the new footprint plus half
 * the old one, so the new specification fits alone and not beside the old. The
 * hdd change also takes the HARD path, which is the path that removes the volume
 * and so the one where a refusal costs the most.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { parseContainerData } from '@runonflux/flux-spec-backend';
import { createTestEnv } from '../framework/test-env.js';
import { pushImage } from '../framework/registry-helper.js';
import { buildSeedableApp, buildSeedableUpdate } from '../framework/seed-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { bootAndPeer, installOnNodes, seedSpecUpdate } from '../framework/reconciler-suite.js';
import { getAppContainerId } from '../framework/container.js';
import { waitFor, waitForComponentRedeployed } from '../framework/wait.js';
import { driveUntil, stopTicker } from '../framework/daemon-control.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

const CONTAINER_DATA = '/tmp';
const HDD_BEFORE = 10;
const HDD_AFTER = 20;
// A cumulus node's disk, and the share of it hwRequirements.nodeCapacity counts.
const CUMULUS_DISK_GB = 240;
const USABLE_GB = CUMULUS_DISK_GB * 0.95;
const footprintGb = (hdd) => hdd + parseContainerData(CONTAINER_DATA, hdd, ['c'], 0).persistentStorage.rootFsGb;
const ROOM_FOR_APPS_GB = footprintGb(HDD_AFTER) + footprintGb(HDD_BEFORE) / 2;
// Node 1 (client index 0): a cumulus node with room for the new specification alone.
const ROOM_FOR_ONE_COPY = { lockedSystemResources: { hdd: 0, extrahdd: Math.round(USABLE_GB - ROOM_FOR_APPS_GB) } };

describe('a redeploy keeps the app on a node with room for its new specification alone', function () {
  let env;
  dumpLogsOnFailure(() => env);

  const appName = `e2eredeproom${Date.now()}`;
  let holder;
  let app;
  let containerBefore;

  // The route carries `cache('30 seconds')` keyed on the URL, so a read right
  // after the redeploy would be handed the answer from before it. The unique
  // parameter makes each read a fresh one.
  async function localSpec(client) {
    const res = await client.get(`/apps/installedapps?_=${Date.now()}`);
    if (res.status !== 'success') return null;
    return (res.data ?? []).find((a) => a.name === appName) ?? null;
  }

  before(async function () {
    this.timeout(420000);

    env = await createTestEnv({
      hookCtx: this,
      nodes: 5,
      tickerAutostart: false,
      nodeTiers: { 1: 'CUMULUS' },
      configOverrides: { fluxapps: { adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
      nodeConfigOverrides: { 0: ROOM_FOR_ONE_COPY },
    });
    await bootAndPeer(env);
    [holder] = env.clients;

    await pushImage(appName, 'v1');
    app = await buildSeedableApp({
      pinnedTo: [0],
      name: appName,
      instances: 1,
      compose: [{
        name: appName,
        description: 'redeploy room test container',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: CONTAINER_DATA,
        cpu: 0.1,
        ram: 100,
        hdd: HDD_BEFORE,
        repoauth: '',
      }],
    });

    await installOnNodes(env, app, [0]);
    await waitFor(async () => {
      containerBefore = await getAppContainerId(holder.container, appName, appName);
      return Boolean(containerBefore);
    }, { timeout: 180000, interval: 2000, label: 'the app is running before its spec changes' });
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('replaces the component at the new specification and keeps the app', async function () {
    this.timeout(1500000);

    const updated = await buildSeedableUpdate(app, (spec) => {
      spec.compose[0].hdd = HDD_AFTER;
    });
    const beforeUpdate = holder.getLastEventId();
    await seedSpecUpdate(env, updated, [0]);
    await stopTicker();

    // Either answer ends the drive: the hard redeploy finishing, or the app
    // gone from the node. Driving on after a removal would only spend blocks.
    const settled = async () => {
      const redeployed = await waitForComponentRedeployed(holder, appName, appName, true, 0, { afterId: beforeUpdate })
        .then(() => true, () => false);
      return redeployed || (await localSpec(holder)) === null;
    };
    await driveUntil(holder, settled, { blocks: 108, label: 'the node redeploys the app or removes it' });

    const installed = await localSpec(holder);
    expect(installed, 'the node removed the app: it counted the old specification beside the new one').to.not.be.null;
    expect(installed.hash, 'the row is at the new specification').to.equal(updated.hash);
    expect(installed.compose[0].hdd).to.equal(HDD_AFTER);

    const containerAfter = await getAppContainerId(holder.container, appName, appName);
    expect(containerAfter, 'the app is running after the redeploy').to.be.a('string');
    expect(containerAfter, 'the component was replaced, not left as it was').to.not.equal(containerBefore);
  });
});
