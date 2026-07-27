import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import crypto from 'node:crypto';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp } from '../framework/content-helper.js';
import { pushTlsEcho } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks, appCaCertificate } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitForUp } from '../framework/wait.js';
import { readFileInContainer } from '../framework/container.js';
import { startHaproxy } from '../framework/haproxy-control.js';
import { getSubnetConfig, REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// The verified hop: a real HAProxy, configured the way FDM configures it,
// completing a TLS handshake with an app backend serving the certificate this
// platform issued it.
//
// This is the assertion the whole feature rested on and nothing made. Suite 83
// proves the certificate reaches the container; FDM's unit tests prove the
// renderer emits the right directive. Neither says the two halves meet — and the
// failure modes that matter (wrong EKU, missing SAN, key/cert mismatch, an
// unusable chain) pass both and fail only here, on a hop carrying customer
// traffic.
//
// The app runs the tls-echo fixture, which serves the delivered certificate and
// answers with its SHA-256 fingerprint, so a response identifies WHICH
// certificate terminated the connection rather than merely that something did.
//
// HAProxy dials the node's IP at the app's hostPort. Nodes are docker-in-docker,
// so a published hostPort lands on the node container's IP — the same topology
// production uses, not an approximation of it.
describe('backend TLS: the verified hop through a real HAProxy', function () {
  let env;
  let haproxy;

  const subnet = getSubnetConfig();
  const SUITE = `hop${Date.now()}`;
  const app = `${SUITE}app`;
  const HOST_PORT = 31000;

  let appClient;
  let appNodeIp;
  let deliveredFingerprint;

  const tlsEchoComponent = () => ({
    web: {
      name: 'web',
      description: 'tls-echo backend behind the verified hop',
      image: `${REGISTRY_REPO_HOST}/${app}:v1`,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 8443, hostPort: HOST_PORT } },
      environmentParameters: [`PORT=8443`],
      loadBalancing: { http: { provider: 'haproxy', mode: 'http', backendTls: { verify: 'required' } } },
    },
  });

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    await pushTlsEcho(app, 'v1');

    const res = await deployContentApp(env.clients[0].url, {
      name: app,
      image: `${REGISTRY_REPO_HOST}/${app}:v1`,
      instances: 1,
      components: tlsEchoComponent(),
    });
    expect(res.status, 'register').to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);

    const idx = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, app, 240000);
      return i;
    }));
    appClient = env.clients[idx];
    appNodeIp = subnet.nodeIp(idx + 1);
    await waitForUp(appClient, app, 'tls-echo backend up');

    // The fingerprint of what the node actually delivered — the yardstick for
    // "the certificate that answered is the certificate we issued".
    const { content: certPem } = await readFileInContainer(appClient.container, app, 'web', '/io.runonflux/tls/cert.pem');
    deliveredFingerprint = crypto.createHash('sha256')
      .update(new crypto.X509Certificate(certPem).raw).digest('hex');

    // FDM fetches the app's CA and writes it where the config names it; the
    // suite does the same thing by the same route.
    const appCaPem = await appCaCertificate(app);
    const foreignCaPem = await appCaCertificate(`${app}other`);

    haproxy = await startHaproxy(env.networkName, {
      backends: [
        { name: app, host: 'right.test', target: `${appNodeIp}:${HOST_PORT}` },
        // Same backend, trusted against a DIFFERENT app's CA. The falsification:
        // if this one also answers, verification is not being enforced and the
        // "verified" hop is decorative.
        { name: `${app}other`, host: 'wrong.test', target: `${appNodeIp}:${HOST_PORT}` },
      ],
      cas: { [app]: appCaPem, [`${app}other`]: foreignCaPem },
    });
  });

  after(async function () {
    this.timeout(180000);
    if (haproxy) await haproxy.stop();
    if (env) await env.teardown();
  });

  it('carries traffic through the verified hop to the app backend', async function () {
    this.timeout(120000);
    const res = await haproxy.request('right.test');
    expect(res.status, 'request through haproxy').to.equal(200);
    expect(res.servedCert, 'backend identified its serving certificate').to.be.a('string');
  });

  // Not just "a certificate": the one this platform issued for this app, and
  // wrote into this container.
  it('terminates against the exact certificate the node delivered', async function () {
    this.timeout(120000);
    const res = await haproxy.request('right.test');
    expect(res.servedCert, 'served cert is the delivered cert').to.equal(deliveredFingerprint);
  });

  // The falsification. Without it a green suite would prove only that TLS
  // happened, not that the app's identity was checked.
  it('refuses the backend when trusted against another app CA', async function () {
    this.timeout(120000);
    const res = await haproxy.request('wrong.test');
    expect(res.status, 'wrong-CA backend must not serve').to.equal(503);
    expect(res.servedCert, 'nothing answered').to.equal(null);

    const logs = await haproxy.logs();
    expect(logs, 'haproxy reports the handshake failing').to.match(/SSL handshake failure|is DOWN/);
  });
});
