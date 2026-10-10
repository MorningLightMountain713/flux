// fleet: 6
/*
 * A v9 app with platform-managed backend TLS, sold while it runs.
 *
 * The app's certificates are issued by a CA of its own, which the signer keys by
 * the app's identity, and a sale keeps the identity. The app names three nodes: two
 * that run it before the sale, one of which is off the network through the sale,
 * and one that boots afterwards. Then:
 *   - the certificate on the node that ran through the sale is the same file, and
 *     still verifies under the CA the signer serves for the identity, which is the
 *     CA FDM fetches;
 *   - the returning node's and the fresh node's certificates verify under it;
 *   - a renewal after the sale is signed by the same CA;
 *   - the buyer's update applies, the seller's is refused.
 *
 * The CA is fetched from the signer, never from a node, as FDM does. A renewal is
 * forced by making the certificate on disk unreadable, which the renewal sweep
 * treats as expired.
 */
import crypto from 'node:crypto';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { appOwnerKey } from '../framework/keys.js';
import { buyerKey, transferApp } from '../framework/transfer-helper.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { confirmOnChain } from '../framework/app-helper.js';
import { registerEncryptedV9App, updateEncryptedV9App } from '../framework/content-helper.js';
import { pushImage } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';
import { execInContainer, getAppContainerStatus } from '../framework/container.js';
import { appView } from '../framework/app-view.js';
import { appCaCertificate } from '../framework/daemon-control.js';
import { waitFor, waitForDaemonReady, waitForInstallSettled } from '../framework/wait.js';
import { appIdentityFromUuid, appUuid } from '@runonflux/flux-spec';

const NODES = 5;
const FRESH = 4; // boots after the sale
const CONVERGE_MS = 300000;
const RENEWAL_MS = 420000; // a few of the harness's two-minute renewal passes
const DOOR_REFUSAL = /does not correspond with Flux App owner/;
const OUTAGE_LIMIT_MS = (loadSharedConfig().fluxapps.nodeDownGraceS - 20) * 1000;
const TLS_DIR = '/io.runonflux/tls';

const fingerprintOf = (pem) => crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');

