import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import crypto from 'node:crypto';
import benchCrypto from '../../daemon-stub/benchCrypto.js';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp } from '../framework/content-helper.js';
import { pushTlsEcho } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitForUp, waitFor } from '../framework/wait.js';
import { readFileInContainer, execInContainer, getAppContainerStatus } from '../framework/container.js';
import { startHaproxy } from '../framework/haproxy-control.js';
import { getSubnetConfig, REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// Rotation: the renewal sweep replaces a managed certificate under a RUNNING
// container, and the app picks it up without being recreated.
//
// This is the reason delivery is files rather than env-var contents. A process's
// environment is fixed at exec, so a certificate delivered that way cannot be
// replaced without recreating the container — and the leaf lives 30 days, so an
// app that runs longer than that would simply go down. The claim being tested is
// that the swap happens underneath live traffic and nothing drops.
//
// Both leaves chain to the same permanent per-app CA, so the load balancer's
// trust anchor never changes across the rotation. That is what makes it seamless
// rather than a coordinated restart, and it is asserted here rather than assumed:
// haproxy is driven continuously across the swap and every response is counted.
//
// The sweep is triggered by making the on-disk certificate unreadable. needsRenewal
// treats missing-or-unparseable exactly as expired — the branch that heals a node
// whose install-time provisioning failed — so this is a supported path, not a test
// hook. The expiry-window arithmetic itself is pure date maths and is covered by
// backendTlsService's unit tests, which inject the clock; reproducing it here
// would need a test-only validity knob on the signing path for no extra coverage.
describe('backend TLS: certificate rotation under live traffic', function () {
  let env;
  let haproxy;

  const subnet = getSubnetConfig();
  const SUITE = `rot${Date.now()}`;
  const app = `${SUITE}app`;
  const HOST_PORT = 31000;
  const CERT_PATH = '/io.runonflux/tls/cert.pem';

  let appClient;
  let hostTlsDir;
  let originalFingerprint;

  const fingerprintOf = (pem) => crypto.createHash('sha256')
    .update(new crypto.X509Certificate(pem).raw).digest('hex');

  // The certificate as it currently stands INSIDE the container.
  async function servedCertPem() {
    const { content, exitCode } = await readFileInContainer(appClient.container, app, 'web', CERT_PATH);
    return exitCode === 0 ? content : null;
  }

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
      components: {
        web: {
          name: 'web',
          description: 'tls-echo backend for rotation',
          image: `${REGISTRY_REPO_HOST}/${app}:v1`,
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
          ports: { http: { containerPort: 8443, hostPort: HOST_PORT } },
          environmentParameters: ['PORT=8443'],
          loadBalancing: { http: { provider: 'haproxy', mode: 'http', backendTls: { verify: 'required' } } },
        },
      },
    });
    expect(res.status, 'register').to.equal('success');
    await queueAppTx(res.data);
    await advanceBlocks(3);

    const idx = await Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, app, 240000);
      return i;
    }));
    appClient = env.clients[idx];
    await waitForUp(appClient, app, 'tls-echo backend up');

    originalFingerprint = fingerprintOf(await servedCertPem());

    // The host directory the node writes into, read off the mount rather than
    // rebuilt from a path guess — the same reason backendTlsPaths() exists.
    const cont = await getAppContainerStatus(appClient.container, app);
    const { stdout } = await execInContainer(
      appClient.container,
      `docker inspect --format '{{json .Mounts}}' ${cont.name}`,
    );
    const mount = JSON.parse(stdout.trim()).find((m) => m.Destination === '/io.runonflux/tls');
    expect(mount, 'reserved TLS mount present').to.not.equal(undefined);
    hostTlsDir = mount.Source;

    const { certificate: appCaPem } = await benchCrypto.caCertificate({ appName: app });
    haproxy = await startHaproxy(env.networkName, {
      backends: [{ name: app, host: 'app.test', target: `${subnet.nodeIp(idx + 1)}:${HOST_PORT}` }],
      cas: { [app]: appCaPem },
    });
  });

  after(async function () {
    this.timeout(180000);
    if (haproxy) await haproxy.stop();
    if (env) await env.teardown();
  });

  it('serves the originally issued certificate through the verified hop', async function () {
    this.timeout(120000);
    const res = await haproxy.request('app.test');
    expect(res.status).to.equal(200);
    expect(res.servedCert, 'serving the cert the node delivered').to.equal(originalFingerprint);
  });

  it('re-issues, signals, and serves the new certificate without recreating the container', async function () {
    this.timeout(600000);

    const before = await getAppContainerStatus(appClient.container, app);
    const startedAtBefore = before.status;

    // Drive the hop continuously across the rotation. If the swap is not seamless
    // this is what notices: a window where the backend is unverifiable shows up as
    // a 503, because haproxy marks a server that fails verification DOWN.
    const seen = { ok: 0, bad: 0, certs: new Set() };
    let driving = true;
    const driver = (async () => {
      while (driving) {
        // eslint-disable-next-line no-await-in-loop
        const r = await haproxy.request('app.test').catch(() => ({ status: 0, servedCert: null }));
        if (r.status === 200) { seen.ok += 1; if (r.servedCert) seen.certs.add(r.servedCert); } else seen.bad += 1;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 500); });
      }
    })();

    // Make the delivered certificate unreadable. The sweep treats that exactly as
    // expired, so the next pass re-issues — and because provisionCert writes the
    // replacement BEFORE firing the reload, the running app never reads the
    // damaged file.
    await execInContainer(
      appClient.container,
      `sh -c 'printf "not-a-certificate" > ${hostTlsDir}/cert.pem'`,
    );

    // Harness cadence is 2 minutes (test-infra/config/shared.js), so allow a few.
    await waitFor(async () => {
      const pem = await servedCertPem();
      if (!pem || !pem.includes('BEGIN CERTIFICATE')) return false;
      return fingerprintOf(pem) !== originalFingerprint;
    }, { timeout: 420000, interval: 5000, label: 'renewal sweep re-issues the certificate' });

    const rotatedFingerprint = fingerprintOf(await servedCertPem());
    expect(rotatedFingerprint, 'a genuinely different leaf').to.not.equal(originalFingerprint);

    // The new leaf must still chain to the SAME per-app CA — the CA is permanent
    // and is what the load balancer trusts. A rotation that changed it would
    // invalidate every director's cached copy.
    const { certificate: appCaPem } = await benchCrypto.caCertificate({ appName: app });
    const caKey = new crypto.X509Certificate(appCaPem).publicKey;
    expect(new crypto.X509Certificate(await servedCertPem()).verify(caKey), 'new leaf chains to the same CA').to.equal(true);

    // Give the reload reaction time to reach the app and be observed on the wire.
    await waitFor(async () => {
      const r = await haproxy.request('app.test');
      return r.servedCert === rotatedFingerprint;
    }, { timeout: 120000, interval: 2000, label: 'app serves the rotated certificate' });

    driving = false;
    await driver;

    // The reload reaction actually reached the app: tls-echo logs the signal by
    // name, the same form test-app uses, so this distinguishes a signal from a
    // restart rather than inferring one from the certificate changing.
    const after = await getAppContainerStatus(appClient.container, app);
    const { stdout: appLogs } = await execInContainer(
      appClient.container, `docker logs ${after.name}`,
    );
    expect(appLogs, 'the reload reaction reached the app').to.match(/RELOAD SIGHUP/);

    // Still the same container: rotation happened underneath a running process,
    // which is the entire reason the certificate is delivered as files.
    expect(after.status, 'container was never recreated').to.equal(startedAtBefore);

    expect(seen.certs.has(originalFingerprint), 'old certificate was served before the swap').to.equal(true);
    expect(seen.certs.has(rotatedFingerprint), 'new certificate served after it').to.equal(true);
    expect(seen.bad, 'no request failed across the rotation').to.equal(0);
  });
});
