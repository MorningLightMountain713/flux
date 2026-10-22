const chai = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const { expect } = chai;

// RELEASED-FLEET COMPATIBILITY: delete with appMessaging/releasedFleetSigterm.
describe('releasedFleetSigterm tests', () => {
  let hosted;
  let senderStub;
  let networkStub;
  let logStub;
  let sigterm;

  beforeEach(() => {
    hosted = sinon.stub().resolves([{ record: { name: 'app1' } }]);
    senderStub = { broadcastMessageToAll: sinon.stub().resolves({}) };
    networkStub = { getLocalSocketAddress: sinon.stub().resolves('1.2.3.4:16127') };
    logStub = {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    };
    sigterm = proxyquire('../../ZelBack/src/services/appMessaging/releasedFleetSigterm', {
      '../../lib/log': logStub,
      '../fluxNetworkHelper': networkStub,
      '../fluxCommunicationMessagesSender': senderStub,
      '../appDatabase/appRecords': { hostedInstances: () => ({ apps: hosted }) },
    });
  });

  afterEach(() => sinon.restore());

  // The form a released node accepts: its handler reads ip and broadcastedAt,
  // and its broadcast check finds the signer by ip.
  it('broadcasts the released form to every held peer', async () => {
    const before = Date.now();
    expect(await sigterm.announceShutdown()).to.equal(true);

    sinon.assert.calledOnce(senderStub.broadcastMessageToAll);
    const [message, options] = senderStub.broadcastMessageToAll.firstCall.args;
    expect(options, 'to every peer, none excluded').to.equal(undefined);
    expect(message).to.include({ type: 'fluxnodesigterm', version: 1, ip: '1.2.3.4:16127' });
    expect(message.broadcastedAt).to.be.within(before, Date.now());
  });

  it('sends nothing from a node that holds no apps', async () => {
    hosted.resolves([]);
    expect(await sigterm.announceShutdown()).to.equal(false);
    sinon.assert.notCalled(senderStub.broadcastMessageToAll);
  });

  it('sends nothing without a local address', async () => {
    networkStub.getLocalSocketAddress.resolves(null);
    expect(await sigterm.announceShutdown()).to.equal(false);
    sinon.assert.notCalled(senderStub.broadcastMessageToAll);
  });

  it('never throws: the stop goes on', async () => {
    hosted.rejects(new Error('db down'));
    expect(await sigterm.announceShutdown()).to.equal(false);
    expect(logStub.warn.calledWithMatch(/not sent: db down/)).to.equal(true);
  });

  it('gives up at its budget rather than hold the shutdown', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      hosted.returns(new Promise(() => {}));
      let outcome = null;
      const sending = sigterm.announceShutdown().then((sent) => { outcome = sent; });
      await clock.tickAsync(1999);
      expect(outcome).to.equal(null);
      await clock.tickAsync(1);
      await sending;
      expect(outcome).to.equal(false);
    } finally {
      clock.restore();
    }
  });

  it('accepts copies as old as a released node does', () => {
    expect(sigterm.MAX_AGE_MS).to.equal(240_000);
  });
});
