'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { Binary } = require('mongodb');
const {
  loadSpecLibrary, V9_SUBMISSION, V8_SUBMISSION, v9Spec,
} = require('./fixtures/fluxSpec');

chai.use(chaiAsPromised);
const { expect } = chai;

// Nothing about entitlements is stubbed here: the specs are real
// FluxAppSpecV9 instances, the policy classes are flux-spec's own
// PolicyGroupHistory and FeatureEntitlements, and the on-chain messages are
// produced by the real encoder and read back through the real parser. What
// stays stubbed is I/O — mongo and the logger.
//
// The hand-written policy double this replaced could not fail: its `check`
// was a sinon stub returning whatever the test wanted, so the gate's answer
// was the test's own answer. Feature detection, the grant bitmap, the
// soft-fork effective depth and the fluxid keying were all invisible to it.
describe('entitlementsState', () => {
  let flux;
  let entitlementsState;
  let dbHelperStub;
  let logStub;
  let docs;
  let checkSpy;
  let addSpy;

  // Real, distinct P2PKH owners — the fluxid is derived from the address, so a
  // membership grant to one must not reach the other.
  const OWNER = V9_SUBMISSION.owner;
  const OTHER_OWNER = V8_SUBMISSION.owner;

  const GRANT_HEIGHT = 1000;
  const MEMBER_GROUP = 7;
  let effectiveHeight;

  // Specs with and without a gated feature. `mesh` has a feature bit and no
  // parent or host requirement, and a cleartext v9 may carry it — it is in
  // ARCANE_REQUIRING_FIELDS (a placement constraint) but not in
  // ENCRYPTION_FORCING_FIELDS, so it builds without being sealed.
  let ungatedSpec;
  let gatedSpec;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
    ungatedSpec = await v9Spec();
    gatedSpec = await v9Spec({ network: { mesh: true } });
    effectiveHeight = GRANT_HEIGHT + flux.SOFT_FORK_EFFECTIVE_DEPTH;
  });

  /** A stored policy-group definition, encoded and parsed the way the chain does. */
  function definitionDoc({
    height = GRANT_HEIGHT, groupId = 0, features, action = 'upsert',
  }) {
    return {
      height,
      message: flux.PolicyGroupMessage.parse(
        flux.PolicyGroupMessage.encodeDefinition({
          groupId, bitmap: flux.encodeGrantBitmap(features), action,
        }),
      ),
    };
  }

  /**
   * A stored membership message. The fluxid bytes are wrapped in a BSON Binary,
   * because that is what the mongo driver hands back for a stored Uint8Array —
   * and a Binary is neither a Uint8Array nor a Buffer, so the history would key
   * the membership under an empty hex string without the restore step.
   */
  function membershipDoc({
    height = GRANT_HEIGHT, groupId = MEMBER_GROUP, owner = OWNER, action = 'upsert',
  }) {
    const message = flux.PolicyGroupMessage.parse(
      flux.PolicyGroupMessage.encodeMembership({
        groupId,
        fluxids: [flux.PolicyGroupMessage.encodeFluxid(owner)],
        action,
      }),
    );
    for (const fluxid of message.fluxids) {
      fluxid.bytes = new Binary(Buffer.from(fluxid.bytes));
    }
    return { height, message };
  }

  beforeEach(() => {
    docs = [];
    dbHelperStub = {
      databaseConnection: sinon.stub().returns({ db: sinon.stub().returns('chainparamsDB') }),
      findInDatabase: sinon.stub().callsFake(async () => docs),
    };
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    // Spies, not stubs: the real methods still run, so what the gate answers is
    // the library's answer and not the test's.
    checkSpy = sinon.spy(flux.FeatureEntitlements.prototype, 'check');
    addSpy = sinon.spy(flux.PolicyGroupHistory.prototype, 'add');

    entitlementsState = proxyquire('../../ZelBack/src/services/entitlementsState', {
      './dbHelper': dbHelperStub,
      '../lib/log': logStub,
      './utils/specLibs': { getSpecPolicy: async () => flux },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('assertSpecEntitled', () => {
    it('fails open (no throw) when the policy state has not been built', async () => {
      await entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight);
      sinon.assert.notCalled(checkSpy);
    });

    it('passes a spec that uses no gated feature, with no grants on chain', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      await entitlementsState.assertSpecEntitled(ungatedSpec, OWNER, effectiveHeight);
      sinon.assert.calledOnce(checkSpy);
      expect(checkSpy.firstCall.returnValue.allowed).to.equal(true);
    });

    // The gate is handed the spec object, and reaches its feature set through
    // toCanonical(). Pin that delegation: the canonical body the real resolver
    // walked has to be the one the spec produces, or the gate is reading
    // something else.
    it('hands the real check the spec\'s own canonical body', async () => {
      docs = [definitionDoc({ features: { mesh: true } })];
      await entitlementsState.rebuildPolicyGroupState();

      await entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight, false);

      const [fluxidBytes, canonical, height, isEncrypted] = checkSpy.firstCall.args;
      expect(canonical, 'the gate must walk the spec\'s canonical form')
        .to.deep.equal(gatedSpec.toCanonical());
      expect([...flux.usedFeatures(canonical, false)], 'and that form must still expose the feature')
        .to.include('mesh');
      expect(fluxidBytes).to.be.instanceOf(Uint8Array);
      expect(height).to.equal(effectiveHeight);
      expect(isEncrypted).to.equal(false);
    });

    it('throws FEATURE_NOT_ENTITLED when a gated feature has no grant', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      try {
        await entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.code).to.equal('FEATURE_NOT_ENTITLED');
        expect(err.message).to.match(/mesh/);
      }
    });

    it('passes once the default group\'s on-chain definition grants the feature', async () => {
      docs = [definitionDoc({ features: { mesh: true } })];
      await entitlementsState.rebuildPolicyGroupState();

      await entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight);
      expect(checkSpy.firstCall.returnValue.allowed).to.equal(true);
    });

    // The grant is real chain state, so it only applies SOFT_FORK_EFFECTIVE_DEPTH
    // blocks after the message. One block early it must still deny — which is
    // also what makes the `height` argument observable in behaviour rather than
    // only in a recorded call.
    it('does not apply a grant before its soft-fork effective depth', async () => {
      docs = [definitionDoc({ features: { mesh: true } })];
      await entitlementsState.rebuildPolicyGroupState();

      await expect(entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight - 1))
        .to.be.rejectedWith(/mesh/);
      await entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight);
    });

    it('resolves entitlements at the supplied height', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      await entitlementsState.assertSpecEntitled(ungatedSpec, OWNER, 4242);
      expect(checkSpy.firstCall.args[2]).to.equal(4242);
    });

    // Membership is keyed by the fluxid bytes, which arrive from mongo as BSON
    // Binary. If those are not restored the key is wrong, the group is never
    // resolved, and this grant silently does nothing.
    it('grants through a group membership whose fluxid came back from mongo as BSON Binary', async () => {
      docs = [
        definitionDoc({ groupId: MEMBER_GROUP, features: { mesh: true } }),
        membershipDoc({ owner: OWNER }),
      ];
      await entitlementsState.rebuildPolicyGroupState();

      await entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight);
      expect(checkSpy.firstCall.returnValue.allowed).to.equal(true);
    });

    it('does not extend a group membership to a different owner', async () => {
      docs = [
        definitionDoc({ groupId: MEMBER_GROUP, features: { mesh: true } }),
        membershipDoc({ owner: OWNER }),
      ];
      await entitlementsState.rebuildPolicyGroupState();

      await expect(entitlementsState.assertSpecEntitled(gatedSpec, OTHER_OWNER, effectiveHeight))
        .to.be.rejectedWith(/mesh/);
    });

    it('throws when the owner address cannot be decoded to a fluxid', async () => {
      await entitlementsState.rebuildPolicyGroupState();
      await expect(entitlementsState.assertSpecEntitled(gatedSpec, 'not-an-address', 100))
        .to.be.rejectedWith(/not a valid fluxid/);
    });
  });

  describe('rebuildPolicyGroupState', () => {
    it('replays persisted messages into the history in height order and restores fluxid bytes', async () => {
      docs = [
        membershipDoc({ height: 20 }),
        definitionDoc({ height: 10, features: { mesh: true } }),
      ];

      await entitlementsState.rebuildPolicyGroupState();

      expect(addSpy.getCalls().map((call) => call.args[1])).to.eql([10, 20]);
      // PolicyGroupHistory hexes these bytes to key the membership — the shape
      // it reads is the property, so assert the property.
      const membership = addSpy.getCalls().map((call) => call.args[0])
        .find((message) => message.subtype === 'membership');
      expect(membership.fluxids[0].bytes).to.be.instanceOf(Uint8Array);
    });

    it('leaves the real history holding what was replayed', async () => {
      docs = [
        definitionDoc({ height: 10, features: { mesh: true } }),
        membershipDoc({ height: 20 }),
      ];

      await entitlementsState.rebuildPolicyGroupState();

      const history = entitlementsState.getPolicyGroupHistory();
      expect(history).to.be.instanceOf(flux.PolicyGroupHistory);
      expect(history.definitionCount).to.equal(1);
      expect(history.membershipCount).to.equal(1);
      expect(history.fluxidCount).to.equal(1);
      expect(entitlementsState.getFeatureEntitlements()).to.be.instanceOf(flux.FeatureEntitlements);
    });
  });

  describe('removeAtHeight', () => {
    it('rolls the granting message back out of the history', async () => {
      docs = [definitionDoc({ features: { mesh: true } })];
      await entitlementsState.rebuildPolicyGroupState();
      await entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight);

      entitlementsState.removeAtHeight(GRANT_HEIGHT);

      expect(entitlementsState.getPolicyGroupHistory().definitionCount).to.equal(0);
      await expect(entitlementsState.assertSpecEntitled(gatedSpec, OWNER, effectiveHeight))
        .to.be.rejectedWith(/mesh/);
    });

    it('is a no-op when the state has not been built', () => {
      expect(() => entitlementsState.removeAtHeight(500)).to.not.throw();
    });
  });
});
