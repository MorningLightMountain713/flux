'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const transportCryptoProvider = require('../../ZelBack/src/services/providers/FluxOSTransportProvider');
const {
  loadSpecLibrary, V8_SUBMISSION, v8Spec, v9Spec, sealedV8Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');

// Orchestration tests for registryManager.convertApplicationSpecification.
//
// The spec library is REAL here — see tests/unit/fixtures/fluxSpec.js for why.
// This endpoint's whole job is to move between real shapes, so a hand-written
// double is the one thing that cannot test it: the sparse-draft branch only
// exists because the real fromLegacy emits a v8 app with no contacts as an
// INCOMPLETE v9 blob, and a stubbed `validateSchema` returning `{valid:false}`
// asserts nothing about whether that ever happens.
//
// The transport provider is real too. Its `seal` direction is pure local HPKE
// (only `open` touches the benchmark channel), so the tests seal toward a real
// X25519 keypair and OPEN the envelope. HPKE binds `info` and the AAD into the
// ciphertext, so a successful open is proof that production passed the library's
// SPEC_VIEW_INFO and the AAD built from the app name and the returned timestamp
// — stronger than reading them back off a stub.
//
// What stays stubbed is I/O: the mongo read behind getGlobalAppInfo, and the
// signed HTTP fetch behind a legacy F_S_ENV storage reference.

let flux;
let suite;

describe('appConvert (registryManager) tests', () => {
  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
    const {
      CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm,
    } = await import('@hpke/core');
    suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm(),
    });
  });

  afterEach(() => sinon.restore());

  /**
   * What `appsRepository.getGlobalAppInfo` hands the module: a real
   * InstantiatedSpec over a real stored spec. Only the mongo read is stubbed.
   * @returns {Promise<object>} the InstantiatedSpec the stub will return
   */
  async function registryHolds(spec, { height = 1700000 } = {}) {
    const held = await instantiatedSpec(spec, { height });
    sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(held);
    return held;
  }

  /** A frontend's ephemeral X25519 keypair, and the open half of the channel. */
  async function frontendRecipient() {
    const keyPair = await suite.kem.generateKeyPair();
    const publicKey = Buffer.from(await suite.kem.serializePublicKey(keyPair.publicKey));
    return {
      pubkeyBase64: publicKey.toString('base64'),
      /**
       * Open what convert sealed. Throws unless `info` and `aad` are exactly what
       * production used, which is what makes this an assertion and not a decode.
       */
      async open(wire, { appName, timestamp }) {
        const context = await suite.createRecipientContext({
          recipientKey: keyPair.privateKey,
          enc: Buffer.from(wire.encapsulatedKey, 'base64'),
          info: new TextEncoder().encode(flux.SPEC_VIEW_INFO),
        });
        const plaintext = await context.open(
          Buffer.from(wire.ciphertext, 'base64'),
          flux.buildSpecViewAad({ appName, timestamp }),
        );
        return JSON.parse(Buffer.from(plaintext).toString('utf8'));
      },
    };
  }

  /** A v8 app whose env is externalised behind a Flux Storage reference. */
  function withStorageRef(overrides = {}) {
    return {
      name: 'convertme',
      compose: [{
        ...V8_SUBMISSION.compose[0],
        environmentParameters: ['F_S_ENV=https://storage.example.com/env.json'],
      }],
      ...overrides,
    };
  }

  /** Flux Storage is a signed HTTP fetch — stubbed at the http seam, not above it. */
  function storageServes(entries) {
    sinon.stub(serviceHelper, 'axiosGet').resolves({ data: entries });
    sinon.stub(fluxCommunicationMessagesSender, 'getFluxMessageSignature').resolves('sig');
  }

  it('returns a complete cleartext v9 spec when nothing sensitive is inlined', async () => {
    const held = await registryHolds(await v8Spec({ name: 'convertme', contacts: ['ops@example.com'] }));
    const create = sinon.spy(transportCryptoProvider, 'create');

    const result = await registryManager.convertApplicationSpecification('convertme', {});

    expect(result.encrypted).to.equal(false);
    expect(result.complete).to.equal(true);
    expect(result.errors).to.deep.equal([]);
    // The draft is the real class's canonical form, so it carries every v9
    // section — including the ones a v8 row has never had.
    expect(result.spec.version).to.equal(9);
    expect(result.spec.name).to.equal('convertme');
    expect(result.spec.owner).to.equal(V8_SUBMISSION.owner);
    expect(result.spec.components.web.image).to.equal('nginx:latest');
    expect(result.spec).to.have.all.keys(
      'version', 'name', 'description', 'owner', 'instances', 'ttl', 'network',
      'placement', 'assignment', 'components', 'contacts', 'marketplace',
      'telemetry', 'referral', 'activation', 'dependencies',
    );
    // Warnings are the owner's review list, not errors.
    expect(result.warnings.join(' ')).to.include('TCP only');
    expect(create.called).to.equal(false);

    // Guard on the stubbed repository. It is the producer here, so the risk is
    // the opposite way round: convert reads five PROPERTIES off whatever
    // getGlobalAppInfo returns and never calls a method on it, so what has to be
    // asserted is that the real InstantiatedSpec answers those five. Any of them
    // renamed in flux-spec and convert reads `undefined` — encrypting nothing,
    // converting at height undefined — with no error anywhere.
    expect(held.version, 'convert routes on .version').to.equal(8);
    expect(held.isEncrypted, 'convert routes on .isEncrypted').to.equal(false);
    expect(held.height, 'fromLegacy is given .height as confirmationHeight').to.equal(1700000);
    expect(held.name, 'storage refs are resolved against .name').to.equal('convertme');
    expect(held.spec, 'fromLegacy converts .spec').to.be.an.instanceOf(flux.FluxAppSpecV8);
  });

  it('returns a fillable draft with inline errors when the converted spec is incomplete', async () => {
    // The shared v8 fixture carries no contacts, which v9 requires. This is the
    // documented fixable gap the endpoint returns rather than rejects — and it
    // is produced by the real conversion, not asserted into existence.
    await registryHolds(await v8Spec({ name: 'convertme' }));

    const result = await registryManager.convertApplicationSpecification('convertme', {});

    expect(result.encrypted).to.equal(false);
    expect(result.complete).to.equal(false);
    expect(result.errors).to.have.length(1);
    expect(result.errors[0].field).to.equal('contacts');
    expect(result.errors[0].code).to.equal('MISSING_FIELD');
    // The draft is the sparse converted blob itself: strict fromSubmission is
    // never run on an invalid blob (it would throw), so none of the canonical
    // sections it would have filled in are present.
    expect(result.spec).to.not.have.property('contacts');
    expect(result.spec).to.not.have.property('placement');
    expect(result.spec.components.web.image).to.equal('nginx:latest');
    expect(result.warnings.join(' ')).to.include('TCP only');
  });

  it('seals the spec toward the frontend when a storage ref was inlined', async () => {
    // A CLEARTEXT source can still produce a secret draft: v9 has no storage-ref
    // convention, so an F_S_ENV value is fetched and inlined, and it was
    // externalised precisely because it is sensitive.
    await registryHolds(await v8Spec(withStorageRef({ contacts: ['ops@example.com'] })));
    storageServes(['SECRET=hunter2']);
    const create = sinon.spy(transportCryptoProvider, 'create');
    const frontend = await frontendRecipient();

    const result = await registryManager.convertApplicationSpecification('convertme', {
      recipientPubkeyBase64: frontend.pubkeyBase64,
    });

    expect(result.encrypted).to.equal(true);
    expect(result.complete).to.equal(true);
    expect(result.appName).to.equal('convertme');
    expect(result.timestamp).to.be.a('number');
    expect(result).to.not.have.property('spec'); // cleartext never crosses the wire
    expect(result.transportEncrypted).to.have.all.keys('algorithm', 'encapsulatedKey', 'ciphertext');
    // create takes only (name, owner) — both read off the converted blob, so
    // sealing toward `undefined` would pass without this. The recipient pubkey
    // is a seal argument, not a create one.
    sinon.assert.calledOnceWithExactly(create, 'convertme', V8_SUBMISSION.owner);

    const draft = await frontend.open(result.transportEncrypted, result);
    expect(draft.version).to.equal(9);
    expect(draft.components.web.env).to.deep.equal({ SECRET: 'hunter2' });
    expect(draft.components.web.env).to.not.have.property('F_S_ENV');
  });

  it('seals the sparse draft when the source was encrypted but the conversion is incomplete', async () => {
    // No contacts on the sealed source, so the draft is incomplete — and an
    // incomplete draft from an encrypted app is still sealed, because it is
    // still the app's cleartext.
    await registryHolds(await sealedV8Spec({ name: 'convertme' }));
    const frontend = await frontendRecipient();

    const result = await registryManager.convertApplicationSpecification('convertme', {
      recipientPubkeyBase64: frontend.pubkeyBase64,
    });

    expect(result.encrypted).to.equal(true);
    expect(result.complete).to.equal(false);
    expect(result.errors.map((e) => e.field)).to.deep.equal(['contacts']);

    // The sealed plaintext is the sparse blob, not a canonical form.
    const draft = await frontend.open(result.transportEncrypted, result);
    expect(draft).to.not.have.property('contacts');
    expect(draft).to.not.have.property('placement');
    expect(draft.components.web.image, 'the sealed source really was opened').to.equal('nginx:latest');
  });

  it('requires a transport pubkey when the result must be encrypted', async () => {
    await registryHolds(await v8Spec(withStorageRef({ contacts: ['ops@example.com'] })));
    storageServes(['SECRET=hunter2']);
    const create = sinon.spy(transportCryptoProvider, 'create');

    let threw;
    try {
      await registryManager.convertApplicationSpecification('convertme', {});
    } catch (e) {
      threw = e;
    }

    expect(threw).to.be.an('error');
    expect(threw.message).to.include('flux-transport-pubkey');
    // The refusal is about the return channel, so it comes after the secret was
    // already inlined and before any provider exists to seal with.
    expect(create.called).to.equal(false);
  });

  it('decrypts an encrypted source before converting, then seals', async () => {
    await registryHolds(await sealedV8Spec({ name: 'convertme', contacts: ['ops@example.com'] }));
    const createProvider = sinon.spy(flux.EncryptedSpecV8.prototype, 'createProvider');
    const decrypt = sinon.spy(flux.EncryptedSpecV8.prototype, 'decrypt');
    const frontend = await frontendRecipient();

    const result = await registryManager.convertApplicationSpecification('convertme', {
      recipientPubkeyBase64: frontend.pubkeyBase64,
    });

    sinon.assert.calledOnce(createProvider);
    sinon.assert.calledOnce(decrypt);
    // decrypt is handed the provider the spec itself minted — not some other one.
    expect(decrypt.firstCall.args[0]).to.equal(await createProvider.firstCall.returnValue);
    expect(result.encrypted).to.equal(true);
    expect(result.complete).to.equal(true);

    // fromLegacy converted the DECRYPTED spec: nothing but a real decrypt
    // produces the repotag that was sealed.
    const draft = await frontend.open(result.transportEncrypted, result);
    expect(draft.version).to.equal(9);
    expect(draft.components.web.image).to.equal('nginx:latest');
    expect(draft.owner).to.equal(V8_SUBMISSION.owner);
  });

  it('rejects an app that is already on spec version 9', async () => {
    await registryHolds(await v9Spec());

    let threw;
    try {
      await registryManager.convertApplicationSpecification('myapp', {});
    } catch (e) {
      threw = e;
    }

    expect(threw).to.be.an('error');
    expect(threw.message).to.include('already on spec version 9');
  });

  it('rejects an unknown app', async () => {
    sinon.stub(appsRepository, 'getGlobalAppInfo').resolves(null);

    let threw;
    try {
      await registryManager.convertApplicationSpecification('ghost', {});
    } catch (e) {
      threw = e;
    }

    expect(threw).to.be.an('error');
    expect(threw.message).to.include('not found');
  });
});
