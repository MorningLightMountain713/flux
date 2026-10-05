// fleet: 3
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { buildAppSpec, registerAndConfirm } from '../framework/app-helper.js';
import { nodeKey } from '../framework/keys.js';
import {
  waitFor, waitForBootSettled, waitForInstallSettled,
} from '../framework/wait.js';
import {
  execInContainer, listAppContainers, getAppContainerStatus, componentIdentifier, legacyFolderId,
  appDataRoot, appVolumeFile, getAppNetwork, networkExists,
} from '../framework/container.js';
import { dbClient, closeDb } from '../framework/db-client.js';
import { IMAGE_TAG } from '../framework/flux-spec-vendor.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// The move onto the identity, on the upgrade a node takes: from released FluxOS to
// this tree. Node 0 boots a released FluxOS (FLUX_E2E_BASE_TAG, an image built by
// test-infra/build-release-image.sh from the release's ref), where a v8 app is
// installed under its name: the container flux<component>_<name>, the directory and
// backing image named from it, the network fluxDockerNetwork_<name>, a row with no
// identity. The suite writes a marker into the app's data, upgrades node 0 in place to
// the run's image (env.upgradeNode), and asserts what the first start of the new code
// leaves once every migration has run: every artifact named by the identity the
// registration minted, the data intact, the former name still answering on the app's
// network, the row naming the registration it came from, and the component running.
// Nodes 1 and 2 run the run's image throughout: a three-node ring is the smallest
// whose registration door opens, the registration is submitted from the middle of the
// ring, and the released node's spawner installs the app from the registration it
// holds, without the harness seeding a row, so the layout under the name is its own.
//
// Control: run with FLUX_E2E_TAG naming images built from this tree with the
// app-identity migration removed (E2E_IMAGES_VERIFIED=1, since they are not this
// tree's); the upgrade then changes nothing under the name and the first assertion
// fails. Without FLUX_E2E_BASE_TAG the suite fails before booting, naming the build
// it needs.
//
// The released node talks to the run's stubs, which moved since the release in the
// daemon stub's content crypto and the FluxDrive stub's manifest rows; a cleartext
// v8 install touches neither.

const BASE_TAG = process.env.FLUX_E2E_BASE_TAG;
const COMPONENT = 'web';
const MARKER = 'moved-with-me';

