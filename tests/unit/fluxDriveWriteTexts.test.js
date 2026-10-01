'use strict';

const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');
const contentBlobService = require('../../ZelBack/src/services/appLifecycle/contentBlobService');
const contentSlotService = require('../../ZelBack/src/services/appLifecycle/contentSlotService');
const specLibs = require('../../ZelBack/src/services/utils/specLibs');

const { encryptAndUploadBlob, sha256Hex } = contentBlobService;
const { backstopManifest, reconcileSlots } = contentSlotService;

// The texts both signatures of a FluxDrive write are over belong to flux-spec
// (fluxDriveWrites.js), and the library publishes vectors for them. The client
// never builds a signed text: it hands the benchmark channel typed fields, and
// FluxDrive rebuilds the text from what arrives on the wire. This suite drives
// the real upload, manifest-put and reconcile paths, and asserts that the
// fields each one hands the channel, run through the library's own text, give
// the vector's digest; and that what is sent to FluxDrive is what was signed.
const vectors = JSON.parse(fs.readFileSync(
  path.join(path.dirname(require.resolve('@runonflux/flux-spec/package.json')), 'vectors', 'fluxdrive-write-texts.json'),
  'utf8',
));

const ok = (obj) => ({ status: 'success', data: { status: 'ok', ...obj } });

describe('FluxDrive write texts: the client hands the channel the fields of the library\'s texts', () => {
  const { identity } = vectors;
  let texts;

  before(async function loadLibrary() {
    this.timeout(30_000);
    texts = await specLibs.getSpec();
  });

  it('the vectors are the library\'s own, and the domains the channel signs under are the library\'s', () => {
    expect(texts.blobUploadDigest({ identity, ...vectors.upload })).to.equal(vectors.upload.digest);
    expect(texts.manifestPutDigest({ identity, ...vectors.manifest })).to.equal(vectors.manifest.digest);
    expect(texts.manifestPutDigest({ identity, ...vectors.manifestCarried })).to.equal(vectors.manifestCarried.digest);
    expect(texts.keptLocatorsHash(vectors.keptLocators.locators)).to.equal(vectors.keptLocators.hash);
    for (const v of [vectors.reconcile, vectors.reconcileCarried]) {
      expect(texts.slotReconcileDigest({
        identity, source: v.source, version: v.version, keptLocators: v.locators, pendingMessageHash: v.pendingMessageHash,
      })).to.equal(v.digest);
    }
    expect(vectors.arcane).to.deep.equal(texts.FLUXDRIVE_ARCANE_DOMAINS);
  });

  it('a blob upload: the signer gets locator, identity and timestamp, and the upload carries the identity', async () => {
    const { locator, timestamp } = vectors.upload;
    const bytes = Buffer.from('placeholder-content-bytes');
    const contentHash = `sha256:${sha256Hex(bytes)}`;
    let signed = null;
    let uploaded = null;
    const benchmark = {
      blobLocator: async () => ok({ locator }),
      contentKey: async () => ok({ key: Buffer.alloc(32).toString('base64') }),
      signBlobUpload: async (fields) => { signed = fields; return ok({ signature: 'arc' }); },
    };
    const uploader = { uploadBlob: async (framed, hdr) => { uploaded = hdr; } };

    await encryptAndUploadBlob(
      {
        appName: 'any-name', identity, contentHash, bytes, ownerSig: 'owner', timestamp, source: 'blob',
      },
      { benchmark, uploader, now: () => timestamp },
    );

    expect(signed).to.deep.equal({
      kind: 'upload', identity, locator, timestamp,
    });
    expect(texts.blobUploadDigest(signed)).to.equal(vectors.upload.digest);
    // FluxDrive rebuilds the text from the headers: they carry what was signed.
    expect(uploaded).to.include({ locator, identity, timestamp });
    expect(texts.blobUploadDigest({ locator: uploaded.locator, identity: uploaded.identity, timestamp: uploaded.timestamp })).to.equal(vectors.upload.digest);
  });

  for (const [name, vector] of [['a content update\'s', vectors.manifest], ['a carried', vectors.manifestCarried]]) {
    it(`${name} manifest put: the signer gets identity, version, timestamp and the message named, and the body names it too`, async () => {
      let signed = null;
      let body = null;
      const sent = await backstopManifest(
        { appName: 'any-name', identity, version: vector.version },
        {
          appName: 'any-name', identity, version: vector.version, timestamp: vector.timestamp, manifestPutSig: 'owner', pendingMessageHash: vector.pendingMessageHash,
        },
        { sign: async (fields) => { signed = fields; return 'arc'; }, put: async (appName, b) => { body = b; } },
      );
      expect(sent).to.equal(true);
      expect(texts.manifestPutDigest(signed)).to.equal(vector.digest);
      expect(body.pendingMessageHash).to.equal(vector.pendingMessageHash);
      expect(texts.manifestPutDigest({
        identity, version: body.version, timestamp: body.timestamp, pendingMessageHash: body.pendingMessageHash,
      })).to.equal(vector.digest);
    });
  }

  for (const [name, vector] of [['a content update\'s', vectors.reconcile], ['a carried', vectors.reconcileCarried]]) {
    it(`${name} reconcile: the signer gets the very locator list sent, hashed as the library hashes it, and the message named`, async () => {
      // Three slots whose locators come back in the vector's order, one twice.
      const derived = [...vector.locators];
      let signed = null;
      let body = null;
      const sent = await reconcileSlots(
        { slots: { a: { hash: 'h1' }, b: { hash: 'h2' }, c: { hash: 'h3' } } },
        {
          appName: 'any-name', identity, version: vector.version, reconcileSig: 'owner', pendingMessageHash: vector.pendingMessageHash,
        },
        {
          deriveLocator: async () => derived.shift(),
          sign: async (fields) => { signed = fields; return 'arc'; },
          reconcile: async (appName, b) => { body = b; },
        },
      );
      expect(sent).to.equal(true);
      expect(signed).to.include({ identity, source: 'slot', version: vector.version, pendingMessageHash: vector.pendingMessageHash });
      expect(texts.keptLocatorsHash(signed.keptLocators)).to.equal(vectors.keptLocators.hash);
      expect(body.liveLocators).to.deep.equal(signed.keptLocators);
      expect(body.pendingMessageHash).to.equal(vector.pendingMessageHash);
      // The text FluxDrive rebuilds from the body is the text the channel signed.
      expect(texts.slotReconcileDigest({
        identity, source: body.source, version: body.version, keptLocators: body.liveLocators, pendingMessageHash: body.pendingMessageHash,
      })).to.equal(texts.slotReconcileDigest(signed));
    });
  }
});
