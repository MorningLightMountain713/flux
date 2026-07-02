const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('appNetworkLinker tests', () => {
  let appNetworkLinker;
  let appsRepositoryStub;
  let deploymentProviderStub;
  let dockerServiceStub;
  let logStub;

  // Build a minimal InstantiatedSpec-shaped object. shareWith lives on
  // the underlying spec's network object; encrypted/legacy specs expose
  // no readable shareWith.
  function instSpec({
    name, owner = 'owner1', shareWith, encrypted = false,
  } = {}) {
    return {
      name,
      owner,
      isEncrypted: encrypted,
      spec: shareWith === undefined ? {} : { network: { shareWith } },
    };
  }

  // Build a DeploymentSpec-shaped object whose componentEntries expose the
  // given component env arrays via toDockerEnv().
  function deployment(components) {
    return {
      componentEntries() {
        return components.map(([cname, env]) => [cname, { toDockerEnv: () => env }]);
      },
    };
  }

  // Loads the module against the shared stubs. The real config (flag off) is used
  // unless fluxappsOverrides supplies e.g. { manageCollectorLifecycle: true }.
  function loadLinker(fluxappsOverrides) {
    const stubs = {
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../dockerService': dockerServiceStub,
      '../../lib/log': logStub,
    };
    if (fluxappsOverrides) {
      stubs.config = { fluxapps: fluxappsOverrides };
    }
    return proxyquire('../../ZelBack/src/services/appLifecycle/appNetworkLinker', stubs);
  }

  beforeEach(() => {
    appsRepositoryStub = {
      getInstalledApp: sinon.stub(),
      listInstalledApps: sinon.stub(),
    };
    deploymentProviderStub = {
      getInstalledDeployment: sinon.stub(),
    };
    dockerServiceStub = {
      appDockerNetworkConnect: sinon.stub().resolves(),
      getAppContainerNames: sinon.stub().resolves([]),
      getAppContainerObjects: sinon.stub().resolves([]),
    };
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    appNetworkLinker = loadLinker();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getLinkedApps', () => {
    it('returns the shareWith entries declared on the spec', () => {
      const inst = instSpec({ name: 'appB', shareWith: ['appA', 'appC'] });
      expect(appNetworkLinker.getLinkedApps(inst)).to.eql(['appA', 'appC']);
    });

    it('excludes a self-reference and deduplicates', () => {
      const inst = instSpec({ name: 'appB', shareWith: ['appA', 'appB', 'appA'] });
      expect(appNetworkLinker.getLinkedApps(inst)).to.eql(['appA']);
    });

    it('returns an empty list when shareWith is absent', () => {
      expect(appNetworkLinker.getLinkedApps(instSpec({ name: 'appB' }))).to.eql([]);
    });

    it('returns an empty list for an encrypted spec', () => {
      const inst = instSpec({ name: 'appB', shareWith: ['appA'], encrypted: true });
      expect(appNetworkLinker.getLinkedApps(inst)).to.eql([]);
    });

    it('returns an empty list for a falsy spec', () => {
      expect(appNetworkLinker.getLinkedApps(null)).to.eql([]);
    });
  });

  describe('checkAppNetworkRequirements', () => {
    it('resolves true and touches no database when there are no linked apps', async () => {
      const result = await appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB' }));
      expect(result).to.equal(true);
      sinon.assert.notCalled(appsRepositoryStub.getInstalledApp);
    });

    it('throws NETWORK_DEPENDENCY_NOT_READY when a linked app is not installed locally', async () => {
      appsRepositoryStub.getInstalledApp.resolves(null);
      const error = await expect(appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB', shareWith: ['appA'] })))
        .to.be.rejectedWith(/is not installed on this node/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
    });

    it('throws a code-less hard failure when a linked app is owned by a different owner', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner2' }));
      const error = await expect(appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] })))
        .to.be.rejectedWith(/owned by a different owner/);
      expect(error.code).to.equal(undefined);
    });

    it('resolves true when every linked app is installed with the same owner', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      const result = await appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] }));
      expect(result).to.equal(true);
    });

    it('flag off (default): an installed but not-running linked app still satisfies the check', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'exited' }]);
      const result = await appNetworkLinker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] }));
      expect(result).to.equal(true);
      sinon.assert.notCalled(dockerServiceStub.getAppContainerObjects);
    });
  });

  describe('checkAppNetworkRequirements with manageCollectorLifecycle on', () => {
    it('throws NETWORK_DEPENDENCY_NOT_READY when a linked app is installed but not running', async () => {
      const linker = loadLinker({ manageCollectorLifecycle: true });
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'exited' }]);
      const error = await expect(linker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] })))
        .to.be.rejectedWith(/installed but not running yet/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
    });

    it('resolves true when every linked app is installed and running', async () => {
      const linker = loadLinker({ manageCollectorLifecycle: true });
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'running' }]);
      const result = await linker.checkAppNetworkRequirements(instSpec({ name: 'appB', owner: 'owner1', shareWith: ['appA'] }));
      expect(result).to.equal(true);
    });
  });

  describe('isAppRunning', () => {
    it('is true when every container of the app is running', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'running' }]);
      expect(await appNetworkLinker.isAppRunning('appA')).to.equal(true);
    });

    it('is false when any container of the app is not running', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'exited' }]);
      expect(await appNetworkLinker.isAppRunning('appA')).to.equal(false);
    });

    it('is false when the app has no containers', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([]);
      expect(await appNetworkLinker.isAppRunning('appA')).to.equal(false);
    });
  });

  describe('connectComponentToLinkedApps', () => {
    it('does nothing when the app declares no network links', async () => {
      await appNetworkLinker.connectComponentToLinkedApps('fluxweb_appB', instSpec({ name: 'appB' }));
      sinon.assert.notCalled(dockerServiceStub.appDockerNetworkConnect);
    });

    it('connects the container to every linked app network', async () => {
      await appNetworkLinker.connectComponentToLinkedApps('fluxweb_appB', instSpec({ name: 'appB', shareWith: ['appA', 'appC'] }));
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appC');
    });

    it('propagates a connection failure so the install is rolled back', async () => {
      dockerServiceStub.appDockerNetworkConnect.rejects(new Error('docker boom'));
      await expect(appNetworkLinker.connectComponentToLinkedApps('c', instSpec({ name: 'appB', shareWith: ['appA'] })))
        .to.be.rejectedWith('docker boom');
    });
  });

  describe('reconnectLinkedApps', () => {
    it('reconnects only the apps that are networked with the given app', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'appB', shareWith: ['appA'] }),
        instSpec({ name: 'appC', shareWith: [] }),
        instSpec({ name: 'appA', shareWith: ['appA'] }),
      ]);
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB', 'fluxapi_appB']);
      dockerServiceStub.getAppContainerNames.withArgs('appC').resolves(['fluxweb_appC']);

      await appNetworkLinker.reconnectLinkedApps('appA');

      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxapi_appB', 'fluxDockerNetwork_appA');
      expect(dockerServiceStub.appDockerNetworkConnect.calledWith('fluxweb_appC')).to.equal(false);
    });

    it('does not throw when the database read fails', async () => {
      appsRepositoryStub.listInstalledApps.rejects(new Error('db down'));
      await expect(appNetworkLinker.reconnectLinkedApps('appA')).to.not.be.rejected;
    });
  });

  describe('reconcileAllAppNetworkLinks', () => {
    it('connects every linked app to each of its linked app networks', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'appB', shareWith: ['appA'] }),
        instSpec({ name: 'appC', shareWith: [] }),
      ]);
      dockerServiceStub.getAppContainerNames.withArgs('appB').resolves(['fluxweb_appB']);

      await appNetworkLinker.reconcileAllAppNetworkLinks();

      sinon.assert.calledWith(dockerServiceStub.appDockerNetworkConnect, 'fluxweb_appB', 'fluxDockerNetwork_appA');
    });

    it('does not throw when the database read fails', async () => {
      appsRepositoryStub.listInstalledApps.rejects(new Error('db down'));
      await expect(appNetworkLinker.reconcileAllAppNetworkLinks()).to.not.be.rejected;
    });
  });

  describe('findLinkedAppLogCollector', () => {
    it('returns null when there are no linked apps', async () => {
      const result = await appNetworkLinker.findLinkedAppLogCollector(instSpec({ name: 'appB' }));
      expect(result).to.equal(null);
      sinon.assert.notCalled(deploymentProviderStub.getInstalledDeployment);
    });

    it('returns the first linked app exposing a LOG=COLLECT component', async () => {
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').resolves(deployment([
        ['web', ['FOO=BAR']],
        ['logsink', ['LOG=COLLECT']],
      ]));

      const result = await appNetworkLinker.findLinkedAppLogCollector(instSpec({ name: 'appB', shareWith: ['appA'] }));
      expect(result).to.eql({ linkedAppName: 'appA', collectorComponentName: 'logsink' });
    });

    it('skips linked apps whose deployment cannot be built (encrypted on non-Arcane)', async () => {
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').resolves(null);
      deploymentProviderStub.getInstalledDeployment.withArgs('appC').resolves(deployment([
        ['collector', ['LOG=COLLECT']],
      ]));

      const result = await appNetworkLinker.findLinkedAppLogCollector(instSpec({ name: 'appB', shareWith: ['appA', 'appC'] }));
      expect(result).to.eql({ linkedAppName: 'appC', collectorComponentName: 'collector' });
    });

    it('returns null when no linked app exposes a LOG=COLLECT component', async () => {
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').resolves(deployment([
        ['web', ['FOO=BAR']],
      ]));

      const result = await appNetworkLinker.findLinkedAppLogCollector(instSpec({ name: 'appB', shareWith: ['appA'] }));
      expect(result).to.equal(null);
    });

    it('continues past a deployment build that throws', async () => {
      deploymentProviderStub.getInstalledDeployment.withArgs('appA').rejects(new Error('db down'));
      deploymentProviderStub.getInstalledDeployment.withArgs('appC').resolves(deployment([
        ['collector', ['LOG=COLLECT']],
      ]));

      const result = await appNetworkLinker.findLinkedAppLogCollector(instSpec({ name: 'appB', shareWith: ['appA', 'appC'] }));
      expect(result).to.eql({ linkedAppName: 'appC', collectorComponentName: 'collector' });
    });
  });
});
