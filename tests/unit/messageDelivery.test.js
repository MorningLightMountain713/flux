'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('messageDelivery', () => {
  let stubs;
  let delivery;
  const contents = { hash: 'paidhash', type: 'fluxappregister', version: 1 };

  beforeEach(() => {
    stubs = {
      paymentRecords: sinon.stub().resolves(new Map([['paidhash', { hash: 'paidhash' }]])),
      getPermanentMessage: sinon.stub().resolves(null),
      storeAppTemporaryMessage: sinon.stub().resolves({ rebroadcast: false, promotion: { hash: 'paidhash' } }),
      checkAndRequestApp: sinon.stub().resolves(true),
      announceAppMessage: sinon.stub().resolves(),
    };
    delivery = proxyquire('../../ZelBack/src/services/appMessaging/messageDelivery', {
      '../appDatabase/appsRepository': { getPermanentMessage: stubs.getPermanentMessage },
      './confirmedMessageStore': { paymentRecords: stubs.paymentRecords },
      './messageStore': { storeAppTemporaryMessage: stubs.storeAppTemporaryMessage },
      './messageVerifier': { checkAndRequestApp: stubs.checkAndRequestApp },
      '../fluxCommunication': { announceAppMessage: stubs.announceAppMessage },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('stores a paid message this node is missing, and announces it to its peers', async () => {
    const result = await delivery.deliverMessage(contents);

    expect(result).to.deep.equal({ outcome: 'stored' });
    sinon.assert.calledOnceWithExactly(stubs.storeAppTemporaryMessage, contents);
    sinon.assert.calledOnceWithExactly(stubs.checkAndRequestApp, 'paidhash', 2);
    sinon.assert.calledOnceWithExactly(stubs.announceAppMessage, contents);
  });

  it('takes nothing for a hash this node has recorded no payment for', async () => {
    stubs.paymentRecords.resolves(new Map());

    const result = await delivery.deliverMessage(contents);

    expect(result).to.deep.equal({ outcome: 'unpaid' });
    sinon.assert.notCalled(stubs.storeAppTemporaryMessage);
    sinon.assert.notCalled(stubs.announceAppMessage);
  });

  it('takes nothing for a hash whose message this node already holds', async () => {
    stubs.getPermanentMessage.resolves({ hash: 'paidhash' });

    const result = await delivery.deliverMessage(contents);

    expect(result).to.deep.equal({ outcome: 'held' });
    sinon.assert.notCalled(stubs.storeAppTemporaryMessage);
    sinon.assert.notCalled(stubs.announceAppMessage);
  });

  it('refuses a message the intake checks reject, and announces nothing', async () => {
    stubs.storeAppTemporaryMessage.resolves(new Error('Invalid Flux App hash received'));

    const result = await delivery.deliverMessage(contents);

    expect(result).to.deep.equal({ outcome: 'refused', reason: 'Invalid Flux App hash received' });
    sinon.assert.notCalled(stubs.checkAndRequestApp);
    sinon.assert.notCalled(stubs.announceAppMessage);
  });

  it('announces nothing when the message is not stored', async () => {
    stubs.checkAndRequestApp.resolves(false);

    const result = await delivery.deliverMessage(contents);

    expect(result.outcome).to.equal('refused');
    sinon.assert.notCalled(stubs.announceAppMessage);
  });

  it('refuses a body that is not an app message', async () => {
    expect(await delivery.deliverMessage(null)).to.deep.equal({ outcome: 'refused', reason: 'not an app message' });
    expect(await delivery.deliverMessage({ type: 'x' })).to.deep.equal({ outcome: 'refused', reason: 'not an app message' });
    sinon.assert.notCalled(stubs.paymentRecords);
  });
});
