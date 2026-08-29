'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
const {
  loadSpecLibrary, V8_SUBMISSION, V9_SUBMISSION, v1Spec, v9Spec, sealedV8Spec,
  instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed - see tests/unit/fixtures/fluxSpec.js
// for why. Every installed row is a real InstantiatedSpec and every deployment a
// real DeploymentSpec, so the docker identifiers this module enumerates are the
// ones the deployment layer MINTS (`myapp` flat for v1-v3, `comp_app` for
// composed specs) rather than a `${c.name}_${app.name}` reimplementation living
// in the test. What stays stubbed is I/O: the crontab, mongo through
// appsRepository, docker, the mount probes, and the tampering recorder.
let flux;

// Create mocks for dependencies
const crontabMock = {
  load: sinon.stub(),
};

const logMock = {
  info: sinon.stub(),
  warn: sinon.stub(),
  error: sinon.stub(),
};

const appsRepositoryMock = {
  listInstalledApps: sinon.stub(),
  // Empty by default so the tests below keep driving the deployment derivation
  // they are about; the recorded path has a test of its own.
  listComponentIdentifiers: sinon.stub().resolves([]),
};

const deploymentProviderMock = {
  buildDeployment: sinon.stub(),
  // Delegates at call time so per-test outcomes (incl. rejects) flow through
  // the plural entry the cleanup uses.
  get buildDeployments() {
    const single = this.buildDeployment;
    return async (inst) => {
      const deployment = await single(inst);
      return deployment ? [deployment] : [];
    };
  },
};

const dockerServiceMock = {
  getAppIdentifier: sinon.stub(),
};

const volumeServiceMock = {
  ensureAppVolumeMounted: sinon.stub(),
  getComponentAppIdsFromVolumeFiles: sinon.stub(),
  isPathMounted: sinon.stub(),
};

const appTamperingDetectionServiceMock = {
  recordEvent: sinon.stub(),
};

// Load module with mocked dependencies
const crontabAndMountsCleanup = proxyquire('../../ZelBack/src/services/appLifecycle/crontabAndMountsCleanup', {
  crontab: crontabMock,
  '../../lib/log': logMock,
  '../appDatabase/appsRepository': appsRepositoryMock,
  '../appRuntime/deploymentProvider': deploymentProviderMock,
  '../dockerService': dockerServiceMock,
  '../utils/volumeService': volumeServiceMock,
  '../appTamperingDetectionService': appTamperingDetectionServiceMock,
});

describe('crontabAndMountsCleanup tests', () => {
  // Real installed rows + the deployment each one resolves to. Built once, in
  // `before`, because the first fromSubmission compiles the ajv schemas.
  let legacyMyapp;
  let legacyApp1;
  let composedWordpress;
  let soloWordpress;
  let enterpriseHermes;

  // row (InstantiatedSpec) -> DeploymentSpec, or an Error to reject with.
  // Keyed by object IDENTITY rather than sinon's withArgs, whose structural
  // match cannot tell two frozen domain instances apart (their state lives in
  // private fields, which are not enumerable).
  const outcomeByRow = new Map();

  /** A real installed row + the deployment deploymentProvider builds from it. */
  async function appFixture(spec, deploymentSource = spec) {
    return {
      row: await instantiatedSpec(spec),
      deployment: flux.DeploymentSpec.fromSpec(deploymentSource, appsFolder, { replica: null }),
    };
  }

  /** Seed listInstalledApps and what buildDeployment answers for each row. */
  function installApps(entries) {
    outcomeByRow.clear();
    entries.forEach(({ row, deployment, error }) => outcomeByRow.set(row, error || deployment));
    appsRepositoryMock.listInstalledApps.resolves(entries.map((e) => e.row));
  }

  /** The docker app ids a deployment's components map to. */
  const appIdsOf = ({ deployment }) => deployment
    .componentEntries().map(([, comp]) => `flux${comp.identifier}`);

  /** A v9 component derived from the shared fixture submission. */
  const componentOn = (name, hostPort, containerPort) => ({
    ...V9_SUBMISSION.components.web,
    name,
    ports: { main: { containerPort, hostPort } },
  });

  before(async function loadLibrary() {
    this.timeout(30000);
    flux = await loadSpecLibrary();

    // v1 is the only stored form whose docker identifier is the BARE app name -
    // the flat pre-compose shape this module still has to enumerate. It cannot
    // be minted from a composed spec, so the version is the fixture.
    legacyMyapp = await appFixture(await v1Spec({ name: 'myapp' }));
    legacyApp1 = await appFixture(await v1Spec({ name: 'app1' }));

    composedWordpress = await appFixture(await v9Spec({
      name: 'wordpress123',
      components: {
        wp: componentOn('wp', 31001, 80),
        mysql: componentOn('mysql', 31002, 3306),
        operator: componentOn('operator', 31003, 8080),
      },
    }));
    soloWordpress = await appFixture(await v9Spec({
      name: 'wordpress123',
      components: { wp: componentOn('wp', 31001, 80) },
    }));

    // The enterprise shape, built the way production holds it: the row carries
    // the SEALED spec (so isEncrypted is the class's own answer, never a flag
    // set on a literal), and the deployment is built from what decrypting it
    // yields. `compose` is not "stored empty" by the test - the components
    // genuinely only exist inside the blob.
    const sealed = await sealedV8Spec({
      name: 'hermesagent123',
      compose: [{ ...V8_SUBMISSION.compose[0], name: 'hermes' }],
    });
    const decrypted = await sealed.decrypt(await sealed.createProvider());
    enterpriseHermes = {
      row: await instantiatedSpec(sealed),
      deployment: flux.DeploymentSpec.fromSpec(decrypted, appsFolder, { replica: null }),
    };

    // Derived by the library, never asserted onto the fixtures here.
    expect(appIdsOf(legacyMyapp)).to.deep.equal(['fluxmyapp']);
    expect(appIdsOf(composedWordpress)).to.deep.equal([
      'fluxwp_wordpress123', 'fluxmysql_wordpress123', 'fluxoperator_wordpress123',
    ]);
    expect(appIdsOf(enterpriseHermes)).to.deep.equal(['fluxhermes_hermesagent123']);
    expect(legacyMyapp.row.isEncrypted, 'a cleartext row is not encrypted').to.be.false;
    expect(enterpriseHermes.row.isEncrypted, 'and a sealed one says so itself').to.be.true;
  });

  beforeEach(() => {
    // Reset only this file's own stubs (a global sinon.reset() would wipe stub
    // behaviour set up at module load by other test files in the same run)
    crontabMock.load.reset();
    logMock.info.reset();
    logMock.warn.reset();
    logMock.error.reset();
    appsRepositoryMock.listInstalledApps.reset();
    appsRepositoryMock.listComponentIdentifiers.reset();
    appsRepositoryMock.listComponentIdentifiers.resolves([]);
    deploymentProviderMock.buildDeployment.reset();
    outcomeByRow.clear();
    deploymentProviderMock.buildDeployment.callsFake(async (row) => {
      const outcome = outcomeByRow.get(row);
      if (outcome instanceof Error) throw outcome;
      return outcome || null;
    });
    dockerServiceMock.getAppIdentifier.reset();
    // The real one is `flux${identifier}` - a pure string function over the
    // component identifier, so the stub reproduces it rather than enumerating
    // answers per test. That makes every app id below the string production
    // would build from the identifier the deployment actually minted.
    dockerServiceMock.getAppIdentifier.callsFake((identifier) => `flux${identifier}`);
    volumeServiceMock.ensureAppVolumeMounted.reset();
    volumeServiceMock.getComponentAppIdsFromVolumeFiles.reset();
    volumeServiceMock.isPathMounted.reset();
    appTamperingDetectionServiceMock.recordEvent.reset();
    appTamperingDetectionServiceMock.recordEvent.resolves();
  });

  describe('getInstalledAppIds', () => {
    it('should return an empty map when no apps are installed', async () => {
      installApps([]);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();
      expect(result).to.be.instanceOf(Map);
      expect(result.size).to.equal(0);
    });

    it('should enumerate a legacy app (version <= 3) as a single id', async () => {
      installApps([legacyMyapp]);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();
      // each id carries the app it belongs to, so nothing downstream has to cut
      // a name back out of it
      expect(result.get('fluxmyapp')).to.equal('myapp');
      expect(result.size).to.equal(1);
    });

    // A stateless component has no volume by design (appVolumeService returns
    // early and never creates one), so it must not enter this set. Both
    // consumers depend on that: ensureInstalledAppVolumesMounted would report
    // volume_file_missing and record a mount_vanished TAMPERING event keyed by
    // the APP, so one stateless sidecar taints the whole app's history at every
    // boot; and the crontab sweep correctly treats an entry for a component that
    // should have none as stale.
    it('leaves out a stateless component, which has no volume to mount', async () => {
      const mixed = await appFixture(await v9Spec({
        name: 'mixedapp',
        components: {
          web: componentOn('web', 31001, 80),
          sidecar: { ...componentOn('sidecar', 31002, 8080), persistentStorage: { sizeGb: 0 } },
        },
      }));
      expect(mixed.deployment.getComponent('sidecar').isStateless, 'fixture must be stateless').to.be.true;
      expect(mixed.deployment.getComponent('web').isStateless).to.be.false;
      installApps([mixed]);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();
      expect([...result.keys()]).to.deep.equal(['fluxweb_mixedapp']);
    });

    it('should enumerate every component of a composed app (version > 3)', async () => {
      installApps([composedWordpress]);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();
      expect(result.get('fluxwp_wordpress123')).to.equal('wordpress123');
      expect(result.get('fluxmysql_wordpress123')).to.equal('wordpress123');
      expect(result.get('fluxoperator_wordpress123')).to.equal('wordpress123');
      expect(result.size).to.equal(3);
    });

    it('should throw when the install set cannot be enumerated (never report empty)', async () => {
      // an empty set means "nothing installed" to callers; a failed enumeration
      // must never masquerade as that
      appsRepositoryMock.listInstalledApps.rejects(new Error('DB connection failed'));

      let thrown = null;
      try {
        await crontabAndMountsCleanup.getInstalledAppIds();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.an('error');
      expect(thrown.message).to.include('DB connection failed');
    });

    it('should decrypt an enterprise app (compose stored empty) to enumerate its components', async () => {
      // enterprise specs are stored locally with compose: []; buildDeployment
      // decrypts them the way the rest of the runtime reads them. The incident
      // regression treated them as "not installed" and ate their crontab entries.
      installApps([enterpriseHermes]);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();

      expect(deploymentProviderMock.buildDeployment.calledWith(enterpriseHermes.row)).to.be.true;
      expect(result.has('fluxhermes_hermesagent123')).to.be.true;
      expect(result.size).to.equal(1);
    });

    it('reports an undecryptable app with nothing recorded as unknown, never as empty', async () => {
      // Nothing can state its components this boot. Saying so is the point: an
      // app treated as having none gets its live volume left unmounted and its
      // crontab safety net dropped. The startup backfill is what fills this gap,
      // and it is the only place that reads components off disk.
      installApps([{ row: enterpriseHermes.row, error: new Error('fluxbenchd unavailable') }]);
      appsRepositoryMock.listComponentIdentifiers.withArgs('hermesagent123').resolves([]);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();

      expect(result.size).to.equal(0);
      expect(logMock.error.called, 'an unenumerable app must be loud').to.equal(true);
      expect(
        volumeServiceMock.getComponentAppIdsFromVolumeFiles.called,
        'the runtime path must not derive from disk',
      ).to.equal(false);
    });

    it('takes an undecryptable CLEARTEXT app as a build failure, not an enterprise lookup', async () => {
      // The recorded-components fallback is gated on isEncrypted, and that is
      // the row's OWN answer. A cleartext row whose deployment cannot be built
      // is a different failure: it must warn and skip, never consult the
      // components table for an app whose spec states them in the open.
      installApps([{ row: legacyMyapp.row, error: new Error('appsFolder unavailable') }]);
      appsRepositoryMock.listComponentIdentifiers.resolves(['should_never_be_read']);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();

      expect(result.size).to.equal(0);
      expect(appsRepositoryMock.listComponentIdentifiers.called).to.equal(false);
      expect(logMock.warn.called, 'a build failure is still reported').to.equal(true);
    });

    it('never derives from disk on the runtime path, for any app', async () => {
      installApps([soloWordpress]);

      await crontabAndMountsCleanup.getInstalledAppIds();

      expect(volumeServiceMock.getComponentAppIdsFromVolumeFiles.called).to.be.false;
    });

    it('hands its stubbed collaborators objects that answer what the real ones ask', async () => {
      // deploymentProvider stays stubbed, so nothing else exercises what the
      // REAL one does with the row it is handed, nor what this module does with
      // the deployment it gets back. Either delegation could disappear from
      // flux-spec with this suite still green.
      installApps([composedWordpress]);

      await crontabAndMountsCleanup.getInstalledAppIds();

      // buildDeployments -> toDeployments reads these PROPERTIES off the row
      // (specCutover.resolveInstantiatedSpec, then DeploymentSpec.fromSpec).
      const [handedRow] = deploymentProviderMock.buildDeployment.firstCall.args;
      expect(handedRow.isEncrypted, 'resolveInstantiatedSpec branches on it').to.be.a('boolean');
      expect(handedRow.spec, 'and unwraps this when it is encrypted').to.be.an('object');
      expect(handedRow.name, 'which this module keys the map by').to.equal('wordpress123');
      expect(handedRow, 'identity is READ off the row, never recomputed').to.have.property('identity');

      // and what comes back is walked by componentEntries(), one identifier each
      const handedDeployment = await deploymentProviderMock.buildDeployment.firstCall.returnValue;
      assertAnswers(handedDeployment, ['componentEntries']);
      const [, handedComp] = handedDeployment.componentEntries()[0];
      expect(handedComp.identifier, 'the docker identifier is read, never parsed together').to.equal('wp_wordpress123');
    });
  });

  describe('extractMountPoint', () => {
    it('should extract the mountpoint from a plain mount command', () => {
      expect(crontabAndMountsCleanup.extractMountPoint('sudo mount -o loop /dat/fluxwpFLUXFSVOL /dat/var/lib/fluxos/flux-apps/fluxwp')).to.equal('/dat/var/lib/fluxos/flux-apps/fluxwp');
    });

    it('should extract the mountpoint from a wait-logic command', () => {
      expect(crontabAndMountsCleanup.extractMountPoint('while [ ! -f /dat/fluxwpFLUXFSVOL ]; do sleep 5; done && sudo mount -o loop /dat/fluxwpFLUXFSVOL /mnt/wp')).to.equal('/mnt/wp');
    });

    it('should return null for unparseable commands', () => {
      expect(crontabAndMountsCleanup.extractMountPoint('sudo apt update')).to.be.null;
    });
  });

  describe('isVolumeMountJob', () => {
    it('should match a plain mount command', () => {
      expect(crontabAndMountsCleanup.isVolumeMountJob('sudo mount -o loop /dat/fluxwpFLUXFSVOL /mount/point')).to.be.true;
    });

    it('should match a mount command with wait logic', () => {
      expect(crontabAndMountsCleanup.isVolumeMountJob('while [ ! -f /dat/fluxwpFLUXFSVOL ]; do sleep 5; done && sudo mount -o loop /dat/fluxwpFLUXFSVOL /mount/point')).to.be.true;
    });

    it('should not match unrelated commands', () => {
      expect(crontabAndMountsCleanup.isVolumeMountJob('sudo apt update')).to.be.false;
    });

    it('should not match loop mounts of non-FLUXFSVOL files', () => {
      expect(crontabAndMountsCleanup.isVolumeMountJob('sudo mount -o loop /dat/somefile /mount/point')).to.be.false;
    });
  });

  describe('ensureInstalledAppVolumesMounted', () => {
    it('should mount every installed app volume derived from the DB', async () => {
      installApps([legacyApp1, soloWordpress]);
      volumeServiceMock.ensureAppVolumeMounted.withArgs('fluxapp1').resolves({ mounted: true, alreadyMounted: false });
      volumeServiceMock.ensureAppVolumeMounted.withArgs('fluxwp_wordpress123').resolves({ mounted: true, alreadyMounted: true });

      const result = await crontabAndMountsCleanup.ensureInstalledAppVolumesMounted();

      expect(result.mounted).to.deep.equal(['fluxapp1']);
      expect(result.alreadyMounted).to.deep.equal(['fluxwp_wordpress123']);
      expect(result.failed).to.have.lengthOf(0);
    });

    it('should record a tampering event when a volume cannot be mounted', async () => {
      installApps([legacyApp1]);
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });

      const result = await crontabAndMountsCleanup.ensureInstalledAppVolumesMounted();

      expect(result.failed).to.deep.equal([{ appId: 'fluxapp1', reason: 'volume_file_missing' }]);
      // the incident is keyed by the APP, not the component's docker id — the
      // reconciler emits the same app's events under that name, and the name
      // comes off the real InstantiatedSpec
      expect(appTamperingDetectionServiceMock.recordEvent.calledWith('app1', 'mount_vanished')).to.be.true;
    });

    it('keys the incident by the owning app for a composed spec, not by the component id', async () => {
      // Every component of one app rolls up under the SAME app name, which is
      // only true because the map carries the owner rather than letting the
      // recorder cut a name back out of `mysql_wordpress123`.
      installApps([composedWordpress]);
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });

      await crontabAndMountsCleanup.ensureInstalledAppVolumesMounted();

      expect(appTamperingDetectionServiceMock.recordEvent.callCount).to.equal(3);
      const names = appTamperingDetectionServiceMock.recordEvent.getCalls().map((c) => c.args[0]);
      expect(names).to.deep.equal(['wordpress123', 'wordpress123', 'wordpress123']);
    });
  });

  describe('removeLegacyMountCrontabEntries', () => {
    let mockCrontab;
    let mockJobs;

    const makeJob = (command, comment) => ({
      isValid: () => true,
      command: () => command,
      comment: () => comment,
    });

    beforeEach(() => {
      mockJobs = [];
      mockCrontab = {
        jobs: () => mockJobs,
        remove: sinon.stub(),
        save: sinon.stub(),
      };
      crontabMock.load.callsFake((callback) => callback(null, mockCrontab));
      volumeServiceMock.isPathMounted.resolves(true);
    });

    it('should remove every mounted FLUXFSVOL entry, installed or not', async () => {
      const plainJob = makeJob('sudo mount -o loop /dat/fluxapp1FLUXFSVOL /mount/app1', 'fluxapp1');
      const waitJob = makeJob('while [ ! -f /dat/fluxapp2FLUXFSVOL ]; do sleep 5; done && sudo mount -o loop /dat/fluxapp2FLUXFSVOL /mount/app2', 'fluxapp2');
      mockJobs = [plainJob, waitJob];

      const result = await crontabAndMountsCleanup.removeLegacyMountCrontabEntries();

      expect(volumeServiceMock.isPathMounted.calledWith('/mount/app1')).to.be.true;
      expect(volumeServiceMock.isPathMounted.calledWith('/mount/app2')).to.be.true;
      expect(mockCrontab.remove.calledWith(plainJob)).to.be.true;
      expect(mockCrontab.remove.calledWith(waitJob)).to.be.true;
      expect(result.removed).to.deep.equal(['fluxapp1', 'fluxapp2']);
      expect(mockCrontab.save.called).to.be.true;
    });

    it('should keep entries whose volume is not currently mounted', async () => {
      // the entry is only superseded once the FluxOS-owned mount demonstrably
      // works; until then it is the remaining safety net for the next boot
      const job = makeJob('sudo mount -o loop /dat/fluxapp1FLUXFSVOL /mount/app1', 'fluxapp1');
      mockJobs = [job];
      volumeServiceMock.isPathMounted.withArgs('/mount/app1').resolves(false);

      const result = await crontabAndMountsCleanup.removeLegacyMountCrontabEntries();

      expect(mockCrontab.remove.called).to.be.false;
      expect(mockCrontab.save.called).to.be.false;
      expect(result.kept).to.deep.equal(['fluxapp1']);
      expect(result.removed).to.have.lengthOf(0);
    });

    it('should keep entries whose mountpoint cannot be parsed', async () => {
      const job = makeJob('mount -o loop somethingFLUXFSVOL', 'fluxweird');
      mockJobs = [job];

      const result = await crontabAndMountsCleanup.removeLegacyMountCrontabEntries();

      expect(mockCrontab.remove.called).to.be.false;
      expect(result.kept).to.deep.equal(['fluxweird']);
    });

    it('should leave non-mount jobs untouched and not save', async () => {
      mockJobs = [makeJob('sudo apt update', 'system-update')];

      const result = await crontabAndMountsCleanup.removeLegacyMountCrontabEntries();

      expect(mockCrontab.remove.called).to.be.false;
      expect(mockCrontab.save.called).to.be.false;
      expect(result.removed).to.have.lengthOf(0);
    });

    it('should handle crontab load errors without throwing', async () => {
      crontabMock.load.callsFake((callback) => callback(new Error('Crontab load failed')));

      const result = await crontabAndMountsCleanup.removeLegacyMountCrontabEntries();

      expect(result.removed).to.have.lengthOf(0);
      expect(logMock.warn.called).to.be.true;
    });

    it('should report a save failure as an error', async () => {
      mockJobs = [makeJob('sudo mount -o loop /dat/fluxapp1FLUXFSVOL /mount/app1', 'fluxapp1')];
      mockCrontab.save.throws(new Error('crontab: permission denied'));

      const result = await crontabAndMountsCleanup.removeLegacyMountCrontabEntries();

      expect(result.errors).to.have.lengthOf(1);
      expect(result.errors[0].error).to.include('permission denied');
    });
  });

  describe('cleanupCrontabAndMounts', () => {
    let mockCrontab;
    let mockJobs;

    beforeEach(() => {
      mockJobs = [];
      mockCrontab = {
        jobs: () => mockJobs,
        remove: sinon.stub(),
        save: sinon.stub(),
      };
      crontabMock.load.callsFake((callback) => callback(null, mockCrontab));
      volumeServiceMock.isPathMounted.resolves(true);
    });

    it('should abort without touching the crontab when the install set cannot be enumerated', async () => {
      // a failed enumeration must not cascade into destructive crontab edits -
      // that is precisely how remount entries kept vanishing in production
      appsRepositoryMock.listInstalledApps.rejects(new Error('DB connection failed'));
      mockJobs = [{
        isValid: () => true,
        command: () => 'sudo mount -o loop /dat/fluxmyappFLUXFSVOL /mount/point',
        comment: () => 'fluxmyapp',
      }];

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(mockCrontab.remove.called).to.be.false;
      expect(mockCrontab.save.called).to.be.false;
      expect(result.crontab.removed).to.have.lengthOf(0);
      expect(result.mounts.mounted).to.have.lengthOf(0);
      expect(logMock.error.called).to.be.true;
    });

    it('uses the components the row recorded rather than scanning disk, when it has them', async () => {
      // An encrypted app's components live in a sealed blob, so a node that
      // cannot open it cannot enumerate them from the spec. The row wrote them
      // down at install time, when it could — a stated fact rather than a
      // filename pattern that has already been wrong once.
      installApps([{ row: enterpriseHermes.row, error: new Error('fluxbenchd unavailable') }]);
      // The recorded identifier is the one the deployment layer would have
      // minted, taken from the real deployment rather than spelled out again.
      const [, recordedComp] = enterpriseHermes.deployment.componentEntries()[0];
      appsRepositoryMock.listComponentIdentifiers.withArgs('hermesagent123').resolves([recordedComp.identifier]);
      volumeServiceMock.ensureAppVolumeMounted.withArgs('fluxhermes_hermesagent123').resolves({ mounted: true, alreadyMounted: false });

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(result.mounts.mounted).to.include('fluxhermes_hermesagent123');
      expect(
        volumeServiceMock.getComponentAppIdsFromVolumeFiles.called,
        'a row that states its components must not be answered from disk',
      ).to.equal(false);
    });

    it('mounts nothing for an undecryptable app that states no components', async () => {
      // The safe answer is to mount nothing rather than guess: a wrong id would
      // mount a volume that is not this app's. The volume stays unmounted until
      // the backfill records what the app has, which is the one place that can.
      installApps([{ row: enterpriseHermes.row, error: new Error('fluxbenchd unavailable') }]);
      appsRepositoryMock.listComponentIdentifiers.withArgs('hermesagent123').resolves([]);

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(result.mounts.mounted).to.have.lengthOf(0);
      expect(result.mounts.failed).to.have.lengthOf(0);
      expect(volumeServiceMock.ensureAppVolumeMounted.called).to.equal(false);
    });

    it('should mount installed app volumes even when the crontab is empty', async () => {
      // the incident regression: the old implementation derived mounts from
      // crontab entries, so a silently emptied crontab meant nothing was ever
      // remounted after a reboot
      installApps([legacyMyapp]);
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: false });
      mockJobs = [];

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(volumeServiceMock.ensureAppVolumeMounted.calledWith('fluxmyapp')).to.be.true;
      expect(result.mounts.mounted).to.include('fluxmyapp');
    });

    it('should mount volumes even when the crontab cannot be loaded at all', async () => {
      installApps([legacyMyapp]);
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: false });
      crontabMock.load.callsFake((callback) => callback(new Error('Crontab load failed')));

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(result.mounts.mounted).to.include('fluxmyapp');
      expect(result.crontab.removed).to.have.lengthOf(0);
    });

    it('should remove legacy mount entries of installed apps too', async () => {
      installApps([legacyMyapp]);
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: true });
      const legacyJob = {
        isValid: () => true,
        command: () => 'while [ ! -f /dat/fluxmyappFLUXFSVOL ]; do sleep 5; done && sudo mount -o loop /dat/fluxmyappFLUXFSVOL /mount/point',
        comment: () => 'fluxmyapp',
      };
      mockJobs = [legacyJob];

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(mockCrontab.remove.calledWith(legacyJob)).to.be.true;
      expect(result.crontab.removed).to.include('fluxmyapp');
      expect(result.mounts.alreadyMounted).to.include('fluxmyapp');
    });

    it('should never remove an app because of crontab state', async () => {
      // the old implementation force-removed apps when a crontab rewrite
      // failed; the new one must take no app-lifecycle action at all
      installApps([legacyMyapp]);
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: true });
      mockJobs = [{
        isValid: () => true,
        command: () => 'sudo mount -o loop /dat/fluxmyappFLUXFSVOL /mount/point',
        comment: () => 'fluxmyapp',
      }];
      mockCrontab.save.throws(new Error('crontab: permission denied'));

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(result.crontab.errors).to.have.lengthOf(1);
      expect(result.mounts.failed).to.have.lengthOf(0);
    });
  });
});