describe('an app with backend TLS sold while it runs', function () {
  let env;
  let view;
  let host;
  let away;
  let registrar;
  let registered;
  let sold;
  let shape;
  let caPem;
  const certBefore = new Map(); // node index -> fingerprint before the sale
  const seller = appOwnerKey();
  const buyer = buyerKey();
  const name = `tlssale${Date.now()}`;
  const url = (i) => env.clients[i].url;

  // The certificate the node delivered, read from the node's side of the
  // reserved mount.
  async function hostTlsDir(index) {
    const { container } = env.clients[index];
    const cont = await getAppContainerStatus(container, name);
    const { stdout } = await execInContainer(container, `docker inspect --format '{{json .Mounts}}' ${cont.name}`);
    return JSON.parse(stdout.trim()).find((m) => m.Destination === TLS_DIR)?.Source ?? null;
  }

  async function certOn(index) {
    const dir = await hostTlsDir(index).catch(() => null);
    if (!dir) return null;
    const { stdout, exitCode } = await execInContainer(env.clients[index].container, `cat ${dir}/cert.pem`);
    return exitCode === 0 && stdout.includes('BEGIN CERTIFICATE') ? stdout : null;
  }

  function verifiesUnderTheCa(pem) {
    return new crypto.X509Certificate(pem).verify(new crypto.X509Certificate(caPem).publicKey);
  }

  before(async function () {
    this.timeout(1200000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: NODES,
      deferredNodes: 1,
      tickerAutostart: false,
      arcane: true,
      configOverrides: { fluxapps: { adoptionStaggerStepMs: 5000, adoptionStaggerWindowMs: 10000 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });
    view = appView(env, name, { component: 'web', timeout: CONVERGE_MS });

    const running = Array.from({ length: FRESH }, (_, i) => i);
    const ordinary = running.filter((i) => !env.establishedNodes.includes(i));
    [host, away] = ordinary;
    registrar = running.find((i) => i !== host && i !== away);
    expect(buyer.zelid, 'the fixture names two owners').to.not.equal(seller.zelid);

    await pushImage(name, 'v1');
    const ip = (i) => getSubnetConfig().nodeIp(i + 1);
    shape = {
      instances: 3,
      placement: { targetIps: [ip(host), ip(away), ip(FRESH)] },
      components: {
        web: {
          name: 'web',
          description: 'backend TLS sold',
          image: `${REGISTRY_REPO_HOST}/${name}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 1, mounts: { '/data': { source: 'data', destination: '/data' } } },
          ports: { http: { containerPort: 80, hostPort: 31230 } },
          loadBalancing: { http: { provider: 'haproxy', mode: 'http', backendTls: { verify: 'required' } } },
        },
      },
    };
    const reg = await registerEncryptedV9App(url(registrar), { name, ...shape });
    expect(reg.status, `the registration is accepted: ${JSON.stringify(reg).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(reg.data, env.clients.filter(Boolean));
    const uuid = appUuid(name, reg.data);
    registered = {
      spec: { name, owner: seller.zelid, hash: reg.data }, hash: reg.data, uuid, identity: appIdentityFromUuid(uuid),
    };
    await Promise.all([host, away].map((i) => waitForInstallSettled(env.clients[i], name, CONVERGE_MS)));
    caPem = await appCaCertificate(name, registered.identity);
  });

  after(async function () {
    this.timeout(120000);
    await env?.teardown();
  });

  it('delivers each host a certificate that verifies under the app\'s CA', async function () {
    this.timeout(CONVERGE_MS);
    for (const i of [host, away]) {
      let pem = null;
      // eslint-disable-next-line no-await-in-loop
      await waitFor(async () => { pem = await certOn(i); return pem !== null; }, {
        timeout: CONVERGE_MS, interval: 3000, label: `node ${i} holds a certificate`,
      });
      expect(verifiesUnderTheCa(pem), `node ${i}'s certificate verifies under the CA`).to.equal(true);
      certBefore.set(i, fingerprintOf(pem));
    }
  });

  it('keeps the host\'s certificate, under the same CA, through a sale made while the other host is away', async function () {
    this.timeout(1200000);
    await env.disconnectNode(away);
    const wentAway = Date.now();
    const stayers = env.clients.map((c, i) => (c && i !== away ? i : -1)).filter((i) => i >= 0);
    const result = await transferApp(url(registrar), seller, registered, stayers.map((i) => env.clients[i]), { v9: shape });
    await env.reconnectNode(away);
    expect(Date.now() - wentAway, 'the node was away for less than the node-down grace').to.be.below(OUTAGE_LIMIT_MS);
    expect(result.status, `the sale is accepted: ${JSON.stringify(result).slice(0, 300)}`).to.equal('success');
    sold = result.app;
    await view.installedEverywhere(sold.spec.hash, [host], 'the host adopts the sale');

    const caAfter = await appCaCertificate(name, registered.identity);
    expect(fingerprintOf(caAfter), 'the signer serves the same CA for the identity').to.equal(fingerprintOf(caPem));
    const pem = await certOn(host);
    expect(fingerprintOf(pem), 'the host\'s certificate is the one it held before the sale').to.equal(certBefore.get(host));
    expect(verifiesUnderTheCa(pem), 'and it verifies under the CA').to.equal(true);
  });

  it('brings the returning host to the sale with a certificate under the same CA', async function () {
    this.timeout(CONVERGE_MS * 2);
    await waitForDaemonReady(env.clients[away]);
    await view.installedEverywhere(sold.spec.hash, [away], 'the returning node adopts the sale');
    const pem = await certOn(away);
    expect(verifiesUnderTheCa(pem), 'its certificate verifies under the CA').to.equal(true);
  });

  it('issues the node that boots afterwards a certificate under the same CA', async function () {
    this.timeout(CONVERGE_MS * 2);
    const fresh = await env.startNode(FRESH);
    await waitForDaemonReady(fresh);
    await env.startDiscovery([FRESH]);
    await view.installedEverywhere(sold.spec.hash, [FRESH], 'the fresh node installs the app as sold');
    let pem = null;
    await waitFor(async () => { pem = await certOn(FRESH); return pem !== null; }, {
      timeout: CONVERGE_MS, interval: 3000, label: 'the fresh node holds a certificate',
    });
    expect(verifiesUnderTheCa(pem), 'its certificate verifies under the CA').to.equal(true);
  });

  it('renews the host\'s certificate under the same CA after the sale', async function () {
    this.timeout(RENEWAL_MS + 60000);
    const before = fingerprintOf(await certOn(host));
    const dir = await hostTlsDir(host);
    await execInContainer(env.clients[host].container, `sh -c 'printf "not-a-certificate" > ${dir}/cert.pem'`);
    let pem = null;
    await waitFor(async () => {
      pem = await certOn(host);
      return pem !== null && fingerprintOf(pem) !== before;
    }, { timeout: RENEWAL_MS, interval: 5000, label: 'the renewal sweep re-issues the certificate' });
    expect(verifiesUnderTheCa(pem), 'the renewed certificate verifies under the CA').to.equal(true);
  });

  it('applies the buyer\'s update and refuses the seller\'s', async function () {
    this.timeout(1200000);
    const refused = await updateEncryptedV9App(url(registrar), {
      name, ...shape, owner: buyer.zelid, ownerKey: seller, specOverrides: { description: 'updated by the seller' },
    });
    expect(refused.status, 'the seller\'s update at the door').to.equal('error');
    expect(refused.data?.message ?? refused.data, 'the door names the owner check').to.match(DOOR_REFUSAL);

    const res = await updateEncryptedV9App(url(registrar), {
      name, ...shape, owner: buyer.zelid, ownerKey: buyer, specOverrides: { description: 'updated by the buyer' },
    });
    expect(res.status, `the buyer's update is accepted: ${JSON.stringify(res).slice(0, 300)}`).to.equal('success');
    await confirmOnChain(res.data, env.clients.filter(Boolean));
    await view.installedEverywhere(res.data, [host, away, FRESH], 'every node runs the buyer\'s update');
  });
});
