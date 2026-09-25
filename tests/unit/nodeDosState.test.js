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

  describe('sticky DOS, held by owner', () => {
    const owners = () => nodeDosState.StickyDosOwner;

    it('reports no reason while no owner holds the node', () => {
      expect(nodeDosState.getStickyDosMessage()).to.equal(null);
      expect(nodeDosState.isNodeDos()).to.equal(false);
    });

    it('takes precedence over the regular message in the effective getter only', () => {
      nodeDosState.setDosMessage('regular reason');
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'sticky reason');
      expect(nodeDosState.getStickyDosMessage()).to.equal('sticky reason');
      expect(nodeDosState.getRawDosMessage()).to.equal('regular reason');
      expect(nodeDosState.getDosMessage()).to.equal('sticky reason');
    });

    // An availability pass ends a good run this way. A verdict that went with it would
    // let the node walk back into service with its condition still in place.
    it('is not released by setDosMessage(null)', () => {
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'sticky reason');
      nodeDosState.setDosMessage(null);
      expect(nodeDosState.getDosMessage()).to.equal('sticky reason');
    });

    // DOS >= 100 is what removes every app on the box, so a hold that did not reach it
    // would be a note.
    it('takes the node out of service on a hold alone, whatever the counted state is', () => {
      nodeDosState.setDosStateValue(0);
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'tampering flag');
      expect(nodeDosState.isNodeDos()).to.equal(true);
      expect(nodeDosState.getDosData()).to.deep.equal({ dosState: 100, dosMessage: 'tampering flag' });
    });

    it('releases the owner that let go', () => {
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'tampering flag');
      nodeDosState.clearStickyDos(owners().APP_TAMPERING);
      expect(nodeDosState.isNodeDos()).to.equal(false);
      expect(nodeDosState.isStickyDosHeldBy(owners().APP_TAMPERING)).to.equal(false);
    });

    it('names every reason, because an operator has to lift all of them', () => {
      nodeDosState.setStickyDos(owners().RESIDENTIAL_DOS, 'residential');
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'tampering');
      const message = nodeDosState.getStickyDosMessage();
      expect(message).to.contain('residential');
      expect(message).to.contain('tampering');
    });

    // One slot could hold one of these two reasons: the second either overwrote the
    // first, leaving an owner that can no longer recognise - and so never release - its
    // own verdict, or was dropped, and the node returned to service on the first owner's
    // release for a condition that never lifted.
    it('keeps the node out of service while any other owner still holds it', () => {
      nodeDosState.setStickyDos(owners().RESIDENTIAL_DOS, 'residential');
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'tampering');
      nodeDosState.clearStickyDos(owners().RESIDENTIAL_DOS);
      expect(nodeDosState.isNodeDos(), 'one owner released the node for both').to.equal(true);
      expect(nodeDosState.getStickyDosMessage()).to.equal('tampering');
    });

    it('does not release a verdict it does not own', () => {
      nodeDosState.setStickyDos(owners().RESIDENTIAL_DOS, 'residential');
      nodeDosState.clearStickyDos(owners().APP_TAMPERING);
      expect(nodeDosState.getStickyDosMessage()).to.equal('residential');
    });

    // An unknown owner is a caller that was never given an identity. Accepted, it would
    // hold the node under a name no release path knows about.
    it('refuses an owner it does not know, rather than minting one', () => {
      expect(() => nodeDosState.setStickyDos('someFeature', 'a reason')).to.throw('unknown owner');
      expect(nodeDosState.isNodeDos()).to.equal(false);
    });

    it('emits the effective DOS status on a hold and on its release', () => {
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'sticky reason');
      sinon.assert.calledWithExactly(publishStub.lastCall, 'dos:changed', { dosState: 100, dosMessage: 'sticky reason' });
      nodeDosState.clearStickyDos(owners().APP_TAMPERING);
      sinon.assert.calledWithExactly(publishStub.lastCall, 'dos:changed', { dosState: 0, dosMessage: null });
    });

    it('says nothing when an owner restates the reason it already holds', () => {
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'sticky reason');
      const emitted = publishStub.callCount;
      nodeDosState.setStickyDos(owners().APP_TAMPERING, 'sticky reason');
      expect(publishStub.callCount).to.equal(emitted);
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

    it('is true while any owner holds the node', () => {
      nodeDosState.setDosStateValue(0);
      nodeDosState.setStickyDos(nodeDosState.StickyDosOwner.NODEJS_FLOOR, 'sticky reason');
      expect(nodeDosState.isNodeDos()).to.be.true;
    });
  });

  describe('getDosData', () => {
    it('returns the regular state when no sticky is set', () => {
      nodeDosState.setDosStateValue(7);
      nodeDosState.setDosMessage('regular reason');
      expect(nodeDosState.getDosData()).to.deep.equal({ dosState: 7, dosMessage: 'regular reason' });
    });

    it('returns the held verdict over the counted state', () => {
      nodeDosState.setDosStateValue(7);
      nodeDosState.setDosMessage('regular reason');
      nodeDosState.setStickyDos(nodeDosState.StickyDosOwner.APP_TAMPERING, 'sticky reason');
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

    it('fires when an owner takes the node out of service', () => {
      const listener = sinon.stub();
      nodeDosState.onNodeDos(listener);
      nodeDosState.setStickyDos(nodeDosState.StickyDosOwner.APP_TAMPERING, 'tampering');
      expect(listener.callCount).to.equal(1);
      nodeDosState.setStickyDos(nodeDosState.StickyDosOwner.RESIDENTIAL_DOS, 'residential');
      expect(listener.callCount, 'a second owner is not a second crossing').to.equal(1);
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
