'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { asConfig } = require('./fixtures/config');

describe('playgroundAudit tests', () => {
  let dbHelperStub;
  let logStub;
  let configStub;
  let indexStub;

  function build() {
    indexStub = sinon.stub().resolves();
    dbHelperStub = {
      databaseConnection: sinon.stub().returns({
        db: sinon.stub().returns({
          collection: sinon.stub().returns({ createIndex: indexStub }),
        }),
      }),
      insertOneToDatabase: sinon.stub().resolves(),
      findOneInDatabase: sinon.stub().resolves(null),
    };
    logStub = { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() };
    configStub = {
      database: {
        appslocal: {
          database: 'localzelapps',
          collections: { playgroundSessions: 'playgroundsessions' },
        },
      },
      fluxapps: { playgroundAuditRetentionMs: 2_592_000_000 },
    };
    return proxyquire('../../ZelBack/src/services/appPlayground/playgroundAudit', {
      config: asConfig(configStub),
      '../../lib/log': logStub,
      '../dbHelper': dbHelperStub,
      '../fluxNetworkHelper': { getFluxNodePublicKey: sinon.stub().resolves('nodepubkey') },
      '../utils/fluxBroadcastHelper': { getFluxMessageSignature: sinon.stub().resolves('sig') },
      '../utils/ingressEncryptionKey': { current: sinon.stub().returns({ kid: 'k1', publicKey: 'pk' }) },
      '../utils/ingressCapture': { captureIngress: sinon.stub().resolves({ observed: {}, asserted: {} }) },
      '../utils/specLibs': { getSpecBackend: sinon.stub().resolves({ seal: sinon.stub().returns({}) }) },
      './playgroundAbuse': { looksLikeMining: sinon.stub().returns(false), fingerprint: sinon.stub().resolves('fp') },
    });
  }

  // The identifying half is sealed to the same fluxteam key an ingress note is,
  // so the purpose bound into the seal is what keeps one from reading as the
  // other. Real library, real keys.
  describe('build', () => {
    it('seals the identifying half as a playground record, which does not open as an ingress note', async () => {
      const backend = await import('@runonflux/flux-spec-backend');
      const { publicKey, privateKey } = backend.generateSealKeypair();
      const audit = proxyquire('../../ZelBack/src/services/appPlayground/playgroundAudit', {
        config: asConfig({ fluxapps: { playgroundAuditRetentionMs: 1 } }),
        '../../lib/log': { error: sinon.stub(), info: sinon.stub(), warn: sinon.stub() },
        '../dbHelper': {},
        '../fluxNetworkHelper': { getFluxNodePublicKey: sinon.stub().resolves('nodepubkey') },
        '../utils/fluxBroadcastHelper': { getFluxMessageSignature: sinon.stub().resolves('sig') },
        '../utils/ingressEncryptionKey': { current: sinon.stub().returns({ kid: 'k1', publicKey }) },
        '../utils/ingressCapture': {},
        '../utils/specLibs': { getSpecBackend: async () => backend },
        './playgroundAbuse': { looksLikeMining: sinon.stub().returns(false), fingerprint: sinon.stub().resolves('fp') },
      });
      const session = {
        sessionId: 's1',
        fluxId: '1FluxIdOfTheCaller',
        appName: 'play',
        images: ['nginx:latest'],
        ingress: {
          observed: { ip: '203.0.113.9', port: 443 },
          asserted: { userAgent: null, forwardedFor: null },
        },
      };

      const doc = await audit.build(session);

      const opened = JSON.parse(Buffer.from(
        backend.unseal(doc.sealed, privateKey, { purpose: backend.SEAL_PURPOSE.PLAYGROUND_AUDIT }),
      ).toString('utf8'));
      expect(opened.fluxId).to.equal('1FluxIdOfTheCaller');
      expect(() => backend.openIngressNote(doc.sealed, privateKey)).to.throw();
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('prepareCollection', () => {
    it('creates the retention TTL index on expireAt', async () => {
      const audit = build();
      await audit.prepareCollection();
      const ttl = indexStub.getCalls().find((c) => c.args[1].expireAfterSeconds !== undefined);
      expect(ttl, 'no TTL index was created - the 30-day retention is enforced by nothing').to.not.equal(undefined);
      expect(ttl.args[0]).to.deep.equal({ expireAt: 1 });
      // expireAt is an absolute Date written by record(), so the document expires
      // at that instant rather than a fixed span after it.
      expect(ttl.args[1].expireAfterSeconds).to.equal(0);
    });

    it('creates the findFlaggedSince index, equality fields before the range', async () => {
      const audit = build();
      await audit.prepareCollection();
      const lookup = indexStub.getCalls().find((c) => c.args[0].callerFingerprint !== undefined);
      expect(lookup, 'the admission-path miner check has no index and scans the collection').to.not.equal(undefined);
      expect(Object.keys(lookup.args[0])).to.deep.equal(['callerFingerprint', 'flagged', 'observedAt']);
    });

    it('indexes the collection findFlaggedSince reads', async () => {
      const audit = build();
      const collectionFor = dbHelperStub.databaseConnection().db();
      collectionFor.collection.resetHistory();
      await audit.prepareCollection();
      expect(collectionFor.collection.alwaysCalledWith('playgroundsessions')).to.equal(true);
    });

    it('logs and does not throw when an index cannot be built', async () => {
      const audit = build();
      indexStub.rejects(new Error('blip'));
      await audit.prepareCollection();
      expect(logStub.error.called).to.equal(true);
    });
  });
});
