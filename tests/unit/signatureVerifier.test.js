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

describe('signatureVerifier tests', () => {
  describe('isValidSigningIdentity tests', () => {
    it('should accept a Flux ID', () => {
      expect(signatureVerifier.isValidSigningIdentity('1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg')).to.equal(true);
    });

    it('should accept an ethereum address', () => {
      expect(signatureVerifier.isValidSigningIdentity('0x2b8e7f6e8f0b6f4c6f8e2b8e7f6e8f0b6f4c6f8e')).to.equal(true);
    });

    it('should reject an arbitrary string', () => {
      expect(signatureVerifier.isValidSigningIdentity('TrippleCore')).to.equal(false);
    });

    it('should reject a Flux ID whose checksum does not hold', () => {
      expect(signatureVerifier.isValidSigningIdentity('1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEh')).to.equal(false);
    });

    it('should reject a Flux ID carrying characters outside the base58 alphabet', () => {
      expect(signatureVerifier.isValidSigningIdentity('1Jwh4djGdRPvgLwXNGsGC0PE7uu4vihbEg')).to.equal(false);
    });

    it('should reject an address that is too short or too long', () => {
      expect(signatureVerifier.isValidSigningIdentity('1Jwh4djGdRPvg')).to.equal(false);
      expect(signatureVerifier.isValidSigningIdentity('1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEgZ12')).to.equal(false);
    });

    it('should reject an ethereum address of the wrong width', () => {
      expect(signatureVerifier.isValidSigningIdentity('0x2b8e7f6e8f0b6f4c6f8e2b8e7f6e8f0b6f4c6f')).to.equal(false);
    });

    it('should reject a public key, which verifySignature accepts but no login can hold', () => {
      expect(signatureVerifier.isValidSigningIdentity('04a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd5b8dec5235a0fa8722476c7709c02559e3aa73aa03918ba2d492eea75abea235')).to.equal(false);
    });

    it('should reject empty and non string input', () => {
      expect(signatureVerifier.isValidSigningIdentity('')).to.equal(false);
      expect(signatureVerifier.isValidSigningIdentity(undefined)).to.equal(false);
      expect(signatureVerifier.isValidSigningIdentity(null)).to.equal(false);
      expect(signatureVerifier.isValidSigningIdentity(12_345)).to.equal(false);
    });
  });
  describe('includesSigningIdentity tests', () => {
    const FLUX_ID = '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg';
    const ETH = '0x2b8E7f6e8F0b6F4c6F8e2B8e7F6e8f0B6f4C6f8E';

    // A LIST OF IDENTITIES IS A SET OF SIGNERS, so membership asks the same question
    // sameSigningIdentity does. Asked as an exact match, an owner who writes their own
    // address in the other valid capitalisation is a stranger to every list while still
    // signing as themselves.
    it('finds an ethereum owner listed in the other capitalisation', () => {
      expect(signatureVerifier.includesSigningIdentity([ETH], ETH.toLowerCase())).to.equal(true);
      expect(signatureVerifier.includesSigningIdentity([ETH.toLowerCase()], ETH)).to.equal(true);
    });

    it('keeps case significant for a Flux ID, which is base58', () => {
      expect(signatureVerifier.includesSigningIdentity([FLUX_ID], FLUX_ID)).to.equal(true);
      expect(signatureVerifier.includesSigningIdentity([FLUX_ID], FLUX_ID.toLowerCase())).to.equal(false);
    });

    it('does not find an identity the list does not hold', () => {
      expect(signatureVerifier.includesSigningIdentity([FLUX_ID], ETH)).to.equal(false);
      expect(signatureVerifier.includesSigningIdentity([], ETH)).to.equal(false);
    });

    // Callers grant a privilege on a true, so anything it cannot read is a false.
    it('answers false for a list that is not one', () => {
      [null, undefined, 'not-a-list', 12345].forEach((notAList) => {
        expect(signatureVerifier.includesSigningIdentity(notAList, ETH)).to.equal(false);
      });
    });
  });

  describe('sameSigningIdentity tests', () => {
    const FLUX_ID = '1Jwh4djGdRPvgLwXNGsGCoPE7uu4vihbEg';
    const ETH = '0x2b8E7f6e8F0b6F4c6F8e2B8e7F6e8f0B6f4C6f8E';

    it('should treat an ethereum address as the same whatever its capitalisation', () => {
      // EIP-55 capitalisation is a checksum over the same 20 bytes, and verifySignature
      // compares recovered addresses this way for that reason.
      expect(signatureVerifier.sameSigningIdentity(ETH, ETH.toLowerCase())).to.equal(true);
      expect(signatureVerifier.sameSigningIdentity(ETH.toLowerCase(), ETH.toUpperCase().replace('0X', '0x'))).to.equal(true);
    });

    it('should treat case as part of a Flux ID, which is base58', () => {
      expect(signatureVerifier.sameSigningIdentity(FLUX_ID, FLUX_ID)).to.equal(true);
      expect(signatureVerifier.sameSigningIdentity(FLUX_ID, FLUX_ID.toLowerCase())).to.equal(false);
    });

    it('should not match two different identities', () => {
      expect(signatureVerifier.sameSigningIdentity(FLUX_ID, '1GM41a9A4rH8CCkCyzDRahHUccuTRLhoDe')).to.equal(false);
      expect(signatureVerifier.sameSigningIdentity(ETH, '0x0000000000000000000000000000000000000001')).to.equal(false);
    });

    it('should not match across identity kinds', () => {
      expect(signatureVerifier.sameSigningIdentity(FLUX_ID, ETH)).to.equal(false);
    });

    it('should answer false for anything missing, since callers grant on a true', () => {
      [['', ''], [FLUX_ID, ''], [undefined, undefined], [null, FLUX_ID], [FLUX_ID, 12345]]
        .forEach(([a, b]) => expect(signatureVerifier.sameSigningIdentity(a, b), `${a} ${b}`).to.equal(false));
    });
  });
});
