// fleet: 3
/*
 * An expired v9 app: its name held for its last owner, and its renewal with
 * its content, on the harness clock and the real FluxDrive.
 *
 * Three apps are registered, two of them with a content slot, and the clock
 * moves past their terms, so every node removes them. Then:
 *   - within 30 days of the term's end, another owner's registration of a
 *     content app's name is refused on every node, and the last owner's renewal
 *     lists the app again with its identity and its slot filled;
 *   - once 30 days have passed, another owner's registration of the plain app's
 *     name is applied on every node, under another identity;
 *   - FluxDrive no longer holds the other content app's file, and its last
 *     owner's renewal, carrying the file, lists it again with its identity and
 *     its slot filled.
 */
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, manifestStanding, registerEncryptedV9App, requestBlobLocator, updateContentApp, updateEncryptedV9App,
} from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { readFileInContainer } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { advanceHarnessClock, harnessNow } from '../framework/harness-clock.js';
import { fluxDriveHolds, fluxDrivePending, fluxDriveSweep } from '../framework/fluxdrive-real.js';
import { waitFor, waitForInstallSettled } from '../framework/wait.js';

const NODES = 3;
const RUNNING = [0, 1, 2];
const CONVERGE_MS = 300000;
const DAY_S = 24 * 3600;
const TERM_S = 30 * DAY_S;
// After an app's term ends only its last owner may register its name for this long.
const NAME_HOLD_S = 30 * DAY_S;
const SLOT = { name: 'conf', destination: '/etc/app.conf', onUpdate: { action: 'restart' } };

