const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('node:crypto');

const meshVoucher = require('../../ZelBack/src/services/appMesh/meshVoucher');
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
    const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const signed = crypto.sign(
      null,
      Buffer.from(meshVoucher.VOUCHER_DOMAIN + GOLDEN_MESSAGE),
      privateKey,
    ).toString('base64');

    it('accepts a signature over the domain-prefixed message', () => {
      expect(meshVoucher.verifyVoucher(signed, FIELDS, publicKeyB64)).to.equal(true);
    });

    it('rejects when any field differs from what was signed', () => {
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, appUuid: FIELDS.appUuid.replace('5', '6') }, publicKeyB64)).to.equal(false);
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, outpoint: FIELDS.outpoint.replace(':0', ':1') }, publicKeyB64)).to.equal(false);
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, blockHash: FIELDS.blockHash.replace('7', '8') }, publicKeyB64)).to.equal(false);
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, meshCa: `${MESH_CA} ` }, publicKeyB64)).to.equal(false);
    });

    it('rejects a signature under a different key', () => {
      const other = crypto.generateKeyPairSync('ed25519');
      const otherB64 = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
      expect(meshVoucher.verifyVoucher(signed, FIELDS, otherB64)).to.equal(false);
    });

    it('treats malformed fields or garbage signatures as invalid, never throws', () => {
      expect(meshVoucher.verifyVoucher(signed, { ...FIELDS, appUuid: 'nope' }, publicKeyB64)).to.equal(false);
      expect(meshVoucher.verifyVoucher('not-base64-!!!', FIELDS, publicKeyB64)).to.equal(false);
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
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlockchainInfo').resolves({
        status: 'success',
        data: { blocks: 2843890, bestblockhash: FIELDS.blockHash },
      });
      const anchor = await meshVoucher.fetchVoucherAnchor();
      expect(anchor).to.deep.equal({ height: 2843890, hash: FIELDS.blockHash });
    });

    it('throws when the daemon cannot provide a tip', async () => {
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlockchainInfo').resolves({ status: 'error', data: {} });
      try {
        await meshVoucher.fetchVoucherAnchor();
        expect.fail('should throw');
      } catch (error) {
        expect(error.message).to.include('chain tip');
      }
    });
  });
});
