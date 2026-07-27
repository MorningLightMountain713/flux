import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import crypto from 'node:crypto';
import benchCrypto from '../../daemon-stub/benchCrypto.js';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { deployContentApp } from '../framework/content-helper.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitForAppInstalled, waitForUp } from '../framework/wait.js';
import {
  readFileInContainer, statFileInContainer, execInContainer, getAppContainerStatus,
} from '../framework/container.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';

// Platform-managed backend TLS, delivery half: a component declaring
// backendTls.verify:'required' gets a node-issued certificate written into the
// reserved /io.runonflux/tls/ mount before its container starts, and env vars
// pointing at it.
//
// Every unit test for this feature proves the same easy half — that the node
// writes a file where it said it would. None of them proves the file is a usable
// certificate, because they all stub the signer. Here the certificate comes from
// the daemon stub over the real benchmark-channel call path, so what is asserted
// is the material itself: that the delivered leaf verifies against the app's own
// CA, that a different app's CA rejects it, and that the paths the app is told to
// read are the paths the node actually wrote.
//
// The suite derives the expected CA itself from benchCrypto rather than asking
// the node for it — the node is the thing under test, so trusting its answer
// about its own output would make the assertion circular.
//
// Inspected components run the static-busybox fixture so the host (the DinD node)
// can `docker exec /bin/busybox cat|stat` into them. arcane:true is the default
// and load-bearing here: verify:'required' is an Arcane-requiring feature, so a
// non-Arcane node refuses the spec before any of this is reachable.
describe('backend TLS: managed certificate delivery into the container', function () {
  let env;

  const SUITE = `btls${Date.now()}`;
  const verifiedApp = `${SUITE}verified`;
  const ownCertApp = `${SUITE}owncert`;

  const TLS_DIR = '/io.runonflux/tls';
  const CERT_PATH = `${TLS_DIR}/cert.pem`;
  const KEY_PATH = `${TLS_DIR}/key.pem`;

  let verifiedClient;
  let ownCertClient;

  // A component that asks the platform for a certificate, or brings its own.
  const componentWith = (backendTls) => ({
    web: {
      name: 'web',
      description: 'backend-tls test component',
      image: `${REGISTRY_REPO_HOST}/${backendTls.verify === 'required' ? verifiedApp : ownCertApp}:v1`,
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: { sizeGb: 10, mounts: { '/data': { source: 'data', destination: '/data' } } },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
      loadBalancing: { http: { provider: 'haproxy', mode: 'http', backendTls } },
    },
  });

  // The container's env as a map. The busybox fixture is a bare binary, so env is
  // read from the container config rather than an exec.
  async function containerEnv(client, appName) {
    const cont = await getAppContainerStatus(client.container, appName);
    if (!cont) return null;
    const { stdout } = await execInContainer(
      client.container,
      `docker inspect --format '{{json .Config.Env}}' ${cont.name}`,
    );
    const env2 = {};
    for (const entry of JSON.parse(stdout.trim())) {
      const eq = entry.indexOf('=');
      env2[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env2;
  }

  // The mount as docker resolved it — read-only is a property of the bind, not of
  // the file, so it has to be read off the container config.
  async function tlsMount(client, appName) {
    const cont = await getAppContainerStatus(client.container, appName);
    const { stdout } = await execInContainer(
      client.container,
      `docker inspect --format '{{json .Mounts}}' ${cont.name}`,
    );
    return JSON.parse(stdout.trim()).find((m) => m.Destination === TLS_DIR) || null;
  }

  before(async function () {
    this.timeout(720000);
    env = await createTestEnv({
      hookCtx: this, nodes: 5, tickerAutostart: false, arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 2 } },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 2, pricing: true });
    await Promise.all([
      pushBusybox(verifiedApp, 'v1'),
      pushBusybox(ownCertApp, 'v1'),
    ]);

    const node = env.clients[0];

    const verifiedRes = await deployContentApp(node.url, {
      name: verifiedApp,
      image: `${REGISTRY_REPO_HOST}/${verifiedApp}:v1`,
      instances: 1,
      components: componentWith({ verify: 'required' }),
    });
    expect(verifiedRes.status, 'verify:required register').to.equal('success');

    const ownCertRes = await deployContentApp(node.url, {
      name: ownCertApp,
      image: `${REGISTRY_REPO_HOST}/${ownCertApp}:v1`,
      instances: 1,
      components: componentWith({ verify: 'none' }),
    });
    expect(ownCertRes.status, 'verify:none register').to.equal('success');

    await queueAppTx(verifiedRes.data);
    await queueAppTx(ownCertRes.data);
    await advanceBlocks(3);

    const pick = (name) => Promise.any(env.clients.map(async (c, i) => {
      await waitForAppInstalled(c, name, 240000);
      return i;
    }));
    const [vi, oi] = await Promise.all([pick(verifiedApp), pick(ownCertApp)]);
    verifiedClient = env.clients[vi];
    ownCertClient = env.clients[oi];

    await waitForUp(verifiedClient, verifiedApp, 'verify:required container up');
    await waitForUp(ownCertClient, ownCertApp, 'verify:none container up');
  });

  after(async function () {
    this.timeout(180000);
    if (env) await env.teardown();
  });

  it('delivers cert.pem and key.pem into the reserved mount before the container starts', async function () {
    this.timeout(60000);
    const cert = await readFileInContainer(verifiedClient.container, verifiedApp, 'web', CERT_PATH);
    const key = await readFileInContainer(verifiedClient.container, verifiedApp, 'web', KEY_PATH);

    expect(cert.exitCode, 'cert readable in container').to.equal(0);
    expect(key.exitCode, 'key readable in container').to.equal(0);
    expect(cert.content, 'certificate delivered').to.include('-----BEGIN CERTIFICATE-----');
    expect(key.content, 'private key delivered').to.include('-----BEGIN PRIVATE KEY-----');
  });

  // The assertion the unit tests cannot make: the bytes on disk are a certificate
  // this app's CA actually signed. A file of the right shape in the right place is
  // what a broken signer also produces.
  it('delivers a leaf that verifies against the app CA, and only that app CA', async function () {
    this.timeout(60000);
    const { content: certPem } = await readFileInContainer(verifiedClient.container, verifiedApp, 'web', CERT_PATH);
    const leaf = new crypto.X509Certificate(certPem);

    const { certificate: ownCaPem } = await benchCrypto.caCertificate({ appName: verifiedApp });
    const ownCa = new crypto.X509Certificate(ownCaPem);
    expect(leaf.verify(ownCa.publicKey), 'leaf signed by its own app CA').to.equal(true);

    // Per-app isolation is the entire point of a per-app CA. If another app's CA
    // verified this leaf, one tenant could impersonate another's backend.
    const { certificate: foreignCaPem } = await benchCrypto.caCertificate({ appName: ownCertApp });
    const foreignCa = new crypto.X509Certificate(foreignCaPem);
    expect(leaf.verify(foreignCa.publicKey), 'another app CA must not verify it').to.equal(false);
  });

  it('issues the leaf for this app, with the SAN and server-auth use haproxy needs', async function () {
    this.timeout(60000);
    const { content: certPem } = await readFileInContainer(verifiedClient.container, verifiedApp, 'web', CERT_PATH);
    const leaf = new crypto.X509Certificate(certPem);

    expect(leaf.subject, 'subject names the app').to.include(verifiedApp);
    expect(leaf.subjectAltName, 'SAN carries the app FQDN').to.include(`${verifiedApp}.app.runonflux.io`);
    // Extended key usage is not exposed by X509Certificate, so this looks for the
    // encoded serverAuth OID (1.3.6.1.5.5.7.3.1) in the DER. Without it a TLS
    // client refuses the certificate for server use, and the verified hop fails on
    // a certificate that otherwise inspects as correct.
    expect(leaf.raw.includes(Buffer.from('2b06010505070301', 'hex')), 'serverAuth EKU present').to.equal(true);
    expect(new Date(leaf.validTo).getTime(), 'leaf is still valid').to.be.greaterThan(Date.now());
  });

  it('points the app at the files it actually wrote', async function () {
    this.timeout(60000);
    const appEnv = await containerEnv(verifiedClient, verifiedApp);
    expect(appEnv.FLUX_TLS_CERT_PATH, 'cert path env').to.equal(CERT_PATH);
    expect(appEnv.FLUX_TLS_KEY_PATH, 'key path env').to.equal(KEY_PATH);

    // The env vars are a promise to the app; a path it cannot read is a broken
    // promise that no unit test on either side would catch.
    const atCertPath = await readFileInContainer(
      verifiedClient.container, verifiedApp, 'web', appEnv.FLUX_TLS_CERT_PATH,
    );
    expect(atCertPath.exitCode, 'env cert path is readable').to.equal(0);
    expect(atCertPath.content, 'env cert path holds the certificate').to.include('-----BEGIN CERTIFICATE-----');
  });

  it('mounts the certificate read-only, and leaves the files readable by the app', async function () {
    this.timeout(60000);
    const mount = await tlsMount(verifiedClient, verifiedApp);
    expect(mount, 'reserved TLS mount present').to.not.equal(null);
    expect(mount.RW, 'mount is read-only to the container').to.equal(false);

    // 0644: the app reads the key whatever uid the image runs as. The container is
    // single-tenant, so in-container world-read is the accepted trade.
    const certStat = await statFileInContainer(verifiedClient.container, verifiedApp, 'web', CERT_PATH);
    const keyStat = await statFileInContainer(verifiedClient.container, verifiedApp, 'web', KEY_PATH);
    expect(certStat.mode, 'cert mode').to.equal('644');
    expect(keyStat.mode, 'key mode').to.equal('644');
  });

  // The falsification. verify:'none' means the owner ships their own certificate
  // and the platform issues nothing — if the platform provisioned here anyway it
  // would be writing into a path the owner never reserved.
  it('provisions nothing for verify:none — no mount, no files, no env', async function () {
    this.timeout(60000);
    const mount = await tlsMount(ownCertClient, ownCertApp);
    expect(mount, 'no TLS mount for verify:none').to.equal(null);

    const appEnv = await containerEnv(ownCertClient, ownCertApp);
    expect(appEnv, 'container exists').to.not.equal(null);
    expect(appEnv).to.not.have.property('FLUX_TLS_CERT_PATH');
    expect(appEnv).to.not.have.property('FLUX_TLS_KEY_PATH');

    const cert = await readFileInContainer(ownCertClient.container, ownCertApp, 'web', CERT_PATH);
    expect(cert.exitCode, 'no certificate written').to.not.equal(0);
  });
});
