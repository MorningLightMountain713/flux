const { expect } = require('chai');
const crypto = require('node:crypto');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');

const { encryptAndUploadBlob, decryptAndVerifyBlob, MAX_BLOB_BYTES } = contentBlobService;

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
});
