'use strict';

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

  describe('resolveNodeCapability', () => {
    let savedArcaneEnv;

    beforeEach(() => {
      savedArcaneEnv = process.env.FLUX_ARCANE_NODE;
      globalState.capabilityVerdict = null;
    });

    afterEach(() => {
      sinon.restore();
      if (savedArcaneEnv === undefined) delete process.env.FLUX_ARCANE_NODE;
      else process.env.FLUX_ARCANE_NODE = savedArcaneEnv;
      globalState.capabilityVerdict = null;
    });

    it('concludes legacy via the pre-gate, without probing, when FLUX_ARCANE_NODE is unset', async () => {
      delete process.env.FLUX_ARCANE_NODE;
      const statusStub = sinon.stub(benchmarkService, 'getStatus');

      await nodeCapabilities.resolveNodeCapability();

      expect(globalState.capabilityVerdict).to.equal(false);
      // the benchmark channel is never touched on the legacy fast-path
      expect(statusStub.called).to.equal(false);
    });

    it('resolves arcane when the benchmark channel latches arcane', async () => {
      process.env.FLUX_ARCANE_NODE = '1';
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'success', data: {} });
      sinon.stub(benchmarkService, 'getNodeType').resolves({ status: 'success', data: { nodetype: 'arcane' } });

      await nodeCapabilities.resolveNodeCapability();

      expect(globalState.capabilityVerdict).to.equal(true);
    });

    it('resolves legacy when an Arcane-imaged node attests legacy', async () => {
      process.env.FLUX_ARCANE_NODE = '1';
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'success', data: {} });
      sinon.stub(benchmarkService, 'getNodeType').resolves({ status: 'success', data: { nodetype: 'legacy' } });

      await nodeCapabilities.resolveNodeCapability();

      expect(globalState.capabilityVerdict).to.equal(false);
    });

    it('keeps polling through pending and never gives up before the verdict latches', async () => {
      process.env.FLUX_ARCANE_NODE = '1';
      const clock = sinon.useFakeTimers();
      sinon.stub(benchmarkService, 'getStatus').resolves({ status: 'success', data: {} });
      const nodeType = sinon.stub(benchmarkService, 'getNodeType');
      nodeType.onFirstCall().resolves({ status: 'success', data: { nodetype: 'pending' } });
      nodeType.onSecondCall().resolves({ status: 'success', data: { nodetype: 'arcane' } });

      const resolved = nodeCapabilities.resolveNodeCapability();
      // flush the first (pending) probe, fire the poll delay, run the second (arcane) probe
      await clock.tickAsync(1100);
      await resolved;

      expect(globalState.capabilityVerdict).to.equal(true);
      expect(nodeType.callCount).to.equal(2);
    });
  });

  describe('verdict', () => {
    it('returns the verdict held on globalState', () => {
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
