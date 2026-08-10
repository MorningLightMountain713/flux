'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const backendTlsService = require('../../ZelBack/src/services/appLifecycle/backendTlsService');

// What DeploymentComponent.backendTlsPaths() hands the service. The service never
// builds these itself - flux-spec derives them from the reserved prefix that its
// validator protects, so there is only ever one copy of the layout.
const tlsPathsFor = (dir) => ({
  dir,
  certPath: path.join(dir, 'cert.pem'),
  keyPath: path.join(dir, 'key.pem'),
});

// What benchmarkService.signCertificate REALLY returns. executeCall wraps every
// result as { status: 'success' | 'error', data }, and `data` is the signer's own
// JSON string carrying { status: 'ok', certificate } — the same double envelope
// enterpriseHelper unwraps for decryptRSAMessage. Stubbing the inner shape
// directly is how a condition that can never be satisfied — reading the signer's
// status off the OUTER envelope — passed every test in this file and then failed
// on every node the moment it met a real benchmark channel.
const signerReturns = (certificate) => ({
  status: 'success',
  data: JSON.stringify({ status: 'ok', certificate }),
});

describe('backendTlsService.provisionCert', () => {
  let dir;
  let tlsPaths;
  let signStub;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-tls-test-'));
    tlsPaths = tlsPathsFor(path.join(dir, 'io.runonflux', 'tls'));
    signStub = sinon.stub(benchmarkService, 'signCertificate');
  });

  afterEach(async () => {
    sinon.restore();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('generates an Ed25519 CSR (CN=appName), signs it, and writes cert+key atomically', async () => {
    const LEAF = '-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n';
    signStub.callsFake(async ({ csr, appName }) => {
      expect(appName).to.equal('myapp');
      expect(csr).to.include('BEGIN CERTIFICATE REQUEST');
      return signerReturns(LEAF);
    });

    await backendTlsService.provisionCert('myapp', tlsPaths);

    expect(fs.readFileSync(tlsPaths.certPath, 'utf8')).to.equal(LEAF);
    const keyPem = fs.readFileSync(tlsPaths.keyPath, 'utf8');
    expect(keyPem).to.include('PRIVATE KEY');
    // world-readable so the app can read it whatever uid the image runs as
    expect(fs.statSync(tlsPaths.keyPath).mode & 0o004).to.not.equal(0);
    // atomic write leaves no temp files behind
    expect(fs.readdirSync(tlsPaths.dir).some((f) => f.endsWith('.tmp'))).to.equal(false);
    expect(signStub.calledOnce).to.equal(true);
  });

  it('writes exactly where it was told, never a path of its own making', async () => {
    // The app reads the cert through FLUX_TLS_*_PATH, which flux-spec derives from
    // the same constants as these paths. A service that rebuilt the layout could
    // write somewhere the mount does not reach.
    signStub.resolves(signerReturns('LEAF\n'));
    const odd = tlsPathsFor(path.join(dir, 'somewhere', 'else'));

    await backendTlsService.provisionCert('myapp', odd);

    expect(fs.readFileSync(odd.certPath, 'utf8')).to.equal('LEAF\n');
    expect(fs.existsSync(tlsPaths.dir), 'nothing written to a self-derived path').to.equal(false);
  });

  it('throws and writes nothing when the signer refuses to sign', async () => {
    // Inner refusal: the call reached the signer, which declined.
    signStub.resolves({ status: 'success', data: JSON.stringify({ status: 'error' }) });

    let threw = false;
    try {
      await backendTlsService.provisionCert('myapp', tlsPaths);
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
    expect(fs.existsSync(tlsPaths.certPath)).to.equal(false);
  });

  it('throws and writes nothing when the signer cannot be reached at all', async () => {
    // Outer envelope failure: executeCall caught the transport error. Distinct
    // from a refusal to sign, and the case whose absence let the two envelopes be
    // conflated — with only the happy path stubbed at the inner shape, nothing
    // here ever exercised the outer one.
    signStub.resolves({ status: 'error', data: { message: 'benchd unreachable' } });

    let threw = false;
    try {
      await backendTlsService.provisionCert('myapp', tlsPaths);
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
    expect(fs.existsSync(tlsPaths.certPath)).to.equal(false);
  });

  it('replaces an existing cert in place, so a renewal is a plain overwrite', async () => {
    signStub.resolves(signerReturns('OLD\n'));
    await backendTlsService.provisionCert('myapp', tlsPaths);
    const oldKey = fs.readFileSync(tlsPaths.keyPath, 'utf8');

    signStub.resolves(signerReturns('NEW\n'));
    await backendTlsService.provisionCert('myapp', tlsPaths);

    expect(fs.readFileSync(tlsPaths.certPath, 'utf8')).to.equal('NEW\n');
    // a renewal is a fresh keypair, never a re-signing of the old one
    expect(fs.readFileSync(tlsPaths.keyPath, 'utf8')).to.not.equal(oldKey);
  });
});

describe('backendTlsService.needsRenewal', () => {
  let dir;
  let tlsPaths;

  const DAY_MS = 24 * 60 * 60 * 1000;

  // A real self-signed Ed25519 cert, so the expiry really is parsed out of DER
  // rather than out of a hand-written stub.
  async function writeCertValidForDays(days) {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-tls-gen-'));
    const keyPath = path.join(tmp, 'k.pem');
    const certPath = path.join(tmp, 'c.pem');
    execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', keyPath]);
    execFileSync('openssl', ['req', '-new', '-x509', '-key', keyPath, '-subj', '/CN=myapp', '-days', String(days), '-out', certPath]);
    await fsp.copyFile(certPath, tlsPaths.certPath);
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-tls-renew-'));
    tlsPaths = tlsPathsFor(dir);
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('is true when there is no cert at all - an unprovisioned component heals here', async () => {
    expect(await backendTlsService.needsRenewal(tlsPaths)).to.equal(true);
    expect(await backendTlsService.certExpiry(tlsPaths)).to.equal(null);
  });

  it('is true when the cert file is unreadable garbage', async () => {
    await fsp.writeFile(tlsPaths.certPath, 'not a certificate');
    expect(await backendTlsService.needsRenewal(tlsPaths)).to.equal(true);
  });

  it('is false for a freshly issued 30-day cert', async () => {
    await writeCertValidForDays(30);
    expect(await backendTlsService.needsRenewal(tlsPaths)).to.equal(false);
  });

  it('turns true once the cert is inside the renewal window', async () => {
    await writeCertValidForDays(30);
    const expiry = await backendTlsService.certExpiry(tlsPaths);
    // 21 days in: 9 days of life left, inside the 10-day window
    const at21Days = expiry.getTime() - 9 * DAY_MS;
    expect(await backendTlsService.needsRenewal(tlsPaths, at21Days - DAY_MS)).to.equal(false);
    expect(await backendTlsService.needsRenewal(tlsPaths, at21Days)).to.equal(true);
  });

  it('is true for an already-expired cert', async () => {
    await writeCertValidForDays(30);
    const expiry = await backendTlsService.certExpiry(tlsPaths);
    expect(await backendTlsService.needsRenewal(tlsPaths, expiry.getTime() + DAY_MS)).to.equal(true);
  });
});
