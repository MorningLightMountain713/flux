'use strict';

const chai = require('chai');
const sinon = require('sinon');
const bitcoinMessage = require('bitcoinjs-message');

const signatureVerifier = require('../../ZelBack/src/services/signatureVerifier');
const ethereumHelper = require('../../ZelBack/src/services/ethereumHelper');
const { getSpecBackend } = require('../../ZelBack/src/services/utils/specLibs');

const { expect } = chai;

const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const bytes32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const LOW_S = bytes32(1n);
const HIGH_S = bytes32(N - 1n);

const btcSig = (header, s = LOW_S) => Buffer.concat([Buffer.from([header]), LOW_S, s]).toString('base64');
const ethSig = (v, s = LOW_S) => `0x${Buffer.concat([LOW_S, s, Buffer.from([v])]).toString('hex')}`;

const BTC_ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ETH_ADDRESS = '0x0000000000000000000000000000000000000001';

describe('signatureVerifier canonical-form gate', () => {
  // The gate runs before the underlying library, so these stub the library to
  // report success. Anything still rejected was rejected by the gate — and
  // anything accepted proves the gate does not over-reject a well-formed
  // signature. Real end-to-end verification is covered in flux-spec's suite.
  let btcStub;
  let ethStub;

  before(async () => {
    // Warm the CJS bridge: its first call dynamically imports the ESM packages.
    await getSpecBackend();
  });

  beforeEach(() => {
    btcStub = sinon.stub(bitcoinMessage, 'verify').returns(true);
    ethStub = sinon.stub(ethereumHelper, 'recoverSigner').returns(ETH_ADDRESS);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('bitcoin', () => {
    it('accepts a canonical compressed-P2PKH signature', async () => {
      expect(await signatureVerifier.verifySignature('msg', BTC_ADDRESS, btcSig(31))).to.equal(true);
      sinon.assert.calledOnce(btcStub);
    });

    it('accepts an uncompressed-P2PKH header', async () => {
      expect(await signatureVerifier.verifySignature('msg', BTC_ADDRESS, btcSig(27))).to.equal(true);
    });

    it('rejects the high-S twin without consulting the library', async () => {
      expect(await signatureVerifier.verifySignature('msg', BTC_ADDRESS, btcSig(31, HIGH_S)))
        .to.equal(false);
      sinon.assert.notCalled(btcStub);
    });

    it('rejects segwit header bytes', async () => {
      for (const header of [35, 36, 37, 38, 39, 40, 41, 42]) {
        // eslint-disable-next-line no-await-in-loop
        const valid = await signatureVerifier.verifySignature('msg', BTC_ADDRESS, btcSig(header));
        expect(valid, `header ${header}`).to.equal(false);
      }
      sinon.assert.notCalled(btcStub);
    });

    it('rejects a signature that is not 65 bytes', async () => {
      expect(await signatureVerifier.verifySignature('msg', BTC_ADDRESS, '1234356asdf')).to.equal(false);
      sinon.assert.notCalled(btcStub);
    });
  });

  describe('ethereum', () => {
    it('accepts a canonical signature', async () => {
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(27))).to.equal(true);
      sinon.assert.calledOnce(ethStub);
    });

    it('rejects the bare 0/1 spelling of v', async () => {
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(0))).to.equal(false);
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(1))).to.equal(false);
      sinon.assert.notCalled(ethStub);
    });

    it('rejects the high-S twin', async () => {
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(27, HIGH_S)))
        .to.equal(false);
      sinon.assert.notCalled(ethStub);
    });
  });

  describe('the replay door', () => {
    // Canonical form is a rule about ADMITTING a message. A message the chain
    // already carries is replayed, and seven on chain carry the bare 0/1
    // spelling of v — a node that refuses them cannot sync. On that path the
    // gate does not run and the underlying libraries decide, which is exactly
    // what the network ran on before the rule existed.
    const REPLAY = { allowLegacyEncoding: true };

    it('lets the bare 0/1 spelling of v reach the library', async () => {
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(0), REPLAY)).to.equal(true);
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(1), REPLAY)).to.equal(true);
      sinon.assert.calledTwice(ethStub);
    });

    it('lets the high-S twin reach the library, on either curve', async () => {
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(27, HIGH_S), REPLAY)).to.equal(true);
      expect(await signatureVerifier.verifySignature('msg', BTC_ADDRESS, btcSig(31, HIGH_S), REPLAY)).to.equal(true);
      sinon.assert.calledOnce(ethStub);
      sinon.assert.calledOnce(btcStub);
    });

    it('does not decide the answer itself — the signer still has to be right', async () => {
      // The property leniency must not touch. It widens how a signature may be
      // spelled, never whose it is.
      ethStub.returns('0x00000000000000000000000000000000000000ff');
      btcStub.returns(false);
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(0), REPLAY)).to.equal(false);
      expect(await signatureVerifier.verifySignature('msg', BTC_ADDRESS, btcSig(31), REPLAY)).to.equal(false);
    });

    it('is opt-in: the same signatures are refused at the ingress door', async () => {
      expect(await signatureVerifier.verifySignature('msg', ETH_ADDRESS, ethSig(0))).to.equal(false);
      expect(await signatureVerifier.verifySignature('msg', BTC_ADDRESS, btcSig(31, HIGH_S))).to.equal(false);
      sinon.assert.notCalled(ethStub);
      sinon.assert.notCalled(btcStub);
    });
  });

  describe('missing parameters', () => {
    it('rejects empty inputs without consulting either library', async () => {
      expect(await signatureVerifier.verifySignature('', '', '')).to.equal(false);
      expect(await signatureVerifier.verifySignature(null, null, null)).to.equal(false);
      sinon.assert.notCalled(btcStub);
      sinon.assert.notCalled(ethStub);
    });
  });
});
