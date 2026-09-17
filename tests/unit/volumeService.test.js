'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('volumeService tests', () => {
  const APPS_FOLDER = '/test/apps/folder/';
  const APP_VOLUMES = '/test/flux/appvolumes';
  const LEGACY_APP_VOLUMES = '/test/fluxappvolumes';
  let dockerServiceStub;
  let serviceHelperStub;
  let fsStub;
  let deviceHelperStub;
  let logStub;
  let appsRepositoryStub;
  let volumeService;

  beforeEach(() => {
    dockerServiceStub = { getAppIdentifier: sinon.stub() };
    // runCommand defaults to success ({ error: null }); tests override as needed
    serviceHelperStub = { runCommand: sinon.stub().resolves({ error: null, stdout: '', stderr: '' }) };
    // readFile rejecting drives isPathMounted onto its mountpoint-command
    // fallback, so tests can keep expressing mountedness via runCommand; the
    // isPathMounted describe covers the mountinfo path with real fixtures
    fsStub = { promises: { access: sinon.stub(), readdir: sinon.stub().resolves([]), readFile: sinon.stub().rejects(new Error('no mountinfo')) } };
    deviceHelperStub = { listMountedFilesystems: sinon.stub().resolves([]), mountForTarget: sinon.stub() };
    appsRepositoryStub = {
      getInstalledApp: sinon.stub().resolves(null),
      listInstalledIdentities: sinon.stub().resolves([null]),
    };
    logStub = {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    };

    volumeService = proxyquire('../../ZelBack/src/services/utils/volumeService', {
      '../dockerService': dockerServiceStub,
      '../serviceHelper': serviceHelperStub,
      // The real APP_VOLUME_MOUNT_OPTIONS, not a placeholder: the assertion
      // below is what stops nosuid/nodev being dropped, so a stubbed value
      // would let the test pass against a mount that no longer sets them.
      './appConstants': {
        appsFolder: APPS_FOLDER,
        appVolumesPath: APP_VOLUMES,
        legacyAppVolumesPath: LEGACY_APP_VOLUMES,
        APP_VOLUME_MOUNT_OPTIONS: require('../../ZelBack/src/services/utils/appConstants').APP_VOLUME_MOUNT_OPTIONS,
      },
      '../../lib/log': logStub,
      '../deviceHelper': deviceHelperStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      // The real containerIdentifierFor: this is the forward derivation under
      // test, so a stub would be the test naming the paths it then finds.
      './specLibs': {
        getSpecBackend: async () => ({
          DeploymentSpec: {
            containerIdentifierFor: (component, identity, replica) => (
              replica != null ? `${component}_${identity}_${replica}` : `${component}_${identity}`
            ),
          },
        }),
      },
      fs: { promises: fsStub.promises },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  const callsFor = (cmd) => serviceHelperStub.runCommand.getCalls().filter((c) => c.args[0] === cmd);

  // per-command dispatcher for runCommand; unlisted commands succeed
  const dispatchRunCommand = (behaviours) => {
    serviceHelperStub.runCommand.callsFake(async (cmd, options) => {
      const behaviour = behaviours[cmd];
      if (!behaviour) return { error: null, stdout: '', stderr: '' };
      return behaviour(options);
    });
  };

  // one /proc/self/mountinfo line per mounted path (field 5 is the mount point)
  const mountinfoWith = (...paths) => paths
    .map((p, i) => `${400 + i} 29 7:${i} / ${p} rw,relatime shared:${i} - ext4 /dev/loop${i} rw`)
    .join('\n');

  describe('isPathMounted tests', () => {
    it('should return true when mountinfo lists the path as a mount point', async () => {
      fsStub.promises.readFile.resolves(mountinfoWith('/dat', '/some/dir'));
      const result = await volumeService.isPathMounted('/some/dir');
      expect(result).to.be.true;
      // no process spawned - this is the whole point of the mountinfo read
      expect(callsFor('mountpoint')).to.have.lengthOf(0);
    });

    it('should return false when mountinfo does not list the path', async () => {
      fsStub.promises.readFile.resolves(mountinfoWith('/dat', '/some/dir/deeper'));
      const result = await volumeService.isPathMounted('/some/dir');
      expect(result).to.be.false;
      expect(callsFor('mountpoint')).to.have.lengthOf(0);
    });

    it('should normalize a trailing slash on the queried path', async () => {
      fsStub.promises.readFile.resolves(mountinfoWith('/some/dir'));
      const result = await volumeService.isPathMounted('/some/dir/');
      expect(result).to.be.true;
    });

    it('should decode octal-escaped characters in mount points', async () => {
      // mountinfo escapes spaces as \040
      fsStub.promises.readFile.resolves(mountinfoWith('/some/dir\\040with\\040space'));
      const result = await volumeService.isPathMounted('/some/dir with space');
      expect(result).to.be.true;
    });

    it('should fall back to the mountpoint command when mountinfo is unreadable', async () => {
      const result = await volumeService.isPathMounted('/some/dir');
      expect(result).to.be.true;
      const probe = callsFor('mountpoint');
      expect(probe).to.have.lengthOf(1);
      expect(probe[0].args[1].params).to.deep.equal(['-q', '/some/dir']);
    });

    it('should return false from the fallback when mountpoint -q fails', async () => {
      serviceHelperStub.runCommand.resolves({ error: new Error('not a mountpoint'), stdout: '', stderr: '' });
      const result = await volumeService.isPathMounted('/some/dir');
      expect(result).to.be.false;
    });
  });

  describe('capacityVolumesInGib tests', () => {
    const mount = (source, target, sizeBytes) => ({
      source, target, sizeBytes, usedBytes: 0, availableBytes: sizeBytes,
    });

    it('counts block-backed volumes', async () => {
      deviceHelperStub.listMountedFilesystems.resolves([
        mount('/dev/sda1', '/dat', 1e12),
        mount('/dev/sdb1', '/dat2', 2e12),
      ]);

      const result = await volumeService.capacityVolumesInGib();
      expect(result.map((v) => v.mount)).to.deep.equal(['/dat', '/dat2']);
    });

    it('excludes a volume that is not block-backed', async () => {
      deviceHelperStub.listMountedFilesystems.resolves([
        mount('/dev/sda1', '/dat', 1e12),
        mount('tmpfs', '/run', 2e12),
      ]);

      const result = await volumeService.capacityVolumesInGib();
      expect(result.map((v) => v.mount)).to.deep.equal(['/dat']);
    });

    it('excludes a loop device, which is an app volume rather than a host disk', async () => {
      deviceHelperStub.listMountedFilesystems.resolves([
        mount('/dev/sda1', '/dat', 1e12),
        mount('/dev/loop3', '/dat/apps/fluxcomp_app', 2e12),
      ]);

      const result = await volumeService.capacityVolumesInGib();
      expect(result.map((v) => v.mount)).to.deep.equal(['/dat']);
    });

    it('excludes a boot filesystem', async () => {
      deviceHelperStub.listMountedFilesystems.resolves([
        mount('/dev/sda1', '/dat', 1e12),
        mount('/dev/sda2', '/boot', 2e12),
      ]);

      const result = await volumeService.capacityVolumesInGib();
      expect(result.map((v) => v.mount)).to.deep.equal(['/dat']);
    });

    it('includes a loop-mounted root, which is the host disk on some images', async () => {
      deviceHelperStub.listMountedFilesystems.resolves([
        mount('/dev/sda1', '/dat', 1e12),
        mount('/dev/loop0', '/', 2e12),
      ]);

      const result = await volumeService.capacityVolumesInGib();
      expect(result.map((v) => v.mount)).to.deep.equal(['/dat', '/']);
    });

    it('reports whole GiB', async () => {
      deviceHelperStub.listMountedFilesystems.resolves([
        { source: '/dev/sda1', target: '/dat', sizeBytes: 1e12, usedBytes: 4e11, availableBytes: 6e11 },
      ]);

      const [volume] = await volumeService.capacityVolumesInGib();
      expect(volume).to.deep.equal({
        filesystem: '/dev/sda1', mount: '/dat', size: 931, used: 373, available: 559,
      });
    });

    it('counts the room for an app in the unit the app will spend', async () => {
      // The number this produces is compared against an app's `hdd`, and that
      // is spent by `fallocate -l <hdd>G`, which util-linux reads as 1024^3.
      // Free space worth exactly twenty of those has to read as 20 - and
      // twenty DECIMAL GB has to read as less, or a node admits an app it is
      // 7.4% short for and finds out when fallocate returns ENOSPC.
      const twentyGib = 20 * (1024 ** 3);
      deviceHelperStub.listMountedFilesystems.resolves([
        { source: '/dev/sda1', target: '/dat', sizeBytes: twentyGib, usedBytes: 0, availableBytes: twentyGib },
      ]);
      expect((await volumeService.capacityVolumesInGib())[0].available).to.equal(20);

      deviceHelperStub.listMountedFilesystems.resolves([
        { source: '/dev/sda1', target: '/dat', sizeBytes: 2e10, usedBytes: 0, availableBytes: 2e10 },
      ]);
      expect((await volumeService.capacityVolumesInGib())[0].available).to.be.below(20);
    });
  });

  describe('getVolumeFilePath tests', () => {
    it('should find the image at the root of an eligible host volume', async () => {
      deviceHelperStub.listMountedFilesystems.resolves([
        { source: '/dev/sda1', target: '/dat' },
        { source: 'tmpfs', target: '/run' },
      ]);
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs('/dat/fluxapp1FLUXFSVOL').resolves();

      const result = await volumeService.getVolumeFilePath('fluxapp1');
      expect(result).to.equal('/dat/fluxapp1FLUXFSVOL');
    });

    it('should not look for images at the root filesystem itself', async () => {
      deviceHelperStub.listMountedFilesystems.resolves([{ source: '/dev/sda1', target: '/' }]);
      fsStub.promises.access.rejects(new Error('ENOENT'));

      await volumeService.getVolumeFilePath('fluxapp1');
      const checked = fsStub.promises.access.getCalls().map((c) => c.args[0]);
      expect(checked).to.not.include('/fluxapp1FLUXFSVOL');
    });

    it('should find the image in the appvolumes directory', async () => {
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs(`${APP_VOLUMES}/fluxapp1FLUXFSVOL`).resolves();

      const result = await volumeService.getVolumeFilePath('fluxapp1');
      expect(result).to.equal(`${APP_VOLUMES}/fluxapp1FLUXFSVOL`);
    });

    it('should find an image left at the legacy glued appvolumes location', async () => {
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs(`${LEGACY_APP_VOLUMES}/fluxapp1FLUXFSVOL`).resolves();

      const result = await volumeService.getVolumeFilePath('fluxapp1');
      expect(result).to.equal(`${LEGACY_APP_VOLUMES}/fluxapp1FLUXFSVOL`);
    });

    it('should return null when the image exists nowhere', async () => {
      fsStub.promises.access.rejects(new Error('ENOENT'));

      const result = await volumeService.getVolumeFilePath('fluxapp1');
      expect(result).to.be.null;
    });

    it('should still check appvolumes locations when the mount table cannot be read', async () => {
      deviceHelperStub.listMountedFilesystems.rejects(new Error('findmnt failed'));
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs(`${APP_VOLUMES}/fluxapp1FLUXFSVOL`).resolves();

      const result = await volumeService.getVolumeFilePath('fluxapp1');
      expect(result).to.equal(`${APP_VOLUMES}/fluxapp1FLUXFSVOL`);
    });
  });

  describe('ensureAppVolumeMounted tests', () => {
    beforeEach(() => {
      dockerServiceStub.getAppIdentifier.returns('fluxapp1');
      deviceHelperStub.listMountedFilesystems.resolves([{ source: '/dev/sda1', target: '/dat' }]);
    });

    it('should be a no-op when the app dir is already a mountpoint', async () => {
      // the mountedness comes from mountinfo - proving the composition once
      fsStub.promises.readFile.resolves(mountinfoWith(`${APPS_FOLDER}fluxapp1`));

      const result = await volumeService.ensureAppVolumeMounted('app1');

      expect(result).to.deep.equal({ mounted: true, alreadyMounted: true });
      expect(callsFor('mount')).to.have.lengthOf(0);
      expect(callsFor('mountpoint')).to.have.lengthOf(0);
    });

    it('should mount the discovered image and set the empty mountpoint immutable first', async () => {
      dispatchRunCommand({
        mountpoint: async () => ({ error: new Error('not mounted'), stdout: '', stderr: '' }),
      });
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs('/dat/fluxapp1FLUXFSVOL').resolves();
      fsStub.promises.readdir.resolves([]);

      const result = await volumeService.ensureAppVolumeMounted('app1');

      expect(result).to.deep.equal({ mounted: true, alreadyMounted: false });
      const chattr = callsFor('chattr');
      expect(chattr).to.have.lengthOf(1);
      expect(chattr[0].args[1].params).to.deep.equal(['+i', `${APPS_FOLDER}fluxapp1`]);
      const mount = callsFor('mount');
      expect(mount).to.have.lengthOf(1);
      // nosuid/nodev are asserted as part of the argv, not just the loop option:
      // a volume holds data its owner writes, so a setuid bit or a device node
      // arriving there - by extraction, by copy, by the app itself - must not be
      // honoured. Dropping either option is a silent privilege regression, so it
      // fails here rather than going unnoticed.
      expect(mount[0].args[1].params).to.deep.equal(['-o', 'loop,nosuid,nodev', '/dat/fluxapp1FLUXFSVOL', `${APPS_FOLDER}fluxapp1`]);
      // the flag must be set BEFORE the mount shadows the bare dir
      expect(chattr[0].calledBefore(mount[0])).to.be.true;
    });

    it('should not set the immutable flag over leaked content, but still mount (shadowing it)', async () => {
      dispatchRunCommand({
        mountpoint: async () => ({ error: new Error('not mounted'), stdout: '', stderr: '' }),
      });
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs('/dat/fluxapp1FLUXFSVOL').resolves();
      fsStub.promises.readdir.resolves(['leaked.db']);

      const result = await volumeService.ensureAppVolumeMounted('app1');

      expect(result.mounted).to.be.true;
      expect(callsFor('chattr')).to.have.lengthOf(0);
      expect(callsFor('mount')).to.have.lengthOf(1);
      expect(logStub.warn.calledWithMatch(/shadowed/)).to.be.true;
    });

    it('should create a missing mountpoint directory before mounting', async () => {
      dispatchRunCommand({
        mountpoint: async () => ({ error: new Error('not mounted'), stdout: '', stderr: '' }),
      });
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs('/dat/fluxapp1FLUXFSVOL').resolves();
      fsStub.promises.readdir.rejects(new Error('ENOENT'));

      const result = await volumeService.ensureAppVolumeMounted('app1');

      expect(result.mounted).to.be.true;
      const mkdir = callsFor('mkdir');
      expect(mkdir).to.have.lengthOf(1);
      expect(mkdir[0].args[1].params).to.deep.equal(['-p', `${APPS_FOLDER}fluxapp1`]);
    });

    it('should report volume_file_missing when no image exists anywhere', async () => {
      dispatchRunCommand({
        mountpoint: async () => ({ error: new Error('not mounted'), stdout: '', stderr: '' }),
      });
      fsStub.promises.access.rejects(new Error('ENOENT'));

      const result = await volumeService.ensureAppVolumeMounted('app1');

      expect(result).to.deep.equal({ mounted: false, reason: 'volume_file_missing' });
      expect(callsFor('mount')).to.have.lengthOf(0);
    });

    it('should treat a lost mount race as success when the dir turns out mounted', async () => {
      let mountpointCalls = 0;
      dispatchRunCommand({
        mountpoint: async () => {
          mountpointCalls += 1;
          // unmounted on the first probe; mounted on the re-probe after our own mount fails
          return mountpointCalls === 1
            ? { error: new Error('not mounted'), stdout: '', stderr: '' }
            : { error: null, stdout: '', stderr: '' };
        },
        mount: async () => ({ error: new Error('already mounted'), stdout: '', stderr: '' }),
      });
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs('/dat/fluxapp1FLUXFSVOL').resolves();
      fsStub.promises.readdir.resolves([]);

      const result = await volumeService.ensureAppVolumeMounted('app1');

      expect(result).to.deep.equal({ mounted: true, alreadyMounted: true });
    });

    it('should report mount_failed when the mount fails and the dir stays unmounted', async () => {
      dispatchRunCommand({
        mountpoint: async () => ({ error: new Error('not mounted'), stdout: '', stderr: '' }),
        mount: async () => ({ error: new Error('bad superblock'), stdout: '', stderr: '' }),
      });
      fsStub.promises.access.rejects(new Error('ENOENT'));
      fsStub.promises.access.withArgs('/dat/fluxapp1FLUXFSVOL').resolves();
      fsStub.promises.readdir.resolves([]);

      const result = await volumeService.ensureAppVolumeMounted('app1');

      expect(result.mounted).to.be.false;
      expect(result.reason).to.include('mount_failed');
      expect(result.reason).to.include('bad superblock');
    });
  });

  describe('clearAppVolumeData tests', () => {
    const FIND_ARGS = ['-mindepth', '1', '-maxdepth', '1', '-exec', 'rm', '-rf', '{}', '+'];

    beforeEach(() => {
      dockerServiceStub.getAppIdentifier.returns('fluxdb_MyApp');
    });

    it('empties the app data directory as root, in one command', async () => {
      await volumeService.clearAppVolumeData('db_MyApp');

      sinon.assert.calledOnce(serviceHelperStub.runCommand);
      const [cmd, opts] = serviceHelperStub.runCommand.firstCall.args;
      // Root for the LISTING as well as the delete. Enumerating host-side runs as
      // the FluxOS user, and an image that chmods its data dir 700 (postgres does)
      // makes that fail - which the caller correctly reads as a failed wipe and
      // then retries forever, so the component never starts again.
      expect(opts.runAsRoot).to.equal(true);
      expect(cmd).to.equal('find');
      // The path is load-bearing: the app ROOT holds the mount structure, and
      // wiping that instead of appdata destroys the volume rather than its
      // contents. -mindepth 1 empties the directory without removing it.
      expect(opts.params).to.deep.equal([`${APPS_FOLDER}fluxdb_MyApp/appdata`, ...FIND_ARGS]);
    });

    // THE CONTRACT. serviceHelper.runCommand never rejects - it resolves
    // { error, stdout, stderr } - so a caller that reads it as though it threw
    // ignores every failure. This logged "Deleted data for app X" when the wipe
    // had failed, and appReconciler's catch, which holds dataDesired at 'clear'
    // so a start cannot proceed onto un-wiped data, was unreachable.
    it('rejects when the wipe failed, rather than reporting success', async () => {
      serviceHelperStub.runCommand.onFirstCall().resolves({
        error: new Error('exit 1'), stdout: '', stderr: "rm: cannot remove '/x': Device or resource busy",
      });
      // the directory exists - the failure was real
      serviceHelperStub.runCommand.onSecondCall().resolves({ error: null, stdout: '', stderr: '' });

      await expect(volumeService.clearAppVolumeData('db_MyApp')).to.be.rejectedWith('Failed to delete data');

      expect(
        logStub.info.getCalls().some((call) => String(call.args[0]).includes('Deleted data')),
        'reported the data deleted when the wipe failed',
      ).to.equal(false);
    });

    // Nothing to clear is not a failed clear: an app whose volume was never
    // populated must not hold the reconciler on a retry forever. The stderr is
    // deliberately NOT the English message: find renders strerror in the node's
    // locale, so the classification must come from `test -d`'s exit status and
    // never from the words.
    it('returns quietly when there is no app data directory, whatever language find speaks', async () => {
      serviceHelperStub.runCommand.onFirstCall().resolves({
        error: new Error('exit 1'),
        stdout: '',
        stderr: "find: '/test/apps/folder/fluxdb_MyApp/appdata': Aucun fichier ou dossier de ce type",
      });
      // the directory does not exist - there was nothing to clear
      serviceHelperStub.runCommand.onSecondCall().resolves({ error: new Error('exit 1'), stdout: '', stderr: '' });

      await volumeService.clearAppVolumeData('db_MyApp');

      expect(
        logStub.info.getCalls().some((call) => String(call.args[0]).includes('No data to delete')),
      ).to.equal(true);
      // The classifier runs as root, like the wipe: an unprivileged check paired
      // with a root action fails on a data dir the image chmods to 700.
      const [cmd, opts] = serviceHelperStub.runCommand.secondCall.args;
      expect(cmd).to.equal('test');
      expect(opts.runAsRoot).to.equal(true);
      expect(opts.params).to.deep.equal(['-d', `${APPS_FOLDER}fluxdb_MyApp/appdata`]);
    });

    it('reports what the wipe actually said, so a failure can be diagnosed', async () => {
      serviceHelperStub.runCommand.onFirstCall().resolves({
        error: new Error('exit 1'), stdout: '', stderr: 'rm: cannot remove: Read-only file system',
      });
      serviceHelperStub.runCommand.onSecondCall().resolves({ error: null, stdout: '', stderr: '' });

      await expect(volumeService.clearAppVolumeData('db_MyApp'))
        .to.be.rejectedWith(/Read-only file system/);
    });
  });
  describe('listComponentVolumeMounts tests', () => {
    const mountRow = (target) => ({
      source: '/dev/loop3', target, fstype: 'ext4', sizeBytes: 2e9, usedBytes: 1e9, availableBytes: 1e9, usePercent: 50,
    });

    beforeEach(() => {
      dockerServiceStub.getAppIdentifier.callsFake((id) => `flux${id}`);
    });

    it('answers nothing for an app this node has not installed', async () => {
      expect(await volumeService.listComponentVolumeMounts('myapp', 'web')).to.deep.equal([]);
      expect(deviceHelperStub.listMountedFilesystems.called).to.equal(false);
    });

    it('resolves each installed replica to its own mount', async () => {
      appsRepositoryStub.getInstalledApp.resolves({ name: 'myapp', identity: 'myapp' });
      appsRepositoryStub.listInstalledIdentities.resolves(['s1', 's2']);
      deviceHelperStub.listMountedFilesystems.resolves([
        mountRow(`${APPS_FOLDER}fluxweb_myapp_s1`),
        mountRow(`${APPS_FOLDER}fluxweb_myapp_s2`),
      ]);

      const volumes = await volumeService.listComponentVolumeMounts('myapp', 'web');

      expect(volumes.map((v) => v.replica)).to.deep.equal(['s1', 's2']);
      expect(volumes.map((v) => v.mount)).to.deep.equal([
        `${APPS_FOLDER}fluxweb_myapp_s1`, `${APPS_FOLDER}fluxweb_myapp_s2`,
      ]);
    });

    // The identity is what the volumes were NAMED from, and it stops being the
    // app's name the moment one is minted. Reading the app name instead finds
    // nothing - which is the half of D16 the entry did not record.
    it('reads the stored identity, not the app name', async () => {
      appsRepositoryStub.getInstalledApp.resolves({ name: 'myapp', identity: 'a1b2c3' });
      appsRepositoryStub.listInstalledIdentities.resolves([null]);
      deviceHelperStub.listMountedFilesystems.resolves([
        mountRow(`${APPS_FOLDER}fluxweb_a1b2c3`),
        mountRow(`${APPS_FOLDER}fluxweb_myapp`),
      ]);

      const volumes = await volumeService.listComponentVolumeMounts('myapp', 'web');

      expect(volumes).to.have.lengthOf(1);
      expect(volumes[0].mount).to.equal(`${APPS_FOLDER}fluxweb_a1b2c3`);
    });

    // A v1-3 app has no compose array and one implicit component, addressed as
    // the literal 'null' by every caller that speaks the v1 API.
    it("resolves a flat app addressed as the literal 'null' to its bare-identity mount", async () => {
      appsRepositoryStub.getInstalledApp.resolves({ name: 'legacyapp', identity: null });
      appsRepositoryStub.listInstalledIdentities.resolves([null]);
      deviceHelperStub.listMountedFilesystems.resolves([mountRow(`${APPS_FOLDER}fluxlegacyapp`)]);

      const volumes = await volumeService.listComponentVolumeMounts('legacyapp', 'null');

      expect(volumes).to.have.lengthOf(1);
      expect(volumes[0].mount).to.equal(`${APPS_FOLDER}fluxlegacyapp`);
    });

    it('refuses to guess when one directory name is mounted twice', async () => {
      // Never last-wins. Two filesystems sharing a directory name break the
      // assumption the lookup rests on, and every caller addresses real data.
      appsRepositoryStub.getInstalledApp.resolves({ name: 'myapp', identity: 'myapp' });
      deviceHelperStub.listMountedFilesystems.resolves([
        mountRow(`${APPS_FOLDER}fluxweb_myapp`),
        mountRow(`/elsewhere/fluxweb_myapp`),
      ]);

      await expect(volumeService.listComponentVolumeMounts('myapp', 'web'))
        .to.be.rejectedWith(/mounted at both .* refusing to guess/);
    });

    it('refuses a mount carrying the identifier from outside the apps folder', async () => {
      appsRepositoryStub.getInstalledApp.resolves({ name: 'myapp', identity: 'myapp' });
      deviceHelperStub.listMountedFilesystems.resolves([mountRow('/elsewhere/fluxweb_myapp')]);

      await expect(volumeService.listComponentVolumeMounts('myapp', 'web'))
        .to.be.rejectedWith(/outside the apps folder/);
    });

    // Containment is a directory, not a string prefix: a sibling whose name
    // merely begins with the apps folder's is a different directory.
    it('refuses a mount under a sibling directory sharing the apps folder prefix', async () => {
      appsRepositoryStub.getInstalledApp.resolves({ name: 'myapp', identity: 'myapp' });
      deviceHelperStub.listMountedFilesystems.resolves([
        mountRow(`${APPS_FOLDER.replace(/\/$/, '')}-backup/fluxweb_myapp`),
      ]);

      await expect(volumeService.listComponentVolumeMounts('myapp', 'web'))
        .to.be.rejectedWith(/outside the apps folder/);
    });
  });

  describe('appVolumeFilesystemId tests', () => {
    const APP_ID = 'fluxcomp_myapp';
    const MOUNT_PATH = `${APPS_FOLDER}${APP_ID}`;

    it('should return the uuid of the volume mounted at the component own mountpoint', async () => {
      deviceHelperStub.mountForTarget.resolves({
        source: '/dev/loop3', target: MOUNT_PATH, fstype: 'ext4', uuid: 'uuid-v1', availableBytes: 1,
      });

      expect(await volumeService.appVolumeFilesystemId(APP_ID)).to.equal('uuid-v1');
    });

    it('should return null when the volume is not mounted, not the hosting disk uuid', async () => {
      // findmnt --target resolves the CONTAINING mountpoint, so an unmounted volume
      // reports the apps-folder filesystem - whose uuid every component on the node
      // shares. Returning it would make each component look like every other one.
      deviceHelperStub.mountForTarget.resolves({
        source: '/dev/sda1', target: '/dat', fstype: 'ext4', uuid: 'uuid-of-the-host-disk', availableBytes: 1,
      });

      expect(await volumeService.appVolumeFilesystemId(APP_ID)).to.equal(null);
    });

    it('should return null when the mountpoint cannot be resolved at all', async () => {
      deviceHelperStub.mountForTarget.rejects(new Error('findmnt resolved no mounted filesystem'));

      expect(await volumeService.appVolumeFilesystemId(APP_ID)).to.equal(null);
    });

    it('should return null on a filesystem that carries no uuid', async () => {
      deviceHelperStub.mountForTarget.resolves({
        source: 'overlay', target: MOUNT_PATH, fstype: 'overlay', uuid: null, availableBytes: 1,
      });

      expect(await volumeService.appVolumeFilesystemId(APP_ID)).to.equal(null);
    });
  });

});
