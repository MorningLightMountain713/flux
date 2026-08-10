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
    logStub = {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    };

    volumeService = proxyquire('../../ZelBack/src/services/utils/volumeService', {
      '../dockerService': dockerServiceStub,
      '../serviceHelper': serviceHelperStub,
      './appConstants': { appsFolder: APPS_FOLDER, appVolumesPath: APP_VOLUMES, legacyAppVolumesPath: LEGACY_APP_VOLUMES },
      '../../lib/log': logStub,
      '../deviceHelper': deviceHelperStub,
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

  describe('getVolumeFilePath tests', () => {
    it('should find the image at the root of an eligible df volume', async () => {
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

    it('should still check appvolumes locations when df fails', async () => {
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
      expect(mount[0].args[1].params).to.deep.equal(['-o', 'loop', '/dat/fluxapp1FLUXFSVOL', `${APPS_FOLDER}fluxapp1`]);
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
