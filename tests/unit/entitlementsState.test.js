'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('entitlementsState', () => {
  let entitlementsState;
  let dbHelperStub;
  let bs58checkStub;
  let checkStub;
  let historyInstance;
  let logStub;

  // Fake spec-policy classes captured per-test so assertions can inspect them.
  function makePolicy() {
    historyInstance = {
      added: [],
      removedAt: [],
      add(message, height) { this.added.push({ message, height }); },
      removeAtHeight(height) { this.removedAt.push(height); },
      resolveFluxidGroups() { return new Set([0]); },
    };
    class PolicyGroupHistory {
      constructor() { return historyInstance; }
    }
    class FeatureEntitlements {
      constructor({ groupHistory }) { this.groupHistory = groupHistory; }

      check(...args) { return checkStub(...args); }
    }
    return { PolicyGroupHistory, FeatureEntitlements };
  }

  beforeEach(() => {
    checkStub = sinon.stub().returns({ allowed: true });
    dbHelperStub = {
      databaseConnection: sinon.stub().returns({ db: sinon.stub().returns('chainparamsDB') }),
      findInDatabase: sinon.stub().resolves([]),
    };
    bs58checkStub = { decode: sinon.stub().returns(Buffer.from('00112233445566778899aabbccddeeff00112233', 'hex')) };
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    entitlementsState = proxyquire('../../ZelBack/src/services/entitlementsState', {
      bs58check: bs58checkStub,
      './dbHelper': dbHelperStub,
      '../lib/log': logStub,
      './utils/specLibs': { getSpecPolicy: async () => makePolicy() },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('assertSpecEntitled', () => {
    const spec = { toCanonical: () => ({ version: 9 }) };

    it('fails open (no throw) when the policy state has not been built', async () => {
      await entitlementsState.assertSpecEntitled(spec, 'owner', 100);
      sinon.assert.notCalled(checkStub);
    });

    it('passes when the entitlement check allows the spec', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      checkStub.returns({ allowed: true });
      await entitlementsState.assertSpecEntitled(spec, 'owner', 100);
      sinon.assert.calledOnce(checkStub);
    });

    it('throws FEATURE_NOT_ENTITLED when the check denies a gated feature', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      checkStub.returns({ allowed: false, missing: ['networkSharing'], reason: 'fluxid not entitled to use: networkSharing' });
      try {
        await entitlementsState.assertSpecEntitled(spec, 'owner', 100);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.code).to.equal('FEATURE_NOT_ENTITLED');
        expect(err.message).to.match(/networkSharing/);
      }
    });

    it('throws when the owner address cannot be decoded to a fluxid', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      bs58checkStub.decode.throws(new Error('bad checksum'));
      await expect(entitlementsState.assertSpecEntitled(spec, 'not-an-address', 100))
        .to.be.rejectedWith(/not a valid fluxid/);
    });

    it('resolves entitlements at the supplied height', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      await entitlementsState.assertSpecEntitled(spec, 'owner', 4242);
      expect(checkStub.firstCall.args[2]).to.equal(4242);
    });
  });

  describe('rebuildPolicyGroupState', () => {
    it('replays persisted messages into the history in height order and restores fluxid bytes', async () => {
      dbHelperStub.findInDatabase.resolves([
        { height: 20, message: { subtype: 'membership', fluxids: [{ bytes: Buffer.from([1, 2, 3]) }] } },
        { height: 10, message: { subtype: 'definition', groupId: 0, bitmap: 1 } },
      ]);

      await entitlementsState.rebuildPolicyGroupState();

      expect(historyInstance.added.map((a) => a.height)).to.eql([10, 20]);
      const membership = historyInstance.added.find((a) => a.message.subtype === 'membership');
      expect(membership.message.fluxids[0].bytes).to.be.instanceOf(Uint8Array);
    });
  });

  describe('removeAtHeight', () => {
    it('delegates to the history when built', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      entitlementsState.removeAtHeight(500);
      expect(historyInstance.removedAt).to.eql([500]);
    });

    it('is a no-op when the state has not been built', () => {
      expect(() => entitlementsState.removeAtHeight(500)).to.not.throw();
    });
  });
});
