'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { EventEmitter } = require('node:events');

const tick = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

const MY_IP = '10.0.0.1:16127';
const MY_OUTPOINT = 'me:0';

function makeHarness() {
  const stubs = {
    registerWithGrantPlane: sinon.stub(),
    handleNodeDownEvent: sinon.stub().resolves({ accepted: true, rebroadcast: true, reason: 'stored' }),
    standingCertificateFor: sinon.stub().resolves(null),
    announce: sinon.stub(),
    noteReturn: sinon.stub(),
  };
  const networkStateServiceStub = {
    membershipFingerprint: () => 'fp1',
    networkState: () => [{
      txhash: 'me', outidx: 0, pubkey: 'pk', ip: MY_IP, added_height: 1,
    }],
    nodeDownTopology: () => null,
    chainHeight: () => 100,
  };
  const service = proxyquire('../../ZelBack/src/services/nodeDownService', {
    './networkStateService': networkStateServiceStub,
    './appMessaging/nodeDownStore': {
      registerWithGrantPlane: stubs.registerWithGrantPlane,
      handleNodeDownEvent: stubs.handleNodeDownEvent,
      standingCertificateFor: stubs.standingCertificateFor,
    },
    './appMessaging/peerNotification': { checkAndNotifyPeersOfRunningApps: stubs.announce },
    './quorumGrant/grantorController': { noteReturnFromUnreachability: stubs.noteReturn },
    './fluxNetworkHelper': {
      getLocalSocketAddress: sinon.stub().resolves(MY_IP),
      getFluxNodePrivateKey: sinon.stub().resolves('L1x'),
    },
  });
  const peerManager = new EventEmitter();
  Object.assign(peerManager, {
    has: () => false,
    get: () => undefined,
    shouldAttemptConnection: () => false,
    inboundCount: 99,
    allPeersDown: () => false,
    networkHealthMonitor: null,
  });
  const transport = {
    peerManager,
    dial: sinon.stub().resolves(null),
    openEphemeralConnection: sinon.stub().resolves(null),
    sendSignedMessage: sinon.stub().resolves(),
    broadcastMessageToAll: sinon.stub().resolves(),
    closePeer: sinon.stub(),
  };
  return { service, transport, stubs };
}

describe('nodeDownService', () => {
  afterEach(() => sinon.restore());

  it('start registers the grant-plane provider; stop detaches the bus handlers', async () => {
    const { service, transport } = makeHarness();
    service.start(transport);
    await tick();
    service.stop();
    expect(transport.peerManager.listenerCount('peer:removed')).to.equal(0);
    expect(transport.peerManager.listenerCount('peer:added')).to.equal(0);
  });

  it('registers exactly once and stays registered for the service lifetime', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();
    expect(stubs.registerWithGrantPlane.callCount).to.equal(1);
    service.stop();
  });

  it('a certificate about THIS node triggers the coalesced announce — the refutation path', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();

    const result = await service.onCertificateBroadcast({
      certificate: { subject: MY_OUTPOINT, height: 100 },
      broadcastedAt: Date.now(),
    });
    expect(result.rebroadcast).to.equal(true);
    expect(stubs.announce.callCount).to.equal(1);
    service.stop();
  });

  it('a certificate about another node never announces, and a refused one changes nothing', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();

    await service.onCertificateBroadcast({
      certificate: { subject: 'other:0', height: 100 },
      broadcastedAt: Date.now(),
    });
    expect(stubs.announce.callCount).to.equal(0);

    stubs.handleNodeDownEvent.resolves({ accepted: false, rebroadcast: false, reason: 'sub_quorum' });
    const refused = await service.onCertificateBroadcast({
      certificate: { subject: MY_OUTPOINT, height: 101 },
      broadcastedAt: Date.now(),
    });
    expect(refused.rebroadcast).to.equal(false);
    expect(stubs.announce.callCount).to.equal(0);
    service.stop();
  });

  describe('sync intake', () => {
    it('adapts the served row to the shared intake: certificate, numeric timestamp, envelope', async () => {
      const { service, transport, stubs } = makeHarness();
      service.start(transport);
      await tick();

      const at = Date.now() - 60_000;
      const envelope = {
        version: 1, pubKey: 'pk', timestamp: at, signature: 'sig',
      };
      // the stored doc as the sync stream serves it: dates JSON-serialized
      const row = JSON.parse(JSON.stringify({
        type: 'nodedown',
        subject: 'other:0',
        broadcastedAt: new Date(at),
        data: { certificate: { subject: 'other:0', height: 100 } },
        envelope,
      }));
      const result = await service.onCertificateSyncEvent(row);
      expect(result.accepted).to.equal(true);
      const call = stubs.handleNodeDownEvent.firstCall.args[0];
      expect(call.message.broadcastedAt).to.equal(at);
      expect(call.message.certificate.subject).to.equal('other:0');
      expect(call.envelope).to.deep.equal(envelope);
      service.stop();
    });

    it('a synced certificate about THIS node announces — the refutation fires on catch-up too', async () => {
      const { service, transport, stubs } = makeHarness();
      service.start(transport);
      await tick();

      const row = JSON.parse(JSON.stringify({
        type: 'nodedown',
        subject: MY_OUTPOINT,
        broadcastedAt: new Date(),
        data: { certificate: { subject: MY_OUTPOINT, height: 100 } },
        envelope: null,
      }));
      const result = await service.onCertificateSyncEvent(row);
      expect(result.accepted).to.equal(true);
      expect(stubs.announce.callCount).to.equal(1);
      service.stop();
    });

    it('a row without a certificate is refused before the store is consulted', async () => {
      const { service, stubs } = makeHarness();
      const result = await service.onCertificateSyncEvent({
        type: 'nodedown', broadcastedAt: new Date().toISOString(), data: {},
      });
      expect(result).to.deep.equal({ accepted: false, rebroadcast: false, reason: 'malformed' });
      expect(stubs.handleNodeDownEvent.callCount).to.equal(0);
    });

    it('delivery before start() stores without throwing — the reconciler catches up on its first pass', async () => {
      const { service, stubs } = makeHarness();
      const row = JSON.parse(JSON.stringify({
        type: 'nodedown',
        subject: 'other:0',
        broadcastedAt: new Date(),
        data: { certificate: { subject: 'other:0', height: 100 } },
        envelope: null,
      }));
      const result = await service.onCertificateSyncEvent(row);
      expect(result.accepted).to.equal(true);
      expect(stubs.announce.callCount).to.equal(0);
    });
  });

  it('returning from total unreachability re-fetches grant records and announces', async () => {
    const { service, transport, stubs } = makeHarness();
    let peersDown = false;
    transport.peerManager.allPeersDown = () => peersDown;
    service.start(transport);
    await tick();

    // an ordinary drop with peers still up marks nothing
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    transport.peerManager.emit('peer:added', {});
    await tick();
    expect(stubs.noteReturn.callCount).to.equal(0);

    // the last peer goes: the next connection is the return event, once
    peersDown = true;
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    peersDown = false;
    transport.peerManager.emit('peer:added', {});
    transport.peerManager.emit('peer:added', {});
    await tick();
    expect(stubs.noteReturn.callCount).to.equal(1);
    expect(stubs.announce.callCount).to.equal(1);
    service.stop();
  });
});
