'use strict';

const crypto = require('crypto');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('FluxOSLegacyCryptoProvider', () => {
  let benchmarkServiceStub;
  let specLibsStub;
  let fluxOSLegacyCryptoProvider;

  class MockCryptoProviderBase {
    constructor() {
      if (new.target === MockCryptoProviderBase) {
        throw new Error('abstract');
      }
    }
  }

  beforeEach(() => {
    benchmarkServiceStub = {
      decryptRSAMessage: sinon.stub(),
      encryptMessage: sinon.stub(),
    };

    specLibsStub = {
      getSpecBackend: sinon.stub().resolves({ CryptoProvider: MockCryptoProviderBase }),
    };

    fluxOSLegacyCryptoProvider = proxyquire(
      '../../ZelBack/src/services/providers/FluxOSLegacyCryptoProvider',
      {
        '../benchmarkService': benchmarkServiceStub,
        '../utils/specLibs': specLibsStub,
      },
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  // Build a well-formed v8 enterprise blob for a given AES key + plaintext.
  // Produces the on-chain layout: [256B wrapped key placeholder || 12B nonce || ct || 16B tag].
  function buildBlob(aesKey, plaintext, wrappedKeyBytes) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedKey = wrappedKeyBytes || crypto.randomBytes(256);
    return {
      blob: Buffer.concat([wrappedKey, nonce, ciphertext, tag]).toString('base64'),
      wrappedKey,
      aesKey,
    };
  }

  describe('create()', () => {
    it('returns an instance of the CryptoProvider base class', async () => {
      const provider = await fluxOSLegacyCryptoProvider.create('testapp', 'owner123');
      expect(provider).to.be.instanceOf(MockCryptoProviderBase);
      expect(typeof provider.encrypt).to.equal('function');
      expect(typeof provider.decrypt).to.equal('function');
    });

    it('loads the base class lazily via specLibs', async () => {
      expect(specLibsStub.getSpecBackend.called).to.be.false;
      await fluxOSLegacyCryptoProvider.create('testapp', 'owner123');
      expect(specLibsStub.getSpecBackend.calledOnce).to.be.true;
    });
  });

  describe('decrypt()', () => {
    it('unwraps the AES key via decryptRSAMessage and GCM-decrypts the tail', async () => {
      const aesKey = crypto.randomBytes(32);
      const plaintext = Buffer.from(JSON.stringify({ compose: [{ name: 'w' }], contacts: [] }));
      const { blob } = buildBlob(aesKey, plaintext);

      benchmarkServiceStub.decryptRSAMessage.resolves({
        status: 'success',
        data: { status: 'ok', message: aesKey.toString('base64') },
      });

      const provider = await fluxOSLegacyCryptoProvider.create('TestApp', '1abc');
      const result = await provider.decrypt({ algorithm: 'AES-256-GCM', ciphertext: blob });

      expect(result).to.be.instanceOf(Buffer);
      expect(result.toString('utf8')).to.equal(plaintext.toString('utf8'));

      const [inputJson] = benchmarkServiceStub.decryptRSAMessage.firstCall.args;
      const input = JSON.parse(inputJson);
      expect(input.appName).to.equal('TestApp');
      expect(input.fluxID).to.equal('1abc');
      expect(input.blockHeight).to.equal(0);
      expect(input.message).to.be.a('string');
      expect(Buffer.from(input.message, 'base64').length).to.equal(256);
    });

    it('accepts a stringified RPC data payload', async () => {
      const aesKey = crypto.randomBytes(32);
      const plaintext = Buffer.from('hello');
      const { blob } = buildBlob(aesKey, plaintext);

      benchmarkServiceStub.decryptRSAMessage.resolves({
        status: 'success',
        data: JSON.stringify({ status: 'ok', message: aesKey.toString('base64') }),
      });

      const provider = await fluxOSLegacyCryptoProvider.create('A', 'o');
      const result = await provider.decrypt({ algorithm: 'AES-256-GCM', ciphertext: blob });
      expect(result.toString('utf8')).to.equal('hello');
    });

    it('rejects a blob shorter than the minimum layout', async () => {
      const short = Buffer.alloc(100).toString('base64'); // < 256+12+16
      const provider = await fluxOSLegacyCryptoProvider.create('A', 'o');
      await expect(provider.decrypt({ algorithm: 'AES-256-GCM', ciphertext: short }))
        .to.be.rejectedWith(/shorter than minimum/);
      expect(benchmarkServiceStub.decryptRSAMessage.called).to.be.false;
    });

    it('throws when the RPC call itself fails', async () => {
      const { blob } = buildBlob(crypto.randomBytes(32), Buffer.from('x'));
      benchmarkServiceStub.decryptRSAMessage.resolves({ status: 'error' });

      const provider = await fluxOSLegacyCryptoProvider.create('A', 'o');
      await expect(provider.decrypt({ algorithm: 'AES-256-GCM', ciphertext: blob }))
        .to.be.rejectedWith(/decryptRSAMessage RPC failed/);
    });

    it('throws when fluxbenchd rejects the RSA unwrap', async () => {
      const { blob } = buildBlob(crypto.randomBytes(32), Buffer.from('x'));
      benchmarkServiceStub.decryptRSAMessage.resolves({
        status: 'success',
        data: { status: 'RSA_DECRYPT_FAILED' },
      });

      const provider = await fluxOSLegacyCryptoProvider.create('A', 'o');
      await expect(provider.decrypt({ algorithm: 'AES-256-GCM', ciphertext: blob }))
        .to.be.rejectedWith(/decryptRSAMessage RPC rejected: RSA_DECRYPT_FAILED/);
    });

    it('fails GCM auth when the ciphertext is tampered', async () => {
      const aesKey = crypto.randomBytes(32);
      const plaintext = Buffer.from('hello');
      const { blob } = buildBlob(aesKey, plaintext);
      const tampered = Buffer.from(blob, 'base64');
      // Flip a ciphertext byte (skip past 256-byte wrapped key + 12-byte nonce).
      tampered[256 + 12] ^= 0xff;

      benchmarkServiceStub.decryptRSAMessage.resolves({
        status: 'success',
        data: { status: 'ok', message: aesKey.toString('base64') },
      });

      const provider = await fluxOSLegacyCryptoProvider.create('A', 'o');
      await expect(provider.decrypt({ algorithm: 'AES-256-GCM', ciphertext: tampered.toString('base64') }))
        .to.be.rejected;
    });
  });

  describe('encrypt()', () => {
    it('forwards fluxID/appName and base64 plaintext to encryptMessage', async () => {
      benchmarkServiceStub.encryptMessage.resolves({
        status: 'success',
        data: { status: 'ok', message: 'encrypted-blob-base64' },
      });

      const provider = await fluxOSLegacyCryptoProvider.create('TestApp', '1abc');
      const result = await provider.encrypt(Buffer.from('hello'));

      expect(benchmarkServiceStub.encryptMessage.calledOnce).to.be.true;
      const [inputJson] = benchmarkServiceStub.encryptMessage.firstCall.args;
      const input = JSON.parse(inputJson);
      expect(input.appName).to.equal('TestApp');
      expect(input.fluxID).to.equal('1abc');
      expect(input.blockHeight).to.equal(0);
      expect(input.message).to.equal(Buffer.from('hello').toString('base64'));

      expect(result).to.deep.equal({
        algorithm: 'AES-256-GCM',
        ciphertext: 'encrypted-blob-base64',
      });
    });

    it('throws when the RPC call itself fails', async () => {
      benchmarkServiceStub.encryptMessage.resolves({ status: 'error' });
      const provider = await fluxOSLegacyCryptoProvider.create('A', 'o');
      await expect(provider.encrypt(Buffer.from('hello')))
        .to.be.rejectedWith(/encryptMessage RPC failed/);
    });

    it('throws when fluxbenchd rejects the encrypt request', async () => {
      benchmarkServiceStub.encryptMessage.resolves({
        status: 'success',
        data: { status: 'bad_request' },
      });
      const provider = await fluxOSLegacyCryptoProvider.create('A', 'o');
      await expect(provider.encrypt(Buffer.from('hello')))
        .to.be.rejectedWith(/encryptMessage RPC rejected: bad_request/);
    });
  });

  it('exports layout constants used by the v8 blob format', () => {
    expect(fluxOSLegacyCryptoProvider.RSA_WRAPPED_KEY_BYTES).to.equal(256);
    expect(fluxOSLegacyCryptoProvider.GCM_NONCE_BYTES).to.equal(12);
    expect(fluxOSLegacyCryptoProvider.GCM_TAG_BYTES).to.equal(16);
  });
});
