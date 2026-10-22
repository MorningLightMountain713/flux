'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { EventEmitter } = require('node:events');
const log = require('../../ZelBack/src/lib/log');
const { NodeDownJuror, STOP_CLOSE_AGE_MS } = require('../../ZelBack/src/services/utils/nodeDownJuror');
const { NODE_DOWN_GRACE_MS, RESTART_GRACE_MS } = require('../../ZelBack/src/services/utils/appConstants');
const { CLOSE_CODES } = require('../../ZelBack/src/services/utils/FluxPeerSocket');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');

const tick = () => new Promise((resolve) => { setImmediate(() => setImmediate(resolve)); });

// The two capabilities the return listens to, as their owners move them.
const floor = () => capabilities.claim('peersAboveFloor', 'FluxPeerManager');
const synced = () => capabilities.claim('appStateSynced', 'appSyncOrchestrator');

// The list refreshed with a new membership.
let movedLists = 0;
async function listMoved(networkStateServiceStub) {
  movedLists += 1;
  const fingerprint = `fp-moved-${movedLists}`;
  networkStateServiceStub.membershipFingerprint = () => fingerprint;
  networkStateServiceStub.listUpdated();
  await tick();
}

const MY_IP = '10.0.0.1:16127';
const MY_OUTPOINT = 'me:0';

function makeHarness(opts = {}) {
  capabilities.resetForTests();
  const stubs = {
    registerWithGrantPlane: sinon.stub(),
    handleNodeDownEvent: sinon.stub().resolves({ accepted: true, rebroadcast: true, reason: 'stored' }),
    standingCertificateFor: sinon.stub().resolves(null),
    recordStateFor: sinon.stub().resolves({ state: 'none', key: null }),
    lockoutFor: sinon.stub().resolves({ lockedOut: false, count: 0, liftsAt: null }),
    announce: sinon.stub(),
    hold: sinon.stub(),
    release: sinon.stub(),
    noteReturn: sinon.stub(),
    noteMeshReturn: sinon.stub(),
    enforcePlacement: sinon.stub().resolves({ placed: true, removed: [] }),
    storeState: sinon.stub().resolves({ isNewer: true }),
    signMessage: sinon.stub().returns('sig-me'),
    verifyMessage: sinon.stub().returns(true),
    certificatesFor: sinon.stub().resolves([]),
    sign: sinon.stub().callsFake(async (message) => JSON.stringify(message)),
    // A statement is accepted when it names a process id; tests that refuse
    // one say so.
    verifyStop: sinon.stub().callsFake(async (statement) => (statement?.data?.processId
      ? { ok: true, processId: statement.data.processId }
      : { ok: false, why: 'malformed' })),
  };
  const world = {
    height: 100, ownStatus: null, listReady: true, listWaiters: [],
  };
  const listEvents = new EventEmitter();
  const networkStateServiceStub = {
    onReady: (callback) => {
      if (world.listReady) callback();
      else world.listWaiters.push(callback);
    },
    onListUpdated: (callback) => {
      listEvents.on('updated', callback);
      return () => listEvents.off('updated', callback);
    },
    listUpdated: () => listEvents.emit('updated'),
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
      lockoutFor: stubs.lockoutFor,
      certificatesFor: stubs.certificatesFor,
    },
    './appMessaging/peerNotification': {
      checkAndNotifyPeersOfRunningApps: stubs.announce,
      holdAnnouncements: stubs.hold,
      releaseAnnouncements: stubs.release,
    },
    './appMessaging/messageStore': {
      APP_STATE_EVENT_TYPES: { NODEALIVE: 'nodealive' },
      storeAppStateEvent: stubs.storeState,
    },
    './quorumGrant/grantorController': { noteReturnFromUnreachability: stubs.noteReturn },
    './appMesh/meshOrdinals': { noteReturnFromUnreachability: stubs.noteMeshReturn },
    './fluxNetworkHelper': {
      getLocalSocketAddress: sinon.stub().resolves(MY_IP),
      getFluxNodePrivateKey: sinon.stub().resolves('L1x'),
    },
    './nodeConfirmationService': { getNodeStatus: () => world.ownStatus },
    './verificationHelper': { signMessage: stubs.signMessage, verifyMessage: stubs.verifyMessage },
    './utils/fluxBroadcastHelper': { serialiseAndSignFluxBroadcast: stubs.sign },
    './utils/stopStatements': { verifyStop: stubs.verifyStop },
  });
  if (opts.placementCheck !== false) service.setPlacementCheck(stubs.enforcePlacement);
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

// The alive records this node sent: each broadcast of its own type.
const aliveSent = (transport) => transport.broadcastMessageToAll.getCalls()
  .map((c) => c.args[0]).filter((m) => m.type === 'fluxnodealive');

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
  transport.openEphemeralConnection = sinon.stub().callsFake(() => Promise.resolve(fakePeer('pong')));
}

