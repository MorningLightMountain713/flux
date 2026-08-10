process.env.NODE_CONFIG_DIR = `${process.cwd()}/ZelBack/config/`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

chai.use(chaiAsPromised);
const { expect } = chai;

// Stubs for util.promisify
const crontabLoadStub = sinon.stub();
const utilFake = {
  promisify: (fn) => {
    if (fn.name === 'load') return crontabLoadStub;
    return sinon.stub();
  },
};

const runCommandStub = sinon.stub();

// Module under test with proxyquire
const getInstalledAppByIdentityStub = sinon.stub();
const getInstalledAppByComponentIdentifierStub = sinon.stub();
const volumeValidationService = proxyquire('../../ZelBack/src/services/volumeValidationService', {
  util: utilFake,
  './serviceHelper': { runCommand: runCommandStub },
  './dockerService': { getBaseAppName: (id) => (id.startsWith('flux') ? id.slice(4) : id) },
  './appDatabase/appsRepository': {
    getInstalledAppByIdentity: getInstalledAppByIdentityStub,
    getInstalledAppByComponentIdentifier: getInstalledAppByComponentIdentifierStub,
  },
  './utils/specLibs': {
    getSpecBackend: async () => ({
      DeploymentSpec: {
        appNameFromIdentifier: (id) => { const p = id.split('_'); return p.length <= 1 ? id : p[1]; },
      },
    }),
  },
});

