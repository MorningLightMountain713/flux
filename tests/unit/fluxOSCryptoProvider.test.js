'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('FluxOSCryptoProvider', () => {
  // Any non-empty AAD; what it contains is EncryptedSpecV9's business, not this
  // provider's. That it is always present is this provider's business.
  const AAD = Buffer.from('aad-bytes');

  let benchmarkServiceStub;
  let specLibsStub;
  let fluxOSCryptoProvider;

  // Minimal abstract base class stubbed in place of the real
  // @runonflux/flux-spec-backend CryptoProvider. Concrete subclass must
  // define encrypt/decrypt; instanceof checks pass through.
  class MockCryptoProviderBase {
    constructor() {
      if (new.target === MockCryptoProviderBase) {
        throw new Error('abstract');
      }
    }
  }

  beforeEach(() => {
    benchmarkServiceStub = {
      seal: sinon.stub(),
      unseal: sinon.stub(),
    };

    specLibsStub = {
      getSpecBackend: sinon.stub().resolves({ CryptoProvider: MockCryptoProviderBase }),
    };

    fluxOSCryptoProvider = proxyquire(
      '../../ZelBack/src/services/providers/FluxOSCryptoProvider',
      {
        '../benchmarkService': benchmarkServiceStub,
        '../utils/specLibs': specLibsStub,
      },
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('create()', () => {
    it('returns an instance of the CryptoProvider base class', async () => {
      const provider = await fluxOSCryptoProvider.create('testapp', 'owner123');
      expect(provider).to.be.instanceOf(MockCryptoProviderBase);
      expect(typeof provider.encrypt).to.equal('function');
      expect(typeof provider.decrypt).to.equal('function');
    });

    it('loads the base class lazily via specLibs', async () => {
      expect(specLibsStub.getSpecBackend.called).to.be.false;
      await fluxOSCryptoProvider.create('testapp', 'owner123');
      expect(specLibsStub.getSpecBackend.calledOnce).to.be.true;
    });
  });

  describe('encrypt()', () => {
    it('forwards appName, fluxID, and base64-encoded message to seal', async () => {
      benchmarkServiceStub.seal.resolves({
        status: 'success',
        data: {
          status: 'ok',
          algorithm: 'AES-256-GCM',
          ciphertext: 'Y2lwaGVy',
          nonce: 'bm9uY2U=',
          tag: 'dGFn',
        },
      });

      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');
      const result = await provider.encrypt(Buffer.from('hello'), Buffer.from('metadata'));

      expect(benchmarkServiceStub.seal.calledOnce).to.be.true;
      const params = benchmarkServiceStub.seal.firstCall.args[0];
      expect(params.appName).to.equal('TestApp');
      expect(params.fluxID).to.equal('1abc');
      expect(params.message).to.equal(Buffer.from('hello').toString('base64'));
      expect(params.aad).to.equal(Buffer.from('metadata').toString('base64'));

      expect(result).to.deep.equal({
        algorithm: 'AES-256-GCM',
        ciphertext: 'Y2lwaGVy',
        nonce: 'bm9uY2U=',
        tag: 'dGFn',
      });
    });

    // The AAD authenticates a v9 container's cleartext half — its name, owner,
    // ttl, placement and the resource summary other nodes schedule on without
    // decrypting. Forwarding it only `if (aad)` made a caller's omission look
    // like a spec that legitimately has none, and the benchmark channel then
    // sealed with no binding and answered ok.
    it('refuses to seal without an aad, rather than sealing an unbound container', async () => {
      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');

      await expect(provider.encrypt(Buffer.from('hello')))
        .to.be.rejectedWith(/sealed under an AAD/);
      expect(benchmarkServiceStub.seal.called, 'nothing should have reached the daemon')
        .to.equal(false);
    });

    it('refuses an empty aad, which binds nothing', async () => {
      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');

      await expect(provider.encrypt(Buffer.from('hello'), Buffer.alloc(0)))
        .to.be.rejectedWith(/sealed under an AAD/);
      expect(benchmarkServiceStub.seal.called).to.equal(false);
    });

    it('throws when the RPC call itself fails', async () => {
      benchmarkServiceStub.seal.resolves({ status: 'error' });
      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');

      await expect(provider.encrypt(Buffer.from('hello'), AAD))
        .to.be.rejectedWith(/seal RPC failed/);
    });

    it('throws when the backend rejects the seal request', async () => {
      benchmarkServiceStub.seal.resolves({
        status: 'success',
        data: { status: 'bad_request' },
      });
      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');

      await expect(provider.encrypt(Buffer.from('hello'), AAD))
        .to.be.rejectedWith(/seal RPC rejected: bad_request/);
    });

    it('parses stringified data payloads from the RPC', async () => {
      benchmarkServiceStub.seal.resolves({
        status: 'success',
        data: JSON.stringify({
          status: 'ok',
          algorithm: 'AES-256-GCM',
          ciphertext: 'Y2lwaGVy',
          nonce: 'bm9uY2U=',
          tag: 'dGFn',
        }),
      });

      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');
      const result = await provider.encrypt(Buffer.from('hello'), AAD);
      expect(result.ciphertext).to.equal('Y2lwaGVy');
    });
  });

  describe('decrypt()', () => {
    it('forwards the full encrypted envelope plus aad to unseal', async () => {
      benchmarkServiceStub.unseal.resolves({
        status: 'success',
        data: { status: 'ok', message: Buffer.from('hello').toString('base64') },
      });

      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');
      const encrypted = {
        algorithm: 'AES-256-GCM',
        ciphertext: 'Y2lwaGVy',
        nonce: 'bm9uY2U=',
        tag: 'dGFn',
      };
      const plaintext = await provider.decrypt(encrypted, Buffer.from('metadata'));

      expect(plaintext.toString()).to.equal('hello');
      const params = benchmarkServiceStub.unseal.firstCall.args[0];
      expect(params.appName).to.equal('TestApp');
      expect(params.fluxID).to.equal('1abc');
      expect(params.ciphertext).to.equal('Y2lwaGVy');
      expect(params.nonce).to.equal('bm9uY2U=');
      expect(params.tag).to.equal('dGFn');
      expect(params.aad).to.equal(Buffer.from('metadata').toString('base64'));
    });

    it('refuses to unseal without an aad', async () => {
      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');

      await expect(provider.decrypt({ ciphertext: 'x', nonce: 'y', tag: 'z' }))
        .to.be.rejectedWith(/sealed under an AAD/);
      expect(benchmarkServiceStub.unseal.called).to.equal(false);
    });

    it('throws when the backend rejects the unseal request', async () => {
      benchmarkServiceStub.unseal.resolves({
        status: 'success',
        data: { status: 'DECRYPT_FAILED' },
      });
      const provider = await fluxOSCryptoProvider.create('TestApp', '1abc');

      await expect(provider.decrypt({
        algorithm: 'AES-256-GCM', ciphertext: 'x', nonce: 'y', tag: 'z',
      }, AAD)).to.be.rejectedWith(/unseal RPC rejected: DECRYPT_FAILED/);
    });
  });
});