// An ephemeral peer as the probe sees it: a socket that answers the ping
// with a pong, hangs up first, or says nothing.
function fakePeer(answer = 'pong') {
  const ws = new EventEmitter();
  ws.ping = sinon.stub().callsFake(() => {
    if (answer === 'pong') setImmediate(() => ws.emit('pong'));
    if (answer === 'close') setImmediate(() => ws.emit('close', 4019, 'node not confirmed'));
  });
  return { ws, close: sinon.stub() };
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

  it('identifies itself by the outpoint its own status carries, whatever address the list shows for it', async () => {
    // A node whose address moved is listed at the old one until the chain
    // records the move. Its outpoint has not changed, and the daemon states it.
    const harness = makeHarness();
    const { service, transport, networkStateServiceStub, world } = harness;
    withDuty(harness);
    networkStateServiceStub.networkState = () => [
      { txhash: 'me', outidx: 0, pubkey: 'pk', ip: '10.0.0.9:16127', added_height: 1 },
      { txhash: 'x', outidx: 0, pubkey: 'pkx', ip: DUTY_IP, added_height: 1 },
    ];
    world.ownStatus = { txhash: 'me', outidx: '0' };
    service.start(transport);
    await tick();
    try {
      sinon.assert.calledWith(transport.dial, DUTY_IP);
    } finally {
      service.stop();
    }
  });

  it('dials its duties the moment the node list arrives, when it started before the list', async () => {
    const harness = makeHarness();
    const { service, transport, networkStateServiceStub, world } = harness;
    withDuty(harness);
    const listed = networkStateServiceStub.nodeDownTopology;
    networkStateServiceStub.nodeDownTopology = () => null;
    world.listReady = false;
    service.start(transport);
    await tick();
    try {
      sinon.assert.notCalled(transport.dial);
      networkStateServiceStub.nodeDownTopology = listed;
      world.listReady = true;
      world.listWaiters.forEach((callback) => callback());
      await tick();
      sinon.assert.calledWith(transport.dial, DUTY_IP);
    } finally {
      service.stop();
    }
  });

  it('re-reads its duties when the list moves, and not on a block that moved nothing', async () => {
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport, networkStateServiceStub } = harness;
    service.start(transport);
    await tick();
    try {
      let reads = 0;
      const before = networkStateServiceStub.networkState;
      networkStateServiceStub.networkState = () => { reads += 1; return before(); };
      networkStateServiceStub.listUpdated();
      await tick();
      expect(reads, 'the same membership: nothing re-read').to.equal(0);
      await listMoved(networkStateServiceStub);
      expect(reads, 'the list moved: the duty index rebuilt').to.be.greaterThan(0);
    } finally {
      service.stop();
    }
  });

  it('a verdict message without a verdict is dropped and said once per sender, again only after a well-formed one', async () => {
    const warn = sinon.stub(log, 'warn');
    const said = () => warn.args.map(([line]) => line).filter((line) => line.includes('carries no verdict')).length;
    const { service, transport } = makeHarness();
    service.start(transport);
    await tick();
    try {
      service.onVerdictMessage({ pubKey: 'pk-a', data: { type: 'fluxnodedownverdict' } });
      service.onVerdictMessage({ pubKey: 'pk-a', data: { type: 'fluxnodedownverdict', verdict: null } });
      expect(said(), 'two malformed from one sender, one line').to.equal(1);
      service.onVerdictMessage({ pubKey: 'pk-b', data: { type: 'fluxnodedownverdict' } });
      expect(said(), 'another sender is its own edge').to.equal(2);
      // a well-formed one from pk-a re-arms its edge (whatever the juror makes of it)
      service.onVerdictMessage({ pubKey: 'pk-a', data: { type: 'fluxnodedownverdict', verdict: { subject: 's:0', juror: 'j:0' } } });
      service.onVerdictMessage({ pubKey: 'pk-a', data: { type: 'fluxnodedownverdict' } });
      expect(said()).to.equal(3);
    } finally {
      service.stop();
      warn.restore();
    }
  });

  it('registers exactly once and stays registered for the service lifetime', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();
    expect(stubs.registerWithGrantPlane.callCount).to.equal(1);
    service.stop();
  });

  // Nothing here may be the reason an app is deleted: with no check wired, the
  // node keeps its apps and announces, as it does when the check throws.
  it('announces when no placement check is wired', async () => {
    const { service, transport, stubs } = makeHarness({ placementCheck: false });
    service.start(transport);
    await tick();

    await service.onCertificateBroadcast({
      certificate: { subject: MY_OUTPOINT, height: 100 },
      broadcastedAt: Date.now(),
    });
    await tick();

    expect(stubs.announce.callCount).to.equal(1);
    service.stop();
  });

  it('a certificate about THIS node runs the placement check and announces only while the rows still place it — the refutation path', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();

    const result = await service.onCertificateBroadcast({
      certificate: { subject: MY_OUTPOINT, height: 100 },
      broadcastedAt: Date.now(),
    });
    expect(result.rebroadcast).to.equal(true);
    await tick();
    sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'certificate');
    expect(stubs.announce.callCount).to.equal(1);

    // past the grace: the network has moved on, the node removes and says nothing
    stubs.enforcePlacement.resolves({ placed: false, removed: ['app1'] });
    await service.onCertificateBroadcast({
      certificate: { subject: MY_OUTPOINT, height: 101 },
      broadcastedAt: Date.now(),
    });
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(2);
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

  describe('the lockout — the stand-down held open, the inbound refused, the lapse still probed', () => {
    it('start installs the peering gate; stop removes it', async () => {
      const { service, transport } = makeHarness();
      service.start(transport);
      await tick();
      expect(transport.peerManager.setInboundGate.callCount).to.equal(1);
      expect(transport.peerManager.setInboundGate.firstCall.args[0]).to.be.a('function');
      service.stop();
      expect(transport.peerManager.setInboundGate.lastCall.args[0]).to.equal(null);
    });

    it('the gate refuses a listed subject under lockout and admits everyone else — a placement freeze refuses nobody', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();
      const gate = transport.peerManager.setInboundGate.firstCall.args[0];

      expect(await gate(DUTY_IP)).to.deep.equal({
        admitted: false, reason: 'locked_out', subject: DUTY_OUTPOINT, tell: [],
      });
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: false, count: 3, liftsAt: null });
      expect(await gate(DUTY_IP)).to.deep.equal({ admitted: true, reason: 'not_locked_out', juror: false });
      expect(await gate(MY_IP)).to.deep.equal({ admitted: true, reason: 'not_locked_out', juror: false });
      expect(await gate('10.0.0.9:16127')).to.deep.equal({ admitted: true, reason: 'unlisted', juror: false });
      service.stop();
    });

    // A juror held off by the inbound cap cannot watch: the gate marks this
    // node's own jurors for the peer manager, read from THIS node's jury.
    it('the gate marks a dialer on this node\'s own jury, and no other', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs, networkStateServiceStub } = harness;
      const topology = networkStateServiceStub.nodeDownTopology();
      networkStateServiceStub.nodeDownTopology = () => ({
        ...topology,
        jury: (outpoint) => (outpoint === MY_OUTPOINT ? [{ outpoint: DUTY_OUTPOINT }] : []),
      });
      stubs.lockoutFor.resolves({ lockedOut: false, count: 0, liftsAt: null });
      service.start(transport);
      await tick();
      const gate = transport.peerManager.setInboundGate.firstCall.args[0];

      expect(await gate(DUTY_IP)).to.deep.equal({ admitted: true, reason: 'not_locked_out', juror: true });
      expect(await gate(MY_IP), 'a listed node off the jury').to.deep.include({ juror: false });

      stubs.lockoutFor.rejects(new Error('store down'));
      expect(await gate(DUTY_IP), 'marked when the lockout lookup fails too').to.deep.equal({ admitted: true, reason: 'store_error', juror: true });
      service.stop();
    });

    it('a locked-out duty stays out of the dial plan though its certificate is refuted', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs, networkStateServiceStub } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'refuted', key: 'nodedown:x:0:90' });
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.callCount).to.equal(0);

      // the hold lifts: the same refuted record now lets the duty be dialed
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: false, count: 3, liftsAt: null });
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });

    it('the trip drops a held connection to the subject', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      transport.peerManager.has = (socketAddress) => socketAddress === DUTY_IP;
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();

      await service.onCertificateBroadcast({
        certificate: { subject: DUTY_OUTPOINT, height: 100 },
        broadcastedAt: Date.now(),
      });
      expect(transport.closePeer.args).to.deep.equal([[DUTY_IP, 'locked out']]);
      service.stop();
    });

    it('a certificate this node assembled itself trips the lockout like one it received: the held connection is dropped', async () => {
      // On a full jury every juror collects and assembles, and the gossip
      // copies that follow are refused as already standing, so the fourth
      // certificate reaches most survivors as their own assembly and never
      // as an intake. The fleet showed it: four rows on every survivor, one
      // lockout announced.
      const harness = makeHarness();
      withDuty(harness);
      const {
        service, transport, stubs, networkStateServiceStub,
      } = harness;
      const jury = [
        { key: MY_OUTPOINT, outpoint: MY_OUTPOINT, owner: 'me' },
        { key: 'j:0', outpoint: 'j:0', owner: 'oj' },
      ];
      const listed = networkStateServiceStub.nodeDownTopology();
      networkStateServiceStub.nodeDownTopology = () => ({ ...listed, juryAt: () => jury });
      transport.openEphemeralConnection = sinon.stub().callsFake(() => Promise.resolve(fakePeer('close')));
      transport.peerManager.has = (socketAddress) => socketAddress === DUTY_IP;
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();

      // my own verdict: the duty dropped unannounced and the probe was hung up on
      transport.peerManager.emit('peer:removed', {
        ip: '10.0.0.2', port: '16127', direction: 'outbound', closeCode: 1006,
      });
      await tick();
      await tick();
      expect(transport.broadcastMessageToAll.callCount, 'one owner is below H').to.equal(0);

      // the second owner's verdict crosses H: this node assembles and stores
      service.onVerdictMessage({
        pubKey: 'pkj',
        data: {
          type: 'fluxnodedownverdict',
          verdict: {
            subject: DUTY_OUTPOINT, juror: 'j:0', judgement: 'unreachable', height: 100, fingerprint: 'fp1', signature: 'sig-j',
          },
        },
      });
      await tick();
      await tick();
      expect(transport.broadcastMessageToAll.callCount).to.equal(1);
      expect(transport.broadcastMessageToAll.firstCall.args[0].type).to.equal('fluxnodedown');
      expect(stubs.handleNodeDownEvent.callCount).to.equal(1);
      expect(transport.closePeer.args).to.deep.equal([[DUTY_IP, 'locked out']]);
      service.stop();
    });

    it('the door hands a locked-out dialer every row it holds, signed, oldest first; an admitted dialer is told nothing', async () => {
      // Every juror stands down and every door closes, so the door is the one
      // place a locked-out node can still hear. It hears the network's word —
      // the rows, which its own intake verifies — not a reason string.
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      stubs.certificatesFor.withArgs(DUTY_OUTPOINT).resolves([
        { certificate: { subject: DUTY_OUTPOINT, height: 90 }, broadcastedAt: 1000 },
        { certificate: { subject: DUTY_OUTPOINT, height: 100 }, broadcastedAt: 2000 },
      ]);
      service.start(transport);
      await tick();
      const gate = transport.peerManager.setInboundGate.firstCall.args[0];

      const refused = await gate(DUTY_IP);
      expect(refused.admitted).to.equal(false);
      expect(refused.tell.map((frame) => JSON.parse(frame))).to.deep.equal([
        {
          type: 'fluxnodedown', version: 1, certificate: { subject: DUTY_OUTPOINT, height: 90 }, broadcastedAt: 1000,
        },
        {
          type: 'fluxnodedown', version: 1, certificate: { subject: DUTY_OUTPOINT, height: 100 }, broadcastedAt: 2000,
        },
      ]);
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: false, count: 3, liftsAt: null });
      expect((await gate(DUTY_IP)).tell).to.equal(undefined);
      service.stop();
    });

    it('a certificate about this node that locks it out runs the removal though a return is pending: a locked-out node\'s return never completes', async () => {
      const { service, transport, stubs } = makeHarness();
      service.start(transport);
      await tick();
      floor().raise('2 peers');
      floor().lower('0 peers');
      transport.peerManager.emit('peer:added', {});
      await tick();

      // the fourth row about ME, handed over at a door while the return is pending
      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      stubs.enforcePlacement.resolves({ placed: false, removed: ['app'], failed: [] });
      await service.onCertificateBroadcast({
        certificate: {
          subject: MY_OUTPOINT, height: 4, fingerprint: 'fp', verdicts: [],
        },
        broadcastedAt: Date.now(),
      });
      await tick();
      sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'lockout');
      expect(stubs.release.callCount).to.equal(1);
      expect(stubs.announce.callCount, 'a locked-out node announces nothing').to.equal(0);
      expect(aliveSent(transport), 'a lockout holds the stand-down open: no alive record').to.deep.equal([]);

      // the lockout answered the return's question: the network back later runs no second check
      floor().raise('2 peers');
      synced().raise('ephemeral state sync complete');
      await tick();
      expect(stubs.enforcePlacement.callCount).to.equal(1);
      service.stop();
    });

    it('the reconciler reads the lockout on this node: locked out, it dials no duty; lifted, it dials again', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs, networkStateServiceStub } = harness;
      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.callCount).to.equal(0);

      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: false, count: 0, liftsAt: null });
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });

    it('a store that cannot be read does not stop the pass: the reading stays the last one, and the duty is still dialled', async () => {
      // 217 on chud, 2026-09-07: the poisoned source's every pass failed on the
      // failpoint ("ringReconciler pass failed"), so it dialled nobody and the
      // joiner never got its fourth peer. The pass awaits this reading first.
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs, networkStateServiceStub } = harness;
      stubs.lockoutFor.withArgs(MY_OUTPOINT).rejects(new Error('Failing command via failpoint'));
      service.start(transport);
      await tick();
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.callCount, 'the pass went on to its plan').to.be.at.least(1);
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      expect(service.isLockedOut()).to.equal(false);

      // the last reading is kept, whichever way it read
      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      await listMoved(networkStateServiceStub);
      await tick();
      expect(service.isLockedOut()).to.equal(true);
      const dialled = transport.dial.callCount;
      stubs.lockoutFor.withArgs(MY_OUTPOINT).rejects(new Error('Failing command via failpoint'));
      await listMoved(networkStateServiceStub);
      await tick();
      expect(service.isLockedOut(), 'unreadable: still locked out').to.equal(true);
      expect(transport.dial.callCount, 'locked out: dialled nobody').to.equal(dialled);
      service.stop();
    });

    it('a dial-back is refused for a locked-out node only: a node whose record merely stands is answered, since its ask is proof it is back', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      expect(await service.mayDialBack(DUTY_IP)).to.deep.equal({ allowed: true, reason: 'not_started' });
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();
      expect(await service.mayDialBack(DUTY_IP)).to.deep.equal({ allowed: false, reason: 'locked_out', subject: DUTY_OUTPOINT });
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: false, count: 3, liftsAt: null });
      expect(await service.mayDialBack(DUTY_IP), 'standing, not locked out: answered').to.deep.equal({ allowed: true, reason: 'not_locked_out', subject: DUTY_OUTPOINT });
      expect(await service.mayDialBack('10.0.0.9:16127')).to.deep.equal({ allowed: true, reason: 'unlisted' });
      service.stop();
    });

    it('a certificate that locks this node out is remembered: isLockedOut answers from the last reading, a peering added while it holds is closed, and a later reading clears it', async () => {
      const harness = makeHarness();
      withDuty(harness); // a topology, so the reconciler's pass reads the lockout
      const { service, transport, stubs, networkStateServiceStub } = harness;
      service.start(transport);
      await tick();
      expect(service.isLockedOut()).to.equal(false);

      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      stubs.enforcePlacement.resolves({ placed: false, removed: ['app'], failed: [] });
      await service.onCertificateBroadcast({
        certificate: {
          subject: MY_OUTPOINT, height: 4, fingerprint: 'fp', verdicts: [],
        },
        broadcastedAt: Date.now(),
      });
      await tick();
      expect(service.isLockedOut()).to.equal(true);
      transport.peerManager.emit('peer:added', { ip: '10.0.0.2', port: '16127', direction: 'inbound' });
      await tick();
      expect(transport.closePeer.args).to.deep.equal([['10.0.0.2:16127', 'locked out']]);

      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: false, count: 3, liftsAt: null });
      await listMoved(networkStateServiceStub);
      await tick();
      expect(service.isLockedOut()).to.equal(false);
      service.stop();
    });

    it('a peering added with a locked-out duty is closed as it is added, whichever end dialled; a duty not locked out is kept', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();
      transport.peerManager.emit('peer:added', { ip: '10.0.0.2', port: '16127', direction: 'outbound' });
      await tick();
      expect(transport.closePeer.args).to.deep.equal([[DUTY_IP, 'locked out']]);

      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: false, count: 3, liftsAt: null });
      transport.peerManager.emit('peer:added', { ip: '10.0.0.2', port: '16127', direction: 'outbound' });
      await tick();
      expect(transport.closePeer.callCount, 'a duty not locked out is kept').to.equal(1);
      service.stop();
    });

    it('the record lapsing under the hold probes the subject once — the jury never loses a still-dark node', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs, networkStateServiceStub } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.openEphemeralConnection.callCount).to.equal(0);

      // the row expired unrefuted
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'none', key: null });
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.openEphemeralConnection.args).to.deep.equal([[DUTY_IP]]);
      expect(transport.dial.callCount).to.equal(0); // the hold itself never lifted

      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.openEphemeralConnection.callCount).to.equal(1); // once per lapse
      service.stop();
    });

    it('a refutation is a return, not a lapse: no probe', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs, networkStateServiceStub } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      service.start(transport);
      await tick();
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'refuted', key: 'nodedown:x:0:90' });
      await listMoved(networkStateServiceStub);
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
      await listMoved(networkStateServiceStub);
      await tick();

      // x is listed again later with no record: a fresh start, not a lapse
      networkStateServiceStub.nodeDownTopology = listed;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'none', key: null });
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.openEphemeralConnection.callCount).to.equal(0);
      service.stop();
    });

    it('the lapse probe fires without a hold too: a still-dark node is re-certified, not forgotten', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs, networkStateServiceStub } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      service.start(transport);
      await tick();
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'none', key: null });
      await listMoved(networkStateServiceStub);
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
        transport.peerManager.emit('peer:answered', { ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound' });
        world.height += 1;
      }
      await tick();
    }

    it('four unexpected drop-and-return cycles damp the duty: no dial while the floor is short, a dial once a window has passed', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, world, networkStateServiceStub } = harness;
      service.start(transport);
      await tick();
      await cycles(harness, 4);
      transport.dial.resetHistory(); // the dials the cycles themselves drew, before the trip

      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.callCount).to.equal(0);

      world.height += 90;
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });

    it('a deliberate close is not a drop: four policy closes damp nothing', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, networkStateServiceStub } = harness;
      service.start(transport);
      await tick();
      await cycles(harness, 4, 4009);

      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });

    it('the count dies with the service: a restart starts every duty from the bottom', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, networkStateServiceStub } = harness;
      service.start(transport);
      await tick();
      await cycles(harness, 4);
      service.stop();

      transport.dial.resetHistory();
      service.start(transport);
      await tick();
      await listMoved(networkStateServiceStub);
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });
  });

  it('returning from total unreachability re-fetches grant records from the first peer back, and announces only once the floor stands and the resync says the rows still place it', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();
    floor().raise('2 peers');

    // an ordinary drop with the floor standing marks nothing
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    transport.peerManager.emit('peer:added', {});
    await tick();
    expect(stubs.noteReturn.callCount).to.equal(0);
    expect(stubs.noteMeshReturn.callCount).to.equal(0);

    // the floor falls: the first peer back is the return notice, once
    floor().lower('0 peers');
    transport.peerManager.emit('peer:added', {});
    transport.peerManager.emit('peer:added', {});
    await tick();
    expect(stubs.noteReturn.callCount).to.equal(1);
    expect(stubs.noteMeshReturn.callCount).to.equal(1);
    // no announce yet: the store has not caught up
    expect(stubs.enforcePlacement.callCount).to.equal(0);
    expect(stubs.announce.callCount).to.equal(0);

    // the floor stands again, the resync has not completed: still nothing
    floor().raise('2 peers');
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(0);

    // the recovery's resync completes: the check runs, then the announce
    synced().raise('ephemeral state sync complete');
    await tick();
    sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'return');
    expect(stubs.announce.callCount).to.equal(1);

    // a later resync is not a return
    synced().lower('resyncing');
    synced().raise('ephemeral state sync complete');
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(1);
    service.stop();
  });

  it('a resync completing below the floor is not a return; the floor standing again is', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();
    floor().raise('2 peers');
    synced().raise('ephemeral state sync complete');
    floor().lower('0 peers');
    synced().lower('resyncing');
    await tick();
    expect(stubs.hold.callCount).to.equal(1);

    synced().raise('block fallback elapsed taking live broadcasts');
    await tick();
    expect(stubs.enforcePlacement.callCount, 'one peer or none: not the network').to.equal(0);
    expect(stubs.release.callCount).to.equal(0);

    floor().raise('2 peers');
    await tick();
    sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'return');
    expect(stubs.release.callCount).to.equal(1);
    service.stop();
  });

  it('losing the floor holds the announcements until the return check has answered, and the release comes before the announce', async () => {
    // A node with no peer keeps announcing to nobody and storing every
    // announce; on return those announces refute, in its own store, the
    // certificate the network formed while it was dark, and the check keeps
    // apps the network has replaced. On the fleet the subject announced every
    // thirty seconds through a seven-minute partition and again a second
    // after the heal, and never removed its app.
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();
    floor().raise('2 peers');

    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    expect(stubs.hold.callCount, 'the floor stands: nothing is held').to.equal(0);

    floor().lower('0 peers');
    expect(stubs.hold.callCount, 'the floor gone: held').to.equal(1);
    transport.peerManager.emit('peer:added', {});
    await tick();
    expect(stubs.release.callCount, 'a peer back is not the network back').to.equal(0);
    floor().raise('2 peers');
    await tick();
    expect(stubs.release.callCount, 'the floor back is not the store caught up').to.equal(0);

    synced().raise('ephemeral state sync complete');
    await tick();
    expect(stubs.release.callCount).to.equal(1);
    expect(stubs.announce.callCount).to.equal(1);
    sinon.assert.callOrder(stubs.enforcePlacement, stubs.release, stubs.announce);
    service.stop();
  });

  describe('the live-isolation clock', () => {
    let clock;
    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    });
    afterEach(() => clock.restore());

    it('no network for the grace removes every app where the node stands, once, and the return check still runs when the network is back', async () => {
      const { service, transport, stubs } = makeHarness();
      stubs.enforcePlacement.withArgs('isolated').resolves({ placed: false, removed: ['app'], failed: [] });
      service.start(transport);
      await tick();
      floor().raise('2 peers');
      floor().lower('0 peers');

      clock.tick(NODE_DOWN_GRACE_MS - 1);
      await tick();
      expect(stubs.enforcePlacement.callCount, 'inside the grace: nothing').to.equal(0);
      clock.tick(1);
      await tick();
      sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'isolated');
      expect(stubs.release.callCount, 'still dark: still held').to.equal(0);
      clock.tick(NODE_DOWN_GRACE_MS);
      await tick();
      expect(stubs.enforcePlacement.callCount, 'once per outage').to.equal(1);

      floor().raise('2 peers');
      synced().raise('ephemeral state sync complete');
      await tick();
      expect(stubs.enforcePlacement.args.map(([trigger]) => trigger)).to.deep.equal(['isolated', 'return']);
      expect(stubs.release.callCount).to.equal(1);
      service.stop();
    });

    it('a peer reaching this node cancels the clock, and every peer gone again runs the grace again from that drop', async () => {
      const { service, transport, stubs } = makeHarness();
      let peersDown = false;
      transport.peerManager.allPeersDown = () => peersDown;
      service.start(transport);
      await tick();
      floor().raise('2 peers');
      peersDown = true;
      floor().lower('0 peers');
      clock.tick(NODE_DOWN_GRACE_MS - 1);

      // one peer back: the fleet can reach this node; the grace stops
      peersDown = false;
      transport.peerManager.emit('peer:added', {});
      await tick();
      clock.tick(NODE_DOWN_GRACE_MS);
      await tick();
      expect(stubs.enforcePlacement.callCount, 'reached: no removal').to.equal(0);
      expect(stubs.release.callCount, 'one peer is not the network back: still held').to.equal(0);

      // that peer gone too: the grace runs from this drop, not the first
      peersDown = true;
      transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
      clock.tick(NODE_DOWN_GRACE_MS - 1);
      await tick();
      expect(stubs.enforcePlacement.callCount).to.equal(0);
      clock.tick(1);
      await tick();
      sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'isolated');
      service.stop();
    });

    it('the network back inside the grace cancels the clock', async () => {
      const { service, transport, stubs } = makeHarness();
      service.start(transport);
      await tick();
      floor().raise('2 peers');
      floor().lower('0 peers');
      clock.tick(NODE_DOWN_GRACE_MS - 1);
      floor().raise('2 peers');
      synced().raise('ephemeral state sync complete');
      await tick();
      sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'return');
      clock.tick(NODE_DOWN_GRACE_MS * 2);
      await tick();
      expect(stubs.enforcePlacement.callCount).to.equal(1);
      service.stop();
    });

    it('a lockout answers the question first: the clock is cancelled with the pending return', async () => {
      const { service, transport, stubs } = makeHarness();
      service.start(transport);
      await tick();
      floor().raise('2 peers');
      floor().lower('0 peers');
      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      stubs.enforcePlacement.resolves({ placed: false, removed: ['app'], failed: [] });
      await service.onCertificateBroadcast({
        certificate: {
          subject: MY_OUTPOINT, height: 4, fingerprint: 'fp', verdicts: [],
        },
        broadcastedAt: Date.now(),
      });
      await tick();
      sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'lockout');
      clock.tick(NODE_DOWN_GRACE_MS * 2);
      await tick();
      expect(stubs.enforcePlacement.callCount).to.equal(1);
      service.stop();
    });

    it('stopping the service cancels the clock and releases the hold', async () => {
      const { service, transport, stubs } = makeHarness();
      service.start(transport);
      await tick();
      floor().raise('2 peers');
      floor().lower('0 peers');
      service.stop();
      expect(stubs.release.callCount).to.equal(1);
      clock.tick(NODE_DOWN_GRACE_MS * 2);
      await tick();
      expect(stubs.enforcePlacement.callCount).to.equal(0);
    });
  });

  it('a peering is a hold once the far end has spoken: the add retires nothing, the first frame does', async () => {
    // A node refusing at the door completes the handshake and hangs up
    // before it says anything; on the fleet every juror's redial to a
    // listed-but-unconfirmed subject was a four-millisecond hold that
    // retired the deferral, and the grace-end look never came.
    const noteHeld = sinon.spy(NodeDownJuror.prototype, 'noteHeld');
    try {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport } = harness;
      service.start(transport);
      await tick();
      transport.peerManager.emit('peer:added', { ip: '10.0.0.2', port: '16127', direction: 'outbound' });
      await tick();
      expect(noteHeld.callCount, 'the handshake is not a hold').to.equal(0);
      transport.peerManager.emit('peer:answered', { ip: '10.0.0.2', port: '16127', direction: 'outbound' });
      await tick();
      expect(noteHeld.callCount, 'the first frame is').to.equal(1);
      service.stop();
      expect(transport.peerManager.listenerCount('peer:answered')).to.equal(0);
    } finally {
      noteHeld.restore();
    }
  });

  it('a certificate about this node arriving while the return is pending runs no check: the return check reads the whole store', async () => {
    // The recovery's resync delivered C's refuted certificate ahead of D's; the
    // check ran on the first, found the rows still placing the node, released
    // the hold and announced, and that announce refuted D's certificate on
    // every survivor. On the fleet the subject never removed its app.
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();
    floor().raise('2 peers');
    floor().lower('0 peers');
    transport.peerManager.emit('peer:added', {});
    await tick();

    // a certificate about ME lands over the resync while the return is pending
    stubs.handleNodeDownEvent.resolves({ accepted: true, rebroadcast: false, reason: 'stored' });
    await service.onCertificateSyncEvent({ data: { certificate: { subject: MY_OUTPOINT, height: 1, fingerprint: 'fp', verdicts: [] }, broadcastedAt: Date.now() } });
    await tick();
    expect(stubs.enforcePlacement.callCount, 'no check on a store the resync is still filling').to.equal(0);
    expect(stubs.release.callCount).to.equal(0);
    expect(stubs.announce.callCount).to.equal(0);

    floor().raise('2 peers');
    synced().raise('ephemeral state sync complete');
    await tick();
    sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'return');
    expect(stubs.release.callCount).to.equal(1);
    service.stop();
  });

  it('a certificate about this node older than the record held is stored for the count and runs no check', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();
    stubs.handleNodeDownEvent.resolves({
      accepted: true, rebroadcast: false, reason: 'stored', superseded: true,
    });
    await service.onCertificateSyncEvent({ data: { certificate: { subject: MY_OUTPOINT, height: 1, fingerprint: 'fp', verdicts: [] }, broadcastedAt: Date.now() - 60_000 } });
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(0);
    expect(stubs.announce.callCount).to.equal(0);
    service.stop();
  });

  it('a node whose rows no longer place it releases the hold on return, announces no app, and sends its alive record', async () => {
    const { service, transport, stubs } = makeHarness();
    stubs.enforcePlacement.resolves({ placed: false, removed: ['app1'] });
    service.start(transport);
    await tick();
    floor().raise('2 peers');
    floor().lower('0 peers');
    transport.peerManager.emit('peer:added', {});
    await tick();
    floor().raise('2 peers');
    synced().raise('ephemeral state sync complete');
    await tick();
    expect(stubs.release.callCount).to.equal(1);
    expect(stubs.announce.callCount).to.equal(0);
    const alive = aliveSent(transport);
    expect(alive.map((m) => m.ip), 'the node refutes whatever it holds').to.deep.equal([MY_IP]);
    sinon.assert.calledOnceWithMatch(stubs.storeState, 'nodealive', {
      message: alive[0], announcer: { txhash: 'me', outidx: '0' },
    });
    service.stop();
  });

  it('a node whose rows no longer place it removes on return and announces nothing', async () => {
    const { service, transport, stubs } = makeHarness();
    stubs.enforcePlacement.resolves({ placed: false, removed: ['app1'] });
    service.start(transport);
    await tick();
    floor().raise('2 peers');
    floor().lower('0 peers');
    transport.peerManager.emit('peer:added', {});
    await tick();
    floor().raise('2 peers');
    synced().raise('ephemeral state sync complete');
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(1);
    expect(stubs.announce.callCount).to.equal(0);
    service.stop();
  });

  it('stop forgets a return still waiting for its resync', async () => {
    const { service, transport, stubs } = makeHarness();
    service.start(transport);
    await tick();
    floor().raise('2 peers');
    floor().lower('0 peers');
    transport.peerManager.emit('peer:added', {});
    await tick();
    service.stop();
    floor().raise('2 peers');
    synced().raise('ephemeral state sync complete');
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(0);
    expect(stubs.release.callCount, 'stop releases what it held').to.equal(1);
  });
});

