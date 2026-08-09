const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const realFsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// The module's file logic (existence checks, atomic renames, mtime ageing) is
// the behaviour under test, so the real filesystem is used, rebased from the
// production /dat root into a per-run temp dir. Only nebula-cert is faked: it
// writes metadata-carrying files whose JSON stands in for certificate
// contents, and `print -json` reads it back — mirroring the real tool's
// observable semantics (files out, details JSON in).
const PROD_ROOT = '/dat/var/lib/flux-mesh';

describe('meshCertificates', () => {
  let tmpRoot;
  let meshCertificates;
  let nebulaCalls;
  let counter;

  const rebase = (p) => (typeof p === 'string' && p.startsWith(PROD_ROOT)
    ? path.join(tmpRoot, p.slice(PROD_ROOT.length)) : p);

  const flagsOf = (params) => {
    const flags = {};
    for (let i = 1; i < params.length; i += 1) {
      if (params[i].startsWith('-')) {
        const next = params[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[params[i]] = next;
          i += 1;
        } else {
          flags[params[i]] = true;
        }
      }
    }
    return flags;
  };

  const fakeNebulaCert = async (params) => {
    const kind = params[0];
    const flags = flagsOf(params);
    counter += 1;
    if (kind === 'ca') {
      nebulaCalls.push({ kind, flags });
      await realFsp.writeFile(rebase(flags['-out-key']), `KEY-ca-${counter}`);
      await realFsp.writeFile(rebase(flags['-out-crt']), JSON.stringify({
        name: flags['-name'],
        issuer: '',
        fingerprint: `fp-ca-${counter}`,
        notAfter: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString(),
      }));
      return { error: null, stdout: '', stderr: '' };
    }
    if (kind === 'sign') {
      nebulaCalls.push({ kind, flags });
      const ca = JSON.parse(await realFsp.readFile(rebase(flags['-ca-crt']), 'utf8'));
      await realFsp.readFile(rebase(flags['-ca-key']));
      await realFsp.writeFile(rebase(flags['-out-key']), `KEY-host-${counter}`);
      await realFsp.writeFile(rebase(flags['-out-crt']), JSON.stringify({
        name: flags['-name'],
        issuer: ca.fingerprint,
        fingerprint: `fp-host-${counter}`,
        notAfter: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      }));
      return { error: null, stdout: '', stderr: '' };
    }
    if (kind === 'print') {
      try {
        const meta = JSON.parse(await realFsp.readFile(rebase(flags['-path']), 'utf8'));
        return {
          error: null,
          stderr: '',
          stdout: JSON.stringify([{
            details: { name: meta.name, issuer: meta.issuer, notAfter: meta.notAfter },
            fingerprint: meta.fingerprint,
          }]),
        };
      } catch (error) {
        return { error, stdout: '', stderr: '' };
      }
    }
    return { error: new Error(`unexpected nebula-cert ${kind}`), stdout: '', stderr: '' };
  };

  const APP = {
    instance: 'ab12cd34ef56',
    appUuid: '5db6f53acbbd9b38e949307e96601e573bd6437ddec08707e76a33f771b358ea',
    outpoint: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08:0',
  };
  const appFile = (name) => path.join(tmpRoot, APP.instance, name);

  beforeEach(async () => {
    tmpRoot = await realFsp.mkdtemp(path.join(os.tmpdir(), 'mesh-certs-'));
    nebulaCalls = [];
    counter = 0;
    const fspShim = {};
    for (const method of ['readFile', 'writeFile', 'rm', 'mkdir', 'chmod', 'stat']) {
      fspShim[method] = (p, ...args) => realFsp[method](rebase(p), ...args);
    }
    fspShim.rename = (a, b) => realFsp.rename(rebase(a), rebase(b));
    meshCertificates = proxyquire('../../ZelBack/src/services/appMesh/meshCertificates', {
      'node:fs/promises': fspShim,
      '../serviceHelper': {
        runCommand: sinon.stub().callsFake(async (cmd, options) => {
          expect(cmd).to.equal('nebula-cert');
          expect(options.runAsRoot).to.equal(true);
          return fakeNebulaCert(options.params);
        }),
      },
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
      },
    });
  });

  afterEach(async () => {
    await realFsp.rm(tmpRoot, { recursive: true, force: true });
    sinon.restore();
  });

  describe('meshAppDir', () => {
    it('rejects anything but an identity-segment name', () => {
      expect(() => meshCertificates.meshAppDir('../etc')).to.throw(TypeError);
      expect(() => meshCertificates.meshAppDir('')).to.throw(TypeError);
      expect(meshCertificates.meshAppDir('ab12cd34ef56')).to.equal(`${PROD_ROOT}/ab12cd34ef56`);
    });
  });

  describe('ensureAuthority', () => {
    it('creates the CA once with pinned constraints and reuses it after', async () => {
      const first = await meshCertificates.ensureAuthority(APP);
      const again = await meshCertificates.ensureAuthority(APP);
      expect(again).to.equal(first);
      const caCalls = nebulaCalls.filter((c) => c.kind === 'ca');
      expect(caCalls).to.have.lengthOf(1);
      expect(caCalls[0].flags['-networks']).to.equal('fdb2:8fa9:3450::/48');
      expect(caCalls[0].flags['-unsafe-networks']).to.equal('fdb2:8fa9:3450::/48');
      expect(caCalls[0].flags['-groups']).to.equal('flux-mesh');
      expect(caCalls[0].flags['-name']).to.equal('flux-mesh-6f6437c5');
    });

    it('regenerates a half-written pair whole', async () => {
      await meshCertificates.ensureAuthority(APP);
      await realFsp.rm(appFile('ca.crt'));
      await meshCertificates.ensureAuthority(APP);
      expect(nebulaCalls.filter((c) => c.kind === 'ca')).to.have.lengthOf(2);
      const key = await realFsp.readFile(appFile('ca.key'), 'utf8');
      expect(key).to.equal(`KEY-ca-${counter}`);
    });
  });

  describe('authorityBundle', () => {
    it('is the incumbent alone outside rotation, both during it', async () => {
      const ca = await meshCertificates.ensureAuthority(APP);
      expect(await meshCertificates.authorityBundle(APP.instance)).to.equal(ca);
      await meshCertificates.beginAuthorityRotation(APP);
      const bundle = await meshCertificates.authorityBundle(APP.instance);
      expect(bundle).to.include('fp-ca-1');
      expect(bundle).to.include('fp-ca-2');
    });

    it('throws when no authority exists', async () => {
      try {
        await meshCertificates.authorityBundle(APP.instance);
        expect.fail('should throw');
      } catch (error) {
        expect(error.message).to.include('No mesh authority');
      }
    });
  });

  describe('reconcileHostCertificate', () => {
    beforeEach(async () => { await meshCertificates.ensureAuthority(APP); });

    it('issues and deploys the first certificate immediately', async () => {
      const action = await meshCertificates.reconcileHostCertificate(APP);
      expect(action).to.equal(meshCertificates.HostCertificateAction.DEPLOYED);
      const cert = JSON.parse(await realFsp.readFile(appFile('host.crt'), 'utf8'));
      expect(cert.issuer).to.equal('fp-ca-1');
      expect(cert.name).to.equal('6f6437c5');
      const sign = nebulaCalls.find((c) => c.kind === 'sign');
      expect(sign.flags['-networks']).to.equal('fdb2:8fa9:3450:76a8:bd32:a312::/48');
      expect(sign.flags['-unsafe-networks']).to.equal('fdb2:8fa9:3450:76a8:bd32:a312::/96');
      expect(sign.flags['-duration']).to.equal('24h');
    });

    it('does nothing while the certificate is fresh', async () => {
      await meshCertificates.reconcileHostCertificate(APP);
      expect(await meshCertificates.reconcileHostCertificate(APP)).to.equal(meshCertificates.HostCertificateAction.NONE);
    });

    it('parks a replacement in the renewal window, deploys it only once aged', async () => {
      await meshCertificates.reconcileHostCertificate(APP);
      const seventeenHours = Date.now() + 17 * 3600 * 1000;
      expect(await meshCertificates.reconcileHostCertificate(APP, seventeenHours)).to.equal(meshCertificates.HostCertificateAction.PARKED);
      const parked = await realFsp.readFile(appFile('host-next.crt'), 'utf8');

      // Five minutes after signing: younger than the minimum age, stays parked.
      const fiveMinutes = Date.now() + 5 * 60 * 1000;
      expect(await meshCertificates.reconcileHostCertificate(APP, fiveMinutes)).to.equal(meshCertificates.HostCertificateAction.NONE);

      const elevenMinutes = Date.now() + 11 * 60 * 1000;
      expect(await meshCertificates.reconcileHostCertificate(APP, elevenMinutes)).to.equal(meshCertificates.HostCertificateAction.DEPLOYED);
      expect(await realFsp.readFile(appFile('host.crt'), 'utf8')).to.equal(parked);
      expect(await realFsp.readFile(appFile('host.key'), 'utf8')).to.equal(`KEY-host-${counter}`);
    });
  });

  describe('authority rotation', () => {
    beforeEach(async () => {
      await meshCertificates.ensureAuthority(APP);
      await meshCertificates.reconcileHostCertificate(APP);
    });

    it('refuses to conclude before the host certificate cites the successor', async () => {
      await meshCertificates.beginAuthorityRotation(APP);
      try {
        await meshCertificates.concludeAuthorityRotation(APP.instance);
        expect.fail('should throw');
      } catch (error) {
        expect(error.message).to.include('not yet signed by the successor');
      }
    });

    it('walks begin → adopt → age → conclude, renewing under the successor', async () => {
      await meshCertificates.beginAuthorityRotation(APP);
      await meshCertificates.adoptSuccessorAuthority(APP);
      const elevenMinutes = Date.now() + 11 * 60 * 1000;
      expect(await meshCertificates.reconcileHostCertificate(APP, elevenMinutes)).to.equal(meshCertificates.HostCertificateAction.DEPLOYED);

      // A renewal now must stay under the successor, not fall back.
      const seventeenHours = Date.now() + 17 * 3600 * 1000;
      expect(await meshCertificates.reconcileHostCertificate(APP, seventeenHours)).to.equal(meshCertificates.HostCertificateAction.PARKED);
      const lastSign = nebulaCalls.filter((c) => c.kind === 'sign').pop();
      expect(lastSign.flags['-ca-crt']).to.include('ca-successor.crt');

      await meshCertificates.concludeAuthorityRotation(APP.instance);
      // The successor was the third nebula call (CA, host sign, successor CA).
      const ca = JSON.parse(await realFsp.readFile(appFile('ca.crt'), 'utf8'));
      expect(ca.fingerprint).to.equal('fp-ca-3');
      const bundle = await meshCertificates.authorityBundle(APP.instance);
      expect(bundle).to.not.include('fp-ca-1');
    });

    it('begin is idempotent', async () => {
      await meshCertificates.beginAuthorityRotation(APP);
      await meshCertificates.beginAuthorityRotation(APP);
      expect(nebulaCalls.filter((c) => c.kind === 'ca')).to.have.lengthOf(2);
    });
  });

  describe('writeTrustBundle', () => {
    it('deploys own authority first, members sorted, and reports change once', async () => {
      const own = await meshCertificates.ensureAuthority(APP);
      const changed = await meshCertificates.writeTrustBundle(APP.instance, ['PEM-B\n', 'PEM-A\n']);
      expect(changed).to.equal(true);
      const bundle = await realFsp.readFile(appFile('trust-bundle.pem'), 'utf8');
      expect(bundle).to.equal(`${own}\nPEM-A\nPEM-B\n`);
      const unchanged = await meshCertificates.writeTrustBundle(APP.instance, ['PEM-A\n', 'PEM-B\n']);
      expect(unchanged).to.equal(false);
    });

    it('newline-terminates every part so PEM blocks never merge across the seam', async () => {
      await meshCertificates.ensureAuthority(APP);
      await meshCertificates.writeTrustBundle(APP.instance, ['PEM-NO-NEWLINE']);
      const bundle = await realFsp.readFile(appFile('trust-bundle.pem'), 'utf8');
      expect(bundle).to.include('PEM-NO-NEWLINE\n');
    });

    it('carries both authorities during a rotation overlap', async () => {
      await meshCertificates.ensureAuthority(APP);
      await meshCertificates.beginAuthorityRotation(APP);
      await meshCertificates.writeTrustBundle(APP.instance, []);
      const bundle = await realFsp.readFile(appFile('trust-bundle.pem'), 'utf8');
      expect(bundle).to.include('fp-ca-1');
      expect(bundle).to.include('fp-ca-2');
    });
  });

  describe('removeAppMaterial', () => {
    it('removes everything, keys included', async () => {
      await meshCertificates.ensureAuthority(APP);
      await meshCertificates.removeAppMaterial(APP.instance);
      try {
        await realFsp.stat(path.join(tmpRoot, APP.instance));
        expect.fail('should be gone');
      } catch (error) {
        expect(error.code).to.equal('ENOENT');
      }
    });
  });
});
