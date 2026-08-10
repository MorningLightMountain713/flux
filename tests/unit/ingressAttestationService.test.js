'use strict';

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
  let ingressKeyStub;
  let specBackend;

  // A minimal stand-in for the flux-spec record + seal. The real class and the
  // real x25519 seal each have their own suites in flux-spec; here we use a fake
  // seal (base64 marker, not real crypto) so the service test can inspect exactly
  // what plaintext was sealed without needing real keys.
  const FAKE_SEALED = {
    v: 1, alg: 'x25519-xchacha20poly1305', kid: 'ft-test', epk: 'EPK', n: 'NONCE', ct: 'CIPHERTEXT',
  };

  function makeSpecBackend() {
    return {
      USER_AGENT_MAX: 512,
      FORWARDED_FOR_MAX: 512,
      buildIngressAttestMessage: (fields) => `PAYLOAD:${JSON.stringify(fields)}`,
      seal: sinon.stub().callsFake((plaintext, publicKey, { kid }) => ({ ...FAKE_SEALED, kid })),
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

  // The JSON plaintext handed to seal, parsed back for assertions.
  const sealedPlaintext = () => JSON.parse(specBackend.seal.firstCall.args[0]);

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
    ingressKeyStub = { current: sinon.stub().returns({ kid: 'ft-test', publicKey: new Uint8Array(32) }) };
    specBackend = makeSpecBackend();

    service = proxyquire('../../ZelBack/src/services/appMessaging/ingressAttestationService', {
      '../../lib/log': logStub,
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../utils/fluxBroadcastHelper': fluxBroadcastHelperStub,
      '../utils/specLibs': { getSpecBackend: sinon.stub().resolves(specBackend) },
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../fluxCommunicationMessagesSender': senderStub,
      '../utils/fluxEventBus': fluxEventBusStub,
      '../utils/ingressEncryptionKey': ingressKeyStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('emit', () => {
    it('captures the socket peer, seals it, stores locally, and broadcasts', async () => {
      await service.emit('a'.repeat(64), makeReq());

      expect(appsRepositoryStub.storeIngressAttestation.calledOnce).to.equal(true);
      const [record, expireAt] = appsRepositoryStub.storeIngressAttestation.firstCall.args;
      expect(record.hash).to.equal('a'.repeat(64));
      expect(record.node).to.equal('04nodepub');
      expect(record.signature).to.equal('SIGVALUE');
      // the source is carried only as the sealed envelope, never in cleartext
      expect(record.sealed).to.deep.equal({ ...FAKE_SEALED, kid: 'ft-test' });
      expect(record.observed).to.equal(undefined);
      expect(record.asserted).to.equal(undefined);
      // and what was sealed is the captured observed/asserted
      expect(sealedPlaintext()).to.deep.equal({
        observed: { ip: '203.0.113.7', port: 51234 },
        asserted: { userAgent: 'flux-cli/1.0', forwardedFor: null },
      });
      expect(expireAt).to.be.a('number').and.greaterThan(Date.now());

      expect(senderStub.broadcastIngressAttestation.calledOnceWith(record)).to.equal(true);
    });

    it('publishes a test-observability event carrying the sealing key id, not the source', async () => {
      await service.emit('a'.repeat(64), makeReq());
      expect(fluxEventBusStub.publish.calledOnce).to.equal(true);
      const [event, payload] = fluxEventBusStub.publish.firstCall.args;
      expect(event).to.equal('network:ingressattestation');
      expect(payload).to.deep.equal({ hash: 'a'.repeat(64), node: '04nodepub', kid: 'ft-test' });
    });

    it('does not publish when the store was a duplicate', async () => {
      appsRepositoryStub.storeIngressAttestation.resolves({ inserted: false });
      await service.emit('a'.repeat(64), makeReq());
      expect(fluxEventBusStub.publish.called).to.equal(false);
    });

    it('normalizes an IPv4-mapped IPv6 address, leaving genuine IPv6 intact', async () => {
      await service.emit('a'.repeat(64), makeReq({ socket: { remoteAddress: '::ffff:198.51.100.9', remotePort: 40000 } }));
      expect(sealedPlaintext().observed.ip).to.equal('198.51.100.9');

      specBackend.seal.resetHistory();
      await service.emit('b'.repeat(64), makeReq({ socket: { remoteAddress: '2001:db8::1', remotePort: 40000 } }));
      expect(sealedPlaintext().observed.ip).to.equal('2001:db8::1');
    });

    it('captures and caps client-asserted headers before sealing', async () => {
      const longUa = 'u'.repeat(1000);
      await service.emit('a'.repeat(64), makeReq({
        headers: { 'user-agent': longUa, 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
      }));
      const { asserted } = sealedPlaintext();
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

    it('signs the sealed envelope — the raw source is never in the signed payload', async () => {
      await service.emit('a'.repeat(64), makeReq());
      const signedMessage = fluxBroadcastHelperStub.getFluxMessageSignature.firstCall.args[0];
      expect(signedMessage).to.be.a('string').and.contain('PAYLOAD:');
      expect(signedMessage).to.contain('ft-test'); // the sealed envelope's kid
      expect(signedMessage).to.contain('CIPHERTEXT'); // the ciphertext
      expect(signedMessage).to.not.contain('203.0.113.7'); // never the cleartext source
    });

    it('skips entirely when the source address cannot be determined', async () => {
      await service.emit('a'.repeat(64), makeReq({ socket: {} }));
      expect(specBackend.seal.called).to.equal(false);
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
      sealed: { ...FAKE_SEALED },
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

    it('quarantines an attestation naming a message this node does not hold', async () => {
      await service.receive(inbound());
      expect(appsRepositoryStub.getPermanentMessage.calledOnce).to.equal(true);
      const [, expireAt] = appsRepositoryStub.storeIngressAttestation.firstCall.args;
      expect(expireAt).to.be.a('number').and.greaterThan(Date.now());
    });

    it('persists an attestation naming a message this node holds', async () => {
      appsRepositoryStub.getPermanentMessage.resolves({ hash: 'a'.repeat(64) });
      await service.receive(inbound());
      const [, expireAt] = appsRepositoryStub.storeIngressAttestation.firstCall.args;
      expect(expireAt).to.equal(null);
    });

    it('derives durability from local message state, never from the sender', async () => {
      // A sync backfill used to be filed confirmed on the serving peer's word. Both
      // sources now take the same path, so a peer cannot make a record permanent by
      // asserting it is.
      await service.receive(inbound());
      expect(appsRepositoryStub.getPermanentMessage.calledOnce).to.equal(true);
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
