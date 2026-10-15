// fleet: 6
/*
 * A renamed component keeps what it holds.
 *
 * A v9 encrypted app with two components, `web` (its volume synced, plain sync)
 * and `db`, names three nodes: two hosts and a node that boots after its
 * updates. Every component is keyed (flux-spec componentKeysFor), and its
 * container, data directory, volume image and Syncthing folder are named by its
 * key, never its name. Then:
 *   - an update renaming `web` to `site` recreates the component's container
 *     under the identifier it had, its label and network aliases the new name's,
 *     on the data and the Syncthing folder it had;
 *   - an update dropping `db` removes its container, data and volume image, and
 *     one declaring `db` again installs a new component, on an empty volume;
 *   - the node that boots afterwards names every container as the hosts do: it
 *     works the keys out from the app's applied history, as they did.
 *
 * The app names exactly as many nodes as it has instances, so every named node's
 * spawner places it. The two hosts are chosen outside env.establishedNodes.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import {
  appComponentIdentifier, appDataRoot, componentIdentifier, execInContainer, requireAppContainerName,
} from '../framework/container.js';
import { getSyncthingState } from '../framework/syncthing-control.js';
import { appView } from '../framework/app-view.js';
import { waitForDaemonReady, waitForInstallSettled } from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const NODES = 5;
const FRESH = 4; // boots after the updates
const CONVERGE_MS = 300000;
const COMPONENT_LABEL = 'io.runonflux.component';

describe('a renamed component keeps what it holds', function () {
  let env;
  let view;
  let hosts;
  let registrar;
  let image;
  let app; // the built app: identity and the keys of the version last applied
  let latest; // the hash of the version last applied
  const installedAs = new Map(); // `${index}:${component}` -> identifier at registration
  const name = `rename${Date.now()}`;
  const url = (i) => env.clients[i].url;
  const ip = (i) => getSubnetConfig().nodeIp(i + 1);
  let targets;

  const web = (componentName, extra = {}) => ({
    name: componentName,
    description: 'a component renamed',
    image,
    cpu: 0.5,
    memory: 300,
    rootFsGb: 2,
    persistentStorage: {
      sizeGb: 1,
      mounts: { '/appdata': { source: 'appdata', destination: '/appdata' } },
      sync: { mode: 'sync' },
    },
    ports: { http: { containerPort: 80, hostPort: 31270 } },
    ...extra,
  });
  const db = () => ({
    name: 'db',
    description: 'a component dropped and declared again',
    image,
    cpu: 0.5,
    memory: 300,
    rootFsGb: 2,
    persistentStorage: { sizeGb: 1, mounts: { '/appdata': { source: 'appdata', destination: '/appdata' } } },
  });
  const shape = (components) => ({ instances: 3, placement: { targetIps: targets }, components });

  // An update the door accepts, confirmed and applied on the nodes named.
  async function update(components, indices, label) {
    const res = await updateEncryptedV9App(url(registrar), {
      name, ...shape(components), previousKeys: app.componentKeys, identity: app.identity,
    });
    expect(res.status, `${label}: the update is accepted: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(res.data, env.clients.filter(Boolean));
    await view.installedEverywhere(res.data, indices, `${label}: every host applies it`);
    app = { ...app, componentKeys: res.componentKeys };
    latest = res.data;
    return res;
  }

  const identifierOn = (index, component) => appComponentIdentifier(env.clients[index].container, name, component);

  async function run(index, command) {
    const r = await execInContainer(env.clients[index].container, `sh -c '${command}'`);
    return { ok: r.exitCode === 0, out: (r.stdout ?? '').trim() };
  }

  const markerPath = async (index, component) => `${await appDataRoot(env.clients[index].container, name, component)}/appdata/marker`;

  async function containerOf(index, component) {
    const container = await requireAppContainerName(env.clients[index].container, name, component);
    const { out } = await run(index, `docker inspect --format "{{json .}}" ${container}`);
    const inspected = JSON.parse(out);
    return {
      startedAt: inspected.State.StartedAt,
      label: inspected.Config.Labels[COMPONENT_LABEL],
      aliases: Object.values(inspected.NetworkSettings.Networks).flatMap((n) => n.Aliases ?? []),
    };
  }

  async function foldersOn(index) {
    const state = await getSyncthingState();
    return (state.nodes.find((n) => n.ip === ip(index))?.folders ?? []).map((f) => f.id).sort();
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    const running = [0, 1, 2, 3];
    hosts = running.filter((i) => !env.establishedNodes.includes(i)).slice(0, 2);
    registrar = running.find((i) => !hosts.includes(i));
    targets = [...hosts, FRESH].map(ip);

    await pushImage(name, 'v1');
    image = `${REGISTRY_REPO_HOST}/${name}:v1`;
    const reg = await registerEncryptedV9App(url(registrar), { name, ...shape({ web: web('web'), db: db() }) });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients.filter(Boolean));
    const uuid = appUuid(name, reg.data);
    app = { spec: { name }, identity: appIdentityFromUuid(uuid), componentKeys: reg.componentKeys };
    latest = reg.data;

    await Promise.all(hosts.map((i) => waitForInstallSettled(env.clients[i], name, CONVERGE_MS)));
    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      // eslint-disable-next-line no-restricted-syntax
      for (const component of ['web', 'db']) {
        // eslint-disable-next-line no-await-in-loop
        const identifier = await identifierOn(index, component);
        expect(identifier, `node ${index} names ${component} by its key`).to.equal(componentIdentifier(app, component));
        installedAs.set(`${index}:${component}`, identifier);
        // eslint-disable-next-line no-await-in-loop
        const marker = await markerPath(index, component);
        // eslint-disable-next-line no-await-in-loop
        const written = await run(index, `mkdir -p $(dirname ${marker}) && echo ${component}-${index} > ${marker}`);
        expect(written.ok, `node ${index} holds a marker in ${component}'s data`).to.equal(true);
      }
    }
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('recreates a renamed component under the identifier it had, on the data and the folder it had', async function () {
    this.timeout(CONVERGE_MS * 2);
    const was = new Map();
    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      // eslint-disable-next-line no-await-in-loop
      was.set(index, { container: await containerOf(index, 'web'), folders: await foldersOn(index) });
      expect(was.get(index).folders, `node ${index} shares web's data under its identifier`).to.include(installedAs.get(`${index}:web`));
    }

    const webKey = app.componentKeys.get('web');
    const res = await update({ site: web('site', { renamedFrom: 'web' }), db: db() }, hosts, 'the rename');
    expect(res.componentKeys.get('site'), 'the renamed component keeps its key').to.equal(webKey);

    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      const identifier = installedAs.get(`${index}:web`);
      // eslint-disable-next-line no-await-in-loop
      expect(await identifierOn(index, 'site'), `node ${index}: site is the component web was`).to.equal(identifier);
      // eslint-disable-next-line no-await-in-loop
      expect(await identifierOn(index, 'web'), `node ${index} runs no component named web`).to.equal(null);
      expect(componentIdentifier(app, 'site'), 'the harness keys site as the nodes do').to.equal(identifier);

      // eslint-disable-next-line no-await-in-loop
      const now = await containerOf(index, 'site');
      expect(now.startedAt, `node ${index}: the container is recreated`).to.not.equal(was.get(index).container.startedAt);
      expect(now.label, `node ${index}: labelled with the new name`).to.equal('site');
      expect(now.aliases, `node ${index}: reached by the new name`).to.include('site');
      expect(now.aliases, `node ${index}: no longer by the old`).to.not.include('web');

      // eslint-disable-next-line no-await-in-loop
      const marker = await run(index, `cat ${await markerPath(index, 'site')}`);
      expect(marker.out, `node ${index}: the data is the data web held`).to.equal(`web-${index}`);
      // eslint-disable-next-line no-await-in-loop
      expect(await foldersOn(index), `node ${index}: the same Syncthing folder, and no other`).to.deep.equal(was.get(index).folders);
    }
  });

  it('removes a component dropped, and installs one declared again under its name on an empty volume', async function () {
    this.timeout(CONVERGE_MS * 3);
    await update({ site: web('site') }, hosts, 'the drop');
    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      const dropped = installedAs.get(`${index}:db`);
      // eslint-disable-next-line no-await-in-loop
      expect(await identifierOn(index, 'db'), `node ${index} runs no db`).to.equal(null);
      // eslint-disable-next-line no-await-in-loop
      expect((await run(index, `test -e /mnt/appdata/flux-apps/${dropped}`)).ok, `node ${index}: db's data is gone`).to.equal(false);
      // eslint-disable-next-line no-await-in-loop
      expect((await run(index, `test -e /mnt/appdata/${dropped}FLUXFSVOL`)).ok, `node ${index}: db's volume image is gone`).to.equal(false);
    }

    const droppedKey = installedAs.get(`${hosts[0]}:db`).split('_')[0];
    const res = await update({ site: web('site'), db: db() }, hosts, 'the return of db');
    expect(res.componentKeys.get('db'), 'db declared again is a new component').to.not.equal(droppedKey);
    // eslint-disable-next-line no-restricted-syntax
    for (const index of hosts) {
      // eslint-disable-next-line no-await-in-loop
      const identifier = await identifierOn(index, 'db');
      expect(identifier, `node ${index}: db is named by its new key`).to.equal(componentIdentifier(app, 'db'));
      expect(identifier, `node ${index}: not the identifier of the db dropped`).to.not.equal(installedAs.get(`${index}:db`));
      // eslint-disable-next-line no-await-in-loop
      expect((await run(index, `test -e ${await markerPath(index, 'db')}`)).ok, `node ${index}: the new db starts empty`).to.equal(false);
    }
  });

  it('names every container on a node that boots afterwards as the hosts do', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await env.startNode(FRESH);
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await view.installedEverywhere(latest, [FRESH], 'the node installs the app as it stands');
    // eslint-disable-next-line no-restricted-syntax
    for (const component of ['site', 'db']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await identifierOn(FRESH, component), `the late node names ${component} as the hosts do`)
        .to.equal(await identifierOn(hosts[0], component));
    }
  });
});
