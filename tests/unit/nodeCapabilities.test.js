const chai = require('chai');
const sinon = require('sinon');

const { expect } = chai;

const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const globalState = require('../../ZelBack/src/services/utils/globalState');
const nodeCapabilities = require('../../ZelBack/src/services/utils/nodeCapabilities');

describe('nodeCapabilities tests', () => {
  describe('probeOnce', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('reports the channel unreachable when the reachability call does not succeed', async () => {
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'error', data: { code: 'ECONNREFUSED' } });
      const nodeTypeStub = sinon.stub(benchmarkService, 'getNodeType');

      const result = await nodeCapabilities.probeOnce();

      expect(result).to.equal('unreachable');
      // never asks for the node type when the channel itself is down
      expect(nodeTypeStub.called).to.equal(false);
    });

    it('reports an attested node when the daemon answers arcane', async () => {
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'success', data: {} });
      sinon.stub(benchmarkService, 'getNodeType').resolves({ status: 'success', data: { nodetype: 'arcane' } });

      const result = await nodeCapabilities.probeOnce();

      expect(result).to.equal('arcane');
    });

    it('reports a legacy node when the daemon answers legacy', async () => {
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'success', data: {} });
      sinon.stub(benchmarkService, 'getNodeType').resolves({ status: 'success', data: { nodetype: 'legacy' } });

      const result = await nodeCapabilities.probeOnce();

      expect(result).to.equal('legacy');
    });

    it('keeps waiting while the node-type latch has not settled', async () => {
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'success', data: {} });
      sinon.stub(benchmarkService, 'getNodeType').resolves({ status: 'success', data: { nodetype: 'pending' } });

      const result = await nodeCapabilities.probeOnce();

      expect(result).to.equal('pending');
    });

    it('treats a method-not-found from an older daemon as a definitive legacy verdict', async () => {
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'success', data: {} });
      sinon.stub(benchmarkService, 'getNodeType').resolves({ status: 'error', data: { code: -32601, message: 'Method not found' } });

      const result = await nodeCapabilities.probeOnce();

      expect(result).to.equal('legacy');
    });

    it('treats a transport error on the node-type call as transient, not legacy', async () => {
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'success', data: {} });
      sinon.stub(benchmarkService, 'getNodeType').resolves({ status: 'error', data: { code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' } });

      const result = await nodeCapabilities.probeOnce();

      expect(result).to.equal('unreachable');
    });
  });

  describe('verdict', () => {
    it('returns the tri-state value held on globalState', () => {
      globalState.capabilityVerdict = null;
      expect(nodeCapabilities.verdict()).to.equal(null);
      globalState.capabilityVerdict = true;
      expect(nodeCapabilities.verdict()).to.equal(true);
      globalState.capabilityVerdict = false;
      expect(nodeCapabilities.verdict()).to.equal(false);
      globalState.capabilityVerdict = null;
    });
  });
});
