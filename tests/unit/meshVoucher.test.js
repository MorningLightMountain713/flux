'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const crypto = require('node:crypto');

const meshVoucher = require('../../ZelBack/src/services/appMesh/meshVoucher');
const { loadSpecLibrary } = require('../../ZelBack/src/services/utils/specLibrary');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const daemonServiceBlockchainRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceBlockchainRpcs');

// The message vector pins the voucher byte layout forever: minter and every
// verifier across the fleet must build identical bytes from identical fields.
// Computed by an independent implementation (python) — if the assertion
// fails, the code is wrong; do not update the vector.
const MESH_CA = '-----BEGIN NEBULA CERTIFICATE-----\nZmFrZS1jYS1mb3ItdmVjdG9ycw==\n-----END NEBULA CERTIFICATE-----\n';
const FIELDS = {
  meshCa: MESH_CA,
  appUuid: '5db6f53acbbd9b38e949307e96601e573bd6437ddec08707e76a33f771b358ea',
  outpoint: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08:0',
  blockHash: '7413fd279058ad2088b061d719fbf59d90cd5e509a08ab0d11746b91d7c01c4c',
};
const GOLDEN_MESSAGE = 'AAAAYS0tLS0tQkVHSU4gTkVCVUxBIENFUlRJRklDQVRFLS0tLS0KWm1GclpTMWpZUzFtYjNJdGRtVmpkRzl5Y3c9PQotLS0tLUVORCBORUJVTEEgQ0VSVElGSUNBVEUtLS0tLQo'
  + 'AAABANWRiNmY1M2FjYmJkOWIzOGU5NDkzMDdlOTY2MDFlNTczYmQ2NDM3ZGRlYzA4NzA3ZTc2YTMzZjc3MWIzNThlYQ'
  + 'AAAEI5Zjg2ZDA4MTg4NGM3ZDY1OWEyZmVhYTBjNTVhZDAxNWEzYmY0ZjFiMmIwYjgyMmNkMTVkNmMxNWIwZjAwYTA4OjA'
  + 'AAABANzQxM2ZkMjc5MDU4YWQyMDg4YjA2MWQ3MTlmYmY1OWQ5MGNkNWU1MDlhMDhhYjBkMTE3NDZiOTFkN2MwMWM0Yw==';

describe('meshVoucher', () => {
  afterEach(() => sinon.restore());

  describe('buildVoucherMessage', () => {
    it('matches the golden vector', () => {
      expect(meshVoucher.buildVoucherMessage(FIELDS)).to.equal(GOLDEN_MESSAGE);
    });

    it('rejects malformed fields', () => {
      expect(() => meshVoucher.buildVoucherMessage({ ...FIELDS, meshCa: '' })).to.throw(TypeError);
      expect(() => meshVoucher.buildVoucherMessage({ ...FIELDS, appUuid: 'myblog' })).to.throw(TypeError);
      expect(() => meshVoucher.buildVoucherMessage({ ...FIELDS, outpoint: FIELDS.outpoint.toUpperCase() })).to.throw(TypeError);
      expect(() => meshVoucher.buildVoucherMessage({ ...FIELDS, blockHash: 'abc' })).to.throw(TypeError);
    });
  });

  describe('verifyVoucher', () => {
    // A locally minted keypair standing in for the mesh-purpose key: the
    // signer prepends the domain, so the test signs domain + message.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const meshKey = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    const signed = crypto.sign(
      null,
      Buffer.from(meshVoucher.VOUCHER_DOMAIN + GOLDEN_MESSAGE),
      privateKey,
    ).toString('base64');

    it('accepts a signature over the domain-prefixed message', () => {
      expect(meshVoucher.verifyVoucher(signed, FIELDS, meshKey)).to.equal(true);
    });

    it('rejects when any field differs from what was signed', () => {
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, appUuid: FIELDS.appUuid.replace('5', '6') }, meshKey)).to.equal(false);
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, outpoint: FIELDS.outpoint.replace(':0', ':1') }, meshKey)).to.equal(false);
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, blockHash: FIELDS.blockHash.replace('7', '8') }, meshKey)).to.equal(false);
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, meshCa: `${MESH_CA} ` }, meshKey)).to.equal(false);
    });

    it('rejects a signature under a different key', () => {
      const other = crypto.generateKeyPairSync('ed25519');
      const otherKey = new Uint8Array(other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
      expect(meshVoucher.verifyVoucher(signed, FIELDS, otherKey)).to.equal(false);
    });

    it('verifies against this chain\'s mesh key when none is given', async () => {
      const flux = await loadSpecLibrary();
      const chain = new flux.Chain({
        name: 'mesh-test', powBlockSeconds: 120, ponBlockSeconds: 30, ponActivationHeight: 2,
        attestationKeys: { mesh: Buffer.from(meshKey).toString('base64') },
      });
      const onChain = proxyquire('../../ZelBack/src/services/appMesh/meshVoucher', {
        '../utils/nodeChain': { nodeChain: () => chain },
      });
      expect(onChain.verifyVoucher(signed, FIELDS)).to.equal(true);
      expect(onChain.verifyVoucher(signed, { ...FIELDS, blockHash: FIELDS.blockHash.replace('7', '8') })).to.equal(false);
    });

    it('treats malformed fields or garbage signatures as invalid, never throws', () => {
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, appUuid: 'nope' }, meshKey)).to.equal(false);
      expect(meshVoucher.verifyVoucher('not-base64-!!!', FIELDS, meshKey)).to.equal(false);
    });
  });

  describe('mintVoucher', () => {
    it('asks the benchmark channel to sign under the mesh purpose', async () => {
      const attest = sinon.stub(benchmarkService, 'attest').resolves({
        status: 'success',
        data: JSON.stringify({ status: 'ok', signature: 'sig-b64' }),
      });
      const signature = await meshVoucher.mintVoucher(FIELDS);
      expect(signature).to.equal('sig-b64');
      expect(attest.firstCall.args[0]).to.deep.equal({ message: GOLDEN_MESSAGE, purpose: 'mesh' });
    });

    it('throws when the signer is unreachable', async () => {
      sinon.stub(benchmarkService, 'attest').resolves({ status: 'error', data: {} });
      try {
        await meshVoucher.mintVoucher(FIELDS);
        expect.fail('should throw');
      } catch (error) {
        expect(error.message).to.include('Could not reach');
      }
    });

    it('throws when the signer refuses, naming the refusal', async () => {
      sinon.stub(benchmarkService, 'attest').resolves({
        status: 'success',
        data: JSON.stringify({ status: 'error', message: 'UNKNOWN_PURPOSE' }),
      });
      try {
        await meshVoucher.mintVoucher(FIELDS);
        expect.fail('should throw');
      } catch (error) {
        expect(error.message).to.include('UNKNOWN_PURPOSE');
      }
    });
  });

  describe('fetchVoucherAnchor', () => {
    it('returns the tip height and hash', async () => {
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlockchainInfo').resolves({ value: { blocks: 2_843_890, bestblockhash: FIELDS.blockHash } });
      const anchor = await meshVoucher.fetchVoucherAnchor();
      expect(anchor).to.deep.equal({ height: 2_843_890, hash: FIELDS.blockHash });
    });

    it('throws when the daemon cannot provide a tip', async () => {
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlockchainInfo').resolves({ value: null, reason: {} });
      try {
        await meshVoucher.fetchVoucherAnchor();
        expect.fail('should throw');
      } catch (error) {
        expect(error.message).to.include('chain tip');
      }
    });
  });
});
