'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

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
  // Empty by default so the tests below keep driving the disk derivation they
  // are about; the recorded path has a test of its own.
  listComponentIdentifiers: sinon.stub().resolves([]),
};

const deploymentProviderMock = {
  buildDeployment: sinon.stub(),
  // Delegates at call time so per-test withArgs overrides (incl. rejects)
  // flow through the plural entry the cleanup uses.
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
    dockerServiceMock.getAppIdentifier.reset();
    volumeServiceMock.ensureAppVolumeMounted.reset();
    volumeServiceMock.getComponentAppIdsFromVolumeFiles.reset();
    volumeServiceMock.isPathMounted.reset();
    appTamperingDetectionServiceMock.recordEvent.reset();
    appTamperingDetectionServiceMock.recordEvent.resolves();
  });

  // A mock deployment whose componentEntries() yields the given docker identifiers.
  const mockDeployment = (identifiers) => ({
    componentEntries: () => identifiers.map((id, i) => [String(i), { identifier: id }]),
  });

  // Docker identifiers a decryptable app's deployment exposes: the bare app name
  // for legacy (v<=3) specs, comp_app per component for composed (v4+) specs.
  const identifiersOf = (app) => (app.version <= 3
    ? [app.name]
    : (app.compose || []).map((c) => `${c.name}_${app.name}`));

  // Seed listInstalledApps with instantiated specs (isEncrypted flagged from
  // `enterprise`) and a default buildDeployment resolving each app's deployment
  // (decrypt success). Returns the instantiated specs so a test can override
  // buildDeployment for one app to reject (decryption unavailable).
  const stubInstalledApps = (apps) => {
    const installed = (apps || []).map((a) => ({ name: a.name, isEncrypted: !!a.enterprise }));
    appsRepositoryMock.listInstalledApps.resolves(installed);
    installed.forEach((inst, i) => {
      deploymentProviderMock.buildDeployment.withArgs(inst).resolves(mockDeployment(identifiersOf(apps[i])));
    });
    return installed;
  };

  describe('getInstalledAppIds', () => {
    it('should return an empty map when no apps are installed', async () => {
      stubInstalledApps([]);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();
      expect(result).to.be.instanceOf(Map);
      expect(result.size).to.equal(0);
    });

    it('should enumerate a legacy app (version <= 3) as a single id', async () => {
      stubInstalledApps([{ name: 'myapp', version: 3 }]);
      dockerServiceMock.getAppIdentifier.withArgs('myapp').returns('fluxmyapp');

      const result = await crontabAndMountsCleanup.getInstalledAppIds();
      // each id carries the app it belongs to, so nothing downstream has to cut
      // a name back out of it
      expect(result.get('fluxmyapp')).to.equal('myapp');
      expect(result.size).to.equal(1);
    });

    it('should enumerate every component of a composed app (version > 3)', async () => {
      stubInstalledApps([{
        name: 'wordpress123',
        version: 4,
        compose: [{ name: 'wp' }, { name: 'mysql' }, { name: 'operator' }],
      }]);
      dockerServiceMock.getAppIdentifier.withArgs('wp_wordpress123').returns('fluxwp_wordpress123');
      dockerServiceMock.getAppIdentifier.withArgs('mysql_wordpress123').returns('fluxmysql_wordpress123');
      dockerServiceMock.getAppIdentifier.withArgs('operator_wordpress123').returns('fluxoperator_wordpress123');

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
      const [inst] = stubInstalledApps([{
        name: 'hermesagent123', version: 8, compose: [{ name: 'hermes' }], enterprise: 'encryptedblob',
      }]);
      dockerServiceMock.getAppIdentifier.withArgs('hermes_hermesagent123').returns('fluxhermes_hermesagent123');

      const result = await crontabAndMountsCleanup.getInstalledAppIds();

      expect(deploymentProviderMock.buildDeployment.calledWith(inst)).to.be.true;
      expect(result.has('fluxhermes_hermesagent123')).to.be.true;
      expect(result.size).to.equal(1);
    });

    it('reports an undecryptable app with nothing recorded as unknown, never as empty', async () => {
      // Nothing can state its components this boot. Saying so is the point: an
      // app treated as having none gets its live volume left unmounted and its
      // crontab safety net dropped. The startup backfill is what fills this gap,
      // and it is the only place that reads components off disk.
      const [inst] = stubInstalledApps([{
        name: 'hermesagent123', version: 8, compose: [], enterprise: 'encryptedblob',
      }]);
      deploymentProviderMock.buildDeployment.withArgs(inst).rejects(new Error('fluxbenchd unavailable'));
      appsRepositoryMock.listComponentIdentifiers.withArgs('hermesagent123').resolves([]);

      const result = await crontabAndMountsCleanup.getInstalledAppIds();

      expect(result.size).to.equal(0);
      expect(logMock.error.called, 'an unenumerable app must be loud').to.equal(true);
      expect(
        volumeServiceMock.getComponentAppIdsFromVolumeFiles.called,
        'the runtime path must not derive from disk',
      ).to.equal(false);
    });

    it('never derives from disk on the runtime path, for any app', async () => {
      stubInstalledApps([{ name: 'wordpress123', version: 4, compose: [{ name: 'wp' }] }]);
      dockerServiceMock.getAppIdentifier.withArgs('wp_wordpress123').returns('fluxwp_wordpress123');

      await crontabAndMountsCleanup.getInstalledAppIds();

      expect(volumeServiceMock.getComponentAppIdsFromVolumeFiles.called).to.be.false;
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
      stubInstalledApps([
        { name: 'app1', version: 3 },
        { name: 'wordpress123', version: 4, compose: [{ name: 'wp' }] },
      ]);
      dockerServiceMock.getAppIdentifier.withArgs('app1').returns('fluxapp1');
      dockerServiceMock.getAppIdentifier.withArgs('wp_wordpress123').returns('fluxwp_wordpress123');
      volumeServiceMock.ensureAppVolumeMounted.withArgs('fluxapp1').resolves({ mounted: true, alreadyMounted: false });
      volumeServiceMock.ensureAppVolumeMounted.withArgs('fluxwp_wordpress123').resolves({ mounted: true, alreadyMounted: true });

      const result = await crontabAndMountsCleanup.ensureInstalledAppVolumesMounted();

      expect(result.mounted).to.deep.equal(['fluxapp1']);
      expect(result.alreadyMounted).to.deep.equal(['fluxwp_wordpress123']);
      expect(result.failed).to.have.lengthOf(0);
    });

    it('should record a tampering event when a volume cannot be mounted', async () => {
      stubInstalledApps([{ name: 'app1', version: 3 }]);
      dockerServiceMock.getAppIdentifier.withArgs('app1').returns('fluxapp1');
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'volume_file_missing' });

      const result = await crontabAndMountsCleanup.ensureInstalledAppVolumesMounted();

      expect(result.failed).to.deep.equal([{ appId: 'fluxapp1', reason: 'volume_file_missing' }]);
      // the incident is keyed by the APP, not the component's docker id — the
      // reconciler emits the same app's events under that name
      expect(appTamperingDetectionServiceMock.recordEvent.calledWith('app1', 'mount_vanished')).to.be.true;
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
      const inst = {
        name: 'hermesagent123', version: 8, compose: [], enterprise: 'encryptedblob', isEncrypted: true,
      };
      appsRepositoryMock.listInstalledApps.resolves([inst]);
      deploymentProviderMock.buildDeployment.withArgs(inst).rejects(new Error('fluxbenchd unavailable'));
      appsRepositoryMock.listComponentIdentifiers.withArgs('hermesagent123').resolves(['hermes_hermesagent123']);
      dockerServiceMock.getAppIdentifier.withArgs('hermes_hermesagent123').returns('fluxhermes_hermesagent123');
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
      const [inst] = stubInstalledApps([{
        name: 'hermesagent123', version: 8, compose: [], enterprise: 'encryptedblob',
      }]);
      deploymentProviderMock.buildDeployment.withArgs(inst).rejects(new Error('fluxbenchd unavailable'));
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
      stubInstalledApps([{ name: 'myapp', version: 3 }]);
      dockerServiceMock.getAppIdentifier.withArgs('myapp').returns('fluxmyapp');
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: false });
      mockJobs = [];

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(volumeServiceMock.ensureAppVolumeMounted.calledWith('fluxmyapp')).to.be.true;
      expect(result.mounts.mounted).to.include('fluxmyapp');
    });

    it('should mount volumes even when the crontab cannot be loaded at all', async () => {
      stubInstalledApps([{ name: 'myapp', version: 3 }]);
      dockerServiceMock.getAppIdentifier.withArgs('myapp').returns('fluxmyapp');
      volumeServiceMock.ensureAppVolumeMounted.resolves({ mounted: true, alreadyMounted: false });
      crontabMock.load.callsFake((callback) => callback(new Error('Crontab load failed')));

      const result = await crontabAndMountsCleanup.cleanupCrontabAndMounts();

      expect(result.mounts.mounted).to.include('fluxmyapp');
      expect(result.crontab.removed).to.have.lengthOf(0);
    });

    it('should remove legacy mount entries of installed apps too', async () => {
      stubInstalledApps([{ name: 'myapp', version: 3 }]);
      dockerServiceMock.getAppIdentifier.withArgs('myapp').returns('fluxmyapp');
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
      stubInstalledApps([{ name: 'myapp', version: 3 }]);
      dockerServiceMock.getAppIdentifier.withArgs('myapp').returns('fluxmyapp');
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
