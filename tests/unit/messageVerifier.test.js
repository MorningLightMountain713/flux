'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const domain = require('./fixtures/appDomain');
const { asConfig } = require('./fixtures/config');

// Shared stubs used by every proxyquire call
function makeBaseStubs(overrides = {}) {
  const dbStub = {
    databaseConnection: sinon.stub().returns({ db: sinon.stub().returns('database') }),
    findOneInDatabase: sinon.stub().resolves(null),
    findInDatabase: sinon.stub().resolves([]),
    updateOneInDatabase: sinon.stub().resolves(),
    insertOneToDatabase: sinon.stub().resolves(),
  };

  const logStub = {
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
    debug: sinon.stub(),
  };

  const messageHelperStub = {
    createDataMessage: (data) => ({ status: 'success', data }),
    createSuccessMessage: (msg) => ({ status: 'success', data: { message: msg } }),
    createErrorMessage: (msg) => ({ status: 'error', data: { message: msg } }),
    errUnauthorizedMessage: () => ({ status: 'error', data: { code: 401, message: 'Unauthorized. Access denied.' } }),
  };

  const broadcastStub = {
    broadcastMessageToAll: sinon.stub().resolves(),
    broadcastMessageToRandomPeer: sinon.stub().resolves(),
  };

  // The five questions every regime answers. A regime reaches the daemon, the
  // database and the network, so each generation's implementation is a double —
  // but which one answers is NOT. That dispatch is pure, it routes on the spec's
  // own declared pricingModel, and it refuses to fall back when a model has no
  // implementation. Stubbing regimeFor away would test none of it.
  const regimeSurface = () => ({
    onChainDisplayPrice: sinon.stub().resolves(1),
    fiatAndFluxDisplayPrice: sinon.stub().resolves({ usd: 1, flux: 1, fluxDiscount: 0 }),
    registrationFee: sinon.stub().resolves(100_000_000n),
    supersededMessage: sinon.stub().resolves(null),
    termCost: sinon.stub().resolves({ oldScaledPriceMicrodollars: 0, oldMetered: new Map() }),
    updateFee: sinon.stub().resolves(100_000_000n),
  });
  // chainFloor, the model a v8 spec declares
  const legacyRegime = regimeSurface();
  // unified, the model a v9 spec declares
  const v9Regime = regimeSurface();
  const pricingRegime = proxyquire('../../ZelBack/src/services/pricing/pricingRegime', {
    './legacyPricingRegime': legacyRegime,
    './v9PricingRegime': v9Regime,
  });

  const stubs = {
    config: asConfig({
      database: {
        url: 'mongodb://localhost:27017',
        daemon: { database: 'daemondb', collections: { appsHashes: 'appsHashes' } },
        appsglobal: {
          database: 'globalapps',
          collections: {
            appsMessages: 'appsMessages',
            appsTemporaryMessages: 'appsTempMessages',
          },
        },
      },
      fluxapps: {
        epochstart: 694_000,
        minHashSyncPeers: 12,
      },
    }),
    '../dbHelper': dbStub,
    '../../lib/log': logStub,
    '../messageHelper': messageHelperStub,
    '../verificationHelper': {
      verifyPrivilege: sinon.stub().resolves(true),
    },
    '../generalService': {
      checkSynced: sinon.stub().resolves(true),
    },
    '../fluxCommunicationMessagesSender': broadcastStub,
    '../serviceHelper': {
      ensureNumber: sinon.stub().callsFake((v) => Number(v)),
      ensureString: sinon.stub().callsFake((v) => String(v)),
      delay: sinon.stub().resolves(),
    },
    '../daemonService/daemonStatus': {
      daemonSyncState: sinon.stub().returns({ height: 2_000_000, synced: true }),
    },
    '../daemonService/daemonServiceBlockchainRpcs': {
      getBlock: sinon.stub().resolves({ status: 'success', data: { time: 1_750_000_000 } }),
    },
    // The real dispatcher, over doubled regimes.
    '../pricing/pricingRegime': pricingRegime,
    // specLibs and specCutover are NOT stubbed. They are pure domain code — no
    // database, no network, no filesystem — so a double buys nothing and can
    // drift from the classes it stands in for. Sealed specs are the one part of
    // specCutover that reaches outside; a test covering those stubs it there.
    '../appDatabase/appsRepository': {
      getPermanentMessage: sinon.stub().resolves(null),
      getTempMessage: sinon.stub().resolves(null),
      storePermanentMessage: sinon.stub().resolves(),
      confirmIngressAttestations: sinon.stub().resolves(),
      getPreviousPermanentMessage: sinon.stub().resolves(null),
      listAppMessagesByName: sinon.stub().resolves([]),
    },
    './appEventVerifier': {
      authorize: sinon.stub().resolves(),
    },
    '../utils/appConstants': {
      scannedHeightCollection: 'scannedHeight',
    },
    '../invalidMessages': {
      invalidMessages: [],
    },
    '../fluxNetworkHelper': {
      getNumberOfPeers: sinon.stub().returns(20),
    },
  };

  // The real store, over a database where every hash asked about has this
  // payment record, writing through appsRepository.storePermanentMessage so a
  // test reads what reached storage there. Loaded per call, so it sees the
  // stubs a test changed after this function returned.
  const chain = {
    paid: true, txid: 'txid', height: 2_000_000, value: 200_000_000, blockTime: null,
  };
  // The app messages: the pool and the confirmed records a test seeds, each
  // answering the form the routes serve; every hash asked about is paid as
  // `chain` says, and contents stored go to the repository's sink.
  const messages = {
    pooled: [],
    confirmed: [],
    held: new Set(),
    pool: sinon.stub().callsFake(async () => messages.pooled),
    byHash: sinon.stub().callsFake(async (hash) => [...messages.pooled, ...messages.confirmed].find((r) => r.hash === hash) ?? null),
    confirmedFind: sinon.stub().callsFake(async () => messages.confirmed),
    byHashes: sinon.stub().callsFake(async (hashes) => hashes.filter((hash) => messages.held.has(hash)).map((hash) => ({ hash, isHeld: true }))),
    payments: sinon.stub().callsFake(async (hashes) => new Map(chain.paid ? hashes.map((hash) => [hash, { hash, ...chain }]) : [])),
    setBlockTime: sinon.stub().resolves(),
    storeContents: sinon.stub().callsFake(async (contents) => {
      await stubs['../appDatabase/appsRepository'].storePermanentMessage(contents);
      messages.held.add(contents.hash);
      return { stored: true };
    }),
  };
  stubs['../appDatabase/appRecords'] = { messages: () => messages };
  const store = () => proxyquire('../../ZelBack/src/services/appMessaging/confirmedMessageStore', {
    config: stubs.config,
    '../../lib/log': logStub,
    '../serviceHelper': stubs['../serviceHelper'],
    '../daemonService/daemonServiceBlockchainRpcs': stubs['../daemonService/daemonServiceBlockchainRpcs'],
    './appEventVerifier': { verifyAttestation: async () => true },
    '../appDatabase/appRecords': { messages: () => messages },
  });
  stubs['./confirmedMessageStore'] = {
    storeConfirmedMessages: (...args) => store().storeConfirmedMessages(...args),
    confirmedEvent: (...args) => store().confirmedEvent(...args),
    notifyStored: sinon.stub(),
    // The payment record every hash has; a test sets the facts it depends on.
    chain,
  };

  // Apply overrides
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && stubs[key]) {
      stubs[key] = { ...stubs[key], ...value };
    } else {
      stubs[key] = value;
    }
  }

  return {
    stubs, dbStub, logStub, messageHelperStub, broadcastStub, legacyRegime, v9Regime, chain, messages,
  };
}

