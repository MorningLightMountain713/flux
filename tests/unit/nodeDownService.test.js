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
    lockoutFor: sinon.stub().resolves({ lockedOut: false, count: 0, liftsAt: null }),
    announce: sinon.stub(),
    hold: sinon.stub(),
    release: sinon.stub(),
    noteReturn: sinon.stub(),
    noteMeshReturn: sinon.stub(),
    enforcePlacement: sinon.stub().resolves({ placed: true, removed: [] }),
    signMessage: sinon.stub().returns('sig-me'),
    verifyMessage: sinon.stub().returns(true),
    certificatesFor: sinon.stub().resolves([]),
    sign: sinon.stub().callsFake(async (message) => JSON.stringify(message)),
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
      lockoutFor: stubs.lockoutFor,
      certificatesFor: stubs.certificatesFor,
    },
    './appMessaging/peerNotification': {
      checkAndNotifyPeersOfRunningApps: stubs.announce,
      holdAnnouncements: stubs.hold,
      releaseAnnouncements: stubs.release,
    },
    './appLifecycle/appStartupManager': { enforceNodePlacement: stubs.enforcePlacement },
    './quorumGrant/grantorController': { noteReturnFromUnreachability: stubs.noteReturn },
    './appMesh/meshOrdinals': { noteReturnFromUnreachability: stubs.noteMeshReturn },
    './fluxNetworkHelper': {
      getLocalSocketAddress: sinon.stub().resolves(MY_IP),
      getFluxNodePrivateKey: sinon.stub().resolves('L1x'),
    },
    './verificationHelper': { signMessage: stubs.signMessage, verifyMessage: stubs.verifyMessage },
    './utils/fluxBroadcastHelper': { serialiseAndSignFluxBroadcast: stubs.sign },
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

  it('a verdict message without a verdict is dropped and said once per sender, again only after a well-formed one', async () => {
    const log = require('../../ZelBack/src/lib/log');
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
      expect(await gate(DUTY_IP)).to.deep.equal({ admitted: true, reason: 'not_locked_out' });
      expect(await gate(MY_IP)).to.deep.equal({ admitted: true, reason: 'not_locked_out' });
      expect(await gate('10.0.0.9:16127')).to.deep.equal({ admitted: true, reason: 'unlisted' });
      service.stop();
    });

    it('a locked-out duty stays out of the dial plan though its certificate is refuted', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'refuted', key: 'nodedown:x:0:90' });
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();
      await service.sweep();
      await tick();
      expect(transport.dial.callCount).to.equal(0);

      // the hold lifts: the same refuted record now lets the duty be dialed
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: false, count: 3, liftsAt: null });
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

    it('a certificate about this node that locks it out runs the removal though a return is pending: a locked-out node\'s return sync never completes', async () => {
      const { appSyncEvents, EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
      const { service, transport, stubs } = makeHarness();
      let peersDown = false;
      transport.peerManager.allPeersDown = () => peersDown;
      service.start(transport);
      await tick();
      peersDown = true;
      transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
      peersDown = false;
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

      // the lockout answered the return's question: a pull completing later runs no second check
      appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, '1.2.3.4:16127');
      await tick();
      expect(stubs.enforcePlacement.callCount).to.equal(1);
      service.stop();
    });

    it('the reconciler reads the lockout on this node: locked out, it dials no duty; lifted, it dials again', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
      service.start(transport);
      await tick();
      await service.sweep();
      await tick();
      expect(transport.dial.callCount).to.equal(0);

      stubs.lockoutFor.withArgs(MY_OUTPOINT).resolves({ lockedOut: false, count: 0, liftsAt: null });
      await service.sweep();
      await tick();
      expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);
      service.stop();
    });

    it('a dial-back is refused for a stood-down node and allowed for anyone else', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      expect(await service.mayDialBack(DUTY_IP)).to.deep.equal({ allowed: true, reason: 'not_started' });
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      service.start(transport);
      await tick();
      expect(await service.mayDialBack(DUTY_IP)).to.deep.equal({ allowed: false, reason: 'stood_down', subject: DUTY_OUTPOINT });
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'refuted', key: 'nodedown:x:0:90' });
      expect(await service.mayDialBack(DUTY_IP)).to.deep.equal({ allowed: true, reason: 'not_stood_down', subject: DUTY_OUTPOINT });
      expect(await service.mayDialBack('10.0.0.9:16127')).to.deep.equal({ allowed: true, reason: 'unlisted' });
      service.stop();
    });

    it('the record lapsing under the hold probes the subject once — the jury never loses a still-dark node', async () => {
      const harness = makeHarness();
      withDuty(harness);
      const { service, transport, stubs } = harness;
      stubs.recordStateFor.withArgs(DUTY_OUTPOINT).resolves({ state: 'standing', key: 'nodedown:x:0:90' });
      stubs.lockoutFor.withArgs(DUTY_OUTPOINT).resolves({ lockedOut: true, count: 4, liftsAt: 1 });
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
        transport.peerManager.emit('peer:answered', { ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound' });
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

  it('returning from total unreachability re-fetches grant records at once, and announces only after the resync says the rows still place it', async () => {
    const { appSyncEvents, EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
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
    expect(stubs.noteMeshReturn.callCount).to.equal(1);
    // no announce yet: the store has not caught up
    expect(stubs.enforcePlacement.callCount).to.equal(0);
    expect(stubs.announce.callCount).to.equal(0);

    // the orchestrator's reconnect pull completes: the check runs, then the announce
    appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, '1.2.3.4:16127');
    await tick();
    sinon.assert.calledOnceWithExactly(stubs.enforcePlacement, 'return');
    expect(stubs.announce.callCount).to.equal(1);

    // a later pull completion is not a return
    appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, '1.2.3.4:16127');
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(1);
    service.stop();
  });

  it('losing every peer holds the announcements until the return check has answered, and the release comes before the announce', async () => {
    // A node with no peer keeps announcing to nobody and storing every
    // announce; on return those announces refute, in its own store, the
    // certificate the network formed while it was dark, and the check keeps
    // apps the network has replaced. On the fleet the subject announced every
    // thirty seconds through a seven-minute partition and again a second
    // after the heal, and never removed its app.
    const { appSyncEvents, EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
    const { service, transport, stubs } = makeHarness();
    let peersDown = false;
    transport.peerManager.allPeersDown = () => peersDown;
    service.start(transport);
    await tick();

    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    expect(stubs.hold.callCount, 'peers remain: nothing is held').to.equal(0);

    peersDown = true;
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    expect(stubs.hold.callCount, 'the last peer gone: held').to.equal(1);
    peersDown = false;
    transport.peerManager.emit('peer:added', {});
    await tick();
    expect(stubs.release.callCount, 'a peer back is not the store caught up').to.equal(0);

    appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, '1.2.3.4:16127');
    await tick();
    expect(stubs.release.callCount).to.equal(1);
    expect(stubs.announce.callCount).to.equal(1);
    sinon.assert.callOrder(stubs.enforcePlacement, stubs.release, stubs.announce);
    service.stop();
  });

  it('a peering is a hold once the far end has spoken: the add retires nothing, the first frame does', async () => {
    // A node refusing at the door completes the handshake and hangs up
    // before it says anything; on the fleet every juror's redial to a
    // listed-but-unconfirmed subject was a four-millisecond hold that
    // retired the deferral, and the grace-end look never came.
    const { NodeDownJuror } = require('../../ZelBack/src/services/utils/nodeDownJuror');
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
    // The reconnect pull delivered C's refuted certificate ahead of D's; the
    // check ran on the first, found the rows still placing the node, released
    // the hold and announced, and that announce refuted D's certificate on
    // every survivor. On the fleet the subject never removed its app.
    const { appSyncEvents, EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
    const { service, transport, stubs } = makeHarness();
    let peersDown = false;
    transport.peerManager.allPeersDown = () => peersDown;
    service.start(transport);
    await tick();
    peersDown = true;
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    peersDown = false;
    transport.peerManager.emit('peer:added', {});
    await tick();

    // a certificate about ME lands over the pull while the return is pending
    stubs.handleNodeDownEvent.resolves({ accepted: true, rebroadcast: false, reason: 'stored' });
    await service.onCertificateSyncEvent({ data: { certificate: { subject: MY_OUTPOINT, height: 1, fingerprint: 'fp', verdicts: [] }, broadcastedAt: Date.now() } });
    await tick();
    expect(stubs.enforcePlacement.callCount, 'no check on a store the pull is still filling').to.equal(0);
    expect(stubs.release.callCount).to.equal(0);
    expect(stubs.announce.callCount).to.equal(0);

    appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, '1.2.3.4:16127');
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

  it('a node whose rows no longer place it releases the hold on return and announces nothing', async () => {
    const { appSyncEvents, EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
    const { service, transport, stubs } = makeHarness();
    stubs.enforcePlacement.resolves({ placed: false, removed: ['app1'] });
    let peersDown = false;
    transport.peerManager.allPeersDown = () => peersDown;
    service.start(transport);
    await tick();
    peersDown = true;
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    peersDown = false;
    transport.peerManager.emit('peer:added', {});
    await tick();
    appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, '1.2.3.4:16127');
    await tick();
    expect(stubs.release.callCount).to.equal(1);
    expect(stubs.announce.callCount).to.equal(0);
    service.stop();
  });

  it('a node whose rows no longer place it removes on return and announces nothing', async () => {
    const { appSyncEvents, EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
    const { service, transport, stubs } = makeHarness();
    stubs.enforcePlacement.resolves({ placed: false, removed: ['app1'] });
    let peersDown = false;
    transport.peerManager.allPeersDown = () => peersDown;
    service.start(transport);
    await tick();
    peersDown = true;
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    peersDown = false;
    transport.peerManager.emit('peer:added', {});
    await tick();
    appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, '1.2.3.4:16127');
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(1);
    expect(stubs.announce.callCount).to.equal(0);
    service.stop();
  });

  it('stop forgets a return still waiting for its resync', async () => {
    const { appSyncEvents, EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
    const { service, transport, stubs } = makeHarness();
    let peersDown = false;
    transport.peerManager.allPeersDown = () => peersDown;
    service.start(transport);
    await tick();
    peersDown = true;
    transport.peerManager.emit('peer:removed', { ip: '1.2.3.4', port: '16127', closeCode: 4009 });
    peersDown = false;
    transport.peerManager.emit('peer:added', {});
    await tick();
    service.stop();
    appSyncEvents.emit(EVENTS.RECONNECT_SYNC_COMPLETE, '1.2.3.4:16127');
    await tick();
    expect(stubs.enforcePlacement.callCount).to.equal(0);
    expect(appSyncEvents.listenerCount(EVENTS.RECONNECT_SYNC_COMPLETE)).to.equal(0);
  });
});

describe('nodeDownService — the drop carries its reason, and the probe is an exchange', () => {
  const DUTY_PORT = '16127';
  const DUTY_HOST = '10.0.0.2';
  const { NODE_DOWN_GRACE_MS, RESTART_GRACE_MS } = require('../../ZelBack/src/services/utils/appConstants');
  const { CLOSE_CODES } = require('../../ZelBack/src/services/utils/FluxPeerSocket');

  function drop(transport, closeCode) {
    transport.peerManager.emit('peer:removed', {
      ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound', closeCode,
    });
  }
  function held(transport) {
    transport.peerManager.emit('peer:added', { ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound' });
    // a held duty is one that has spoken: the first frame notes the hold
    transport.peerManager.emit('peer:answered', { ip: DUTY_HOST, port: DUTY_PORT, direction: 'outbound' });
  }

  afterEach(() => sinon.restore());

  it('a SHUTTING_DOWN close probes nothing at the drop and feeds no ladder; the grace end probes once while the duty is unheld', async () => {
    const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
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
    await service.sweep();
    await tick();
    expect(transport.dial.firstCall.args[0]).to.equal(DUTY_IP);

    // one more close and the duty stays unheld: the look comes at the grace end, once
    drop(transport, CLOSE_CODES.SHUTTING_DOWN);
    await tick();
    clock.tick(NODE_DOWN_GRACE_MS - 1);
    await service.sweep();
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(0);
    clock.tick(1);
    await service.sweep();
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    expect(transport.openEphemeralConnection.firstCall.args[0]).to.equal(DUTY_IP);
    await service.sweep();
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    service.stop();
    clock.restore();
  });

  it('a RESTARTING close is honoured for the shorter grace', async () => {
    const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport } = harness;
    service.start(transport);
    await tick();
    drop(transport, CLOSE_CODES.RESTARTING);
    await tick();
    clock.tick(RESTART_GRACE_MS - 1);
    await service.sweep();
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(0);
    clock.tick(1);
    await service.sweep();
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(1);
    service.stop();
    clock.restore();
  });

  it('a duty held again before the grace ends is not looked at', async () => {
    const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
    const harness = makeHarness();
    withDuty(harness);
    const { service, transport } = harness;
    service.start(transport);
    await tick();
    drop(transport, CLOSE_CODES.SHUTTING_DOWN);
    held(transport);
    await tick();
    clock.tick(NODE_DOWN_GRACE_MS);
    await service.sweep();
    await tick();
    expect(transport.openEphemeralConnection.callCount).to.equal(0);
    service.stop();
    clock.restore();
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
