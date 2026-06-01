const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('nodeDosState tests', () => {
  let nodeDosState;
  let publishStub;

  // proxyquire bypasses the require cache, so each load gives a fresh module
  // with its singleton state reset to defaults.
  function loadModule() {
    publishStub = sinon.stub();
    return proxyquire('../../ZelBack/src/services/nodeDosState', {
      './utils/fluxEventBus': { publish: publishStub },
    });
  }

  beforeEach(() => {
    nodeDosState = loadModule();
  });

  describe('dosState value', () => {
    it('starts at zero', () => {
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('sets the value and emits dos:changed', () => {
      nodeDosState.setDosStateValue(42);
      expect(nodeDosState.getDosStateValue()).to.equal(42);
      sinon.assert.calledOnceWithExactly(publishStub, 'dos:changed', { dosState: 42, dosMessage: null });
    });

    it('increments the value by a delta and emits dos:changed', () => {
      nodeDosState.addDosState(11);
      nodeDosState.addDosState(2);
      expect(nodeDosState.getDosStateValue()).to.equal(13);
      sinon.assert.calledTwice(publishStub);
      sinon.assert.calledWithExactly(publishStub.secondCall, 'dos:changed', { dosState: 13, dosMessage: null });
    });

    it('supports fractional increments', () => {
      nodeDosState.addDosState(0.13);
      expect(nodeDosState.getDosStateValue()).to.equal(0.13);
    });
  });

  describe('dosMessage', () => {
    it('starts null', () => {
      expect(nodeDosState.getRawDosMessage()).to.be.null;
      expect(nodeDosState.getDosMessage()).to.be.null;
    });

    it('sets the regular message without emitting', () => {
      nodeDosState.setDosMessage('a reason');
      expect(nodeDosState.getRawDosMessage()).to.equal('a reason');
      expect(nodeDosState.getDosMessage()).to.equal('a reason');
      sinon.assert.notCalled(publishStub);
    });
  });

  describe('sticky DOS state', () => {
    it('takes precedence over the regular message in the effective getter only', () => {
      nodeDosState.setDosMessage('regular reason');
      nodeDosState.setStickyDosMessage('sticky reason');
      expect(nodeDosState.getStickyDosMessage()).to.equal('sticky reason');
      expect(nodeDosState.getRawDosMessage()).to.equal('regular reason');
      expect(nodeDosState.getDosMessage()).to.equal('sticky reason');
    });

    it('is not cleared by setDosMessage(null)', () => {
      nodeDosState.setStickyDosMessage('sticky reason');
      nodeDosState.setDosMessage(null);
      expect(nodeDosState.getDosMessage()).to.equal('sticky reason');
    });

    it('clears both the sticky message and sticky state value', () => {
      nodeDosState.setStickyDosMessage('sticky reason');
      nodeDosState.setStickyDosStateValue(100);
      nodeDosState.clearStickyDosMessage();
      expect(nodeDosState.getStickyDosMessage()).to.be.null;
      expect(nodeDosState.isNodeDos()).to.be.false;
    });
  });

  describe('isNodeDos', () => {
    it('is false below the threshold', () => {
      nodeDosState.setDosStateValue(99);
      expect(nodeDosState.isNodeDos()).to.be.false;
    });

    it('is true at or above the threshold', () => {
      nodeDosState.setDosStateValue(100);
      expect(nodeDosState.isNodeDos()).to.be.true;
    });

    it('uses the sticky state value when a sticky message is set', () => {
      nodeDosState.setDosStateValue(0);
      nodeDosState.setStickyDosMessage('sticky reason');
      nodeDosState.setStickyDosStateValue(100);
      expect(nodeDosState.isNodeDos()).to.be.true;
    });
  });

  describe('getDosData', () => {
    it('returns the regular state when no sticky is set', () => {
      nodeDosState.setDosStateValue(7);
      nodeDosState.setDosMessage('regular reason');
      expect(nodeDosState.getDosData()).to.deep.equal({ dosState: 7, dosMessage: 'regular reason' });
    });

    it('returns the sticky state when a sticky message is set', () => {
      nodeDosState.setDosStateValue(7);
      nodeDosState.setDosMessage('regular reason');
      nodeDosState.setStickyDosStateValue(100);
      nodeDosState.setStickyDosMessage('sticky reason');
      expect(nodeDosState.getDosData()).to.deep.equal({ dosState: 100, dosMessage: 'sticky reason' });
    });
  });
});
