'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');
const contentSlotService = require('../../ZelBack/src/services/appLifecycle/contentSlotService');

const { encryptAndUploadBlob, sha256Hex } = contentBlobService;
const { backstopManifest, reconcileSlots } = contentSlotService;

// Shared wire-contract vectors, generated in the FluxDrive repo
// (fluxdrive-api/tests/contract) and copied here verbatim. The client no longer
// builds signed bytes — the benchmark channel does, from typed fields — so this
// suite drives the real upload/backstop/reconcile paths and asserts each one
// hands the channel exactly the vector's fields and emits the vector's values
// on the wire. The byte construction itself is pinned by the FluxDrive suite
// (and its verifier). Regenerate + recopy on any change.
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'content-wire-vectors.json'), 'utf8'));

describe('content wire contract (shared vectors)', () => {
  it('vectors are the v2 (domain-prefixed arcane) contract, epoch-millisecond timestamped', () => {
    expect(vectors.$schema).to.equal('content-delivery-wire-contract/v2');
    expect(vectors.timestampUnit).to.equal('unix-epoch-milliseconds');
  });

  it('each vector\'s arcane message is its domain + the owner digest', () => {
    // Keeps the copied fixture honest against hand-edits: the arcane form is
    // derived, never independent.
    Object.entries({ blob: 'upload', manifestPut: 'manifest', reconcile: 'reconcile' }).forEach(([group, kind]) => {
      vectors.vectors[group].forEach((v) => {
        expect(v.arcaneSignedMessage).to.equal(`${vectors.arcaneDomains[kind]}${v.signedMessage}`, v.name);
      });
    });
  });

  describe('blob upload sends typed fields for the channel to sign', () => {
    vectors.vectors.blob.forEach((v) => {
      it(v.name, async () => {
        const { locator, appName, timestamp } = v.inputs;
        const bytes = Buffer.from('placeholder-content-bytes');
        const contentHash = `sha256:${sha256Hex(bytes)}`;
        let signParams = null;
        let uploaded = null;
        const benchmark = {
          blobLocator: async () => ({ status: 'success', data: { status: 'ok', locator } }),
          contentKey: async () => ({ status: 'success', data: { status: 'ok', key: Buffer.alloc(32).toString('base64') } }),
          signBlobUpload: async (params) => {
            signParams = params;
            return { status: 'success', data: { status: 'ok', signature: 'arc' } };
          },
        };
        const uploader = { uploadBlob: async (framed, hdr) => { uploaded = hdr; } };

        await encryptAndUploadBlob(
          { appName, fluxID: '1id', contentHash, bytes, ownerSig: v.ownerSig, timestamp, source: 'blob' },
          { benchmark, uploader, now: () => timestamp },
        );

        expect(signParams).to.deep.equal({
          kind: 'upload', locator, appName, timestamp,
        });
        expect(uploaded.timestamp).to.equal(timestamp); // emitted verbatim on the wire
        expect(String(timestamp)).to.have.lengthOf(13); // epoch ms
      });
    });
  });

  describe('manifest PUT sends typed fields for the channel to sign', () => {
    vectors.vectors.manifestPut.forEach((v) => {
      it(v.name, async () => {
        const { appName, version, timestamp } = v.inputs;
        let signFields = null;
        const ok = await backstopManifest(
          { appName, version },
          { appName, version, timestamp, manifestPutSig: v.ownerSig },
          {
            sign: async (fields) => { signFields = fields; return 'arc'; },
            put: async () => {},
          },
        );
        expect(ok).to.equal(true);
        expect(signFields).to.deep.equal({ appName, version, timestamp });
        expect(String(timestamp)).to.have.lengthOf(13);
      });
    });
  });

  describe('reconcile sends typed fields for the channel to sign', () => {
    vectors.vectors.reconcile.forEach((v) => {
      it(v.name, async () => {
        const { appName, source, version } = v.inputs;
        let signFields = null;
        const sent = await reconcileSlots(
          { slots: { s: { hash: 'h' } } },
          { appName, owner: '1id', version, reconcileSig: v.ownerSig },
          {
            deriveLocator: async () => 'loc',
            sign: async (fields) => { signFields = fields; return 'arc'; },
            reconcile: async () => {},
          },
        );
        expect(sent).to.equal(true);
        expect(signFields).to.deep.equal({ appName, source, version });
      });
    });
  });
});