describe('volumeValidationService tests', () => {
  afterEach(() => {
    // Only reset global stubs, don't call sinon.restore() as it will restore
    // all stubs including those in nested beforeEach blocks
    runCommandStub.reset();
    crontabLoadStub.reset();
  });

  describe('hasIncorrectFluxPath tests', () => {
    it('should return true for path containing /flux/ZelApps', () => {
      const volumePath = '/home/user/flux/ZelApps/myapp';

      const result = volumeValidationService.hasIncorrectFluxPath(volumePath);

      expect(result).to.be.true;
    });

    it('should return true for path with /flux/ZelApps in the middle', () => {
      const volumePath = '/root/flux/ZelApps/testapp/data';

      const result = volumeValidationService.hasIncorrectFluxPath(volumePath);

      expect(result).to.be.true;
    });

    it('should return false for correct path without /flux/ZelApps', () => {
      const volumePath = '/home/user/zelflux/ZelApps/myapp';

      const result = volumeValidationService.hasIncorrectFluxPath(volumePath);

      expect(result).to.be.false;
    });

    it('should return false for path with just ZelApps', () => {
      const volumePath = '/home/ZelApps/myapp';

      const result = volumeValidationService.hasIncorrectFluxPath(volumePath);

      expect(result).to.be.false;
    });

    it('should return false for null path', () => {
      const result = volumeValidationService.hasIncorrectFluxPath(null);

      expect(result).to.be.false;
    });

    it('should return false for undefined path', () => {
      const result = volumeValidationService.hasIncorrectFluxPath(undefined);

      expect(result).to.be.false;
    });

    it('should return false for empty string', () => {
      const result = volumeValidationService.hasIncorrectFluxPath('');

      expect(result).to.be.false;
    });

    it('should return false for non-string input', () => {
      const result = volumeValidationService.hasIncorrectFluxPath(12345);

      expect(result).to.be.false;
    });
  });


  describe('resolveAppForMountEntry tests', () => {
    beforeEach(() => getInstalledAppByComponentIdentifierStub.resolves(null));

    afterEach(() => {
      getInstalledAppByIdentityStub.reset();
      getInstalledAppByComponentIdentifierStub.reset();
    });

    it('resolves the app from the components its row recorded, without taking the id apart', async () => {
      getInstalledAppByComponentIdentifierStub.withArgs('mongodb_MyApp').resolves({ name: 'MyApp' });

      const result = await volumeValidationService.resolveAppForMountEntry('fluxmongodb_MyApp');

      expect(result).to.equal('MyApp');
      expect(getInstalledAppByIdentityStub.called, 'the parse must not run when the row states it').to.be.false;
    });

    // Rows written before componentIdentifiers existed state nothing to the index,
    // so the parse stays until coverage reports covered fleet-wide.
    it('falls back to the parse for a row that records no components', async () => {
      getInstalledAppByIdentityStub.resolves({ name: 'MyApp' });

      const result = await volumeValidationService.resolveAppForMountEntry('fluxmongodb_MyApp');

      expect(result).to.equal('MyApp');
      expect(getInstalledAppByIdentityStub.calledOnceWith('MyApp')).to.be.true;
    });

    // The caller redeploys with createVolumes, which reformats the volume. An
    // entry nothing claims must produce no answer at all - the old code sliced
    // four characters off anything starting with `flux` and handed the result on,
    // which two different apps can both produce.
    it('answers null when no installed app claims that identity', async () => {
      getInstalledAppByIdentityStub.resolves(null);

      expect(await volumeValidationService.resolveAppForMountEntry('fluxweb_ghost')).to.equal(null);
    });

    it('answers null rather than guessing when the lookup fails', async () => {
      getInstalledAppByIdentityStub.rejects(new Error('db down'));

      expect(await volumeValidationService.resolveAppForMountEntry('fluxweb_myapp')).to.equal(null);
    });

    it('answers null for a missing app id', async () => {
      expect(await volumeValidationService.resolveAppForMountEntry('')).to.equal(null);
      expect(getInstalledAppByIdentityStub.called).to.be.false;
      expect(getInstalledAppByComponentIdentifierStub.called).to.be.false;
    });
  });

  describe('getAppsWithIncorrectVolumeMounts tests', () => {
    let mockCrontab;

    beforeEach(() => {
      mockCrontab = {
        jobs: sinon.stub(),
        save: sinon.stub(),
        remove: sinon.stub(),
      };
      getInstalledAppByIdentityStub.reset();
      getInstalledAppByComponentIdentifierStub.reset();
      getInstalledAppByComponentIdentifierStub.resolves(null);
      getInstalledAppByIdentityStub.callsFake(async (identity) => ({ name: identity }));
    });

    it('should find apps with incorrect volume mounts', async () => {
      const mockJobs = [
        {
          comment: () => 'fluxweb_myapp',
          command: () => 'sudo mount -o loop /home/flux/ZelApps/myappTEMP /root/flux/ZelApps/myapp',
        },
        {
          comment: () => 'fluxweb_testapp',
          command: () => 'sudo mount -o loop /home/flux/ZelApps/testappTEMP /root/flux/ZelApps/testapp',
        },
      ];

      mockCrontab.jobs.returns(mockJobs);
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.getAppsWithIncorrectVolumeMounts();

      expect(result).to.have.lengthOf(2);
      expect(result[0]).to.deep.include({
        appName: 'myapp',
        volumePath: '/home/flux/ZelApps/myappTEMP',
        mountPoint: '/root/flux/ZelApps/myapp',
        appId: 'fluxweb_myapp',
      });
      expect(result[1]).to.deep.include({
        appName: 'testapp',
        volumePath: '/home/flux/ZelApps/testappTEMP',
        mountPoint: '/root/flux/ZelApps/testapp',
        appId: 'fluxweb_testapp',
      });
    });

    it('should filter out apps with correct volume mounts', async () => {
      const mockJobs = [
        {
          comment: () => 'fluxweb_myapp',
          command: () => 'sudo mount -o loop /home/correctpath/myappTEMP /root/zelflux/ZelApps/myapp',
        },
        {
          comment: () => 'fluxweb_badapp',
          command: () => 'sudo mount -o loop /home/flux/ZelApps/badappTEMP /root/flux/ZelApps/badapp',
        },
      ];

      mockCrontab.jobs.returns(mockJobs);
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.getAppsWithIncorrectVolumeMounts();

      expect(result).to.have.lengthOf(1);
      expect(result[0].appName).to.equal('badapp');
    });

    it('should return empty array if no crontab found', async () => {
      crontabLoadStub.resolves(null);

      const result = await volumeValidationService.getAppsWithIncorrectVolumeMounts();

      expect(result).to.be.an('array').that.is.empty;
    });

    it('should handle crontab load error gracefully', async () => {
      crontabLoadStub.rejects(new Error('Crontab load failed'));

      const result = await volumeValidationService.getAppsWithIncorrectVolumeMounts();

      expect(result).to.be.an('array').that.is.empty;
    });

    it('should skip jobs without mount command', async () => {
      const mockJobs = [
        {
          comment: () => 'fluxweb_myapp',
          command: () => '*/5 * * * * /usr/bin/backup.sh',
        },
        {
          comment: () => 'fluxweb_app',
          command: () => 'sudo mount -o loop /home/flux/ZelApps/appTEMP /root/flux/ZelApps/app',
        },
      ];

      mockCrontab.jobs.returns(mockJobs);
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.getAppsWithIncorrectVolumeMounts();

      expect(result).to.have.lengthOf(1);
      expect(result[0].appName).to.equal('app');
    });

    it('should handle jobs with malformed commands', async () => {
      const mockJobs = [
        {
          comment: () => 'fluxweb_myapp',
          command: () => 'sudo mount -o loop',
        },
      ];

      mockCrontab.jobs.returns(mockJobs);
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.getAppsWithIncorrectVolumeMounts();

      expect(result).to.be.an('array').that.is.empty;
    });
  });

  describe('unmountIncorrectVolume tests', () => {
    it('should successfully unmount a volume', async () => {
      const mountPoint = '/root/flux/ZelApps/myapp';
      runCommandStub.resolves({ error: null, stdout: '', stderr: '' });

      const result = await volumeValidationService.unmountIncorrectVolume(mountPoint);

      expect(result).to.be.true;
      sinon.assert.calledWith(runCommandStub, 'umount', sinon.match({
        runAsRoot: true,
        params: [mountPoint],
      }));
    });

    it('should handle unmount failure gracefully', async () => {
      const mountPoint = '/root/flux/ZelApps/myapp';
      runCommandStub.resolves({ error: new Error('Not mounted'), stdout: '', stderr: '' });

      const result = await volumeValidationService.unmountIncorrectVolume(mountPoint);

      expect(result).to.be.false;
    });
  });

  describe('removeCrontabEntry tests', () => {
    let mockCrontab;
    let mockJob;

    beforeEach(() => {
      mockJob = {
        comment: sinon.stub(),
        command: sinon.stub(),
      };

      mockCrontab = {
        jobs: sinon.stub(),
        save: sinon.stub(),
        remove: sinon.stub(),
      };
    });

    it('should successfully remove crontab entry with matching app ID and path', async () => {
      const appId = 'app-id-123';
      const incorrectVolumePath = '/home/flux/ZelApps/myappTEMP';

      mockJob.comment.returns(appId);
      mockJob.command.returns(`sudo mount -o loop ${incorrectVolumePath} /root/flux/ZelApps/myapp`);
      mockCrontab.jobs.returns([mockJob]);
      mockCrontab.save.resolves();
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.removeCrontabEntry(appId, incorrectVolumePath);

      expect(result).to.be.true;
      sinon.assert.calledOnce(mockCrontab.remove);
      sinon.assert.calledWith(mockCrontab.remove, mockJob);
      sinon.assert.calledOnce(mockCrontab.save);
    });

    it('should not remove entry if app ID does not match', async () => {
      const appId = 'app-id-123';
      const incorrectVolumePath = '/home/flux/ZelApps/myappTEMP';

      mockJob.comment.returns('different-app-id');
      mockJob.command.returns(`sudo mount -o loop ${incorrectVolumePath} /root/flux/ZelApps/myapp`);
      mockCrontab.jobs.returns([mockJob]);
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.removeCrontabEntry(appId, incorrectVolumePath);

      expect(result).to.be.false;
      sinon.assert.notCalled(mockCrontab.remove);
      sinon.assert.notCalled(mockCrontab.save);
    });

    it('should not remove entry if volume path does not match', async () => {
      const appId = 'app-id-123';
      const incorrectVolumePath = '/home/flux/ZelApps/myappTEMP';

      mockJob.comment.returns(appId);
      mockJob.command.returns('sudo mount -o loop /different/path /root/flux/ZelApps/myapp');
      mockCrontab.jobs.returns([mockJob]);
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.removeCrontabEntry(appId, incorrectVolumePath);

      expect(result).to.be.false;
      sinon.assert.notCalled(mockCrontab.remove);
      sinon.assert.notCalled(mockCrontab.save);
    });

    it('should return false if no crontab found', async () => {
      const appId = 'app-id-123';
      const incorrectVolumePath = '/home/flux/ZelApps/myappTEMP';

      crontabLoadStub.resolves(null);

      const result = await volumeValidationService.removeCrontabEntry(appId, incorrectVolumePath);

      expect(result).to.be.false;
    });

    it('should handle crontab save error', async () => {
      const appId = 'app-id-123';
      const incorrectVolumePath = '/home/flux/ZelApps/myappTEMP';

      mockJob.comment.returns(appId);
      mockJob.command.returns(`sudo mount -o loop ${incorrectVolumePath} /root/flux/ZelApps/myapp`);
      mockCrontab.jobs.returns([mockJob]);
      mockCrontab.save.rejects(new Error('Save failed'));
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.removeCrontabEntry(appId, incorrectVolumePath);

      expect(result).to.be.false;
      sinon.assert.calledOnce(mockCrontab.remove);
    });

    it('should handle crontab load error', async () => {
      const appId = 'app-id-123';
      const incorrectVolumePath = '/home/flux/ZelApps/myappTEMP';

      crontabLoadStub.rejects(new Error('Load failed'));

      const result = await volumeValidationService.removeCrontabEntry(appId, incorrectVolumePath);

      expect(result).to.be.false;
    });

    it('should handle multiple jobs and remove only matching one', async () => {
      const appId = 'app-id-123';
      const incorrectVolumePath = '/home/flux/ZelApps/myappTEMP';

      const mockJob1 = {
        comment: () => appId,
        command: () => `sudo mount -o loop ${incorrectVolumePath} /root/flux/ZelApps/myapp`,
      };

      const mockJob2 = {
        comment: () => 'other-app-id',
        command: () => 'sudo mount -o loop /other/path /root/flux/ZelApps/otherapp',
      };

      mockCrontab.jobs.returns([mockJob1, mockJob2]);
      mockCrontab.save.resolves();
      crontabLoadStub.resolves(mockCrontab);

      const result = await volumeValidationService.removeCrontabEntry(appId, incorrectVolumePath);

      expect(result).to.be.true;
      sinon.assert.calledOnce(mockCrontab.remove);
      sinon.assert.calledWith(mockCrontab.remove, mockJob1);
    });
  });


  // Note: checkAndFixIncorrectVolumeMounts is an integration function that orchestrates
  // the other functions which are already tested above. Testing it would require
  // complex mocking of internal function calls which goes against testing best practices.
  // The individual functions (getAppsWithIncorrectVolumeMounts, unmountIncorrectVolume,
  // removeCrontabEntry, rebuildApp, extractBaseAppName) are all tested separately.
});
