'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

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
      fluxapps: { playgroundAuditRetentionMs: 2592000000 },
    };
    return proxyquire('../../ZelBack/src/services/appPlayground/playgroundAudit', {
      config: configStub,
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
