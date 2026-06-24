const { expect } = require('chai');
const crypto = require('node:crypto');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');
const { aeadEncrypt } = require('../../ZelBack/src/services/utils/aeadCrypto');

const {
  encryptAndUploadBlob, decryptAndVerifyBlob, resolveBlob, provisionContentBlobs,
  serveBlob, fetchBlobFromPeer, MAX_BLOB_BYTES,
} = contentBlobService;

const KEY = crypto.randomBytes(32);
const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;
const freshTs = String(NOW_MS / 1000);

const hashOf = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
// executeCall shape: { status: 'success', data: { status: 'ok', <field> } }
const ok = (obj) => ({ status: 'success', data: { status: 'ok', ...obj } });

function makeBenchmark(overrides = {}) {
  return {
    blobLocator: async () => ok({ locator: 'a'.repeat(64) }),
    contentKey: async () => ok({ key: KEY.toString('base64') }),
    signBlobUpload: async () => ok({ signature: 'arcane-sig-b64' }),
    ...overrides,
  };
}

function makeUploader() {
  const calls = [];
  return { calls, uploadBlob: async (framed, headers) => { calls.push({ framed, headers }); } };
}

async function expectReject(promise, regex) {
  try {
    await promise;
  } catch (e) {
    expect(e.message).to.match(regex);
    return;
  }
  throw new Error('expected promise to reject');
}

