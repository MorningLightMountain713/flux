// fleet: 3
/*
 * A name registered again is a new app.
 *
 * An owner cancels a v9 app with content slots and backend TLS (an update with
 * ttl 0 ends its term), the app leaves every node, and the owner registers the
 * name again: inside the name's hold only its last owner may. The new
 * registration mints a new identity, and everything keyed by the identity is
 * the new app's alone:
 *   - the locator the new app derives for the earlier app's blob is not the one
 *     FluxDrive holds it under, so the new app cannot address it;
 *   - the new app holds none of the earlier app's manifests;
 *   - its certificates are signed by a CA of its own, which the signer serves
 *     for the new identity and which does not verify the earlier app's.
 */
import crypto from 'node:crypto';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { appOwnerKey } from '../framework/keys.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import {
  deployContentApp, manifestStanding, requestBlobLocator, updateEncryptedV9App,
} from '../framework/content-helper.js';
import { blobHash } from '../framework/content-crypto-v9.js';
import { getFluxDriveState } from '../framework/fluxdrive-control.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { appView } from '../framework/app-view.js';
import { appCaCertificate } from '../framework/daemon-control.js';
import { waitFor, waitForAppRemoved } from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const NODES = 3;
const CONVERGE_MS = 240000;
const SLOT = 'cfg';
const SLOT_PATH = '/io.runonflux/app.conf';

describe('a name registered again is a new app', function () {
  let env;
  let view;
  let node;
  let earlier; // { identity, locator, manifest, ca }
  let later; // { identity }
  const owner = appOwnerKey();
  const name = `again${Date.now()}`;
  const earlierBlob = Buffer.from(`the earlier ${name}\n`);
  const laterBlob = Buffer.from(`the later ${name}\n`);

  function components() {
    return {
      web: {
        name: 'web',
        description: 'a name registered again',
        image: `${REGISTRY_REPO_HOST}/${name}:v1`,
        cpu: 0.5,
        memory: 300,
        rootFsGb: 2,
        persistentStorage: {
          sizeGb: 1,
          mounts: {
            '/data': { source: 'data', destination: '/data' },
            [SLOT_PATH]: {
              source: SLOT, destination: SLOT_PATH, type: 'file', contentSlot: SLOT, onUpdate: null, atomic: true,
            },
          },
        },
        ports: { http: { containerPort: 80, hostPort: 31270 } },
        loadBalancing: { http: { provider: 'haproxy', mode: 'http', backendTls: { verify: 'required' } } },
      },
    };
  }

  async function register(bytes) {
    const reg = await deployContentApp(node.url, {
      name, instances: 1, components: components(), contentSlots: [{ name: SLOT, destination: SLOT_PATH, bytes }],
    });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients);
    await view.listedEverywhere(reg.data, [0, 1, 2], 'every node lists the registration');
    return appIdentityFromUuid(appUuid(name, reg.data));
  }

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this, nodes: NODES, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    node = env.clients[0];
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });
    await pushImage(name, 'v1');

    const identity = await register(earlierBlob);
    let locator = null;
    await waitFor(async () => {
      const state = await getFluxDriveState();
      locator = state.blobs.find((b) => b.identity === identity && !b.tombstoned)?.locator ?? null;
      return locator !== null;
    }, { timeout: 60000, interval: 2000, label: 'FluxDrive holds the earlier app\'s blob' });
    const standing = await manifestStanding(node.url, name);
    earlier = {
      identity, locator, manifest: standing.standing.hash, ca: await appCaCertificate(name, identity),
    };
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('ends the earlier app when its owner cancels it, and takes the name again for the same owner', async function () {
    this.timeout(900000);
    const cancel = await updateEncryptedV9App(node.url, {
      name, instances: 1, components: components(), ttl: 0,
    });
    expect(cancel.status, `the cancellation is accepted: ${JSON.stringify(cancel).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(cancel.data, env.clients);
    await Promise.all(env.clients.map((c) => waitForAppRemoved(c, name, CONVERGE_MS).catch(() => {})));
    await waitFor(async () => (await Promise.all([0, 1, 2].map((i) => view.listedOn(i)))).every((row) => row === null), {
      timeout: CONVERGE_MS, interval: 3000, label: 'no node lists the earlier app',
    });

    later = { identity: await register(laterBlob) };
    expect(later.identity, 'the registration mints a new identity').to.not.equal(earlier.identity);
  });

  it('derives the new app no locator for the earlier app\'s blob that FluxDrive holds it under', async function () {
    this.timeout(60000);
    const res = await requestBlobLocator(node.url, { name, contentHash: blobHash(earlierBlob), ownerKey: owner });
    expect(res.status, `the owner's request: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    expect(res.data.locator, 'the new app\'s locator for the earlier blob').to.not.equal(earlier.locator);
  });

  it('holds none of the earlier app\'s manifests for the new app', async function () {
    this.timeout(60000);
    const standing = await manifestStanding(node.url, name);
    expect(standing.identity, 'the listed app is the new one').to.equal(later.identity);
    const held = standing.manifests.map((m) => m.identity);
    expect(held, 'no manifest of the earlier identity').to.not.include(earlier.identity);
    expect(standing.standing?.hash, 'the new app stands on its own manifest').to.not.equal(earlier.manifest);
  });

  it('signs the new app\'s certificates with a CA of its own', async function () {
    this.timeout(60000);
    const laterCa = await appCaCertificate(name, later.identity);
    const fingerprint = (pem) => new crypto.X509Certificate(pem).fingerprint256;
    expect(fingerprint(laterCa), 'the new identity\'s CA').to.not.equal(fingerprint(earlier.ca));
  });
});
