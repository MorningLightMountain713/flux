const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
// Real registry singleton - un-stubbed in proxyquire, so the uninstaller and the test share it.
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');

describe('appUninstaller tests', () => {
  let appUninstaller;
  let verificationHelperStub;
  let messageHelperStub;
  let logStub;
  let configStub;
  let globalStateStub;
  let dockerServiceStub;
  let dbHelperStub;
  let appsRepositoryStub;

  beforeEach(() => {
    configStub = {
      database: {
        url: 'mongodb://localhost:27017',
        daemon: {
          collections: { scannedHeight: 'scannedHeight', appsHashes: 'appsHashes' },
          database: 'daemon',
        },
        appslocal: {
          collections: { appsInformation: 'localAppsInformation' },
          database: 'localapps',
        },
        appsglobal: {
          collections: {
            appsMessages: 'appsMessages',
            appsInformation: 'globalAppsInformation',
            appsTemporaryMessages: 'appsTemporaryMessages',
            appsLocations: 'appsLocations',
          },
          database: 'globalapps',
        },
      },
      fluxapps: {
        newMinBlocksAllowance: 22000,
        newMinBlocksAllowanceBlock: 1000000,
        minBlocksAllowance: 5000,
      },
    };

    verificationHelperStub = {
      verifyPrivilege: sinon.stub(),
    };

    messageHelperStub = {
      createErrorMessage: sinon.stub(),
      errUnauthorizedMessage: sinon.stub(),
      createSuccessMessage: sinon.stub().returns({ status: 'success' }),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    dbHelperStub = {
      databaseConnection: sinon.stub(),
      findOneInDatabase: sinon.stub(),
      findInDatabase: sinon.stub(),
      removeDocumentsFromCollection: sinon.stub().resolves(),
    };

    globalStateStub = {};

    dockerServiceStub = {
      appDockerStop: sinon.stub().resolves(),
      appDockerRemove: sinon.stub().resolves(),
      appDockerImageRemove: sinon.stub().resolves(),
      dockerListContainers: sinon.stub().resolves([]),
      getAppIdentifier: sinon.stub().returns('testapp'),
      getBaseAppName: sinon.stub().callsFake((id) => id),
    };

    appsRepositoryStub = {
      getInstalledApp: sinon.stub().resolves(null),
      getGlobalAppInfo: sinon.stub().resolves(null),
      getAppMessage: sinon.stub().resolves(null),
      removeInstalledApp: sinon.stub().resolves(),
      listInstalledApps: sinon.stub().resolves([]),
      listGlobalAppInfo: sinon.stub().resolves([]),
      removeGlobalAppInfo: sinon.stub().resolves(),
    };

    appUninstaller = proxyquire('../../ZelBack/src/services/appLifecycle/appUninstaller', {
      config: configStub,
      '../verificationHelper': verificationHelperStub,
      '../messageHelper': messageHelperStub,
      '../serviceHelper': {
        ensureString: sinon.stub().returnsArg(0),
        ensureBoolean: sinon.stub().returnsArg(0),
        ensureNumber: sinon.stub().callsFake((v) => Number(v)),
        delay: sinon.stub().resolves(),
      },
      '../dbHelper': dbHelperStub,
      '../dockerService': dockerServiceStub,
      '../../lib/log': logStub,
      '../utils/globalState': globalStateStub,
      '../utils/appConstants': proxyquire('../../ZelBack/src/services/utils/appConstants', {
        config: configStub,
      }),
      './appOperations': {
        reindexGlobalAppsInformation: sinon.stub().resolves(),
        updateAppSpecsForRestoredNode: sinon.stub().resolves(),
        checkAndNotifyPeersOfRunningApps: sinon.stub().resolves(),
      },
      '../upnpService': {
        removeMapUpnpPort: sinon.stub().resolves(),
        isUPNP: sinon.stub().returns(false),
      },
      '../fluxNetworkHelper': {
        closeConnection: sinon.stub().resolves(),
        isFirewallActive: sinon.stub().resolves(false),
        allowPort: sinon.stub().resolves(true),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
      },
      '../appDatabase/registryManager': {
        availableApps: sinon.stub().resolves([]),
      },
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../providers/FluxOSLegacyCryptoProvider': {
        create: sinon.stub().resolves({
          decrypt: sinon.stub().resolves(Buffer.from('{}')),
        }),
      },
      '../utils/specLibs': {
        getSpec: sinon.stub().resolves({
          FluxAppSpecBase: { getVersionClass: sinon.stub().returns(null) },
        }),
        getSpecBackend: sinon.stub().resolves({ EncryptedSpecBase: class EncryptedSpecBase {}, InstantiatedSpec: class InstantiatedSpec {} }),
      },
      '../appManagement/appInspector': {
        stopAppMonitoring: sinon.stub().resolves(),
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('removeAppLocallyApi', () => {
    it('should reject unauthorized users', async () => {
      const req = {
        params: { appname: 'testapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(verificationHelperStub.verifyPrivilege.called).to.be.true;
    });

    it('should handle missing appname parameter', async () => {
      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      messageHelperStub.createErrorMessage.returns({ status: 'error' });

      await appUninstaller.removeAppLocallyApi(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('uninstallApplication tests', () => {
    it('reports the error via onStatus and returns FAILED if no app name is specified', async () => {
      const messages = [];
      const result = await appUninstaller.uninstallApplication(undefined, { onStatus: (msg) => messages.push(msg) });
      expect(messages.some((m) => m.includes('No App specified'))).to.be.true;
      expect(result.status).to.equal(appUninstaller.UninstallStatus.FAILED);
    });

    it('reports not found via onStatus and returns SKIPPED when the app is missing and skipGuard is false', async () => {
      const messages = [];
      const result = await appUninstaller.uninstallApplication('nonexistent', { onStatus: (msg) => messages.push(msg) });
      expect(messages.some((m) => m.includes('Flux App not found'))).to.be.true;
      expect(result.status).to.equal(appUninstaller.UninstallStatus.SKIPPED);
    });

    it('returns DEFERRED without attempting removal when the app holds an operation lease', async () => {
      operationRegistry.acquire('anyapp', 'install', 'test');
      try {
        const result = await appUninstaller.uninstallApplication('anyapp', {});
        expect(result.status).to.equal(appUninstaller.UninstallStatus.DEFERRED);
      } finally {
        operationRegistry.clear();
      }
    });
  });

  describe('reclaimUnusedImages (reference-gated image GC)', () => {
    const noop = () => {};

    it('removes an image no remaining container references', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.calledOnceWithExactly('alpine:latest')).to.be.true;
    });

    it('leaves an image still referenced by another container (matched by tag)', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Image: 'alpine:latest' }]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.called).to.be.false;
    });

    it('leaves an image still referenced by ImageID', async () => {
      dockerServiceStub.dockerListContainers.resolves([{ Image: 'other:tag', ImageID: 'sha256:abc' }]);
      await appUninstaller.reclaimUnusedImages(['sha256:abc'], noop);
      expect(dockerServiceStub.appDockerImageRemove.called).to.be.false;
    });

    it('deduplicates a shared image to a single removal', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      await appUninstaller.reclaimUnusedImages(['alpine:latest', 'alpine:latest', 'alpine:latest'], noop);
      expect(dockerServiceStub.appDockerImageRemove.calledOnce).to.be.true;
    });

    it('treats a Docker "must force" 409 as benign (no error logged)', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      dockerServiceStub.appDockerImageRemove.rejects(new Error('(HTTP code 409) unable to remove repository reference "alpine:latest" (must force)'));
      await appUninstaller.reclaimUnusedImages(['alpine:latest'], noop);
      expect(logStub.error.called).to.be.false;
    });

    it('no-ops on an empty list without listing containers', async () => {
      await appUninstaller.reclaimUnusedImages([], noop);
      expect(dockerServiceStub.dockerListContainers.called).to.be.false;
    });
  });

  describe('expireGlobalApplications (authoritative-global expiry decision)', () => {
    // listInstalledApps/listGlobalAppInfo return hydrated specs exposing .name,
    // .height and .isExpired(nowSeconds, explorerHeight) - we control all three so the
    // decision is exercised in isolation. Selection is observed via the
    // "Application <name> is expired, removing" warn emitted BEFORE uninstallApplication.
    const spec = (name, height, expired) => ({ name, height, isExpired: () => expired });
    const wasSelected = (name) => logStub.warn.getCalls()
      .some((c) => c.args[0] === `Application ${name} is expired, removing`);

    beforeEach(() => {
      dbHelperStub.databaseConnection.returns({ db: sinon.stub().returns({}) });
      dbHelperStub.findOneInDatabase.resolves({ generalScannedHeight: 1000000 });
    });

    it('does NOT remove a renewed app whose authoritative GLOBAL spec is unexpired (F6-G stale-local)', async () => {
      // The local install row carries a stale shorter expire (says expired); the
      // authoritative global spec is renewed (says alive). Must trust global.
      appsRepositoryStub.listInstalledApps.resolves([spec('renewed', 100, true)]);
      appsRepositoryStub.listGlobalAppInfo.callsFake(({ filter } = {}) => (
        filter && filter.name && filter.name.$in
          ? Promise.resolve([spec('renewed', 100, false)]) // authoritative: not expired
          : Promise.resolve([]) // height-filtered candidates exclude the renewed app
      ));
      await appUninstaller.expireGlobalApplications();
      expect(wasSelected('renewed')).to.equal(false);
    });

    it('does NOT remove a forever app (height===0) - checked before !height (F6-H)', async () => {
      appsRepositoryStub.listInstalledApps.resolves([spec('forever', 0, false)]);
      appsRepositoryStub.listGlobalAppInfo.resolves([]); // no global row -> local fallback (height 0)
      await appUninstaller.expireGlobalApplications();
      expect(wasSelected('forever')).to.equal(false);
    });

    it('removes an app the authoritative global confirms expired', async () => {
      const expiredSpec = spec('expiredapp', 50, true);
      appsRepositoryStub.listInstalledApps.resolves([expiredSpec]);
      appsRepositoryStub.listGlobalAppInfo.resolves([expiredSpec]); // candidates + $in both expired
      await appUninstaller.expireGlobalApplications();
      expect(wasSelected('expiredapp')).to.equal(true);
    });

    it('falls back to the local row when the app has no global registration', async () => {
      appsRepositoryStub.listInstalledApps.resolves([spec('manual', 100, true)]);
      appsRepositoryStub.listGlobalAppInfo.resolves([]); // absent from global -> evaluate off local
      await appUninstaller.expireGlobalApplications();
      expect(wasSelected('manual')).to.equal(true);
    });
  });

});