describe('an expired app renewed, and its name held', function () {
  let env;
  let host;
  let registrar;
  let targets;
  let image;
  const owner = appOwnerKey();
  const other = buyerKey();
  const stamp = Date.now();
  // renewed within the hold, with its content
  const kept = { name: `renewkept${stamp}`, bytes: Buffer.from(`conf renewkept${stamp}\n`), port: 31258 };
  // taken by another owner once the hold has passed
  const freed = { name: `renewfreed${stamp}`, port: 31259 };
  // renewed after the hold, carrying its content
  const late = { name: `renewlate${stamp}`, bytes: Buffer.from(`conf renewlate${stamp}\n`), port: 31260 };
  const url = (i) => env.clients[i].url;

  function components(app, withSlot) {
    const mounts = { '/data': { source: 'data', destination: '/data' } };
    if (withSlot) {
      mounts[SLOT.destination] = {
        source: SLOT.name, destination: SLOT.destination, type: 'file', contentSlot: SLOT.name, onUpdate: SLOT.onUpdate,
      };
    }
    return {
      web: {
        name: 'web',
        description: 'an expired app renewed',
        image,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: { sizeGb: 1, mounts },
        ports: { http: { containerPort: 80, hostPort: app.port } },
      },
    };
  }
  const shape = (app, withSlot) => ({
    instances: 1, ttl: TERM_S, placement: { targetIps: targets }, components: components(app, withSlot),
  });

  async function decisionOn(index, hash) {
    const { status, data } = await env.clients[index].request('GET', `/v2/apps/messages/${hash}/decision`);
    return status === 200 ? data.data : null;
  }

  // Every node's decision on a paid message, once none is undecided.
  async function decisionsOf(hash, label) {
    let decisions = [];
    await waitFor(async () => {
      decisions = await Promise.all(RUNNING.map((i) => decisionOn(i, hash)));
      return decisions.every((d) => d && d.decision !== 'undecided');
    }, { timeout: CONVERGE_MS, interval: 3000, label });
    return decisions;
  }

  async function appliedEverywhere(hash, label) {
    const decisions = await decisionsOf(hash, label);
    decisions.forEach((d, k) => expect(d.decision, `node ${k}: ${label}: ${JSON.stringify(d)}`).to.equal('applied'));
  }

  async function slotOn(app) {
    const r = await readFileInContainer(env.clients[host].container, app.name, 'web', SLOT.destination).catch(() => null);
    return r?.exitCode === 0 ? r.content : null;
  }

  async function slotFilled(app, label) {
    await waitFor(async () => (await slotOn(app)) === app.bytes.toString(), { timeout: CONVERGE_MS, interval: 3000, label });
  }

  async function identitiesOf(app) {
    return Promise.all(RUNNING.map(async (i) => (await manifestStanding(url(i), app.name)).identity));
  }

  async function locatorOf(app) {
    const res = await requestBlobLocator(url(registrar), { name: app.name, contentHash: blobHash(app.bytes), ownerKey: owner });
    expect(res.status, `the locator of ${app.name}'s file: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    return res.data.locator;
  }

  async function sweep(now) {
    const pass = await fluxDriveSweep(now);
    expect(pass.skipped, `the pass at ${new Date(now).toISOString()} reads the live set: ${JSON.stringify(pass)}`).to.not.equal(true);
    return pass;
  }

  before(async function () {
    this.timeout(1800000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      tickerAutostart: false,
      arcane: true,
      harnessClock: true,
      fluxDrive: 'real',
      configOverrides: { fluxapps: { nameReservedActivationHeight: 0 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    const ordinary = RUNNING.filter((i) => !env.establishedNodes.includes(i));
    [host] = ordinary;
    registrar = RUNNING.find((i) => i !== host);
    targets = [getSubnetConfig().nodeIp(host + 1)];
    expect(other.zelid, 'the fixture names two owners').to.not.equal(owner.zelid);
    await pushBusybox(kept.name);
    image = `${REGISTRY_REPO_HOST}/${kept.name}:v1`;

    for (const app of [kept, late]) {
      // eslint-disable-next-line no-await-in-loop -- one registration at a time, named in the failure
      const reg = await deployContentApp(url(registrar), {
        name: app.name, ...shape(app, true), ownerKey: owner, contentSlots: [{ ...SLOT, bytes: app.bytes }],
      });
      expect(reg.status, `${app.name} is registered: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
      // eslint-disable-next-line no-await-in-loop
      await confirmOnChain(reg.data, env.clients);
      // eslint-disable-next-line no-await-in-loop
      await appliedEverywhere(reg.data, `every node applies ${app.name}'s registration`);
    }
    const plain = await registerEncryptedV9App(url(registrar), { name: freed.name, ownerKey: owner, ...shape(freed, false) });
    expect(plain.status, `${freed.name} is registered: ${JSON.stringify(plain).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(plain.data, env.clients);
    await appliedEverywhere(plain.data, `every node applies ${freed.name}'s registration`);
    expect(await fluxDrivePending(harnessNow()), 'both content registrations\' manifest puts apply').to.include({ applied: 2 });

    for (const app of [kept, freed, late]) {
      // eslint-disable-next-line no-await-in-loop
      [app.identity] = await identitiesOf(app);
    }
    kept.locator = await locatorOf(kept);
    late.locator = await locatorOf(late);
    await waitForInstallSettled(env.clients[host], kept.name, CONVERGE_MS);
    await slotFilled(kept, `the host fills ${kept.name}'s slot`);

    await advanceHarnessClock(TERM_S + DAY_S);
    await waitFor(async () => {
      const rows = await Promise.all([kept, freed, late].flatMap((app) => RUNNING.map((i) => appView(env, app.name).listedOn(i))));
      return rows.every((row) => row === null);
    }, { timeout: CONVERGE_MS, interval: 5000, label: 'every node removes the three expired apps' });
    await sweep(harnessNow());
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('refuses another owner\'s registration of the name within 30 days of the term\'s end, on every node', async function () {
    this.timeout(CONVERGE_MS * 2);
    const taken = await registerEncryptedV9App(url(registrar), { name: kept.name, ownerKey: other, ...shape(kept, false) });
    expect(taken.status, `the door takes the registration: ${JSON.stringify(taken).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(taken.data, env.clients);
    const decisions = await decisionsOf(taken.data, 'every node decides the other owner\'s registration');
    decisions.forEach((d, k) => expect(d, `node ${k} refuses it for the name hold`).to.include({ decision: 'refused', reason: 'name-reserved' }));
  });

  it('lists the app again with its identity and its content when its last owner renews it within 30 days', async function () {
    this.timeout(CONVERGE_MS * 2);
    const renewal = await updateEncryptedV9App(url(registrar), { name: kept.name, ownerKey: owner, ...shape(kept, true) });
    expect(renewal.status, `the renewal is accepted: ${JSON.stringify(renewal).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(renewal.data, env.clients);
    await appliedEverywhere(renewal.data, 'every node applies the renewal');
    expect(await identitiesOf(kept), 'every node holds the identity the app held').to.deep.equal(RUNNING.map(() => kept.identity));
    await slotFilled(kept, 'the host fills the renewed app\'s slot');
    expect(await fluxDriveHolds(kept.locator), 'FluxDrive holds the renewed app\'s file').to.equal(true);
  });

  it('applies anyone\'s registration of the name once 30 days have passed since the term ended', async function () {
    this.timeout(CONVERGE_MS * 2);
    await advanceHarnessClock(NAME_HOLD_S + DAY_S);
    const taken = await registerEncryptedV9App(url(registrar), { name: freed.name, ownerKey: other, ...shape(freed, false) });
    expect(taken.status, `the door takes the registration: ${JSON.stringify(taken).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(taken.data, env.clients);
    await appliedEverywhere(taken.data, 'every node applies the other owner\'s registration');
    const identities = await identitiesOf(freed);
    identities.forEach((id, k) => expect(id, `node ${k} lists the name under another identity`).to.not.equal(freed.identity));
  });

  it('lists the app again with its identity and its content when its last owner renews it after 30 days, carrying its file', async function () {
    this.timeout(CONVERGE_MS * 2);
    const past = await sweep(harnessNow());
    expect(await fluxDriveHolds(late.locator), `past 30 days FluxDrive no longer holds the expired app's file: ${JSON.stringify(past)}`).to.equal(false);

    const renewal = await updateContentApp(url(registrar), {
      name: late.name, ...shape(late, true), ownerKey: owner, contentSlots: [{ ...SLOT, bytes: late.bytes }],
    });
    expect(renewal.status, `the renewal carrying the file is accepted: ${JSON.stringify(renewal).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(renewal.data, env.clients);
    await appliedEverywhere(renewal.data, 'every node applies the renewal');
    expect(await identitiesOf(late), 'every node holds the identity the app held').to.deep.equal(RUNNING.map(() => late.identity));
    expect(await fluxDrivePending(harnessNow()), 'the renewal\'s manifest put applies').to.include({ applied: 1 });
    expect(await fluxDriveHolds(late.locator), 'FluxDrive holds the file the renewal carried').to.equal(true);
    await slotFilled(late, 'the host fills the renewed app\'s slot');
  });
});
