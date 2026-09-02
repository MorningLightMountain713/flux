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
    recordStateFor: sinon.stub().resolves({ state: 'none', key: null }),
    quarantineFor: sinon.stub().resolves({ quarantined: false, count: 0, liftsAt: null }),
    announce: sinon.stub(),
    noteReturn: sinon.stub(),
    noteMeshReturn: sinon.stub(),
  };
  const world = { height: 100 };
  const networkStateServiceStub = {
    membershipFingerprint: () => 'fp1',
    networkState: () => [{
      txhash: 'me', outidx: 0, pubkey: 'pk', ip: MY_IP, added_height: 1,
    }],
    nodeDownTopology: () => null,
    chainHeight: () => world.height,
  };
  const service = proxyquire('../../ZelBack/src/services/nodeDownService', {
    './networkStateService': networkStateServiceStub,
    './appMessaging/nodeDownStore': {
      RECORD_STATE: { STANDING: 'standing', REFUTED: 'refuted', NONE: 'none' },
      registerWithGrantPlane: stubs.registerWithGrantPlane,
      handleNodeDownEvent: stubs.handleNodeDownEvent,
      standingCertificateFor: stubs.standingCertificateFor,
      recordStateFor: stubs.recordStateFor,
      quarantineFor: stubs.quarantineFor,
    },
    './appMessaging/peerNotification': { checkAndNotifyPeersOfRunningApps: stubs.announce },
    './quorumGrant/grantorController': { noteReturnFromUnreachability: stubs.noteReturn },
    './appMesh/meshOrdinals': { noteReturnFromUnreachability: stubs.noteMeshReturn },
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
    setInboundGate: sinon.stub(),
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
  return {
    service, transport, stubs, networkStateServiceStub, world,
  };
}

const DUTY_IP = '10.0.0.2:16127';
const DUTY_OUTPOINT = 'x:0';

// One duty, x, listed beside this node: the reconciler owes it a dial and the
// juror may probe it. The jury math is stubbed empty so a probe records an
// answer and never assembles.
function withDuty({ networkStateServiceStub, transport }) {
  networkStateServiceStub.networkState = () => [
    {
      txhash: 'me', outidx: 0, pubkey: 'pk', ip: MY_IP, added_height: 1,
    },
    {
      txhash: 'x', outidx: 0, pubkey: 'pkx', ip: DUTY_IP, added_height: 1,
    },
  ];
  networkStateServiceStub.nodeDownTopology = () => ({
    duties: () => [{ outpoint: DUTY_OUTPOINT }],
    jury: () => [],
    juryAt: () => [],
    sameJuryFor: () => null,
    cotenants: () => new Set(),
    ringSuccessors: () => [],
  });
  transport.peerManager.shouldAttemptConnection = () => true;
  transport.openEphemeralConnection = sinon.stub().resolves({ close: () => {} });
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

  describe('severe quarantine — the stand-down held open, the inbound refused, the lapse still probed', () => {
    it('start installs the peering gate; stop removes it', async () => {
      const { service, transport } = makeHarness();
      service.start(transport);
      await tick();
      expect(transport.peerManager.setInboundGate.callCount).to.equal(1);
      expect(transport.peerManager.setInboundGate.firstCall.args[0]).to.be.a('function');
      service.stop();
      expect(transport.peerManager.setInboundGate.lastCall.args[0]).to.equal(null);
    });

    it('the gate refuses a listed subject under quarantine and admits everyone else', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.quarantineFor.withArgs(DUTY_OUTPOINT).resolves({ quarantined: true, count: 3, liftsAt: 1 });
      service.start(transport);
      await tick();
      const gate = transport.peerManager.setInboundGate.firstCall.args[0];

      expect(await gate(DUTY_IP)).to.deep.equal({ admitted: false, reason: 'quarantined', subject: DUTY_OUTPOINT });
      expect(await gate(MY_IP)).to.deep.equal({ admitted: true, reason: 'not_quarantined' });
      expect(await gate('10.0.0.9:16127')).to.deep.equal({ admitted: true, reason: 'unlisted' });
      service.stop();
    });

    it('a quarantined duty stays out of the dial plan though its certificate is refuted', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'refuted', key: 'nodedown:x:0:90' });
      stubs.quarantineFor.withArgs(DUTY_OUTPOINT).resolves({ quarantined: true, count: 3, liftsAt: 1 });
      service.start(transport);
      await tick();
      await service.sweep();
      await tick();
      expect(transport.dial.callCount).to.equal(0);

      // the hold lifts: the same refuted record now lets the duty be dialed
      stubs.quarantineFor.withArgs(DUTY_OUTPOINT).resolves({ quarantined: false, count: 2, liftsAt: null });
      await service.sweep();
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });

    it('the trip drops a held connection to the subject', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      transport.peerManager.has = (socketAddress) => socketAddress === DUTY_IP;
      stubs.quarantineFor.withArgs(DUTY_OUTPOINT).resolves({ quarantined: true, count: 3, liftsAt: 1 });
      service.start(transport);
      await tick();

      await service.onCertificateBroadcast({
        certificate: { subject: DUTY_OUTPOINT, height: 100 },
        broadcastedAt: Date.now(),
      });
      expect(transport.closePeer.args).to.deep.equal([[DUTY_IP, 'quarantined']]);
      service.stop();
    });

    it('the record lapsing under the hold probes the subject once — the jury never loses a still-dark node', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      stubs.quarantineFor.withArgs(DUTY_OUTPOINT).resolves({ quarantined: true, count: 3, liftsAt: 1 });
      service.start(transport);
      await tick();
      await service.sweep();
      await tick();
      expect(transport.openEphemeralConnection.callCount).to.equal(0);

      // the row expired unrefuted
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'none', key: null });
      await service.sweep();
      await tick();
      expect(transport.openEphemeralConnection.args).to.deep.equal([[DUTY_IP]]);
      expect(transport.dial.callCount).to.equal(0); // the hold itself never lifted

      await service.sweep();
      await tick();
      expect(transport.openEphemeralConnection.callCount).to.equal(1); // once per lapse
      service.stop();
    });

    it('a refutation is a return, not a lapse: no probe', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      service.start(transport);
      await tick();
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'refuted', key: 'nodedown:x:0:90' });
      await service.sweep();
      await tick();
      expect(transport.openEphemeralConnection.callCount).to.equal(0);
      service.stop();
    });

    it('a node that left the list while certified is forgotten on the sweep: no probe when its record later vanishes', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs, networkStateServiceStub } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      service.start(transport);
      await tick();

      // the list moves on without x; the sweep prunes what nobody will ask about
      const listed = networkStateServiceStub.nodeDownTopology;
      networkStateServiceStub.nodeDownTopology = () => ({ ...listed(), duties: () => [] });
      await service.sweep();
      await tick();

      // x is listed again later with no record: a fresh start, not a lapse
      networkStateServiceStub.nodeDownTopology = listed;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'none', key: null });
      await service.sweep();
      await tick();
      expect(transport.openEphemeralConnection.callCount).to.equal(0);
      service.stop();
    });

    it('the lapse probe fires without a hold too: a still-dark node is re-certified, not forgotten', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      service.start(transport);
      await tick();
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'none', key: null });
      await service.sweep();
      await tick();
      expect(transport.openEphemeralConnection.args).to.deep.equal([[DUTY_IP]]);
      service.stop();
    });
  });

  describe('the mild tier — a juror\'s private count of its duty\'s cycles orders its dials', () => {
    const DUTY_PORT = '16127';
    const DUTY_HOST = '10.0.0.2';

    async function cycles(harness, count, closeCode = 1006) {
      const { transport, world } = harness;
      for (let i = 0; i < count; i += 1) {
        transport.peerManager.emit('peer:removed', {
          ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound', closeCode,
        });
        world.height += 1;
        transport.peerManager.emit('peer:added', { ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound' });
        world.height += 1;
      }
      await tick();
    }

    it('four unexpected drop-and-return cycles damp the duty: no dial while the floor is short, a dial once a window has passed', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, world } = harness;
      service.start(transport);
      await tick();
      await cycles(harness, 4);
      transport.dial.resetHistory(); // the dials the cycles themselves drew, before the trip

      await service.sweep();
      await tick();
      expect(transport.dial.callCount).to.equal(0);

      world.height += 90;
      await service.sweep();
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });

    it('a deliberate close is not a drop: four policy closes damp nothing', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport } = harness;
      service.start(transport);
      await tick();
      await cycles(harness, 4, 4009);

      await service.sweep();
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });

    it('the count dies with the service: a restart starts every duty from the bottom', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport } = harness;
      service.start(transport);
      await tick();
      await cycles(harness, 4);
      service.stop();

      transport.dial.resetHistory();
      service.start(transport);
      await tick();
      await service.sweep();
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
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
    expect(stubs.noteMeshReturn.callCount).to.equal(0);

    // the last peer goes: the next connection is the return event, once
    peersDown = true;
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    peersDown = false;
    transport.peerManager.emit('peer:added', {});
    transport.peerManager.emit('peer:added', {});
    await tick();
    expect(stubs.noteReturn.callCount).to.equal(1);
    // The mesh hears the same return: its ordinal names are re-probed before they are trusted.
    expect(stubs.noteMeshReturn.callCount).to.equal(1);
    expect(stubs.announce.callCount).to.equal(1);
    service.stop();
  });
});