describe('the move onto the identity at the first start of the new code', function () {
  let env;
  let app;
  let node;
  let db;
  const appName = `move${Date.now()}`;
  let formerName;
  let formerDataDir;
  let formerRoot; // the component's directory under the apps folder, under the name
  let dataSubdir; // where the bound data directory sits within it
  let formerVolumeFiles;
  let formerNetwork;

  // The directories and backing images under the apps folder, as the node has them.
  async function appdataListing() {
    const r = await execInContainer(node.container, 'ls -1 /mnt/appdata 2>/dev/null; echo --; ls -1 /mnt/appdata/flux-apps 2>/dev/null');
    return r.stdout;
  }

  before(async function () {
    this.timeout(900000);
    if (!BASE_TAG) {
      throw new Error('FLUX_E2E_BASE_TAG names the node image of the released FluxOS the node upgrades from: build it with FLUX_E2E_TAG=<base-tag> ./test-infra/build-release-image.sh <release ref>');
    }
    if (BASE_TAG === IMAGE_TAG) throw new Error('FLUX_E2E_BASE_TAG must name another build than FLUX_E2E_TAG: the suite upgrades from the one to the other');
    env = await createTestEnv({
      hookCtx: this, nodes: 3, nodeImageTags: { 0: BASE_TAG }, tickerAutostart: false,
    });
    await bootAndPeer(env);
    node = env.clients[0];
    const registrar = env.clients[1];
    db = dbClient(node.num);
    // A submission is broadcast only once the node can sign as itself, which its
    // orchestrator's READY requires; one sent before that is signed by nobody and
    // sent nowhere, and the door answers that the network could not be reached.
    await registrar.waitForEvent('orchestrator:stateChanged', (d) => d.to === 'READY', 300000);

    const spec = buildAppSpec({
      name: appName,
      compose: [{
        name: COMPONENT,
        description: 'the component the move carries',
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
    const registered = await registerAndConfirm(registrar.url, nodeKey(2), spec, env.clients);
    expect(registered.status, JSON.stringify(registered)).to.equal('success');
    app = registered.app;

    // The released node installs the app the way a node takes one from the network: its
    // own spawner places it from the registration it holds. An install asked for over the
    // route as well would race that spawner, whose pre-install port check holds the app's
    // port while it runs.
    try {
      await waitForInstallSettled(node, appName, 300000, { afterId: installMark });
    } catch (error) {
      throw new Error(`node 0 does not hold ${appName}: ${error.message}`);
    }

    // The old layout, read off the node rather than spelled: the fixture is what the
    // released code made, and the suite is wrong if it is not the layout under the name.
    formerName = legacyFolderId(appName, COMPONENT);
    const mounts = await execInContainer(node.container, `docker inspect ${formerName} --format '{{range .Mounts}}{{.Source}}\n{{end}}'`);
    expect(mounts.exitCode, `the released node installs the app under its name, as container ${formerName}: ${mounts.output}`).to.equal(0);
    formerDataDir = mounts.stdout.split('\n').map((s) => s.trim()).find((p) => p.includes('/flux-apps/'));
    expect(formerDataDir, `a data directory under the apps folder bound into ${formerName}: ${mounts.stdout}`).to.be.a('string');
    [, formerRoot, dataSubdir = ''] = formerDataDir.match(/^(.*\/flux-apps\/[^/]+)\/?(.*)$/);
    const row = await db.getLocalApp(appName);
    expect(row, 'the released node holds a row for the app').to.include({ name: appName });
    expect(row, 'a released row carries no identity').to.not.have.property('identity');
    const networks = await execInContainer(node.container, `docker inspect ${formerName} --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}'`);
    [formerNetwork] = networks.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(formerNetwork, 'the app network under the name').to.be.a('string');
    const listing = await appdataListing();
    formerVolumeFiles = listing.split('\n').filter((l) => l.endsWith('FLUXFSVOL'));
    expect(formerVolumeFiles, `a backing image under the apps folder: ${listing}`).to.have.lengthOf.at.least(1);

    // Data the move must carry: written on the node into the component's bound directory.
    const wrote = await execInContainer(node.container, `sh -c 'echo ${MARKER} > ${formerDataDir}/marker && cat ${formerDataDir}/marker'`);
    expect(wrote.stdout.trim(), wrote.output).to.equal(MARKER);

    const afterId = node.getLastEventId();
    await env.upgradeNode(0, { tag: IMAGE_TAG });
    await waitForBootSettled(node, 420000, { afterId });
  });

  after(async function () {
    this.timeout(60000);
    await closeDb();
    await env?.teardown();
  });

  it('names the container by the identity and leaves none under the name', async function () {
    this.timeout(180000);
    const expected = componentIdentifier(app, COMPONENT);
    await waitFor(async () => {
      const names = (await listAppContainers(node.container, { all: true })).map((c) => c.name);
      return names.includes(expected) && !names.includes(formerName);
    }, { timeout: 120000, interval: 2000, label: `container ${expected}, none named ${formerName}` });
    expect(env.nodeImageTag(0)).to.equal(IMAGE_TAG);
  });

  it('runs the component once the boot reconcile has started it', async function () {
    this.timeout(180000);
    await waitFor(async () => {
      const status = await getAppContainerStatus(node.container, appName, { component: COMPONENT });
      return Boolean(status && status.status.startsWith('Up'));
    }, { timeout: 120000, interval: 2000, label: 'component running under the identity' });
  });

  it('carries the data: the marker is in the volume under the identity, and the directory and image under the name are gone', async function () {
    this.timeout(60000);
    const dir = await appDataRoot(node.container, appName, COMPONENT);
    expect(dir).to.not.equal(formerRoot);
    // the same place within the volume the released node bound and the marker was written to
    const marker = await execInContainer(node.container, `cat ${dir}${dataSubdir ? `/${dataSubdir}` : ''}/marker`);
    expect(marker.stdout.trim(), marker.output).to.equal(MARKER);
    const volume = await appVolumeFile(node.container, appName, COMPONENT);
    expect((await execInContainer(node.container, `test -f ${volume}`)).exitCode, `backing image ${volume}`).to.equal(0);
    expect((await execInContainer(node.container, `test -e ${formerRoot}`)).exitCode, `${formerRoot} still there`).to.not.equal(0);
    const listing = await appdataListing();
    const remaining = listing.split('\n').filter((l) => l.endsWith('FLUXFSVOL'));
    formerVolumeFiles.forEach((f) => expect(remaining, `${f} still there`).to.not.include(f));
  });

  it('the row names the identity and the registration it came from, and no version', async function () {
    const row = await db.getLocalApp(appName);
    expect(row.identity).to.equal(app.identity);
    expect(row.uuid).to.equal(app.uuid);
    expect(row).to.not.have.property('registrationVersion');
    expect(await db.registrationVersion(appName), 'the registration message states it').to.equal(8);
  });

  it('the former name still answers on the app network, as an alias of the moved container', async function () {
    const name = componentIdentifier(app, COMPONENT);
    const aliases = await execInContainer(node.container, `docker inspect ${name} --format '{{range .NetworkSettings.Networks}}{{join .Aliases ","}}\n{{end}}'`);
    expect(aliases.stdout, aliases.output).to.include(formerName);
  });

  it('the network exists under the identity and the one under the name is gone', async function () {
    const network = await getAppNetwork(node.container, appName);
    expect(network, 'the app network').to.be.a('string');
    expect(network).to.not.equal(formerNetwork);
    expect(await networkExists(node.container, formerNetwork), `${formerNetwork} still there`).to.equal(false);
  });
});
