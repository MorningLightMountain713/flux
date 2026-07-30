const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

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

  // messageVerifier asks a pricing regime for a fee and does not know how one is
  // computed, so this is the whole pricing surface it can see.
  const regimeStub = {
    onChainDisplayPrice: sinon.stub().resolves(1),
    fiatAndFluxDisplayPrice: sinon.stub().resolves({ usd: 1, flux: 1, fluxDiscount: 0 }),
    registrationFee: sinon.stub().resolves(100000000n),
    updateFee: sinon.stub().resolves(100000000n),
  };

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
    '../pricing/pricingRegime': { regimeFor: sinon.stub().returns(regimeStub) },
    '../utils/specLibs': {
      getSpec: sinon.stub().resolves({}),
      getSpecBackend: sinon.stub().resolves({
        AppEventLegacy: { deserialize: sinon.stub().returns({}) },
        ConfirmedAppEvent: { deserialize: sinon.stub().returns({}) },
        InstantiatedSpec: { fromEvent: sinon.stub().returns({}) },
        deserializeSpec: sinon.stub().returnsArg(0),
      }),
    },
    '../utils/specCutover': {
      resolveSpec: sinon.stub().resolvesArg(0),
      // cleartext seam behaviour: a non-encrypted instance resolves to its own spec
      resolveInstantiatedSpec: sinon.stub().callsFake(async (inst) => inst.spec),
    },
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
    '../appDatabase/appSpecHistory': {
      getPreviousSpec: sinon.stub().resolves(null),
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

  return { stubs, dbStub, logStub, messageHelperStub, broadcastStub, regimeStub };
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
      const serializedEvent = {
        type: 'fluxappregister',
        appSpecifications: { name: 'testapp', version: 8, owner: 'owner1' },
        hash: 'regHash',
      };
      const mockConfirmedEvent = {
        isRegistration: true,
        isUpdate: false,
        spec: { name: 'testapp', version: 8 },
        serialize: sinon.stub().returns(serializedEvent),
        toInstantiatedSpec: sinon.stub().returns({}),
      };
      const mockInstantiated = {
        name: 'testapp',
        spec: { name: 'testapp', version: 8 },
        isExpired: sinon.stub().returns(false),
        serialize: sinon.stub().returns(serializedEvent),
      };

      const { stubs } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves({
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'testapp', version: 8, owner: 'owner1' },
        hash: 'regHash',
        timestamp: Date.now(),
        signature: 'sig',
      });
      stubs['../appDatabase/appsRepository'].storePermanentMessage = storePermanentStub;
      stubs['../appDatabase/registryManager'].insertAppSpecifications = insertStub;
      stubs['../utils/specLibs'].getSpecBackend = sinon.stub().resolves({
        AppEventLegacy: { deserialize: sinon.stub().returns(mockConfirmedEvent) },
        ConfirmedAppEvent: { deserialize: sinon.stub().returns(mockConfirmedEvent) },
        InstantiatedSpec: { fromEvent: sinon.stub().returns(mockInstantiated) },
        deserializeSpec: sinon.stub().returnsArg(0),
      });

      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('regHash', 'txid', 2000000, 200000000, null, 2);
      expect(result).to.be.true;
      expect(storePermanentStub.calledOnce).to.be.true;
    });

    it('fail-closed: rejects a v9 registration priced at 0 (no PriceMessage in force) without inserting specs', async () => {
      const insertStub = sinon.stub().resolves();
      const serializedEvent = {
        type: 'fluxappregister',
        appSpecifications: { name: 'v9app', version: 9, owner: 'owner1' },
        hash: 'v9reg',
      };
      const mockConfirmedEvent = {
        isRegistration: true,
        isUpdate: false,
        spec: { name: 'v9app', version: 9 },
        serialize: sinon.stub().returns(serializedEvent),
        toInstantiatedSpec: sinon.stub().returns({}),
      };
      const mockInstantiated = {
        name: 'v9app',
        spec: { name: 'v9app', version: 9 },
        isExpired: sinon.stub().returns(false),
        serialize: sinon.stub().returns(serializedEvent),
      };

      const { stubs, regimeStub } = makeBaseStubs();
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves({
        type: 'fluxappregister',
        version: 2,
        appSpecifications: { name: 'v9app', version: 9, owner: 'owner1' },
        hash: 'v9reg',
        timestamp: Date.now(),
        signature: 'sig',
      });
      stubs['../appDatabase/registryManager'].insertAppSpecifications = insertStub;
      stubs['../utils/specLibs'].getSpecBackend = sinon.stub().resolves({
        AppEventLegacy: { deserialize: sinon.stub().returns(mockConfirmedEvent) },
        ConfirmedAppEvent: { deserialize: sinon.stub().returns(mockConfirmedEvent) },
        InstantiatedSpec: { fromEvent: sinon.stub().returns(mockInstantiated) },
        deserializeSpec: sinon.stub().returnsArg(0),
      });

      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      // A zero fee means pricing is not in force yet, not that the app is free.
      regimeStub.registrationFee = sinon.stub().resolves(0n);

      // valueSat 0 would satisfy the old `valueSat >= 0` check and mint a free app.
      const result = await mv.checkAndRequestApp('v9reg', 'txid', 2000000, 0, null, 2);
      expect(result).to.be.true;
      expect(insertStub.called).to.be.false;
    });

    // registeredAt anchors v9 time-based expiry: a wrong value (0, or a stray
    // retry counter) stores an app every liveness query reads as long-dead.
    function makeV9Fixture(stubs) {
      const mockConfirmedEvent = {
        isRegistration: true,
        isUpdate: false,
        spec: { name: 'v9app', version: 9 },
        serialize: sinon.stub().returns({}),
        toInstantiatedSpec: sinon.stub().returns({}),
      };
      const mockInstantiated = {
        name: 'v9app',
        spec: { name: 'v9app', version: 9 },
        isExpired: sinon.stub().returns(false),
        serialize: sinon.stub().returns({}),
      };
      const confirmedDeserialize = sinon.stub().returns(mockConfirmedEvent);
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves({
        type: 'fluxappregister',
        version: 2,
        appSpecifications: { name: 'v9app', version: 9, owner: 'owner1' },
        hash: 'v9reg',
        timestamp: Date.now(),
        signature: 'sig',
      });
      stubs['../utils/specLibs'].getSpecBackend = sinon.stub().resolves({
        AppEventLegacy: { deserialize: sinon.stub().returns(mockConfirmedEvent) },
        ConfirmedAppEvent: { deserialize: confirmedDeserialize },
        InstantiatedSpec: { fromEvent: sinon.stub().returns(mockInstantiated) },
        deserializeSpec: sinon.stub().returnsArg(0),
      });
      return { confirmedDeserialize };
    }

    it('uses the confirming block time as the v9 registeredAt', async () => {
      const { stubs } = makeBaseStubs();
      const { confirmedDeserialize } = makeV9Fixture(stubs);
      const getBlockStub = stubs['../daemonService/daemonServiceBlockchainRpcs'].getBlock;
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('v9reg', 'txid', 2000000, 200000000, 1751234567, 2);

      expect(result).to.be.true;
      expect(confirmedDeserialize.firstCall.args[0].registeredAt).to.equal(1751234567);
      // block time was supplied — no daemon round-trip
      expect(getBlockStub.called).to.be.false;
    });

    it('recovers the block time from the daemon when the hash row predates it', async () => {
      const { stubs } = makeBaseStubs();
      const { confirmedDeserialize } = makeV9Fixture(stubs);
      const getBlockStub = stubs['../daemonService/daemonServiceBlockchainRpcs'].getBlock;
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('v9reg', 'txid', 2000000, 200000000, null, 2);

      expect(result).to.be.true;
      expect(getBlockStub.calledOnce).to.be.true;
      expect(confirmedDeserialize.firstCall.args[0].registeredAt).to.equal(1750000000);
    });

    it('leaves the hash unresolved rather than storing a v9 app without a block time', async () => {
      const storePermanentStub = sinon.stub().resolves();
      const { stubs } = makeBaseStubs();
      makeV9Fixture(stubs);
      stubs['../appDatabase/appsRepository'].storePermanentMessage = storePermanentStub;
      stubs['../daemonService/daemonServiceBlockchainRpcs'].getBlock = sinon.stub().resolves({ status: 'error', data: { message: 'no block' } });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);

      const result = await mv.checkAndRequestApp('v9reg', 'txid', 2000000, 200000000, null, 2);

      expect(result).to.be.false;
      expect(storePermanentStub.called).to.be.false;
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
      const serializedEvent = {
        type: 'fluxappregister',
        appSpecifications: { name: 'encapp', version: 8, owner: 'owner1', enterprise: 'base64blob' },
        hash: 'encReg',
      };
      const mockConfirmedEvent = {
        isRegistration: true,
        isUpdate: false,
        spec: { name: 'encapp', version: 8 },
        serialize: sinon.stub().returns(serializedEvent),
        toInstantiatedSpec: sinon.stub().returns({}),
      };
      // Encrypted installed spec: spec is the encrypted wrapper (no components).
      // resolveInstantiatedSpec decrypts the held instance — never serialized.
      const wireForm = { name: 'encapp', version: 8, enterprise: 'base64blob' };
      const mockInstantiated = {
        name: 'encapp',
        isEncrypted: true,
        spec: { name: 'encapp', version: 8 },
        isExpired: sinon.stub().returns(false),
        serialize: sinon.stub().returns(wireForm),
      };
      // The decrypted view the pricing regime can price.
      const decryptedSpec = { name: 'encapp', version: 8, expire: 88000 };

      const { stubs, regimeStub } = makeBaseStubs();
      const resolveInstantiatedStub = sinon.stub().resolves(decryptedSpec);
      stubs['../utils/specCutover'].resolveInstantiatedSpec = resolveInstantiatedStub;
      stubs['../appDatabase/appsRepository'].getTempMessage = sinon.stub().resolves({
        type: 'fluxappregister', version: 1, appSpecifications: wireForm,
        hash: 'encReg', timestamp: Date.now(), signature: 'sig',
      });
      stubs['../utils/specLibs'].getSpecBackend = sinon.stub().resolves({
        AppEventLegacy: { deserialize: sinon.stub().returns(mockConfirmedEvent) },
        ConfirmedAppEvent: { deserialize: sinon.stub().returns(mockConfirmedEvent) },
        InstantiatedSpec: { fromEvent: sinon.stub().returns(mockInstantiated) },
        deserializeSpec: sinon.stub().returnsArg(0),
      });
      const mv = proxyquire('../../ZelBack/src/services/appMessaging/messageVerifier', stubs);
      const result = await mv.checkAndRequestApp('encReg', 'txid', 2000000, 200000000, null, 2);

      expect(result).to.be.true;
      // the held encrypted instance is decrypted to its cleartext pricing view
      expect(resolveInstantiatedStub.calledOnceWith(mockInstantiated)).to.be.true;
      // pricing ran against the decrypted spec, never the encrypted wrapper
      expect(regimeStub.registrationFee.calledOnce).to.be.true;
      expect(regimeStub.registrationFee.firstCall.args[0]).to.equal(decryptedSpec);
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
