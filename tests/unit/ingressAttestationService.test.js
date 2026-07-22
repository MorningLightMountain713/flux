const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('ingressAttestationService tests', () => {
  let service;
  let logStub;
  let fluxNetworkHelperStub;
  let fluxBroadcastHelperStub;
  let appsRepositoryStub;
  let senderStub;
  let fluxEventBusStub;
  let specBackend;

  // A minimal stand-in for the flux-spec record. The real class has its own
  // 22-test suite in flux-spec; here we only need to steer verify/deserialize
  // so we can exercise the service's orchestration.
  function makeSpecBackend() {
    return {
      USER_AGENT_MAX: 512,
      FORWARDED_FOR_MAX: 512,
      buildIngressAttestMessage: (fields) => `PAYLOAD:${JSON.stringify(fields)}`,
      verifySignature: sinon.stub().resolves(true),
      IngressAttestation: {
        deserialize: (data) => {
          if (!data || typeof data.hash !== 'string' || !data.hash) {
            throw new Error('malformed');
          }
          return {
            hash: data.hash,
            verify: async (verifyFn) => (await verifyFn('payload', data.node, data.signature)) === true,
            serialize: () => ({ ...data }),
          };
        },
      },
    };
  }

  function makeReq(overrides = {}) {
    return {
      socket: { remoteAddress: '203.0.113.7', remotePort: 51234 },
      headers: { 'user-agent': 'flux-cli/1.0' },
      ...overrides,
    };
  }

  beforeEach(() => {
    logStub = { error: sinon.stub(), warn: sinon.stub(), info: sinon.stub() };
    fluxNetworkHelperStub = { getFluxNodePublicKey: sinon.stub().resolves('04nodepub') };
    fluxBroadcastHelperStub = { getFluxMessageSignature: sinon.stub().resolves('SIGVALUE') };
    appsRepositoryStub = {
      storeIngressAttestation: sinon.stub().resolves({ inserted: true }),
      getPermanentMessage: sinon.stub().resolves(null),
    };
    senderStub = { broadcastIngressAttestation: sinon.stub().resolves() };
    fluxEventBusStub = { publish: sinon.stub() };
    specBackend = makeSpecBackend();

    service = proxyquire('../../ZelBack/src/services/appMessaging/ingressAttestationService', {
      '../../lib/log': logStub,
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../utils/fluxBroadcastHelper': fluxBroadcastHelperStub,
      '../utils/specLibs': { getSpecBackend: sinon.stub().resolves(specBackend) },
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../fluxCommunicationMessagesSender': senderStub,
      '../utils/fluxEventBus': fluxEventBusStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('emit', () => {
    it('captures the socket peer, stores locally, and broadcasts', async () => {
      await service.emit('a'.repeat(64), makeReq());

      expect(appsRepositoryStub.storeIngressAttestation.calledOnce).to.equal(true);
      const [record, expireAt] = appsRepositoryStub.storeIngressAttestation.firstCall.args;
      expect(record.hash).to.equal('a'.repeat(64));
      expect(record.node).to.equal('04nodepub');
      expect(record.observed.ip).to.equal('203.0.113.7');
      expect(record.observed.port).to.equal(51234);
      expect(record.signature).to.equal('SIGVALUE');
      expect(expireAt).to.be.a('number').and.greaterThan(Date.now());

      expect(senderStub.broadcastIngressAttestation.calledOnceWith(record)).to.equal(true);
    });

    it('publishes a test-observability event on a new store', async () => {
      await service.emit('a'.repeat(64), makeReq());
      expect(fluxEventBusStub.publish.calledOnce).to.equal(true);
      const [event, payload] = fluxEventBusStub.publish.firstCall.args;
      expect(event).to.equal('network:ingressattestation');
      expect(payload).to.deep.equal({ hash: 'a'.repeat(64), node: '04nodepub', ip: '203.0.113.7' });
    });

    it('does not publish when the store was a duplicate', async () => {
      appsRepositoryStub.storeIngressAttestation.resolves({ inserted: false });
      await service.emit('a'.repeat(64), makeReq());
      expect(fluxEventBusStub.publish.called).to.equal(false);
    });

    it('normalizes an IPv4-mapped IPv6 address, leaving genuine IPv6 intact', async () => {
      await service.emit('a'.repeat(64), makeReq({ socket: { remoteAddress: '::ffff:198.51.100.9', remotePort: 40000 } }));
      expect(appsRepositoryStub.storeIngressAttestation.firstCall.args[0].observed.ip).to.equal('198.51.100.9');

      appsRepositoryStub.storeIngressAttestation.resetHistory();
      await service.emit('b'.repeat(64), makeReq({ socket: { remoteAddress: '2001:db8::1', remotePort: 40000 } }));
      expect(appsRepositoryStub.storeIngressAttestation.firstCall.args[0].observed.ip).to.equal('2001:db8::1');
    });

    it('captures and caps client-asserted headers', async () => {
      const longUa = 'u'.repeat(1000);
      await service.emit('a'.repeat(64), makeReq({
        headers: { 'user-agent': longUa, 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
      }));
      const { asserted } = appsRepositoryStub.storeIngressAttestation.firstCall.args[0];
      expect(asserted.userAgent).to.have.length(512);
      expect(asserted.forwardedFor).to.equal('203.0.113.7, 10.0.0.1');
    });

    it('gives an unconfirmed message an orphan TTL', async () => {
      await service.emit('a'.repeat(64), makeReq());
      const [, expireAt] = appsRepositoryStub.storeIngressAttestation.firstCall.args;
      expect(expireAt).to.be.a('number').and.greaterThan(Date.now());
    });

    it('persists a confirmed message attestation with no TTL', async () => {
      appsRepositoryStub.getPermanentMessage.resolves({ hash: 'a'.repeat(64) });
      await service.emit('a'.repeat(64), makeReq());
      const [, expireAt] = appsRepositoryStub.storeIngressAttestation.firstCall.args;
      expect(expireAt).to.equal(null);
    });

    it('signs the payload built from the captured fields', async () => {
      await service.emit('a'.repeat(64), makeReq());
      const signedMessage = fluxBroadcastHelperStub.getFluxMessageSignature.firstCall.args[0];
      expect(signedMessage).to.be.a('string').and.contain('PAYLOAD:');
      expect(signedMessage).to.contain('203.0.113.7');
    });

    it('skips entirely when the source address cannot be determined', async () => {
      await service.emit('a'.repeat(64), makeReq({ socket: {} }));
      expect(appsRepositoryStub.storeIngressAttestation.called).to.equal(false);
      expect(senderStub.broadcastIngressAttestation.called).to.equal(false);
    });

    it('is best-effort — a signing failure never throws or stores', async () => {
      fluxBroadcastHelperStub.getFluxMessageSignature.rejects(new Error('no key'));
      await service.emit('a'.repeat(64), makeReq());
      expect(appsRepositoryStub.storeIngressAttestation.called).to.equal(false);
      expect(senderStub.broadcastIngressAttestation.called).to.equal(false);
      expect(logStub.error.calledOnce).to.equal(true);
    });

    it('does nothing without a hash or a request', async () => {
      await service.emit(null, makeReq());
      await service.emit('a'.repeat(64), null);
      expect(appsRepositoryStub.storeIngressAttestation.called).to.equal(false);
    });
  });

  describe('receive', () => {
    const inbound = () => ({
      hash: 'a'.repeat(64),
      observedAt: 1700000000000,
      node: '04peerpub',
      observed: { ip: '203.0.113.7', port: 51234 },
      asserted: { userAgent: 'flux-cli/1.0', forwardedFor: null },
      signature: 'PEERSIG',
    });

    it('verifies, stores, and asks to rebroadcast on first store', async () => {
      const result = await service.receive(inbound());
      expect(specBackend.verifySignature.calledOnce).to.equal(true);
      expect(appsRepositoryStub.storeIngressAttestation.calledOnce).to.equal(true);
      expect(result).to.deep.include({ rebroadcast: true });
      expect(result.record.hash).to.equal('a'.repeat(64));
      // a peer store also publishes the observability event
      expect(fluxEventBusStub.publish.calledOnceWith('network:ingressattestation')).to.equal(true);
    });

    it('does not rebroadcast a duplicate', async () => {
      appsRepositoryStub.storeIngressAttestation.resolves({ inserted: false });
      const result = await service.receive(inbound());
      expect(result.rebroadcast).to.equal(false);
    });

    it('files a sync backfill as confirmed — no TTL, no local message lookup', async () => {
      const result = await service.receive(inbound(), { confirmed: true });
      expect(result).to.deep.include({ rebroadcast: true });
      // confirmed by construction (the responder serves confirmed only) — don't derive TTL
      expect(appsRepositoryStub.getPermanentMessage.called).to.equal(false);
      const [, expireAt] = appsRepositoryStub.storeIngressAttestation.firstCall.args;
      expect(expireAt).to.equal(null);
    });

    it('files a live-gossip receive with a TTL (unconfirmed message)', async () => {
      await service.receive(inbound()); // confirmed defaults to false
      expect(appsRepositoryStub.getPermanentMessage.calledOnce).to.equal(true);
      const [, expireAt] = appsRepositoryStub.storeIngressAttestation.firstCall.args;
      expect(expireAt).to.be.a('number').and.greaterThan(Date.now());
    });

    it('rejects and does not store an attestation with a bad signature', async () => {
      specBackend.verifySignature.resolves(false);
      const result = await service.receive(inbound());
      expect(result).to.be.instanceOf(Error);
      expect(appsRepositoryStub.storeIngressAttestation.called).to.equal(false);
    });

    it('rejects and does not store a malformed attestation', async () => {
      const result = await service.receive({ not: 'valid' });
      expect(result).to.be.instanceOf(Error);
      expect(appsRepositoryStub.storeIngressAttestation.called).to.equal(false);
    });
  });
});