describe('nodeDownService — the drop carries its reason, and the probe is an exchange', () => {
  const DUTY_PORT = '16127';
  const DUTY_HOST = '10.0.0.2';

  // A coded close carries a signed stop of a new process unless told otherwise.
  let processSeq = 0;
  function drop(transport, closeCode, stopStatement = undefined) {
    processSeq += 1;
    transport.peerManager.emit('peer:removed', {
      ip: DUTY_HOST,
      port: DUTY_PORT,
      direction: 'outbound',
      closeCode,
      stopStatement: stopStatement === undefined
        ? { data: { processId: processSeq.toString(16).padStart(32, '0') } }
        : stopStatement,
    });
  }
  function held(transport) {
    transport.peerManager.emit('peer:added', { ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound' });
    // a held duty is one that has spoken: the first frame notes the hold
    transport.peerManager.emit('peer:answered', { ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound' });
  }

  afterEach(() => sinon.restore());

  it('a SHUTTING_DOWN close probes nothing at the drop and feeds no ladder; the grace end probes once while the duty is unheld', async () => {
    const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport, world } = harness;
    service.start(transport);
    await tick();

    // three coded drop-and-return cycles inside the courtesy: not one probe,
    // and no damping (the fourth close below is the last honoured one)
    for (let i = 0; i < 3; i += 1) {
      drop(transport, CLOSE_CODES.SHUTTING_DOWN);
      world.height += 1;
      held(transport);
      world.height += 1;
    }
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(0);
    transport.dial.resetHistory();
    await listMoved(harness.networkStateServiceStub);
    expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);

    // one more close and the duty stays unheld: the look comes at the grace end, once
    drop(transport, CLOSE_CODES.SHUTTING_DOWN);
    await tick();
    clock.tick(NODE_DOWN_GRACE_MS - 1);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(0);
    clock.tick(1);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    expect(transport.openEphemeralConnection.firstCall.args[0]).to.equal(DUTY_IP);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    service.stop();
    clock.restore();
  });

  it('a RESTARTING close is honoured for the shorter grace', async () => {
    const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport } = harness;
    service.start(transport);
    await tick();
    drop(transport, CLOSE_CODES.RESTARTING);
    await tick();
    clock.tick(RESTART_GRACE_MS - 1);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(0);
    clock.tick(1);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    service.stop();
    clock.restore();
  });

  it('a duty held again before the grace ends is not looked at', async () => {
    const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport } = harness;
    service.start(transport);
    await tick();
    drop(transport, CLOSE_CODES.SHUTTING_DOWN);
    held(transport);
    await tick();
    clock.tick(NODE_DOWN_GRACE_MS);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(0);
    service.stop();
    clock.restore();
  });

  it('a coded close\'s statement is checked as the closing node\'s, for the close\'s reason, within the close age', async () => {
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport, stubs } = harness;
    service.start(transport);
    await tick();
    drop(transport, CLOSE_CODES.RESTARTING);
    await tick();
    sinon.assert.calledOnce(stubs.verifyStop);
    expect(stubs.verifyStop.firstCall.args[1]).to.include({
      socketAddress: DUTY_IP, reason: 'restart', maxAgeMs: STOP_CLOSE_AGE_MS,
    });
    expect(transport.openEphemeralConnection.callCount, 'honoured: no look at the drop').to.equal(0);
    service.stop();
  });

  it('a coded close without a stop statement is looked at now', async () => {
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport } = harness;
    service.start(transport);
    await tick();
    drop(transport, CLOSE_CODES.RESTARTING, null);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    service.stop();
  });

  it('a coded close whose stop statement is refused is looked at now', async () => {
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport, stubs } = harness;
    stubs.verifyStop.resolves({ ok: false, why: 'age' });
    const said = sinon.spy(log, 'info');
    service.start(transport);
    await tick();
    drop(transport, CLOSE_CODES.SHUTTING_DOWN);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    expect(said.args.map((args) => args[0])).to.include(`nodeDownService: the stop statement on ${DUTY_IP}'s shutdown close is not accepted (age)`);
    service.stop();
  });

  it('a coded close whose statement cannot be checked is looked at now', async () => {
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport, stubs } = harness;
    stubs.verifyStop.rejects(new Error('list unavailable'));
    service.start(transport);
    await tick();
    drop(transport, CLOSE_CODES.SHUTTING_DOWN);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    service.stop();
  });

  it('an unannounced drop is still looked at now', async () => {
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport } = harness;
    service.start(transport);
    await tick();
    drop(transport, 1006);
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    service.stop();
  });

  it('the probe is an exchange: a pong is reachable, a hang-up before the pong is not, silence is not, and the connection is closed either way', async () => {
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport } = harness;
    service.start(transport);
    await tick();

    const answering = fakePeer('pong');
    transport.openEphemeralConnection = sinon.stub().resolves(answering);
    expect(await service.probe(DUTY_IP)).to.equal(true);
    sinon.assert.calledOnce(answering.ws.ping);
    sinon.assert.calledOnce(answering.close);

    const refusing = fakePeer('close');
    transport.openEphemeralConnection = sinon.stub().resolves(refusing);
    expect(await service.probe(DUTY_IP)).to.equal(false);
    sinon.assert.calledOnce(refusing.close);

    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const silent = fakePeer('silent');
    transport.openEphemeralConnection = sinon.stub().resolves(silent);
    const pending = service.probe(DUTY_IP);
    await clock.tickAsync(10_000);
    expect(await pending).to.equal(false);
    sinon.assert.calledOnce(silent.close);
    clock.restore();

    transport.openEphemeralConnection = sinon.stub().resolves(null);
    expect(await service.probe(DUTY_IP)).to.equal(false);
    service.stop();
  });
});

