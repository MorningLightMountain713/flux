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

    const dbHelperStub = {
      databaseConnection: sinon.stub(),
      findOneInDatabase: sinon.stub(),
      findInDatabase: sinon.stub(),
    };

    globalStateStub = {
      removalInProgress: false,
      installationInProgress: false,
      setRemovalInProgress: sinon.stub(),
      resetRemovalInProgress: sinon.stub(),
      getRemovalInProgress: sinon.stub().returns(false),
    };

    dockerServiceStub = {
      appDockerStop: sinon.stub().resolves(),
      appDockerRemove: sinon.stub().resolves(),
      appDockerImageRemove: sinon.stub().resolves(),
      dockerListContainers: sinon.stub().resolves([]),
      getAppIdentifier: sinon.stub().returns('testapp'),
      getBaseAppName: sinon.stub().callsFake((id) => id),
    };

    appUninstaller = proxyquire('../../ZelBack/src/services/appLifecycle/appUninstaller', {
      config: configStub,
      '../verificationHelper': verificationHelperStub,
      '../messageHelper': messageHelperStub,
      '../serviceHelper': {
        ensureString: sinon.stub().returnsArg(0),
        ensureBoolean: sinon.stub().returnsArg(0),
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
      '../appDatabase/appsRepository': {
        getInstalledApp: sinon.stub().resolves(null),
        getGlobalAppInfo: sinon.stub().resolves(null),
        getAppMessage: sinon.stub().resolves(null),
      },
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

});
