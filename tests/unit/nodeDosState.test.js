'use strict';

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
      './lib/log': { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() },
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

    it('sets the regular message and emits dos:changed', () => {
      nodeDosState.setDosMessage('a reason');
      expect(nodeDosState.getRawDosMessage()).to.equal('a reason');
      expect(nodeDosState.getDosMessage()).to.equal('a reason');
      sinon.assert.calledOnceWithExactly(publishStub, 'dos:changed', { dosState: 0, dosMessage: 'a reason' });
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

    it('emits the effective DOS status on sticky mutations', () => {
      nodeDosState.setStickyDosStateValue(100);
      nodeDosState.setStickyDosMessage('sticky reason');
      sinon.assert.calledWithExactly(publishStub.lastCall, 'dos:changed', { dosState: 100, dosMessage: 'sticky reason' });
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
  describe('onNodeDos', () => {
    it('fires once when the score crosses the limit, not again while it stays there, and again after it clears and re-crosses', () => {
      const listener = sinon.stub();
      nodeDosState.onNodeDos(listener);

      nodeDosState.setDosStateValue(99);
      expect(listener.callCount).to.equal(0);
      nodeDosState.addDosState(1);
      expect(listener.callCount).to.equal(1);
      nodeDosState.addDosState(50);
      nodeDosState.setDosMessage('still dos');
      expect(listener.callCount).to.equal(1);

      nodeDosState.setDosStateValue(0);
      expect(listener.callCount).to.equal(1);
      nodeDosState.setDosStateValue(100);
      expect(listener.callCount).to.equal(2);
    });

    it('fires for a sticky state reaching the limit', () => {
      const listener = sinon.stub();
      nodeDosState.onNodeDos(listener);
      nodeDosState.setStickyDosMessage('tampering');
      expect(listener.callCount).to.equal(0);
      nodeDosState.setStickyDosStateValue(100);
      expect(listener.callCount).to.equal(1);
    });

    it('a listener that throws does not break the setter or the other listeners', () => {
      const bad = sinon.stub().throws(new Error('boom'));
      const good = sinon.stub();
      nodeDosState.onNodeDos(bad);
      nodeDosState.onNodeDos(good);
      nodeDosState.setDosStateValue(100);
      expect(good.callCount).to.equal(1);
      expect(nodeDosState.getDosStateValue()).to.equal(100);
    });
  });
});