// A pool record or a confirmed record as the routes read it.
const pooledRecord = (doc) => ({
  hash: doc.hash, isHeld: true, isPaid: false, temporaryForm: () => doc,
});
const confirmedRecord = (doc) => ({
  hash: doc.hash, isHeld: true, isPaid: true, permanentForm: () => doc,
});

describe('messageVerifier tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('requestAppMessage', () => {
    it('should broadcast a fluxapprequest message with the given hash', async () => {
      const { stubs, broadcastStub } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      await mv.requestAppMessage('abc123');

      expect(broadcastStub.broadcastMessageToAll.calledOnce).to.be.true;
      const msg = broadcastStub.broadcastMessageToAll.firstCall.args[0];
      expect(msg).to.deep.equal({ type: 'fluxapprequest', version: 1, hash: 'abc123' });
    });
  });

  describe('requestAppsMessage', () => {
    it('asks one random held peer, whichever direction label it carries', async () => {
      const { stubs, broadcastStub } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const apps = [{ hash: 'h1' }, { hash: 'h2' }];
      await mv.requestAppsMessage(apps);

      expect(broadcastStub.broadcastMessageToRandomPeer.calledOnce).to.be.true;
      const msg = broadcastStub.broadcastMessageToRandomPeer.firstCall.args[0];
      expect(msg.type).to.equal('fluxapprequest');
      expect(msg.version).to.equal(2);
      expect(msg.hashes).to.deep.equal(['h1', 'h2']);
    });
  });

  describe('requestAppMessageAPI', () => {
    it('should return unauthorized when privilege check fails', async () => {
      const { stubs } = makeBaseStubs({
        '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(false) },
      });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.requestAppMessageAPI({ params: {}, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('error');
      expect(res.json.firstCall.args[0].data.code).to.equal(401);
    });

    it('should return error when no hash is provided', async () => {
      const { stubs } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.requestAppMessageAPI({ params: {}, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });

    it('should broadcast and return success when hash is provided in params', async () => {
      const { stubs, broadcastStub } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.requestAppMessageAPI({ params: { hash: 'myhash' }, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(broadcastStub.broadcastMessageToAll.calledOnce).to.be.true;
    });

    it('should accept hash from query string', async () => {
      const { stubs, broadcastStub } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.requestAppMessageAPI({ params: {}, query: { hash: 'queryhash' } }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(broadcastStub.broadcastMessageToAll.calledOnce).to.be.true;
    });
  });

  describe('appHashHasMessage', () => {
  });

  describe('appHashHasMessageNotFound', () => {
  });

  describe('getAppsTemporaryMessages', () => {
    it('should return all temporary messages when no hash filter', async () => {
      const tempMsgs = [{ hash: 'h1' }, { hash: 'h2' }];
      const { stubs, messages } = makeBaseStubs();
      messages.pooled.push(...tempMsgs.map(pooledRecord));
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);
      const res = { json: sinon.stub() };
      await mv.getAppsTemporaryMessages({ params: {}, query: {} }, res);
      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(res.json.firstCall.args[0].data).to.deep.equal(tempMsgs);
    });
    it('should filter by hash when provided in params', async () => {
      const { stubs, messages } = makeBaseStubs();
      messages.pooled.push(pooledRecord({ hash: 'xyz' }), pooledRecord({ hash: 'other' }));
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);
      const res = { json: sinon.stub() };
      await mv.getAppsTemporaryMessages({ params: { hash: 'xyz' }, query: {} }, res);
      expect(res.json.firstCall.args[0].data).to.deep.equal([{ hash: 'xyz' }]);
    });
    it('should return error on database failure', async () => {
      const { stubs, messages } = makeBaseStubs();
      messages.pool.rejects(new Error('DB error'));
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getAppsTemporaryMessages({ params: {}, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });
  });

  describe('getAppsPermanentMessages', () => {
    it('should return all permanent messages when no filters', async () => {
      const permMsgs = [{ hash: 'p1' }];
      const { stubs, messages } = makeBaseStubs();
      messages.confirmed.push(...permMsgs.map(confirmedRecord));
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);
      const res = { json: sinon.stub() };
      await mv.getAppsPermanentMessages({ params: {}, query: {} }, res);
      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(res.json.firstCall.args[0].data).to.deep.equal(permMsgs);
    });
    it('should filter by hash, owner, and appname', async () => {
      const { stubs, messages } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);
      const res = { json: sinon.stub() };
      await mv.getAppsPermanentMessages({
        params: { hash: 'h1', owner: 'o1', appname: 'a1' },
        query: {},
      }, res);
      sinon.assert.calledOnceWithExactly(messages.confirmedFind, { hash: 'h1', owner: 'o1', name: 'a1' });
    });
    it('should accept filters from query string', async () => {
      const { stubs, messages } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getAppsPermanentMessages({
        params: {},
        query: { hash: 'qh', owner: 'qo', appname: 'qa' },
      }, res);

      sinon.assert.calledOnceWithExactly(messages.confirmedFind, { hash: 'qh', owner: 'qo', name: 'qa' });
    });

    it('should return error on database failure', async () => {
      const { stubs, messages } = makeBaseStubs();
      messages.confirmedFind.rejects(new Error('DB failure'));
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getAppsPermanentMessages({ params: {}, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });
  });

  describe('getIngressAttestationsByApp', () => {
    it('returns the grouped attestations for an app to fluxteam', async () => {
      const { stubs } = makeBaseStubs();
      const groups = [{ hash: 'h1', type: 'fluxappregister', timestamp: 1, attestations: [{ hash: 'h1', sealed: {} }] }];
      stubs['../appDatabase/appsRepository'].listIngressAttestationsByApp = sinon.stub().resolves(groups);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getIngressAttestationsByApp({ params: { name: 'myapp' }, query: {} }, res);

      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(res.json.firstCall.args[0].data).to.deep.equal(groups);
      expect(stubs['../appDatabase/appsRepository'].listIngressAttestationsByApp.calledOnceWith('myapp')).to.be.true;
    });

    it('denies a non-fluxteam caller (401)', async () => {
      const { stubs } = makeBaseStubs();
      stubs['../verificationHelper'] = { verifyPrivilege: sinon.stub().resolves(false) };
      stubs['../appDatabase/appsRepository'].listIngressAttestationsByApp = sinon.stub().resolves([]);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getIngressAttestationsByApp({ params: { name: 'myapp' }, query: {} }, res);

      expect(res.json.firstCall.args[0].data.code).to.equal(401);
      expect(stubs['../appDatabase/appsRepository'].listIngressAttestationsByApp.called).to.be.false;
    });

    it('requires a name', async () => {
      const { stubs } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getIngressAttestationsByApp({ params: {}, query: {} }, res);

      expect(res.json.firstCall.args[0].status).to.equal('error');
    });
  });

  describe('checkAndRequestApp', () => {
    it('does not store a message whose payment this node has not recorded', async () => {
      const storePermanentStub = sinon.stub().resolves();
      const { stubs } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(await domain.paidTempMessage({ version: 1 }));
      stubs['../appDatabase/appsRepository'].storePermanentMessage = storePermanentStub;
      stubs['./confirmedMessageStore'].chain.paid = false;
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('hash', 2);
      expect(result).to.be.false;
      expect(storePermanentStub.called).to.be.false;
    });

    it('should return true immediately when permanent message already exists', async () => {
      const { stubs } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getPermanentMessage = sinon.stub().resolves({ hash: 'existing' });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('existing');
      expect(result).to.be.true;
      // and wake the decider for it: a message met again after a rescan is decided again
      sinon.assert.calledOnceWithExactly(stubs['./confirmedMessageStore'].notifyStored, ['existing']);
    });

    it('persists the ingress attestations of a message confirmed when its payment met contents already held', async () => {
      const { stubs } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getPermanentMessage = sinon.stub().resolves({ hash: 'existing' });
      stubs['../appDatabase/appsRepository'].confirmIngressAttestations = sinon.stub().resolves();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      expect(await mv.checkAndRequestApp('existing')).to.equal(true);
      sinon.assert.calledOnceWithExactly(stubs['../appDatabase/appsRepository'].confirmIngressAttestations, 'existing');
    });

    it('should request from network and retry when temp message not found', async () => {
      const { stubs, broadcastStub } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(null);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      // Start at i=0, will broadcast and recurse up to i=2
      Object.assign(stubs['./confirmedMessageStore'].chain, {
        txid: 'txid', height: 2_000_000, value: 100_000_000, blockTime: null,
      });
      const result = await mv.checkAndRequestApp('hash', 0);
      expect(result).to.be.false;
      // Should have broadcast twice (i=0, i=1)
      expect(broadcastStub.broadcastMessageToAll.callCount).to.equal(2);
    });

    it('should return false when temp message has no specifications', async () => {
      const { stubs, logStub } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves({ hash: 'h', type: 'fluxappregister' });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      Object.assign(stubs['./confirmedMessageStore'].chain, {
        txid: 'txid', height: 2_000_000, value: 100_000_000, blockTime: null,
      });
      const result = await mv.checkAndRequestApp('h', 2);
      expect(result).to.be.false;
      expect(logStub.error.called).to.be.true;
    });

    it('leaves the hash unresolved rather than storing a v9 app without a block time', async () => {
      const storePermanentStub = sinon.stub().resolves();
      const { stubs } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(await domain.paidTempMessage({ version: 2 }));
      stubs['../appDatabase/appsRepository'].storePermanentMessage = storePermanentStub;
      stubs['../daemonService/daemonServiceBlockchainRpcs'].getBlock = sinon.stub().resolves({ status: 'error', data: { message: 'no block' } });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      Object.assign(stubs['./confirmedMessageStore'].chain, {
        txid: 'txid', height: 2_000_000, value: 200_000_000, blockTime: null,
      });
      const result = await mv.checkAndRequestApp('v9reg', 2);

      expect(result).to.be.false;
      expect(storePermanentStub.called).to.be.false;
    });

    it('stores a paid message and prices nothing', async () => {
      const { stubs, legacyRegime, v9Regime } = makeBaseStubs();
      const message = await domain.paidTempMessage({ version: 1 });
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(message);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      expect(await mv.checkAndRequestApp(message.hash)).to.equal(true);

      for (const regime of [legacyRegime, v9Regime]) {
        sinon.assert.notCalled(regime.registrationFee);
        sinon.assert.notCalled(regime.updateFee);
      }
      sinon.assert.calledOnceWithExactly(stubs['../appDatabase/appsRepository'].confirmIngressAttestations, message.hash);
    });

    it('should return false and log error when an exception occurs', async () => {
      const { stubs, logStub } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getPermanentMessage = sinon.stub().rejects(new Error('DB crash'));
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('crashHash');
      expect(result).to.be.false;
      expect(logStub.error.called).to.be.true;
    });

    // A sealed spec's cleartext half carries every pricing input, so a node that
    // cannot open it prices it exactly as one that can. Opening is refused here,
    // and the refusal is also the canary: a path that tried would reach it.
  });

  describe('exported functions', () => {
    it('should export all remaining public functions', () => {
      const { stubs } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      expect(mv.requestAppMessage).to.be.a('function');
      expect(mv.requestAppsMessage).to.be.a('function');
      expect(mv.requestAppMessageAPI).to.be.a('function');
      expect(mv.getAppsTemporaryMessages).to.be.a('function');
      expect(mv.getAppsPermanentMessages).to.be.a('function');
      expect(mv.checkAndRequestApp).to.be.a('function');
      expect(mv.checkAndRequestMultipleApps).to.be.a('function');
    });

    it('should not export removed functions', () => {
      const { stubs } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      expect(mv.verifyAppHash).to.be.undefined;
      expect(mv.verifyAppMessageSignature).to.be.undefined;
      expect(mv.verifyAppMessageUpdateSignature).to.be.undefined;
      expect(mv.isExpireOnlyUpdate).to.be.undefined;
      expect(mv.checkAppMessageExistence).to.be.undefined;
      expect(mv.checkAppTemporaryMessageExistence).to.be.undefined;
    });
  });
});
