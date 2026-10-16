// fleet: 6
/*
 * A v7 app moves to v9 with its data.
 *
 * A v7 app whose component is `MyWeb`, its volume syncFirst, runs on two hosts, each
 * holding a marker in its data. Its owner moves it to v9 the way an owner does: a
 * node converts the app (GET /apps/appconvert), which lowercases the component to
 * `myweb` and continues it by `renamedFrom: "MyWeb"`; the owner adds the contact and
 * the placement the conversion cannot carry over, and submits the draft as the app's
 * v9 update. Then:
 *   - every host recreates the component under the identifier it had, labelled
 *     `myweb`, on the data and the Syncthing folder it had;
 *   - a node that boots afterwards installs it under the same identifier, on the
 *     Syncthing folder the hosts share;
 *   - a second v7 app making the same move with `renamedFrom` taken out of its draft
 *     installs `myweb` as a new component on an empty volume: what this suite would
 *     see if the move did not carry the component.
 *
 * Each app names exactly as many nodes as it has instances, so every named node's
 * spawner places it. The two hosts are chosen outside env.establishedNodes. The
 * harness's Syncthing carries no data between nodes, so the suite puts each host's
 * marker on its disk and reports that host's folder synced, which is what lets every
 * host of the syncFirst volume start.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { buildAppSpec, registerAndConfirm, confirmOnChain } from '../framework/app-helper.js';
import { convertToV9 } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import {
  appComponentIdentifier, appDataRoot, appSyncthingFolderId, execInContainer, requireAppContainerName,
} from '../framework/container.js';
import { getSyncthingState, setSynced } from '../framework/syncthing-control.js';
import { appView } from '../framework/app-view.js';
import {
  START_ACTIONS, waitFor, waitForDaemonReady, waitForInstallSettled, waitForReconcileActuated,
} from '../framework/wait.js';
import { nodeKey } from '../framework/keys.js';

const NODES = 5;
const FRESH = 4; // boots after the move
const CONVERGE_MS = 300000;
const COMPONENT_LABEL = 'io.runonflux.component';
const LEGACY = 'MyWeb';
const V9 = 'myweb';

describe('a v7 app moves to v9 with its data', function () {
  let env;
  let hosts;
  let registrar;
  let targets;
  const stamp = Date.now();
  const moved = { name: `movev7${stamp}` };
  const control = { name: `movectl${stamp}` };
  const url = (i) => env.clients[i].url;
  const ip = (i) => getSubnetConfig().nodeIp(i + 1);

  async function run(index, command) {
    const r = await execInContainer(env.clients[index].container, `sh -c '${command}'`);
    return { ok: r.exitCode === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? r.output ?? '').trim() };
  }

  const identifierOn = (index, app, component) => appComponentIdentifier(env.clients[index].container, app.name, component);
  const dataOf = async (index, app, component) => `${await appDataRoot(env.clients[index].container, app.name, component)}/appdata`;

  async function labelOf(index, app, component) {
    const container = await requireAppContainerName(env.clients[index].container, app.name, component);
    const { out } = await run(index, `docker inspect --format "{{json .Config.Labels}}" ${container}`);
    return JSON.parse(out)[COMPONENT_LABEL];
  }

  async function foldersOn(index) {
    const state = await getSyncthingState();
    return (state.nodes.find((n) => n.ip === ip(index))?.folders ?? []).map((f) => f.id).sort();
  }

  // A v7 app as an owner registered one: its one component named with capitals, its
  // volume syncFirst, pinned to the hosts and the node that boots later. Every field a
  // v7 component carries is present, in its order: the signature is over this string.
  async function registerV7(app) {
    await pushImage(app.name, 'v1');
    const base = buildAppSpec({
      version: 7,
      name: app.name,
      compose: [{
        name: LEGACY,
        description: 'a v7 component named with capitals',
        repotag: `${REGISTRY_REPO_HOST}/${app.name}:v1`,
        ports: [],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: 'r:/appdata',
        cpu: 0.5,
        ram: 300,
        hdd: 1,
        tiered: false,
        repoauth: '',
        secrets: '',
      }],
      instances: 3,
      nodes: targets.map((i) => `${ip(i)}:16127`),
    });
    const { enterprise, ...spec } = base;
    const anchors = new Map(hosts.map((i) => [i, env.clients[i].getLastEventId()]));
    const registered = await registerAndConfirm(url(registrar), nodeKey(registrar), spec, env.clients.filter(Boolean));
    expect(registered.status, `${app.name}: the v7 registration is accepted: ${JSON.stringify(registered).slice(0, 300)}`).to.equal('success');
    Object.assign(app, { identity: registered.app.identity, view: appView(env, app.name, { component: LEGACY, timeout: CONVERGE_MS }) });

    await Promise.all(hosts.map((i) => waitForInstallSettled(env.clients[i], app.name, CONVERGE_MS)));
    app.folder = await appSyncthingFolderId(env.clients[hosts[0]], app.name, LEGACY);
    app.installedAs = new Map();
    // A syncFirst volume is cleared on its first install, directory included; data
    // written before the clear goes with it. A host starts once its folder reads
    // synced, and promotes only if its disk holds data the index claims.
    await Promise.all(hosts.map(async (index) => {
      let identifier = null;
      await waitFor(async () => { identifier = await identifierOn(index, app, LEGACY); return identifier !== null; }, {
        timeout: CONVERGE_MS, interval: 2000, label: `${app.name}: node ${index} has ${LEGACY}'s container`,
      });
      app.installedAs.set(index, identifier);
      const cleared = await waitForReconcileActuated(env.clients[index], identifier, 'dataCleared', CONVERGE_MS, { afterId: anchors.get(index) });
      const data = await dataOf(index, app, LEGACY);
      const written = await run(index, `mkdir -p ${data} && echo ${index} > ${data}/marker-${index}`);
      expect(written.ok, `${app.name}: node ${index} holds a marker in ${LEGACY}'s data: ${written.err}`).to.equal(true);
      await setSynced({ ip: ip(index), folder: app.folder });
      await waitForReconcileActuated(env.clients[index], identifier, START_ACTIONS, CONVERGE_MS, { afterId: cleared.id });
    }));
  }

  // The owner's move: the node's conversion, with the contact and placement the owner
  // adds, and `renamedFrom` taken out when `carry` is false.
  async function moveToV9(app, { carry }) {
    const res = await convertToV9(url(registrar), {
      name: app.name,
      previousKeys: new Map([[LEGACY, LEGACY]]),
      identity: app.identity,
      edit: (draft) => {
        const edited = {
          ...draft,
          contacts: { email: ['owner@example.com'] },
          placement: { ...(draft.placement ?? {}), targetIps: targets.map(ip) },
        };
        if (!carry) delete edited.components[V9].renamedFrom;
        return edited;
      },
    });
    expect(res.status, `${app.name}: the v9 update is accepted: ${JSON.stringify(res).slice(0, 400)}`).to.equal('success');
    await confirmOnChain(res.data, env.clients.filter(Boolean));
    await app.view.installedEverywhere(res.data, hosts, 'every host applies the v9 update');
    // The record is written before the component is recreated under its new name.
    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      // eslint-disable-next-line no-await-in-loop
      await waitFor(async () => (await identifierOn(index, app, V9)) !== null, {
        timeout: CONVERGE_MS, interval: 3000, label: `${app.name}: node ${index} runs ${V9}`,
      });
    }
    app.latest = res.data;
    return res;
  }

  before(async function () {
    this.timeout(1800000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2, adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    const running = [0, 1, 2, 3];
    hosts = running.filter((i) => !env.establishedNodes.includes(i)).slice(0, 2);
    registrar = running.find((i) => !hosts.includes(i));
    targets = [...hosts, FRESH];
    await registerV7(moved);
    await registerV7(control);
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('carries the component onto v9 under its key, on the data and the folder it had', async function () {
    this.timeout(CONVERGE_MS * 2);
    const was = new Map();
    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      // The folder is configured on the monitor's pass after the install.
      // eslint-disable-next-line no-await-in-loop
      await waitFor(async () => (await foldersOn(index)).length > 0, {
        timeout: CONVERGE_MS, interval: 3000, label: `node ${index} shares ${LEGACY}'s data`,
      });
      // eslint-disable-next-line no-await-in-loop
      was.set(index, await foldersOn(index));
    }

    const res = await moveToV9(moved, { carry: true });
    expect(res.conversion.spec.components[V9].renamedFrom, 'the conversion continues the component by renamedFrom').to.equal(LEGACY);
    expect(res.conversion.warnings.join('\n'), 'and says so').to.include(`continued as "${V9}" by renamedFrom "${LEGACY}"`);
    expect(res.componentKeys.get(V9), 'the component keeps its key').to.equal(LEGACY);

    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      // eslint-disable-next-line no-await-in-loop
      expect(await identifierOn(index, moved, V9), `node ${index}: ${V9} is the component ${LEGACY} was`).to.equal(moved.installedAs.get(index));
      // eslint-disable-next-line no-await-in-loop
      expect(await identifierOn(index, moved, LEGACY), `node ${index} runs no component named ${LEGACY}`).to.equal(null);
      // eslint-disable-next-line no-await-in-loop
      expect(await labelOf(index, moved, V9), `node ${index}: labelled with the v9 name`).to.equal(V9);
      // eslint-disable-next-line no-await-in-loop
      const marker = await run(index, `cat ${await dataOf(index, moved, V9)}/marker-${index}`);
      expect(marker.out, `node ${index}: the data is the data ${LEGACY} held`).to.equal(String(index));
      // eslint-disable-next-line no-await-in-loop
      expect(await foldersOn(index), `node ${index}: the same Syncthing folders`).to.deep.equal(was.get(index));
      // eslint-disable-next-line no-await-in-loop
      expect(await appSyncthingFolderId(env.clients[index], moved.name, V9), `node ${index}: ${V9}'s folder is the one ${LEGACY} had`).to.equal(moved.folder);
    }
  });

  it('installs a component the move does not continue as a new one, on an empty volume', async function () {
    this.timeout(CONVERGE_MS * 2);
    const res = await moveToV9(control, { carry: false });
    expect(res.componentKeys.get(V9), `${V9} without renamedFrom is a new component`).to.not.equal(LEGACY);
    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      // eslint-disable-next-line no-await-in-loop
      const identifier = await identifierOn(index, control, V9);
      expect(identifier, `node ${index}: not the identifier ${LEGACY} had`).to.not.equal(control.installedAs.get(index));
      // eslint-disable-next-line no-await-in-loop
      expect((await run(index, `test -e /mnt/appdata/flux-apps/${control.installedAs.get(index)}`)).ok, `node ${index}: ${LEGACY}'s data is gone`).to.equal(false);
      // eslint-disable-next-line no-await-in-loop
      const listed = await run(index, `ls ${await dataOf(index, control, V9)}`);
      expect(listed.out, `node ${index}: ${V9} starts empty`).to.not.include('marker-');
    }
  });

  it('installs the moved component on a node that boots afterwards, on the folder the hosts share', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await env.startNode(FRESH);
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await moved.view.installedEverywhere(moved.latest, [FRESH], 'the node installs the app as it stands');
    await waitFor(async () => (await identifierOn(FRESH, moved, V9)) !== null, {
      timeout: CONVERGE_MS, interval: 3000, label: `the late node runs ${V9}`,
    });
    expect(await identifierOn(FRESH, moved, V9), 'the late node names the component as the hosts do').to.equal(moved.installedAs.get(hosts[0]));
    // The folder is configured on the monitor's pass after the install.
    await waitFor(async () => (await foldersOn(FRESH)).includes(moved.folder), {
      timeout: CONVERGE_MS, interval: 3000, label: 'the late node shares its data under the hosts\' folder',
    });
    expect(await appSyncthingFolderId(env.clients[FRESH], moved.name, V9), `the late node's ${V9} is on that folder`).to.equal(moved.folder);
  });
});
