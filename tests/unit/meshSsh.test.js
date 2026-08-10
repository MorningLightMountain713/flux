'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const realFsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Key material handling runs against the real filesystem, rebased from the
// production /dat root into a per-run temp dir; ssh-keygen is faked at the
// runCommand seam and writes the pair like the real tool. The exec channel
// tests pin the exact ssh invocation — the flags ARE the security posture
// (BatchMode, strict host key checking against our own pin).
const PROD_ROOT = '/dat/var/lib/flux-mesh';

describe('meshSsh', () => {
  let tmpRoot;
  let meshSsh;
  let calls;
  let sshResponses;
  let keygenCount;

  const rebase = (p) => (typeof p === 'string' && p.startsWith(PROD_ROOT)
    ? path.join(tmpRoot, p.slice(PROD_ROOT.length)) : p);

  const INSTANCE = 'ab12cd34ef56';

  beforeEach(async () => {
    tmpRoot = await realFsp.mkdtemp(path.join(os.tmpdir(), 'mesh-ssh-'));
    calls = [];
    sshResponses = [];
    keygenCount = 0;
    const fspShim = {};
    for (const method of ['readFile', 'writeFile', 'rm', 'mkdir', 'chmod', 'stat']) {
      fspShim[method] = (p, ...args) => realFsp[method](rebase(p), ...args);
    }
    fspShim.rename = (a, b) => realFsp.rename(rebase(a), rebase(b));
    meshSsh = proxyquire('../../ZelBack/src/services/appMesh/meshSsh', {
      'node:fs/promises': fspShim,
      '../serviceHelper': {
        runCommand: sinon.stub().callsFake(async (cmd, options) => {
          calls.push({ cmd, params: options.params });
          expect(options.runAsRoot).to.equal(true);
          if (cmd === 'ssh-keygen') {
            keygenCount += 1;
            const keyPath = options.params[options.params.indexOf('-f') + 1];
            await realFsp.writeFile(rebase(keyPath), `PRIVATE-${keygenCount}`);
            await realFsp.writeFile(rebase(`${keyPath}.pub`), `ssh-ed25519 AAAAKEY${keygenCount} flux-mesh\n`);
            return { error: null, stdout: '', stderr: '' };
          }
          if (cmd === 'ip') {
            return sshResponses.shift() ?? { error: null, stdout: '', stderr: '' };
          }
          return { error: new Error(`unexpected command ${cmd}`), stdout: '', stderr: '' };
        }),
      },
    });
  });

  afterEach(async () => {
    await realFsp.rm(tmpRoot, { recursive: true, force: true });
    sinon.restore();
  });

  describe('ensureClientKeypair', () => {
    it('generates once and returns the same public line thereafter', async () => {
      const pub = await meshSsh.ensureClientKeypair();
      expect(pub).to.equal('ssh-ed25519 AAAAKEY1 flux-mesh');
      const again = await meshSsh.ensureClientKeypair();
      expect(again).to.equal(pub);
      expect(keygenCount).to.equal(1);
      const priv = await realFsp.readFile(path.join(tmpRoot, 'ssh_client_ed25519'), 'utf8');
      expect(priv).to.equal('PRIVATE-1');
    });
  });

  describe('ensureHostKey', () => {
    it('mints the host key and its known_hosts pin together, idempotently', async () => {
      await meshSsh.ensureHostKey(INSTANCE);
      const knownHosts = await realFsp.readFile(path.join(tmpRoot, INSTANCE, 'known_hosts'), 'utf8');
      expect(knownHosts).to.equal('[127.0.0.1]:2222 ssh-ed25519 AAAAKEY1 flux-mesh\n');
      await meshSsh.ensureHostKey(INSTANCE);
      expect(keygenCount).to.equal(1);
    });
  });

  describe('listHostmap', () => {
    it('runs the pinned ssh invocation inside the namespace and parses the table', async () => {
      const hostmap = [{ vpnAddrs: ['fd00::1'], cert: { details: { issuer: 'fp1' }, fingerprint: 'leaf1' } }];
      sshResponses.push({ error: null, stdout: JSON.stringify(hostmap), stderr: '' });
      const result = await meshSsh.listHostmap(INSTANCE);
      expect(result).to.deep.equal(hostmap);
      expect(calls).to.have.length(1);
      expect(calls[0].cmd).to.equal('ip');
      expect(calls[0].params).to.deep.equal([
        'netns', 'exec', `flux-mesh-${INSTANCE}`,
        'ssh',
        '-i', '/dat/var/lib/flux-mesh/ssh_client_ed25519',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=/dat/var/lib/flux-mesh/${INSTANCE}/known_hosts`,
        '-o', 'ConnectTimeout=5',
        '-p', '2222',
        'fluxos@127.0.0.1',
        'list-hostmap -json',
      ]);
    });

    it('treats unparseable output as failure whatever the exit status said', async () => {
      sshResponses.push({ error: null, stdout: 'Could not find tunnel', stderr: '' });
      try {
        await meshSsh.listHostmap(INSTANCE);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include('unreadable hostmap');
      }
    });

    it('surfaces a connection failure', async () => {
      sshResponses.push({ error: new Error('exit 255'), stdout: '', stderr: 'Connection refused' });
      try {
        await meshSsh.listHostmap(INSTANCE);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include('Connection refused');
      }
    });
  });

  describe('printOwnCert', () => {
    it('parses the loaded certificate', async () => {
      sshResponses.push({
        error: null,
        stdout: JSON.stringify({ details: { name: 'abcd1234' }, fingerprint: 'fp-live' }),
        stderr: '',
      });
      const cert = await meshSsh.printOwnCert(INSTANCE);
      expect(cert.fingerprint).to.equal('fp-live');
      expect(calls[0].params[calls[0].params.length - 1]).to.equal('print-cert -json');
    });

    it('rejects a reply with no fingerprint', async () => {
      sshResponses.push({ error: null, stdout: '{}', stderr: '' });
      try {
        await meshSsh.printOwnCert(INSTANCE);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include('unreadable certificate');
      }
    });
  });
});