describe('nodeDownService — a subject\'s signed stop travels between its jurors', () => {
  const OTHER_JUROR = '10.0.0.3:16127';
  const statementOf = (processId) => ({ data: { type: 'fluxprocessstop', processId } });

  // This node and one other juror watch x.
  function withJury(harness) {
    withDuty(harness);
    const { networkStateServiceStub } = harness;
    const listed = networkStateServiceStub.networkState();
    networkStateServiceStub.networkState = () => [...listed, {
      txhash: 'j', outidx: 0, pubkey: 'pkj', ip: OTHER_JUROR, added_height: 1,
    }];
    const topology = networkStateServiceStub.nodeDownTopology();
    networkStateServiceStub.nodeDownTopology = () => ({
      ...topology,
      jury: () => [{ outpoint: MY_OUTPOINT }, { outpoint: 'j:0' }],
    });
  }

  afterEach(() => sinon.restore());

  it('a stop seen on the close is pushed to the other juror, verbatim, over an ephemeral connection', async () => {
    const harness = makeHarness();
    withJury(harness);
    const { service, transport } = harness;
    service.start(transport);
    await tick();
    const statement = statementOf('ab'.repeat(16));
    transport.peerManager.emit('peer:removed', {
      ip: '10.0.0.2', port: '16127', direction: 'outbound', closeCode: CLOSE_CODES.RESTARTING, stopStatement: statement,
    });
    await tick();
    await tick();
    expect(transport.openEphemeralConnection.args).to.deep.equal([[OTHER_JUROR]]);
    sinon.assert.calledOnce(transport.sendSignedMessage);
    expect(transport.sendSignedMessage.firstCall.args[0]).to.deep.equal({ type: 'fluxcourtesynote', version: 1, statement });
    service.stop();
  });

  it('a forwarded stop is checked within the forward age and held for the subject it names', async () => {
    const harness = makeHarness();
    withJury(harness);
    const { service, transport, stubs } = harness;
    stubs.verifyStop.callsFake(async (statement) => ({
      ok: true, ip: DUTY_IP, reason: 'restart', processId: statement.data.processId,
    }));
    service.start(transport);
    await tick();
    const statement = statementOf('cd'.repeat(16));
    await service.onCourtesyNote({ pubKey: 'pkj', data: { type: 'fluxcourtesynote', statement } });
    await tick();
    expect(stubs.verifyStop.firstCall.args[1]).to.include({ maxAgeMs: 10 * 60 * 1000 });
    // held, so forwarded on to the other juror
    expect(transport.sendSignedMessage.firstCall.args[0].statement).to.equal(statement);
    service.stop();
  });

  it('a forwarded stop that is refused is not held', async () => {
    const harness = makeHarness();
    withJury(harness);
    const { service, transport, stubs } = harness;
    stubs.verifyStop.resolves({ ok: false, why: 'age' });
    const said = sinon.spy(log, 'info');
    service.start(transport);
    await tick();
    await service.onCourtesyNote({ pubKey: 'pkj', data: { type: 'fluxcourtesynote', statement: statementOf('ef'.repeat(16)) } });
    await tick();
    sinon.assert.notCalled(transport.sendSignedMessage);
    expect(said.args.map((args) => args[0])).to.include('nodeDownService: a stop note from pkj is not accepted (age)');
    service.stop();
  });

  it('a forwarded stop of a node not in the list is not held', async () => {
    const harness = makeHarness();
    withJury(harness);
    const { service, transport, stubs } = harness;
    stubs.verifyStop.callsFake(async (statement) => ({
      ok: true, ip: '10.9.9.9:16127', reason: 'restart', processId: statement.data.processId,
    }));
    service.start(transport);
    await tick();
    await service.onCourtesyNote({ pubKey: 'pkj', data: { type: 'fluxcourtesynote', statement: statementOf('aa'.repeat(16)) } });
    await tick();
    sinon.assert.notCalled(transport.sendSignedMessage);
    service.stop();
  });
});