describe('contentBlobService', () => {
  describe('encryptAndUploadBlob', () => {
    it('encrypts, signs, and uploads a blob and returns its locator', async () => {
      const bytes = Buffer.from('hello content');
      const contentHash = hashOf(bytes);
      const uploader = makeUploader();

      const out = await encryptAndUploadBlob(
        { appName: 'app', fluxID: '1id', contentHash, bytes, ownerSig: 'owner-sig', timestamp: freshTs },
        { benchmark: makeBenchmark(), uploader, now },
      );

      expect(out.locator).to.equal('a'.repeat(64));
      expect(uploader.calls.length).to.equal(1);
      const { framed, headers } = uploader.calls[0];
      expect(headers).to.include({
        locator: 'a'.repeat(64), appName: 'app', ownerSig: 'owner-sig', arcaneSig: 'arcane-sig-b64', source: 'blob', timestamp: freshTs,
      });
      // ciphertext is nonce || ciphertext || tag (plaintext + 28) and hides the plaintext
      expect(framed.length).to.equal(bytes.length + 28);
      expect(framed.includes(bytes)).to.equal(false);
    });

    it('rejects a hash mismatch', async () => {
      const bytes = Buffer.from('data');
      await expectReject(encryptAndUploadBlob(
        { appName: 'app', fluxID: '1id', contentHash: `sha256:${'0'.repeat(64)}`, bytes, ownerSig: 's', timestamp: freshTs },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /hash mismatch/);
    });

    it('rejects an oversized blob', async () => {
      const bytes = Buffer.alloc(MAX_BLOB_BYTES + 1);
      await expectReject(encryptAndUploadBlob(
        { appName: 'app', fluxID: '1id', contentHash: hashOf(bytes), bytes, ownerSig: 's', timestamp: freshTs },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /exceeds/);
    });

    it('rejects a stale owner timestamp', async () => {
      const bytes = Buffer.from('data');
      await expectReject(encryptAndUploadBlob(
        { appName: 'app', fluxID: '1id', contentHash: hashOf(bytes), bytes, ownerSig: 's', timestamp: String(NOW_MS / 1000 - 1000) },
        { benchmark: makeBenchmark(), uploader: makeUploader(), now },
      ), /stale/);
    });

    it('surfaces a benchmark-channel rejection', async () => {
      const bytes = Buffer.from('data');
      const benchmark = makeBenchmark({ contentKey: async () => ({ status: 'error', data: 'boom' }) });
      await expectReject(encryptAndUploadBlob(
        { appName: 'app', fluxID: '1id', contentHash: hashOf(bytes), bytes, ownerSig: 's', timestamp: freshTs },
        { benchmark, uploader: makeUploader(), now },
      ), /benchmark channel/);
    });
  });

  describe('decryptAndVerifyBlob', () => {
    it('round-trips an uploaded blob back to verified plaintext', async () => {
      const bytes = Buffer.from('round trip me');
      const contentHash = hashOf(bytes);
      const uploader = makeUploader();
      await encryptAndUploadBlob(
        { appName: 'app', fluxID: '1id', contentHash, bytes, ownerSig: 's', timestamp: freshTs },
        { benchmark: makeBenchmark(), uploader, now },
      );
      const { framed } = uploader.calls[0];

      const out = await decryptAndVerifyBlob(
        { appName: 'app', fluxID: '1id', contentHash, framed },
        { benchmark: makeBenchmark() },
      );
      expect(out.equals(bytes)).to.equal(true);
    });

    it('rejects ciphertext that fails authentication (wrong key)', async () => {
      const bytes = Buffer.from('data');
      const contentHash = hashOf(bytes);
      const uploader = makeUploader();
      await encryptAndUploadBlob(
        { appName: 'app', fluxID: '1id', contentHash, bytes, ownerSig: 's', timestamp: freshTs },
        { benchmark: makeBenchmark(), uploader, now },
      );
      const { framed } = uploader.calls[0];

      const wrongKey = makeBenchmark({ contentKey: async () => ok({ key: crypto.randomBytes(32).toString('base64') }) });
      await expectReject(decryptAndVerifyBlob(
        { appName: 'app', fluxID: '1id', contentHash, framed },
        { benchmark: wrongKey },
      ), /./);
    });
  });

  describe('resolveBlob', () => {
    const bytes = Buffer.from('install me');
    const contentHash = hashOf(bytes);
    const validFramed = () => aeadEncrypt(KEY, bytes, Buffer.from(contentHash));
    const noFluxDrive = { fetchBlobByLocator: async () => null };

    it('resolves from the first healthy peer', async () => {
      const framed = validFramed();
      const out = await resolveBlob(
        { appName: 'app', fluxID: '1id', contentHash, peers: ['p1', 'p2'] },
        { benchmark: makeBenchmark(), peerFetch: async () => framed, fluxDrive: noFluxDrive },
      );
      expect(out.equals(bytes)).to.equal(true);
    });

    it('falls through a failing peer to the next', async () => {
      const framed = validFramed();
      let n = 0;
      const peerFetch = async () => { n += 1; if (n === 1) throw new Error('peer down'); return framed; };
      const out = await resolveBlob(
        { appName: 'app', fluxID: '1id', contentHash, peers: ['p1', 'p2'] },
        { benchmark: makeBenchmark(), peerFetch, fluxDrive: noFluxDrive },
      );
      expect(out.equals(bytes)).to.equal(true);
      expect(n).to.equal(2);
    });

    it('skips a peer returning garbage and uses the FluxDrive backstop', async () => {
      const fluxDrive = { fetchBlobByLocator: async () => validFramed() };
      const out = await resolveBlob(
        { appName: 'app', fluxID: '1id', contentHash, peers: ['p1'] },
        { benchmark: makeBenchmark(), peerFetch: async () => Buffer.alloc(40, 7), fluxDrive },
      );
      expect(out.equals(bytes)).to.equal(true);
    });

    it('throws when no source yields verified content', async () => {
      await expectReject(resolveBlob(
        { appName: 'app', fluxID: '1id', contentHash, peers: ['p1'] },
        { benchmark: makeBenchmark(), peerFetch: async () => null, fluxDrive: noFluxDrive },
      ), /no source/);
    });
  });

  describe('provisionContentBlobs', () => {
    const deployment = {
      componentEntries: () => [
        ['web', { contentBlobMounts: () => [{ source: '/dat/app/config', hash: 'sha256:aaa' }, { source: '/dat/app/seed', hash: 'sha256:bbb' }] }],
        ['db', { contentBlobMounts: () => [] }],
      ],
    };

    it('resolves and writes every content-blob mount, in order', async () => {
      const writes = [];
      const resolve = async ({ contentHash }) => Buffer.from(`plain:${contentHash}`);
      await provisionContentBlobs(
        deployment,
        { appName: 'app', fluxID: '1id', peers: ['p1'] },
        { resolve, writeFile: async (s, b) => writes.push({ source: s, body: b }) },
      );
      expect(writes.map((w) => w.source)).to.deep.equal(['/dat/app/config', '/dat/app/seed']);
      expect(writes[0].body.toString()).to.equal('plain:sha256:aaa');
    });

    it('propagates a resolve failure (app not installable without its content)', async () => {
      const resolve = async () => { throw new Error('contentBlob: no source for sha256:aaa'); };
      await expectReject(provisionContentBlobs(
        deployment,
        { appName: 'app', fluxID: '1id', peers: [] },
        { resolve, writeFile: async () => {} },
      ), /no source/);
    });
  });

  describe('serveBlob', () => {
    const bytes = Buffer.from('served content');
    const contentHash = hashOf(bytes);
    const deployment = {
      componentEntries: () => [['web', { contentBlobMounts: () => [{ source: '/dat/app/config', hash: contentHash }] }]],
    };
    const getDeployment = async () => deployment;
    const readFile = async (src) => (src === '/dat/app/config' ? bytes : null);

    it('serves a matching locator as re-encrypted, verifiable ciphertext', async () => {
      const framed = await serveBlob(
        { appName: 'app', fluxID: '1id', locator: 'a'.repeat(64) },
        { benchmark: makeBenchmark(), getDeployment, readFile },
      );
      expect(Buffer.isBuffer(framed)).to.equal(true);
      const out = await decryptAndVerifyBlob({ appName: 'app', fluxID: '1id', contentHash, framed }, { benchmark: makeBenchmark() });
      expect(out.equals(bytes)).to.equal(true);
    });

    it('returns null when no mount matches the locator', async () => {
      const framed = await serveBlob(
        { appName: 'app', fluxID: '1id', locator: 'b'.repeat(64) },
        { benchmark: makeBenchmark(), getDeployment, readFile },
      );
      expect(framed).to.equal(null);
    });

    it('returns null when the app is not installed here', async () => {
      const framed = await serveBlob(
        { appName: 'app', fluxID: '1id', locator: 'a'.repeat(64) },
        { benchmark: makeBenchmark(), getDeployment: async () => null, readFile },
      );
      expect(framed).to.equal(null);
    });
  });

  describe('fetchBlobFromPeer', () => {
    it('returns the framed bytes on success', async () => {
      const http = { get: async () => ({ data: Buffer.from('framed-cipher') }) };
      const out = await fetchBlobFromPeer('1.2.3.4:16127', 'app', 'loc', { http });
      expect(out.toString()).to.equal('framed-cipher');
    });

    it('returns null on any error', async () => {
      const http = { get: async () => { throw new Error('refused'); } };
      expect(await fetchBlobFromPeer('1.2.3.4:16127', 'app', 'loc', { http })).to.equal(null);
    });
  });
});
