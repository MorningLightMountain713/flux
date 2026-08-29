'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. Everything this module does arithmetic on comes off real objects: the
// installed rows are real InstantiatedSpecs (the class appsRepository.hydrate
// produces), and every figure it sums is a real DeploymentSpec's own
// resourceTotals()/reservableHostDiskGb(). The host-disk overhead in particular
// is the spec's to state — a fake that added a flat 12GB was asserting the
// answer it was there to check.
//
// What stays stubbed is I/O and node policy: mongo (appsRepository), the
// hardware probe (hwRequirements), the deployment provider (two daemon RPCs and
// the docker socket), the uninstaller, and the delay between removals.

// One fixed apps folder for every DeploymentSpec here.
const APPS_FOLDER = '/tmp/flux/apps/';

let flux;

describe('hardwareValidationService tests', () => {
  let hardwareValidationService;
  let logStub;
  let configStub;
  let appsRepositoryStub;
  let hwRequirementsStub;
  let appUninstallerStub;
  let serviceHelperStub;
  let deploymentProviderStub;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  /**
   * A real FluxAppSpecV9 sized to order.
   *
   * `memory` must be a multiple of 100 and `cpu` at most 14 — the schema says
   * so, which is why the numbers below are not the ones a literal could carry.
   * rootFsGb 10 + swapGb 2 is the per-component overhead the host must hold on
   * top of the persistent volume, so reservableHostDiskGb() comes out as
   * storageGb + 12 — derived by flux-spec rather than added by this file.
   */
  function specSized(name, { cpu, memoryMb, storageGb }) {
    return v9Spec({
      name,
      components: {
        web: {
          ...V9_SUBMISSION.components.web,
          cpu,
          memory: memoryMb,
          rootFsGb: 10,
          swapGb: 2,
          persistentStorage: { sizeGb: storageGb, mounts: {} },
        },
      },
    });
  }

  /** Real DeploymentSpecs — one per identity installed on this node. */
  function deploymentsFor(spec, replicas) {
    return replicas.map((replica) => flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica }));
  }

  /**
   * Register real installed apps: each returns the row appsRepository hands over
   * and wires the (stubbed) provider to answer with that app's real deployments.
   *
   * `height: undefined` builds the row the way appsRepository.hydrate does, from
   * a stored document — which is how a row written before the height column
   * existed comes back with no height at all.
   */
  async function installAll(entries) {
    const rows = [];
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      const spec = await specSized(entry.name, entry.sizing);
      const row = entry.height === undefined
        ? flux.InstantiatedSpec.deserialize({ ...spec.serialize(), hash: 'a'.repeat(64) })
        // eslint-disable-next-line no-await-in-loop
        : await instantiatedSpec(spec, { height: entry.height });
      rows.push(row);
      deploymentProviderStub.getInstalledDeployments
        .withArgs(entry.name).resolves(deploymentsFor(spec, entry.replicas ?? [null]));
    }
    return rows;
  }

  /** An app that comfortably fits the node below: 1 CPU, 1000MB, 17GB of host disk. */
  const FITS = Object.freeze({ cpu: 1, memoryMb: 1000, storageGb: 5 });

  /** The node every test measures against: 4 cores, 8GB, 100GB. Net of the
   *  locked reserves below that is 3 CPU, 6192MB and 85GB usable. */
  function fourCoreNode() {
    hwRequirementsStub.getNodeSpecs.resolves({ cpuCores: 4, ram: 8192, ssdStorage: 100 });
  }

  beforeEach(() => {
    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    // Config stub - 4 CPU node (40 CPU units), 8GB RAM, 100GB storage
    configStub = {
      lockedSystemResources: {
        cpu: 10, // 1 CPU reserved
        ram: 2000, // 2GB reserved
        hdd: 10, // 10GB reserved
        extrahdd: 0,
      },
    };

    appsRepositoryStub = {
      listInstalledApps: sinon.stub().resolves([]),
    };

    hwRequirementsStub = {
      getNodeSpecs: sinon.stub(),
    };

    appUninstallerStub = {
      uninstallApplication: sinon.stub().resolves(),
    };

    serviceHelperStub = {
      delay: sinon.stub().resolves(),
    };

    // Validation sums every identity installed here, so the provider answers
    // with a list. An app nothing was registered for answers the empty list -
    // the "no deployment found" case.
    deploymentProviderStub = {
      getInstalledDeployments: sinon.stub().resolves([]),
    };

    hardwareValidationService = proxyquire('../../ZelBack/src/services/appLifecycle/hardwareValidationService', {
      '../../lib/log': logStub,
      config: configStub,
      '../appRequirements/hwRequirements': hwRequirementsStub,
      './appUninstaller': appUninstallerStub,
      '../serviceHelper': serviceHelperStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('performBootTimeHardwareValidation', () => {
    it('should return empty results if no apps are installed', async () => {
      appsRepositoryStub.listInstalledApps.resolves([]);

      const result = await hardwareValidationService.performBootTimeHardwareValidation();

      expect(result).to.deep.equal({
        appsChecked: 0,
        appsRemoved: [],
        appsFailed: [],
      });
      expect(logStub.info.calledWith('hardwareValidationService - No installed apps found')).to.equal(true);
    });

    it('should not remove apps if all apps meet hardware requirements', async () => {
      fourCoreNode();
      const rows = await installAll([
        { name: 'app1', height: 1000, sizing: FITS },
        { name: 'app2', height: 2000, sizing: FITS },
      ]);
      appsRepositoryStub.listInstalledApps.resolves(rows);

      // The rows carry what the sweep reads off them, and the deployments answer
      // the two questions it asks - both of which live in flux-spec, so a
      // delegation removed there must fail here rather than pass silently.
      rows.forEach((row) => {
        expect(row.name, 'the sweep looks the app up by name').to.be.a('string');
        expect(row.height, 'installation order is the chain height').to.be.a('number');
      });
      const [deployment] = await deploymentProviderStub.getInstalledDeployments('app1');
      assertAnswers(deployment, ['resourceTotals', 'reservableHostDiskGb']);

      const result = await hardwareValidationService.performBootTimeHardwareValidation();

      expect(result.appsChecked).to.equal(2);
      expect(result.appsRemoved).to.have.length(0);
      expect(result.appsFailed).to.have.length(0);
      expect(logStub.info.calledWith('hardwareValidationService - All installed apps meet hardware requirements')).to.equal(true);
      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
    });

    it('should handle critical error gracefully', async () => {
      appsRepositoryStub.listInstalledApps.rejects(new Error('Database connection failed'));

      const result = await hardwareValidationService.performBootTimeHardwareValidation();

      expect(result).to.deep.equal({
        appsChecked: 0,
        appsRemoved: [],
        appsFailed: [],
      });
      expect(logStub.error.calledWith(sinon.match(/Critical error/))).to.equal(true);
    });
  });

  describe('validateAppsCumulatively', () => {
    it('should return empty array if all apps fit within capacity', async () => {
      fourCoreNode();
      const rows = await installAll([
        { name: 'app1', height: 1000, sizing: FITS },
        { name: 'app2', height: 2000, sizing: FITS },
      ]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(0);
    });

    it('should remove app that individually exceeds CPU capacity', async () => {
      fourCoreNode();
      const rows = await installAll([
        { name: 'bigapp', height: 1000, sizing: { cpu: 5, memoryMb: 1000, storageGb: 5 } },
      ]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('bigapp');
      expect(result[0].reason).to.include('requires 5 CPU');
    });

    it('should remove app that individually exceeds RAM capacity', async () => {
      fourCoreNode();
      const rows = await installAll([
        { name: 'bigapp', height: 1000, sizing: { cpu: 1, memoryMb: 7200, storageGb: 5 } },
      ]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('bigapp');
      expect(result[0].reason).to.include('requires 7200MB RAM');
    });

    it('should remove app that individually exceeds storage capacity', async () => {
      fourCoreNode();
      const rows = await installAll([
        { name: 'bigapp', height: 1000, sizing: { cpu: 1, memoryMb: 1000, storageGb: 80 } },
      ]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('bigapp');
      // 80GB of volume + the component's own rootFs and swap: the full host
      // footprint flux-spec states, not the declared persistent size.
      expect(result[0].reason).to.include('requires 92GB storage');
    });

    it('should sum every identity of a co-located app', async () => {
      fourCoreNode();
      // Two named replicas of one app on this node. Each holds its own
      // containers and volumes, so one identity's totals report a fraction of
      // what the app actually consumes here: 2 CPU fits, 2 + 2 does not.
      const rows = await installAll([
        { name: 'app1', height: 1000, sizing: { cpu: 2, memoryMb: 1000, storageGb: 5 }, replicas: ['r1', 'r2'] },
      ]);
      expect(await deploymentProviderStub.getInstalledDeployments('app1')).to.have.length(2);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('app1');
      expect(result[0].reason).to.include('requires 4 CPU');
    });

    it('should remove newer apps when cumulative CPU exceeds capacity', async () => {
      fourCoreNode();
      const sizing = { cpu: 2, memoryMb: 1000, storageGb: 5 };
      const rows = await installAll([
        { name: 'app1', height: 1000, sizing },
        { name: 'app2', height: 2000, sizing },
      ]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('app2');
      expect(result[0].reason).to.include('Cumulative CPU limit exceeded');
    });

    it('should remove newer apps when cumulative RAM exceeds capacity', async () => {
      fourCoreNode();
      const sizing = { cpu: 1, memoryMb: 4100, storageGb: 5 };
      const rows = await installAll([
        { name: 'app1', height: 1000, sizing },
        { name: 'app2', height: 2000, sizing },
      ]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('app2');
      expect(result[0].reason).to.include('Cumulative RAM limit exceeded');
    });

    it('should remove newer apps when cumulative storage exceeds capacity', async () => {
      fourCoreNode();
      const sizing = { cpu: 1, memoryMb: 1000, storageGb: 40 };
      const rows = await installAll([
        { name: 'app1', height: 1000, sizing },
        { name: 'app2', height: 2000, sizing },
      ]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('app2');
      expect(result[0].reason).to.include('Cumulative storage limit exceeded');
    });

    it('should sort apps by height and keep oldest apps', async () => {
      fourCoreNode();
      const sizing = { cpu: 1.5, memoryMb: 1000, storageGb: 5 };
      const rows = await installAll([
        { name: 'newest-app', height: 3000, sizing },
        { name: 'oldest-app', height: 1000, sizing },
        { name: 'middle-app', height: 2000, sizing },
      ]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(1);
      expect(result[0].name).to.equal('newest-app');
      expect(result[0].height).to.equal(3000);
    });

    it('should handle apps with missing height field (treat as 0)', async () => {
      fourCoreNode();
      // app1 is a row stored before the height column existed - the real
      // InstantiatedSpec built from that document reports no height at all.
      const rows = await installAll([
        { name: 'app1', height: undefined, sizing: FITS },
        { name: 'app2', height: 1000, sizing: FITS },
      ]);
      expect(rows[0].height, 'a legacy row states no height').to.equal(undefined);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(0);
    });

    it('should skip app if deployment is not found', async () => {
      fourCoreNode();
      const rows = await installAll([
        { name: 'app1', height: 1000, sizing: FITS },
        { name: 'app2', height: 2000, sizing: FITS },
      ]);
      // Installed in the database, but no identity was ever provisioned here.
      deploymentProviderStub.getInstalledDeployments.withArgs('app1').resolves([]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(0);
      expect(logStub.warn.calledWith('hardwareValidationService - No deployment found for app1, skipping')).to.equal(true);
    });

    it('should return empty array if storage is 0', async () => {
      hwRequirementsStub.getNodeSpecs.resolves({ cpuCores: 4, ram: 8192, ssdStorage: 0 });
      const rows = await installAll([{ name: 'app1', height: 1000, sizing: FITS }]);

      const result = await hardwareValidationService.validateAppsCumulatively(rows);

      expect(result).to.have.length(0);
      expect(logStub.error.calledWith(sinon.match(/No storage detected/))).to.equal(true);
    });
  });

  describe('removeNonCompliantApps', () => {
    // The input here is the sweep's OWN verdict shape - {name, reason, height}
    // built by validateAppsCumulatively above - not a spec object, so these stay
    // plain: substituting a spec would be describing something the caller
    // never passes.
    it('should return empty results if no apps to remove', async () => {
      const result = await hardwareValidationService.removeNonCompliantApps([]);

      expect(result).to.deep.equal({
        removed: [],
        failed: [],
      });
      expect(appUninstallerStub.uninstallApplication.called).to.equal(false);
    });

    it('should successfully remove a single app', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
      ];

      appUninstallerStub.uninstallApplication.resolves();

      const result = await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(result.removed).to.have.length(1);
      expect(result.removed[0]).to.equal('app1');
      expect(result.failed).to.have.length(0);
      expect(logStub.warn.calledWith(sinon.match(/REMOVAL REASON: Hardware downgrade - app1/))).to.equal(true);
      expect(logStub.info.calledWith(sinon.match(/Successfully removed app1/))).to.equal(true);
      expect(appUninstallerStub.uninstallApplication.firstCall.args[0]).to.equal('app1');
    });

    it('should successfully remove multiple apps', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
        { name: 'app2', reason: 'RAM requirements not met', height: 2000 },
        { name: 'app3', reason: 'Storage requirements not met', height: 3000 },
      ];

      appUninstallerStub.uninstallApplication.resolves();

      const result = await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(result.removed).to.have.length(3);
      expect(result.removed).to.include('app1');
      expect(result.removed).to.include('app2');
      expect(result.removed).to.include('app3');
      expect(result.failed).to.have.length(0);
      expect(appUninstallerStub.uninstallApplication.callCount).to.equal(3);
      expect(serviceHelperStub.delay.callCount).to.equal(3);
    });

    it('should handle removal failure and add to failed list', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
      ];

      appUninstallerStub.uninstallApplication.rejects(new Error('Container not found'));

      const result = await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(result.removed).to.have.length(0);
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].name).to.equal('app1');
      expect(result.failed[0].error).to.equal('Container not found');
      expect(logStub.error.calledWith(sinon.match(/Failed to remove app1/))).to.equal(true);
    });

    it('should handle mixed success and failure', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
        { name: 'app2', reason: 'RAM requirements not met', height: 2000 },
        { name: 'app3', reason: 'Storage requirements not met', height: 3000 },
      ];

      appUninstallerStub.uninstallApplication.onFirstCall().resolves();
      appUninstallerStub.uninstallApplication.onSecondCall().rejects(new Error('Removal failed'));
      appUninstallerStub.uninstallApplication.onThirdCall().resolves();

      const result = await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(result.removed).to.have.length(2);
      expect(result.removed).to.include('app1');
      expect(result.removed).to.include('app3');
      expect(result.failed).to.have.length(1);
      expect(result.failed[0].name).to.equal('app2');
    });

    it('should delay 5 seconds between removals', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
        { name: 'app2', reason: 'RAM requirements not met', height: 2000 },
      ];

      appUninstallerStub.uninstallApplication.resolves();

      await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(serviceHelperStub.delay.callCount).to.equal(2);
      expect(serviceHelperStub.delay.alwaysCalledWith(5000)).to.equal(true);
    });

    it('should call uninstallApplication with correct parameters', async () => {
      const appsToRemove = [
        { name: 'app1', reason: 'CPU requirements not met', height: 1000 },
      ];

      appUninstallerStub.uninstallApplication.resolves();

      await hardwareValidationService.removeNonCompliantApps(appsToRemove);

      expect(appUninstallerStub.uninstallApplication.calledOnce).to.equal(true);
      const call = appUninstallerStub.uninstallApplication.getCall(0);
      expect(call.args[0]).to.equal('app1');
      expect(call.args[1]).to.deep.equal({ forceKill: true, skipGuard: true, broadcastRemoval: true });
    });
  });
});
