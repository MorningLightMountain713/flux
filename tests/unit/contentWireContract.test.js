const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');
const contentSlotService = require('../../ZelBack/src/services/appLifecycle/contentSlotService');

const { encryptAndUploadBlob, sha256Hex } = contentBlobService;
const { backstopManifest, reconcileSlots } = contentSlotService;

// Shared wire-contract vectors, generated in the FluxDrive repo
// (fluxdrive-api/tests/contract) and copied here verbatim. This suite drives the
// real client upload/backstop/reconcile paths and asserts the message each one
// signs is byte-identical to the vector — so a drift in either repo's message
// construction turns that repo's suite red. Regenerate + recopy on any change.
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'content-wire-vectors.json'), 'utf8'));

describe('content wire contract (shared vectors)', () => {
  it('vectors are epoch-millisecond timestamped', () => {
    expect(vectors.timestampUnit).to.equal('unix-epoch-milliseconds');
  });

  describe('blob upload signs sha256(locator:appName:timestamp)', () => {
    vectors.vectors.blob.forEach((v) => {
      it(v.name, async () => {
        const { locator, appName, timestamp } = v.inputs;
        const bytes = Buffer.from('placeholder-content-bytes');
        const contentHash = `sha256:${sha256Hex(bytes)}`;
        let signed = null;
        let uploaded = null;
        const benchmark = {
          blobLocator: async () => ({ status: 'success', data: { status: 'ok', locator } }),
          contentKey: async () => ({ status: 'success', data: { status: 'ok', key: Buffer.alloc(32).toString('base64') } }),
          signBlobUpload: async ({ message }) => {
            signed = message;
            return { status: 'success', data: { status: 'ok', signature: 'arc' } };
          },
        };
        const uploader = { uploadBlob: async (framed, hdr) => { uploaded = hdr; } };

        await encryptAndUploadBlob(
          { appName, fluxID: '1id', contentHash, bytes, ownerSig: v.ownerSig, timestamp, source: 'blob' },
          { benchmark, uploader, now: () => timestamp },
        );

        expect(signed).to.equal(v.signedMessage);
        expect(uploaded.timestamp).to.equal(timestamp); // emitted verbatim on the wire
        expect(String(timestamp)).to.have.lengthOf(13); // epoch ms
      });
    });
  });

  describe('manifest PUT signs sha256(appName:version:timestamp)', () => {
    vectors.vectors.manifestPut.forEach((v) => {
      it(v.name, async () => {
        const { appName, version, timestamp } = v.inputs;
        let signed = null;
        const ok = await backstopManifest(
          { appName, version },
          { appName, version, timestamp, manifestPutSig: v.ownerSig },
          {
            sign: async (message) => { signed = message; return 'arc'; },
            put: async () => {},
          },
        );
        expect(ok).to.equal(true);
        expect(signed).to.equal(v.signedMessage);
        expect(String(timestamp)).to.have.lengthOf(13);
      });
    });
  });

  describe('reconcile signs sha256(appName:slot:version)', () => {
    vectors.vectors.reconcile.forEach((v) => {
      it(v.name, async () => {
        const { appName, version } = v.inputs;
        let token = null;
        const sent = await reconcileSlots(
          { slots: { s: { hash: 'h' } } },
          { appName, owner: '1id', version, reconcileSig: v.ownerSig },
          {
            deriveLocator: async () => 'loc',
            sign: async (t) => { token = t; return 'arc'; },
            reconcile: async () => {},
          },
        );
        expect(sent).to.equal(true);
        expect(token).to.equal(v.signedMessage);
      });
    });
  });
});
