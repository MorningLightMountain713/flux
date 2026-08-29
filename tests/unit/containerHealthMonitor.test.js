'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// containerHealthMonitor's monitorAndRecoverApps (the old hourly restart
// actuator) was removed by the reconciler rearchitecture — restart/start
// decisions live in appReconciler now (see appReconciler.test.js). What
// remains here is the recreate path: rebuilding a missing container from the
// installed deployment, and the masterSlave wrapper that escalates to removal
// when recreation is impossible. Component sizing (tier overrides) happens
// inside deploymentProvider.buildDeployment, so it is covered there, not here.
//
// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. The InstantiatedSpec, the DeploymentSpec and its DeploymentComponents
// are the real classes, so `identifier`, `dir`, `owner` and `isStateless` are all
// derived by the library from one submission rather than asserted onto literals.
// What stays stubbed is I/O and FluxOS policy: docker (componentProvisioner),
// the volume mount probe, the bind-mount source repair, and the syncthing scan.
let flux;

describe('containerHealthMonitor tests', () => {
  let containerHealthMonitor;
  let deploymentProviderStub;
  let shutdownPlanStub;
  let componentProvisionerStub;
  let appVolumeServiceStub;
  let volumeServiceStub;
  let appDockerNetworkStub;
  let instantiated;
  let deployment;
  let statelessInstantiated;
  let statelessDeployment;
  let webComp;
  let dbComp;

  /**
   * A real DeploymentSpec + its InstantiatedSpec, built from ONE v9 submission —
   * exactly the pair deploymentProvider.installedDeployments hands the monitor in
   * production, and built the same way (same appsFolder, `replica` stated rather
   * than defaulted, as DeploymentSpec.fromSpec demands).
   */
  async function appFor(components) {
    const spec = await v9Spec({ name: 'testapp', components });
    return {
      instantiated: await instantiatedSpec(spec),
      deployment: flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null }),
    };
  }

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();

    ({ instantiated, deployment } = await appFor({
      web: V9_SUBMISSION.components.web,
      // A second component so the whole-app path recreates more than one
      // container. Two components may not share a hostPort.
      db: {
        ...V9_SUBMISSION.components.web,
        name: 'db',
        description: 'postgres',
        image: 'postgres:16',
        ports: { pg: { containerPort: 5432, hostPort: 31001 } },
      },
    }));
    webComp = deployment.getComponent('web');
    dbComp = deployment.getComponent('db');

    // A component with no persistent storage at all — the v9 stateless form.
    // Its volume is absent BY DESIGN, which is the other side of the
    // isStateless gate below.
    ({ instantiated: statelessInstantiated, deployment: statelessDeployment } = await appFor({
      web: { ...V9_SUBMISSION.components.web, persistentStorage: { sizeGb: 0 } },
    }));

    // Everything the monitor keys on is DERIVED by the library, never asserted
    // onto the fixture here.
    expect(webComp.identifier).to.equal('web_testapp');
    expect(dbComp.identifier).to.equal('db_testapp');
    expect(instantiated.name).to.equal('testapp');
    expect(instantiated.identity, 'no identity stored, so the bare name is the app-level identifier').to.equal(null);
    expect(webComp.isStateless, 'persistentStorage.sizeGb 5 is stateful').to.be.false;
    expect(webComp.dir, 'and a stateful component always has a host directory').to.equal(`${appsFolder}flux${webComp.identifier}`);
    expect(statelessDeployment.getComponent('web').isStateless, 'sizeGb 0 is stateless').to.be.true;
    expect(statelessDeployment.getComponent('web').dir, 'and therefore has no directory').to.equal(null);
  });

  beforeEach(() => {
    deploymentProviderStub = {
      // The monitor drives the INSTALLED view. Backed by a settable deployment
      // so a test can swap in the stateless app without reaching past the stub.
      installedDeployments: sinon.stub().resolves([deployment]),
    };
    shutdownPlanStub = { appRequiresDaemonShutdown: sinon.stub().returns(true) };
    componentProvisionerStub = { installComponent: sinon.stub().resolves() };
    appVolumeServiceStub = { ensureMountSourcesExist: sinon.stub().resolves() };
    volumeServiceStub = { verifyAppVolumeMount: sinon.stub().resolves(false) };
    appDockerNetworkStub = {
      ensureAppDockerNetwork: sinon.stub().resolves('net'),
      ensureAppNetworkPresent: sinon.stub().resolves('net'),
    };

    containerHealthMonitor = proxyquire('../../ZelBack/src/services/appMonitoring/containerHealthMonitor', {
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      // Stubbed HERE because proxyquire does not recurse: the heal path
      // reinstalls a component through this module, and left real it resolves
      // the real dockerService and appVolumeService and drives the daemon.
      '../appLifecycle/componentProvisioner': componentProvisionerStub,
      '../appLifecycle/appVolumeService': appVolumeServiceStub,
      '../appRuntime/deploymentProvider': deploymentProviderStub,
      '../appLifecycle/shutdownPlan': shutdownPlanStub,
      '../utils/volumeService': volumeServiceStub,
      // requestFolderScan reaches syncthing over axios and spawns processes.
      './syncthingMonitorHelpers': { requestFolderScan: sinon.stub().resolves() },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('module surface', () => {
    it('no longer exposes monitorAndRecoverApps - the reconciler owns runtime recovery', () => {
      expect(containerHealthMonitor.monitorAndRecoverApps).to.be.undefined;
      expect(containerHealthMonitor.recreateMissingContainers).to.be.a('function');
    });

    describe('allowVolumeCreation (the network-detach heal)', () => {
      // Creating a volume runs fallocate + mke2fs on the app's volume file, i.e. it
      // REFORMATS the app's data (installComponent createVolumes). The heal
      // deliberately force-removes a LIVE container whose data is intact, so it must
      // never be able to trigger that path - a transient verifyAppVolumeMount
      // failure would wipe user data.
      it('throws instead of creating the volume for a component whose volume cannot be verified', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);
        let err;
        try {
          await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated, { allowVolumeCreation: false });
        } catch (e) { err = e; }

        expect(err).to.be.an('error');
        expect(err.message).to.include('without creating (reformatting) its data volume');
        expect(componentProvisionerStub.installComponent.called, 'must never reach a volume-creating install for a container it was asked to rebuild without one').to.be.false;
      });

      it('throws instead of creating volumes on the whole-app path', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);
        let err;
        try {
          await containerHealthMonitor.recreateMissingContainers('testapp', instantiated, { allowVolumeCreation: false });
        } catch (e) { err = e; }

        expect(err).to.be.an('error');
        expect(componentProvisionerStub.installComponent.called).to.be.false;
      });

      // The other side of the same gate. A stateless component has no volume by
      // design, so "not mounted" is its correct steady state and the refusal —
      // whose entire purpose is to avoid silently reformatting DATA — must not
      // fire, or the heal can never rebuild a stateless container at all.
      //
      // Invisible while the components were literals: a hand-written double
      // implicitly had a volume, so this branch was never handed one that
      // legitimately does not. (syncthingMonitor had the same blind spot and
      // was missing the gate outright — see syncthingMonitor.test.js.)
      it('recreates a stateless component whose volume is unverifiable, without refusing', async () => {
        deploymentProviderStub.installedDeployments.resolves([statelessDeployment]);
        volumeServiceStub.verifyAppVolumeMount.resolves(false);

        await containerHealthMonitor.recreateMissingContainers('web_testapp', statelessInstantiated, { allowVolumeCreation: false });

        expect(componentProvisionerStub.installComponent.calledOnce, 'a component with no data cannot have its data reformatted').to.be.true;
        // and nothing was remade on disk for a component that owns no directory
        expect(appVolumeServiceStub.ensureMountSourcesExist.called).to.be.false;
      });

      it('still recreates normally (no volume creation) when the volume is verified', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(true);

        await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated, { allowVolumeCreation: false });

        expect(componentProvisionerStub.installComponent.calledOnce).to.be.true;
        expect(componentProvisionerStub.installComponent.firstCall.args[1].createVolumes).to.be.false;
      });

      it('leaves the default (vanished-container) path free to create the volume', async () => {
        volumeServiceStub.verifyAppVolumeMount.resolves(false);

        await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);

        expect(componentProvisionerStub.installComponent.calledOnce, 'a container that is gone anyway may still be rebuilt from scratch').to.be.true;
        expect(componentProvisionerStub.installComponent.firstCall.args[1].createVolumes).to.be.true;
      });
    });
  });

  describe('recreateMissingContainers', () => {
    it('throws when the caller could not resolve the app', async () => {
      let err;
      try {
        await containerHealthMonitor.recreateMissingContainers('web_testapp', null);
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      expect(err.message).to.include('not found in local database');
      expect(componentProvisionerStub.installComponent.called).to.be.false;
    });

    it('throws when the component is not part of the app', async () => {
      let err;
      try {
        await containerHealthMonitor.recreateMissingContainers('ghost_testapp', instantiated);
      } catch (e) { err = e; }
      expect(err).to.be.an('error');
      // Reports the identifier it was asked for, not a component name carved
      // back out of it — the resolution is an exact match, not a parse.
      expect(err.message).to.include('Component ghost_testapp not found');
      expect(componentProvisionerStub.installComponent.called).to.be.false;
    });

    it('keeps existing volumes when the component volume is still mounted', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      expect(componentProvisionerStub.installComponent.calledOnce).to.be.true;
      const [deployComp, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(deployComp.name).to.equal('web');
      expect(opts.createVolumes).to.be.false;
    });

    it('probes the mount by the component identifier the deployment layer minted', async () => {
      // The mount probe stays stubbed, so nothing else proves the string it is
      // handed is the one the volume actually lives under. It is read off the
      // real DeploymentComponent, never carved out of the app name.
      volumeServiceStub.verifyAppVolumeMount.resolves(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      expect(volumeServiceStub.verifyAppVolumeMount.calledOnceWithExactly(webComp.identifier)).to.be.true;
      expect(volumeServiceStub.verifyAppVolumeMount.calledWith('testapp'), 'never probes by app name').to.be.false;
    });

    it('remakes vanished bind-mount sources before a recreate that keeps the volume', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      expect(appVolumeServiceStub.ensureMountSourcesExist.calledOnce).to.be.true;
      expect(appVolumeServiceStub.ensureMountSourcesExist.firstCall.args[0]).to.equal(webComp);
      // the sources must exist before the container is recreated
      sinon.assert.callOrder(appVolumeServiceStub.ensureMountSourcesExist, componentProvisionerStub.installComponent);
    });

    it('recreates volumes when the component volume is gone', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(false);
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      expect(componentProvisionerStub.installComponent.calledOnce).to.be.true;
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.createVolumes).to.be.true;
    });

    it('does not remake sources on a rebuild (the fresh volume creates them)', async () => {
      volumeServiceStub.verifyAppVolumeMount.resolves(false);
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      expect(appVolumeServiceStub.ensureMountSourcesExist.called).to.be.false;
    });

    it('treats an unreadable volume state as not mounted', async () => {
      volumeServiceStub.verifyAppVolumeMount.rejects(new Error('mount probe failed'));
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.createVolumes).to.be.true;
    });

    it('forwards the app owner to the create path (load-bearing shutdown label)', async () => {
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      // Read off the real InstantiatedSpec, which reads it off the spec — the
      // owner is a real P2PKH address, because the library rejects anything else.
      expect(opts.owner).to.equal(instantiated.owner);
      expect(opts.owner).to.equal('16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1');
    });

    it('recomputes the graceful-shutdown gate and forwards it, so a recreate keeps its budget labels', async () => {
      shutdownPlanStub.appRequiresDaemonShutdown.returns(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      expect(shutdownPlanStub.appRequiresDaemonShutdown.calledWith(deployment)).to.be.true;
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.requiresEncryption).to.equal(true);
    });

    it('forwards requiresEncryption=false for a non-graceful app (budget labels skipped)', async () => {
      shutdownPlanStub.appRequiresDaemonShutdown.returns(false);
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);
      const [, opts] = componentProvisionerStub.installComponent.firstCall.args;
      expect(opts.requiresEncryption).to.equal(false);
    });

    it('does not ensure the app network itself - the reconciler owns that guarantee', async () => {
      // The network is still a precondition of the recreate, but it is
      // guaranteed once above every path that runs a container. Two owners of
      // one guarantee is how they drift apart, so this path must not re-ensure.
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);

      expect(componentProvisionerStub.installComponent.called).to.be.true;
      expect(appDockerNetworkStub.ensureAppDockerNetwork.called).to.be.false;
      expect(appDockerNetworkStub.ensureAppNetworkPresent.called).to.be.false;
    });

    it('recreates every component for a whole-app identifier', async () => {
      await containerHealthMonitor.recreateMissingContainers('testapp', instantiated);
      expect(componentProvisionerStub.installComponent.callCount).to.equal(2);
      const recreated = componentProvisionerStub.installComponent.getCalls().map((c) => c.args[0].name);
      // startupOrder, derived by the library from the dependency graph.
      expect(recreated).to.deep.equal(['web', 'db']);
    });

    it('hands its stubbed collaborators objects that answer what the real ones ask', async () => {
      // Three collaborators here stay stubbed and each receives a domain object.
      // Nothing else exercises what the REAL ones do with it, so a delegation
      // could disappear from flux-spec with this suite still green.
      volumeServiceStub.verifyAppVolumeMount.resolves(true);
      await containerHealthMonitor.recreateMissingContainers('web_testapp', instantiated);

      // deploymentProvider.installedDeployments resolves the row: it reads
      // `isEncrypted`, `spec`, `name` and `identity` off it (specCutover
      // .resolveInstantiatedSpec + toDeployment), so assert the PROPERTIES.
      const [handedRow] = deploymentProviderStub.installedDeployments.firstCall.args;
      expect(handedRow.isEncrypted, 'resolveInstantiatedSpec branches on it').to.be.a('boolean');
      expect(handedRow.spec, 'and unwraps this when it is encrypted').to.be.an('object');
      expect(handedRow.name).to.be.a('string');
      expect(handedRow, 'identity is READ off the row, never recomputed').to.have.property('identity');

      // shutdownPlan.appRequiresDaemonShutdown walks componentEntries().
      const [handedDeployment] = shutdownPlanStub.appRequiresDaemonShutdown.firstCall.args;
      assertAnswers(handedDeployment, ['componentEntries']);

      // componentProvisioner.installComponent reads these off the component.
      const [handedComp] = componentProvisionerStub.installComponent.firstCall.args;
      expect(handedComp.identifier).to.equal('web_testapp');
      expect(handedComp.appName).to.equal('testapp');
      expect(handedComp.hostPorts, 'openHostPorts iterates them').to.be.an('array');
      expect(handedComp.image, 'verifyComponentImage reads it').to.be.a('string');
      // appVolumeService.ensureMountSourcesExist walks `mounts`, then writes the
      // .stignore from `dir` + `sync` + injectedSyncExcludes().
      const [handedForSources] = appVolumeServiceStub.ensureMountSourcesExist.firstCall.args;
      expect(handedForSources.mounts).to.be.an('array');
      expect(handedForSources.dir).to.be.a('string');
      // `sync` sits DIRECTLY on the component. Reaching for it through a
      // persistentStorage object is how appOperations grew a guard that was
      // always true — the real class has no such property.
      expect(handedForSources, 'writeStignore branches on it').to.have.property('sync');
      expect(handedForSources.persistentStorage, 'and there is nothing to reach through').to.be.undefined;
      assertAnswers(handedForSources, ['injectedSyncExcludes']);
    });
  });
});
