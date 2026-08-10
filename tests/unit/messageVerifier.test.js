const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const domain = require('./fixtures/appDomain');

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
    broadcastMessageToRandomIncoming: sinon.stub().resolves(),
    broadcastMessageToRandomOutgoing: sinon.stub().resolves(),
  };

  // The five questions every regime answers. A regime reaches the daemon, the
  // database and the network, so each generation's implementation is a double —
  // but which one answers is NOT. That dispatch is pure, it routes on the spec's
  // own declared pricingModel, and it refuses to fall back when a model has no
  // implementation. Stubbing regimeFor away would test none of it.
  const regimeSurface = () => ({
    onChainDisplayPrice: sinon.stub().resolves(1),
    fiatAndFluxDisplayPrice: sinon.stub().resolves({ usd: 1, flux: 1, fluxDiscount: 0 }),
    registrationFee: sinon.stub().resolves(100000000n),
    supersededMessage: sinon.stub().resolves(null),
    updateFee: sinon.stub().resolves(100000000n),
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
    config: {
      database: {
        url: 'mongodb://localhost:27017',
        daemon: { database: 'daemondb' },
        appsglobal: {
          database: 'globalapps',
          collections: {
            appsMessages: 'appsMessages',
            appsTemporaryMessages: 'appsTempMessages',
          },
        },
      },
      fluxapps: {
        epochstart: 694000,
        daemonPONFork: 2020000,
        blocksLasting: 22000,
      },
    },
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
    '../daemonService/daemonServiceMiscRpcs': {
      isDaemonSynced: sinon.stub().returns({ data: { height: 2000000, synced: true } }),
    },
    '../daemonService/daemonServiceBlockchainRpcs': {
      getBlock: sinon.stub().resolves({ status: 'success', data: { time: 1750000000 } }),
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
      getGlobalAppInfo: sinon.stub().resolves(null),
      existsGlobalApp: sinon.stub().resolves(false),
      existsInstalledApp: sinon.stub().resolves(false),
      removeGlobalAppInfo: sinon.stub().resolves(),
      storePermanentMessage: sinon.stub().resolves(),
      confirmIngressAttestations: sinon.stub().resolves(),
      getPreviousPermanentMessage: sinon.stub().resolves(null),
      listAppMessagesByName: sinon.stub().resolves([]),
    },
    '../appDatabase/registryManager': {
      insertAppSpecifications: sinon.stub().resolves(),
      updateAppSpecifications: sinon.stub().resolves(),
    },
    './appEventVerifier': {
      authorize: sinon.stub().resolves(),
    },
    '../utils/appConstants': {
      globalAppsMessages: 'appsMessages',
      globalAppsTempMessages: 'appsTempMessages',
      appsHashesCollection: 'appsHashes',
      scannedHeightCollection: 'scannedHeight',
    },
    '../invalidMessages': {
      invalidMessages: [],
    },
    '../fluxNetworkHelper': {
      getNumberOfPeers: sinon.stub().returns(20),
    },
    '../utils/globalState': {
      getPendingUpdates: sinon.stub().returns([]),
      clearPendingUpdates: sinon.stub(),
      checkAndSyncAppHashesWasEverExecuted: true,
    },
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
    stubs, dbStub, logStub, messageHelperStub, broadcastStub, legacyRegime, v9Regime,
  };
}

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
    it('should broadcast to random outgoing by default', async () => {
      const { stubs, broadcastStub } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const apps = [{ hash: 'h1' }, { hash: 'h2' }];
      await mv.requestAppsMessage(apps, false);

      expect(broadcastStub.broadcastMessageToRandomOutgoing.calledOnce).to.be.true;
      const msg = broadcastStub.broadcastMessageToRandomOutgoing.firstCall.args[0];
      expect(msg.type).to.equal('fluxapprequest');
      expect(msg.version).to.equal(2);
      expect(msg.hashes).to.deep.equal(['h1', 'h2']);
    });

    it('should broadcast to random incoming when incoming is true', async () => {
      const { stubs, broadcastStub } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const apps = [{ hash: 'h1' }];
      await mv.requestAppsMessage(apps, true);

      expect(broadcastStub.broadcastMessageToRandomIncoming.calledOnce).to.be.true;
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
    it('should update the database and return true', async () => {
      const { stubs, dbStub } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.appHashHasMessage('hash123');

      expect(result).to.be.true;
      expect(dbStub.updateOneInDatabase.calledOnce).to.be.true;
      const [, collection, query, update] = dbStub.updateOneInDatabase.firstCall.args;
      expect(collection).to.equal('appsHashes');
      expect(query).to.deep.equal({ hash: 'hash123' });
      expect(update).to.deep.equal({ $set: { message: true, messageNotFound: false } });
    });
  });

  describe('appHashHasMessageNotFound', () => {
    it('should update the database and return true', async () => {
      const { stubs, dbStub } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.appHashHasMessageNotFound('hash456');

      expect(result).to.be.true;
      expect(dbStub.updateOneInDatabase.calledOnce).to.be.true;
      const [, collection, query, update] = dbStub.updateOneInDatabase.firstCall.args;
      expect(collection).to.equal('appsHashes');
      expect(query).to.deep.equal({ hash: 'hash456' });
      expect(update).to.deep.equal({ $set: { messageNotFound: true } });
    });
  });

  describe('getAppsTemporaryMessages', () => {
    it('should return all temporary messages when no hash filter', async () => {
      const tempMsgs = [{ hash: 'h1' }, { hash: 'h2' }];
      const { stubs, dbStub } = makeBaseStubs();
      dbStub.findInDatabase.resolves(tempMsgs);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getAppsTemporaryMessages({ params: {}, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(res.json.firstCall.args[0].data).to.deep.equal(tempMsgs);
    });

    it('should filter by hash when provided in params', async () => {
      const { stubs, dbStub } = makeBaseStubs();
      dbStub.findInDatabase.resolves([]);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getAppsTemporaryMessages({ params: { hash: 'xyz' }, query: {} }, res);

      expect(dbStub.findInDatabase.calledOnce).to.be.true;
      const [, collection, query] = dbStub.findInDatabase.firstCall.args;
      expect(collection).to.equal('appsTempMessages');
      expect(query).to.deep.equal({ hash: 'xyz' });
    });

    it('should return error on database failure', async () => {
      const { stubs, dbStub } = makeBaseStubs();
      dbStub.findInDatabase.rejects(new Error('DB error'));
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
      const { stubs, dbStub } = makeBaseStubs();
      dbStub.findInDatabase.resolves(permMsgs);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getAppsPermanentMessages({ params: {}, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('success');
      expect(res.json.firstCall.args[0].data).to.deep.equal(permMsgs);
    });

    it('should filter by hash, owner, and appname', async () => {
      const { stubs, dbStub } = makeBaseStubs();
      dbStub.findInDatabase.resolves([]);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getAppsPermanentMessages({
        params: { hash: 'h1', owner: 'o1', appname: 'a1' },
        query: {},
      }, res);

      expect(dbStub.findInDatabase.calledOnce).to.be.true;
      const query = dbStub.findInDatabase.firstCall.args[2];
      expect(query.hash).to.equal('h1');
      expect(query['appSpecifications.owner']).to.equal('o1');
      expect(query['appSpecifications.name']).to.equal('a1');
    });

    it('should accept filters from query string', async () => {
      const { stubs, dbStub } = makeBaseStubs();
      dbStub.findInDatabase.resolves([]);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.getAppsPermanentMessages({
        params: {},
        query: { hash: 'qh', owner: 'qo', appname: 'qa' },
      }, res);

      const query = dbStub.findInDatabase.firstCall.args[2];
      expect(query.hash).to.equal('qh');
      expect(query['appSpecifications.owner']).to.equal('qo');
      expect(query['appSpecifications.name']).to.equal('qa');
    });

    it('should return error on database failure', async () => {
      const { stubs, dbStub } = makeBaseStubs();
      dbStub.findInDatabase.rejects(new Error('DB failure'));
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
    it('should return false when height is below epochstart', async () => {
      const { stubs } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('hash', 'txid', 100, 100000000);
      expect(result).to.be.false;
    });

    it('should return true immediately when permanent message already exists', async () => {
      const { stubs, dbStub } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getPermanentMessage = sinon.stub().resolves({ hash: 'existing' });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('existing', 'txid', 2000000, 100000000);
      expect(result).to.be.true;
      // Should mark hash as having message
      expect(dbStub.updateOneInDatabase.calledOnce).to.be.true;
    });

    it('should request from network and retry when temp message not found', async () => {
      const { stubs, broadcastStub } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(null);
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      // Start at i=0, will broadcast and recurse up to i=2
      const result = await mv.checkAndRequestApp('hash', 'txid', 2000000, 100000000, null, 0);
      expect(result).to.be.false;
      // Should have broadcast twice (i=0, i=1)
      expect(broadcastStub.broadcastMessageToAll.callCount).to.equal(2);
    });

    it('should return false when temp message has no specifications', async () => {
      const { stubs, logStub } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves({ hash: 'h', type: 'fluxappregister' });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('h', 'txid', 2000000, 100000000, null, 2);
      expect(result).to.be.false;
      expect(logStub.error.called).to.be.true;
    });

    it('should store permanent message and insert specs for a registration with sufficient payment', async () => {
      const insertStub = sinon.stub().resolves();
      const storePermanentStub = sinon.stub().resolves();
      const { stubs } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(
        await domain.tempMessage({ version: 1, hash: 'regHash' }),
      );
      stubs['../appDatabase/appsRepository'].storePermanentMessage = storePermanentStub;
      stubs['../appDatabase/registryManager'].insertAppSpecifications = insertStub;

      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('regHash', 'txid', 2000000, 200000000, null, 2);
      expect(result).to.be.true;
      expect(storePermanentStub.calledOnce).to.be.true;

      // A registration is the one moment both halves of an app's instance
      // identity are in hand: the name being claimed, and the transaction
      // claiming it. It is minted here or nowhere - an update arrives under a
      // different txid and must never re-mint against it.
      //
      // Asserted on the row that reached storage rather than on the call that
      // built it: what matters is that the identity is durable, and a real
      // InstantiatedSpec is what decides whether it survives serialization.
      const { mintAppUuid, identityFromUuid } = require('../../ZelBack/src/services/utils/appIdentity');
      const expectedUuid = mintAppUuid('testapp', 'txid');
      expect(insertStub.calledOnce, 'the registration must be stored').to.be.true;
      const stored = insertStub.firstCall.args[0];
      expect(stored.uuid).to.equal(expectedUuid);
      expect(stored.identity).to.equal(identityFromUuid(expectedUuid));
    });

    it('fail-closed: rejects a v9 registration priced at 0 (no PriceMessage in force) without inserting specs', async () => {
      const insertStub = sinon.stub().resolves();
      const { stubs, v9Regime } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(
        await domain.tempMessage({ version: 2, hash: 'v9reg' }),
      );
      stubs['../appDatabase/registryManager'].insertAppSpecifications = insertStub;

      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      // A zero fee means pricing is not in force yet, not that the app is free.
      // The v9 regime, because a v9 spec declares the unified model.
      v9Regime.registrationFee = sinon.stub().resolves(0n);

      // valueSat 0 would satisfy the old `valueSat >= 0` check and mint a free app.
      const result = await mv.checkAndRequestApp('v9reg', 'txid', 2000000, 0, 1760000000, 2);
      expect(result).to.be.true;
      expect(insertStub.called).to.be.false;
    });

    // registeredAt anchors v9 time-based expiry: a wrong value (0, or a stray
    // retry counter) stores an app every liveness query reads as long-dead.
    async function makeV9Fixture(stubs) {
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(
        await domain.tempMessage({ version: 2, hash: 'v9reg' }),
      );
      const insertStub = sinon.stub().resolves();
      stubs['../appDatabase/registryManager'].insertAppSpecifications = insertStub;
      // The row that reached storage, because a term start only matters if it is
      // durable — asserting on the argument handed to deserialize would pass
      // just as well if the value were dropped on the way to the database.
      return { insertStub };
    }

    it('uses the confirming block time as the v9 registeredAt', async () => {
      const { stubs } = makeBaseStubs();
      const { insertStub } = await makeV9Fixture(stubs);
      const getBlockStub = stubs['../daemonService/daemonServiceBlockchainRpcs'].getBlock;
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('v9reg', 'txid', 2000000, 200000000, 1751234567, 2);

      expect(result).to.be.true;
      expect(insertStub.firstCall.args[0].registeredAt).to.equal(1751234567);
      // block time was supplied — no daemon round-trip
      expect(getBlockStub.called).to.be.false;
    });

    it('recovers the block time from the daemon when the hash row predates it', async () => {
      const { stubs } = makeBaseStubs();
      const { insertStub } = await makeV9Fixture(stubs);
      const getBlockStub = stubs['../daemonService/daemonServiceBlockchainRpcs'].getBlock;
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('v9reg', 'txid', 2000000, 200000000, null, 2);

      expect(result).to.be.true;
      expect(getBlockStub.calledOnce).to.be.true;
      expect(insertStub.firstCall.args[0].registeredAt).to.equal(1750000000);
    });

    it('leaves the hash unresolved rather than storing a v9 app without a block time', async () => {
      const storePermanentStub = sinon.stub().resolves();
      const { stubs } = makeBaseStubs();
      await makeV9Fixture(stubs);
      stubs['../appDatabase/appsRepository'].storePermanentMessage = storePermanentStub;
      stubs['../daemonService/daemonServiceBlockchainRpcs'].getBlock = sinon.stub().resolves({ status: 'error', data: { message: 'no block' } });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('v9reg', 'txid', 2000000, 200000000, null, 2);

      expect(result).to.be.false;
      expect(storePermanentStub.called).to.be.false;
    });

    describe('promoting an update', () => {
      // The confirming block's time, which is the term start a paid update takes.
      const BLOCK_TIME = 1760000000;

      // These tests assert v9 term semantics — a term start carried on the
      // projection, and an update that either renews it or inherits it. Only
      // ConfirmedAppEvent projects registeredAt; AppEventLegacy projects
      // { spec, hash, height } and nothing else. So the message is version 2
      // over a v9 spec, which is the pairing that can actually carry what these
      // tests are about.
      async function updateStubs(activeRow) {
        const made = makeBaseStubs();
        const { stubs } = made;
        stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(
          await domain.tempMessage({
            version: 2, type: 'fluxappupdate', hash: 'updHash', registeredAt: BLOCK_TIME,
          }),
        );
        stubs['../appDatabase/appsRepository'].getGlobalAppInfo = sinon.stub().resolves(activeRow);
        return made;
      }

      it('authorizes against the app active on this node, not the name history', async () => {
        const activeRow = { name: 'testapp', owner: 'currentOwner' };
        const { stubs } = await updateStubs(activeRow);
        const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

        await mv.checkAndRequestApp('updHash', 'txid', 2000000, 200000000, BLOCK_TIME, 2);

        const { authorize } = stubs['./appEventVerifier'];
        sinon.assert.calledOnce(authorize);
        expect(authorize.firstCall.args[0].previousState).to.equal(activeRow);
      });

      // The old shape only re-verified when the name had message history, so an
      // update to a name with no app on this node authorized against nothing.
      it('refuses to promote an update the verifier will not authorize', async () => {
        const storePermanentStub = sinon.stub().resolves();
        const { stubs, logStub } = await updateStubs(null);
        stubs['../appDatabase/appsRepository'].storePermanentMessage = storePermanentStub;
        stubs['./appEventVerifier'].authorize = sinon.stub().rejects(
          new Error('Flux App testapp update cannot be authorized: no registration to update'),
        );
        const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

        const result = await mv.checkAndRequestApp('updHash', 'txid', 2000000, 200000000, BLOCK_TIME, 2);

        expect(result).to.be.false;
        expect(storePermanentStub.called).to.be.false;
        expect(logStub.error.called).to.be.true;
      });

      // The seam the free-update collapse lived in: the fee is computed from a
      // message somebody else selected, and nothing used to check which one.
      describe('what the fee is computed against', () => {
        // A real superseded message. Its spec differs from the one being
        // promoted on `instances`, which is what makes "priced against the
        // predecessor, not against itself" an assertion with something behind
        // it: resolveSpec now really deserializes this, so a blob the spec
        // library would reject cannot stand in for it.
        let predecessor;

        before(async () => {
          predecessor = {
            hash: 'prevHash',
            height: 1999000,
            registeredAt: 1750000000,
            appSpecifications: (await domain.v9Spec({ instances: 5 })).serialize(),
          };
        });

        // v9Regime and not legacyRegime because the spec is v9 — the real
        // dispatcher routes on the model the spec itself declares, so naming the
        // wrong one here would fail rather than silently answer anyway.
        async function pricedUpdate(overrides = {}) {
          const { stubs, v9Regime } = await updateStubs({ name: 'testapp', owner: 'owner1' });
          v9Regime.supersededMessage = sinon.stub().resolves(
            'superseded' in overrides ? overrides.superseded : predecessor,
          );
          v9Regime.updateFee = sinon.stub().resolves(overrides.fee ?? 100000000n);
          stubs['../appDatabase/registryManager'].updateAppSpecifications = sinon.stub().resolves();
          return { stubs, v9Regime };
        }

        it('asks the regime which message this update supersedes, by height and timestamp', async () => {
          const { stubs, v9Regime } = await pricedUpdate();
          const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

          await mv.checkAndRequestApp('updHash', 'txid', 2000000, 200000000, BLOCK_TIME, 2);

          sinon.assert.calledOnce(v9Regime.supersededMessage);
          const [name, confirming] = v9Regime.supersededMessage.firstCall.args;
          expect(name).to.equal('testapp');
          expect(confirming.height).to.equal(2000000);
          expect(confirming.timestamp).to.be.a('number');
        });

        // Priced against itself, a spec matches itself on every rule the
        // free-update policy tests, so the update costs nothing. The fee must
        // see the superseded message's spec and its height, never this one's.
        it('prices against the superseded message, not the message being promoted', async () => {
          const { stubs, v9Regime } = await pricedUpdate();
          const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

          await mv.checkAndRequestApp('updHash', 'txid', 2000000, 200000000, BLOCK_TIME, 2);

          sinon.assert.calledOnce(v9Regime.updateFee);
          const [thisSpec, prevSpec, height, prevHeight, prevRegisteredAt] = v9Regime.updateFee.firstCall.args;
          // the resolved predecessor, not the message being promoted - they are
          // the same app and differ only on instances, so that is the tell
          expect(prevSpec.instances).to.equal(5);
          expect(thisSpec.instances).to.equal(3);
          expect(height).to.equal(2000000);
          expect(prevHeight).to.equal(predecessor.height);
          expect(prevRegisteredAt).to.equal(predecessor.registeredAt);
          expect(prevHeight).to.not.equal(height);
        });

        it('applies an update that pays the fee its regime asks for', async () => {
          const { stubs } = await pricedUpdate({ fee: 100000000n });
          const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

          await mv.checkAndRequestApp('updHash', 'txid', 2000000, 100000000, BLOCK_TIME, 2);

          sinon.assert.calledOnce(stubs['../appDatabase/registryManager'].updateAppSpecifications);
        });

        it('does not apply an underpaid update', async () => {
          const { stubs } = await pricedUpdate({ fee: 100000000n });
          const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

          await mv.checkAndRequestApp('updHash', 'txid', 2000000, 99999999, BLOCK_TIME, 2);

          sinon.assert.notCalled(stubs['../appDatabase/registryManager'].updateAppSpecifications);
        });

        it('applies a free update, which is a fee of zero and not a missing fee', async () => {
          const { stubs } = await pricedUpdate({ fee: 0n });
          const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

          await mv.checkAndRequestApp('updHash', 'txid', 2000000, 0, BLOCK_TIME, 2);

          sinon.assert.calledOnce(stubs['../appDatabase/registryManager'].updateAppSpecifications);
        });

        // A v9 app expires at registeredAt + ttl, so what is stored as the term
        // start decides whether an update renewed the app. A paid update bought
        // its term and starts a new one; a free update bought nothing.
        describe('whether an update renews the term', () => {
          // The tests below drive a double for InstantiatedSpec, so they pin the
          // wiring and not the domain type. This one uses the real class, on the
          // single property the wiring depends on: a term start handed to
          // fromEvent is the one that reaches storage, and a free update's
          // inherited start therefore survives into the row.
          it('really does round-trip a term start through InstantiatedSpec', async () => {
            const { InstantiatedSpec, FluxAppSpecV9 } = await require('@runonflux/flux-spec-cjs').load();
            const spec = FluxAppSpecV9.fromSubmission({
              version: 9,
              name: 'termapp',
              description: 'fixture',
              owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
              instances: 3,
              ttl: 2_592_000,
              contacts: { email: ['test@example.com'] },
              components: {
                web: {
                  name: 'web',
                  image: 'nginx:latest',
                  cpu: 1,
                  memory: 1000,
                  swapGb: 2,
                  rootFsGb: 2,
                  persistentStorage: { sizeGb: 10, mounts: {} },
                  ports: { tcp_80: { containerPort: 80, hostPort: 31000, protocol: 'tcp' } },
                },
              },
            });
            const projection = {
              spec, hash: 'updHash', height: 2000000, registeredAt: 1760000000,
            };

            const asConfirmed = InstantiatedSpec.fromEvent(projection);
            const inheritingTerm = InstantiatedSpec.fromEvent({ ...projection, registeredAt: 1750000000 });

            expect(asConfirmed.serialize().registeredAt).to.equal(1760000000);
            expect(inheritingTerm.serialize().registeredAt).to.equal(1750000000);
            // and the term start is what decides expiry, so inheriting it is
            // exactly declining to renew
            expect(inheritingTerm.isExpired(1750000000 + 2_592_000 + 1, 2000000)).to.equal(true);
            expect(asConfirmed.isExpired(1750000000 + 2_592_000 + 1, 2000000)).to.equal(false);
          });

          function storedRow(stubs) {
            const { updateAppSpecifications } = stubs['../appDatabase/registryManager'];
            sinon.assert.calledOnce(updateAppSpecifications);
            return updateAppSpecifications.firstCall.args[0];
          }

          it('starts a new term when the update paid for one', async () => {
            const { stubs } = await pricedUpdate({ fee: 100000000n });
            const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

            await mv.checkAndRequestApp('updHash', 'txid', 2000000, 100000000, 1760000000, 2);

            expect(storedRow(stubs).registeredAt).to.equal(1760000000);
          });

          // Without this an owner resubmits an unchanged spec near expiry, pays
          // nothing because nothing grew, and walks away with a fresh full term
          // — for as long as they like.
          it('keeps the superseded term start when the update was free', async () => {
            const { stubs } = await pricedUpdate({ fee: 0n });
            const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

            await mv.checkAndRequestApp('updHash', 'txid', 2000000, 0, 1760000000, 2);

            expect(storedRow(stubs).registeredAt).to.equal(predecessor.registeredAt);
          });

          it('starts a new term when the superseded message records none', async () => {
            const { stubs } = await pricedUpdate({
              fee: 0n,
              superseded: { ...predecessor, registeredAt: undefined },
            });
            const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

            await mv.checkAndRequestApp('updHash', 'txid', 2000000, 0, 1760000000, 2);

            expect(storedRow(stubs).registeredAt).to.equal(1760000000);
          });
        });

        it('does not apply an update with nothing to supersede', async () => {
          const { stubs, v9Regime } = await pricedUpdate({ superseded: null });
          const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

          await mv.checkAndRequestApp('updHash', 'txid', 2000000, 200000000, BLOCK_TIME, 2);

          sinon.assert.notCalled(v9Regime.updateFee);
          sinon.assert.notCalled(stubs['../appDatabase/registryManager'].updateAppSpecifications);
        });
      });
    });

    it('should return false and log error when an exception occurs', async () => {
      const { stubs, logStub } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getPermanentMessage = sinon.stub().rejects(new Error('DB crash'));
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('crashHash', 'txid', 2000000, 100000000);
      expect(result).to.be.false;
      expect(logStub.error.called).to.be.true;
    });

    it('decrypts an encrypted registration spec before pricing it', async () => {
      // A genuinely encrypted spec — the enterprise blob stays sealed, so this
      // is a real EncryptedSpecV8 and isEncrypted is the class's own answer.
      const encrypted = await domain.encryptedV8Spec();
      // Opening the blob is the one thing here that leaves the process (it needs
      // the benchmark channel), so it is the one thing stubbed. What the pricer
      // is handed is a cleartext view it can read.
      const decryptedSpec = await domain.v8Spec({ name: 'encapp', expire: 88000 });

      const { stubs, legacyRegime } = makeBaseStubs();
      const resolveInstantiatedStub = sinon.stub().resolves(decryptedSpec);
      stubs['../utils/specCutover'] = { resolveInstantiatedSpec: resolveInstantiatedStub };
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves(
        await domain.tempMessage({ version: 1, hash: 'encReg', spec: encrypted }),
      );

      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);
      const result = await mv.checkAndRequestApp('encReg', 'txid', 2000000, 200000000, null, 2);

      expect(result).to.be.true;
      // the held instance really is encrypted, and it is what gets decrypted
      sinon.assert.calledOnce(resolveInstantiatedStub);
      expect(resolveInstantiatedStub.firstCall.args[0].isEncrypted).to.be.true;
      // pricing ran against the decrypted view, never the sealed wrapper
      expect(legacyRegime.registrationFee.calledOnce).to.be.true;
      expect(legacyRegime.registrationFee.firstCall.args[0]).to.equal(decryptedSpec);
    });
  });

  describe('triggerAppHashesCheckAPI', () => {
    it('should return unauthorized when privilege check fails', async () => {
      const { stubs } = makeBaseStubs({
        '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(false) },
      });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.triggerAppHashesCheckAPI({ params: {}, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('error');
      expect(res.json.firstCall.args[0].data.code).to.equal(401);
    });

    it('should return success when authorized', async () => {
      const { stubs } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const res = { json: sinon.stub() };
      await mv.triggerAppHashesCheckAPI({ params: {}, query: {} }, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0].status).to.equal('success');
    });
  });

  describe('exported functions', () => {
    it('should export all remaining public functions', () => {
      const { stubs } = makeBaseStubs();
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      expect(mv.requestAppMessage).to.be.a('function');
      expect(mv.requestAppsMessage).to.be.a('function');
      expect(mv.requestAppMessageAPI).to.be.a('function');
      expect(mv.appHashHasMessage).to.be.a('function');
      expect(mv.appHashHasMessageNotFound).to.be.a('function');
      expect(mv.getAppsTemporaryMessages).to.be.a('function');
      expect(mv.getAppsPermanentMessages).to.be.a('function');
      expect(mv.checkAndRequestApp).to.be.a('function');
      expect(mv.checkAndRequestMultipleApps).to.be.a('function');
      expect(mv.continuousFluxAppHashesCheck).to.be.a('function');
      expect(mv.triggerAppHashesCheckAPI).to.be.a('function');
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
