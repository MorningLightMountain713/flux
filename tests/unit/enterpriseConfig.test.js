const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();


const OWNER_MAP = {
  nodeA: ['ownerA', 'ownerB'],
  nodeB: ['ownerB'],
};

// Fetching the document, validating its shape, caching it and holding last-known-good all
// belong to policyStore and are covered in policyStore.test.js. What is left here is the
// shape-aware view over it: the accessors and the owner-union memoization.
function loadModule(payload = OWNER_MAP) {
  const log = { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
  const policyStore = {
    get: sinon.stub(),
    onChange: sinon.stub(),
  };
  policyStore.get.withArgs('enterpriseNodes').returns(payload);

  return {
    module: proxyquire('../../ZelBack/src/services/utils/enterpriseConfig', {
      '../policy/policyStore': policyStore,
      '../../lib/log': log,
    }),
    policyStore,
    log,
  };
}

describe('enterpriseConfig', () => {
  afterEach(() => sinon.restore());

  describe('accessors', () => {
    it('serves the node->owners map policyStore holds', () => {
      const { module: m } = loadModule();

      expect(m.getEnterpriseNodeOwnerMap()).to.deep.equal(OWNER_MAP);
    });

    it('reads the enterpriseNodes document, not another one', () => {
      const { module: m, policyStore } = loadModule();

      m.getEnterpriseNodeOwnerMap();

      sinon.assert.calledWith(policyStore.get, 'enterpriseNodes');
    });

    it('derives node pubkeys (keys) and the global owner union (deduped values)', () => {
      const { module: m } = loadModule();

      expect(m.getEnterpriseNodesPublicKeys()).to.deep.equal(['nodeA', 'nodeB']);
      expect(m.getEnterpriseAppOwners()).to.deep.equal(['ownerA', 'ownerB']);
    });

    it("returns a specific node's allowed owners, or [] for an unknown node", () => {
      const { module: m } = loadModule();

      expect(m.getAllowedOwnersForNode('nodeA')).to.deep.equal(['ownerA', 'ownerB']);
      expect(m.getAllowedOwnersForNode('nobody')).to.deep.equal([]);
    });
  });

  describe('when policyStore has no copy', () => {
    // Every caller asks an allow-list question, so the answer under an unreadable document
    // has to be no: a node cannot admit an enterprise owner it cannot confirm.
    it('presents an empty map rather than throwing', () => {
      const { module: m } = loadModule(null);

      expect(m.getEnterpriseNodeOwnerMap()).to.deep.equal({});
      expect(m.getEnterpriseNodesPublicKeys()).to.deep.equal([]);
      expect(m.getEnterpriseAppOwners()).to.deep.equal([]);
      expect(m.getAllowedOwnersForNode('nodeA')).to.deep.equal([]);
    });

    // The accessors above deliberately collapse "no copy" into "no owners", because every
    // one of them answers an allow-list question. A caller that can distinguish must still
    // be able to, or the collapse leaks out of the module as a fact about the network.
    it('reports the map as not loaded, keeping "could not ask" separate from "nobody"', () => {
      expect(loadModule(null).module.isOwnerMapLoaded()).to.equal(false);
    });

    it('reports a genuinely empty document as loaded', () => {
      expect(loadModule({}).module.isOwnerMapLoaded()).to.equal(true);
    });

    it('reports a populated document as loaded', () => {
      expect(loadModule().module.isOwnerMapLoaded()).to.equal(true);
    });
  });

  describe('getEnterpriseAppOwners memoization', () => {
    it('returns the same array instance while the underlying map is unchanged', () => {
      const { module: m } = loadModule();

      expect(m.getEnterpriseAppOwners()).to.equal(m.getEnterpriseAppOwners());
    });

    it('rebuilds when policyStore replaces the map', () => {
      const { module: m, policyStore } = loadModule();
      const before = m.getEnterpriseAppOwners();

      policyStore.get.withArgs('enterpriseNodes').returns({ nodeC: ['ownerC'] });
      const after = m.getEnterpriseAppOwners();

      expect(after).to.not.equal(before);
      expect(after).to.deep.equal(['ownerC']);
    });

    it('skips non-array values rather than failing the union', () => {
      const { module: m } = loadModule({ nodeA: ['ownerA'], nodeB: 'notAnArray' });

      expect(m.getEnterpriseAppOwners()).to.deep.equal(['ownerA']);
    });
  });

  describe('onOwnerMapChange', () => {
    it('subscribes the handler to enterpriseNodes refreshes', () => {
      const { module: m, policyStore } = loadModule();
      const handler = sinon.stub();

      m.onOwnerMapChange(handler);

      sinon.assert.calledWith(policyStore.onChange, 'enterpriseNodes', handler);
    });

    it('is a no-op without a handler', () => {
      const { module: m, policyStore } = loadModule();

      m.onOwnerMapChange(undefined);

      sinon.assert.notCalled(policyStore.onChange);
    });
  });
});
