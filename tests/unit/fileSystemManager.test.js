const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('fileSystemManager tests', () => {
  let fileSystemManager;
  let verificationHelperStub;
  let messageHelperStub;
  let serviceHelperStub;
  let volumeTargetStub;
  let logStub;
  let pathSecurityStub;
  let formidableStub;
  let formStub;

  beforeEach(() => {
    // Stubs
    verificationHelperStub = {
      verifyPrivilege: sinon.stub(),
    };

    messageHelperStub = {
      createSuccessMessage: sinon.stub(),
      createErrorMessage: sinon.stub(),
      errUnauthorizedMessage: sinon.stub(),
    };

    serviceHelperStub = {
      ensureString: sinon.stub().returnsArg(0),
      runCommand: sinon.stub(),
    };

    // The handlers depend on "resolve which volume this request addresses",
    // not on how that is done — volumeTarget owns the identity rule and is
    // covered on its own.
    volumeTargetStub = {
      resolveVolumeTarget: sinon.stub().resolves({
        appname: 'testapp', component: 'testcomp', replica: null, mount: '/mnt/testapp',
      }),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    // The upload form is chainable and its parse is a no-op: these tests are
    // about which volume the upload lands in, not about multipart parsing.
    formStub = { on: sinon.stub(), parse: sinon.stub() };
    formStub.on.returns(formStub);
    formidableStub = { formidable: sinon.stub().returns(formStub) };

    pathSecurityStub = {
      sanitizePath: sinon.stub().callsFake((userPath, basePath) => {
        // Simple mock: if userPath is empty, return basePath, otherwise join them
        if (!userPath) return basePath;
        return `${basePath}/${userPath}`;
      }),
      verifyRealPath: sinon.stub().resolves(),
      verifyRealPathOfExistingPath: sinon.stub().resolves(),
    };

    // Proxy require with mocked dependencies
    fileSystemManager = proxyquire('../../ZelBack/src/services/appSystem/fileSystemManager', {
      '../messageHelper': messageHelperStub,
      '../verificationHelper': verificationHelperStub,
      '../serviceHelper': serviceHelperStub,
      '../../lib/log': logStub,
      '../utils/pathSecurity': pathSecurityStub,
      './volumeTarget': volumeTargetStub,
      formidable: formidableStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('createAppsFolder', () => {
    it('should create folder when authorized', async () => {
      const req = {
        params: { appname: 'testapp', folder: 'testfolder', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      serviceHelperStub.runCommand.resolves({});
      messageHelperStub.createSuccessMessage.returns({ status: 'success', data: { message: 'Folder Created' } });

      await fileSystemManager.createAppsFolder(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(verificationHelperStub.verifyPrivilege.calledWith('appownerabove', req, 'testapp')).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.calledOnceWithExactly('/mnt/testapp/testfolder', '/mnt/testapp')).to.be.true;
      expect(serviceHelperStub.runCommand.calledOnceWithExactly('mkdir', {
        runAsRoot: true,
        params: ['/mnt/testapp/testfolder'],
      })).to.be.true;
      expect(messageHelperStub.createSuccessMessage.calledWith('Folder Created')).to.be.true;
    });

    it('should deny unauthorized access', async () => {
      const req = {
        params: { appname: 'testapp', folder: 'testfolder', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error', data: { message: 'Unauthorized' } });

      await fileSystemManager.createAppsFolder(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.errUnauthorizedMessage.calledOnce).to.be.true;
      expect(serviceHelperStub.runCommand.called).to.be.false;
    });

    it('should handle missing appname parameter', async () => {
      const req = {
        params: {},
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      volumeTargetStub.resolveVolumeTarget.rejects(new Error('appname parameter is mandatory'));
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'appname parameter is mandatory' } });

      await fileSystemManager.createAppsFolder(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.createErrorMessage.calledOnce).to.be.true;
    });

    it('should handle application volume not found error', async () => {
      const req = {
        params: { appname: 'testapp', folder: 'testfolder', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      volumeTargetStub.resolveVolumeTarget.rejects(new Error('Application volume not found'));
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Application volume not found' } });

      await fileSystemManager.createAppsFolder(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.createErrorMessage.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('renameAppsObject', () => {
    it('should rename object when authorized', async () => {
      const req = {
        params: {
          appname: 'testapp', oldpath: 'oldname', newname: 'newname', component: 'testcomp',
        },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      serviceHelperStub.runCommand.resolves({});
      messageHelperStub.createSuccessMessage.returns({ status: 'success', data: { message: 'Rename successful' } });

      await fileSystemManager.renameAppsObject(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.calledTwice).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.firstCall.calledWithExactly('/mnt/testapp', '/mnt/testapp')).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.secondCall.calledWithExactly('/mnt/testapp', '/mnt/testapp')).to.be.true;
      expect(pathSecurityStub.verifyRealPath.calledOnceWithExactly('/mnt/testapp/oldname', '/mnt/testapp')).to.be.true;
      expect(serviceHelperStub.runCommand.calledOnceWithExactly('mv', {
        runAsRoot: true,
        params: ['-T', '/mnt/testapp/oldname', '/mnt/testapp/newname'],
      })).to.be.true;
      expect(messageHelperStub.createSuccessMessage.calledWith('Rename successful')).to.be.true;
    });

    it('should rename symlink without resolving its target', async () => {
      const req = {
        params: {
          appname: 'testapp', oldpath: 'oldname', newname: 'newname', component: 'testcomp',
        },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      serviceHelperStub.runCommand.resolves({});
      messageHelperStub.createSuccessMessage.returns({ status: 'success', data: { message: 'Rename successful' } });

      const fsPromises = require('fs').promises;
      sinon.stub(fsPromises, 'lstat').resolves({ isSymbolicLink: () => true });

      await fileSystemManager.renameAppsObject(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.calledTwice).to.be.true;
      expect(pathSecurityStub.verifyRealPath.notCalled).to.be.true;
      expect(serviceHelperStub.runCommand.calledOnceWithExactly('mv', {
        runAsRoot: true,
        params: ['-T', '/mnt/testapp/oldname', '/mnt/testapp/newname'],
      })).to.be.true;
    });

    it('should deny unauthorized access', async () => {
      const req = {
        params: {
          appname: 'testapp', oldpath: 'oldname', newname: 'newname', component: 'testcomp',
        },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error', data: { message: 'Unauthorized' } });

      await fileSystemManager.renameAppsObject(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.errUnauthorizedMessage.calledOnce).to.be.true;
      expect(serviceHelperStub.runCommand.called).to.be.false;
    });

    it('should handle missing oldpath parameter', async () => {
      const req = {
        params: { appname: 'testapp', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        write: sinon.stub(),
        end: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'No file nor folder to rename specified' } });

      await fileSystemManager.renameAppsObject(req, res);

      expect(res.write.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });

    it('should reject invalid newname with slash', async () => {
      const req = {
        params: {
          appname: 'testapp', oldpath: 'oldname', newname: 'new/name', component: 'testcomp',
        },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        write: sinon.stub(),
        end: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'New name is invalid' } });

      await fileSystemManager.renameAppsObject(req, res);

      expect(res.write.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('removeAppsObject', () => {
    it('should remove object when authorized', async () => {
      const req = {
        params: { appname: 'testapp', object: 'testfile', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      serviceHelperStub.runCommand.resolves({});
      messageHelperStub.createSuccessMessage.returns({ status: 'success', data: { message: 'File Removed' } });

      await fileSystemManager.removeAppsObject(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.calledTwice).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.firstCall.calledWithExactly('/mnt/testapp', '/mnt/testapp')).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.secondCall.calledWithExactly('/mnt/testapp/testfile', '/mnt/testapp')).to.be.true;
      expect(serviceHelperStub.runCommand.calledOnceWithExactly('rm', {
        runAsRoot: true,
        params: ['-rf', '/mnt/testapp/testfile'],
      })).to.be.true;
      expect(messageHelperStub.createSuccessMessage.calledWith('File Removed')).to.be.true;
    });

    it('should skip target realpath check when removing symlink', async () => {
      const req = {
        params: { appname: 'testapp', object: 'testlink', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      serviceHelperStub.runCommand.resolves({});
      messageHelperStub.createSuccessMessage.returns({ status: 'success', data: { message: 'File Removed' } });

      const fsPromises = require('fs').promises;
      sinon.stub(fsPromises, 'lstat').resolves({ isSymbolicLink: () => true });

      await fileSystemManager.removeAppsObject(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(pathSecurityStub.verifyRealPathOfExistingPath.calledOnceWithExactly('/mnt/testapp', '/mnt/testapp')).to.be.true;
      expect(serviceHelperStub.runCommand.calledOnceWithExactly('rm', {
        runAsRoot: true,
        params: ['-rf', '/mnt/testapp/testlink'],
      })).to.be.true;
    });

    it('should deny unauthorized access', async () => {
      const req = {
        params: { appname: 'testapp', object: 'testfile', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error', data: { message: 'Unauthorized' } });

      await fileSystemManager.removeAppsObject(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.errUnauthorizedMessage.calledOnce).to.be.true;
      expect(serviceHelperStub.runCommand.called).to.be.false;
    });

    it('should handle missing object parameter', async () => {
      const req = {
        params: { appname: 'testapp', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        write: sinon.stub(),
        end: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'No object specified' } });

      await fileSystemManager.removeAppsObject(req, res);

      expect(res.write.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('downloadAppsFolder', () => {
    it('should deny unauthorized access', async () => {
      const req = {
        params: { appname: 'testapp', folder: 'testfolder', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error', data: { message: 'Unauthorized' } });

      await fileSystemManager.downloadAppsFolder(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.errUnauthorizedMessage.calledOnce).to.be.true;
    });

    it('should handle missing folder parameter', async () => {
      const req = {
        params: { appname: 'testapp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'folder and component parameters are mandatory' } });

      await fileSystemManager.downloadAppsFolder(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.createErrorMessage.calledOnce).to.be.true;
    });

    it('should handle application volume not found error', async () => {
      const req = {
        params: { appname: 'testapp', folder: 'testfolder', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        write: sinon.stub(),
        end: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      volumeTargetStub.resolveVolumeTarget.rejects(new Error('Application volume not found'));
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Application volume not found' } });

      await fileSystemManager.downloadAppsFolder(req, res);

      expect(res.write.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  describe('downloadAppsFile', () => {
    it('should initiate file download when authorized', async () => {
      const req = {
        params: { appname: 'testapp', file: 'testfile.txt', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        download: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      serviceHelperStub.runCommand.resolves({});

      await fileSystemManager.downloadAppsFile(req, res);

      expect(serviceHelperStub.runCommand.calledOnceWithExactly('chmod', {
        runAsRoot: true,
        params: ['777', '/mnt/testapp/testfile.txt'],
      })).to.be.true;
      expect(res.download.calledOnceWithExactly('/mnt/testapp/testfile.txt', 'testfile.txt', { dotfiles: 'allow' })).to.be.true;
    });

    it('should deny unauthorized access', async () => {
      const req = {
        params: { appname: 'testapp', file: 'testfile.txt', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(false);
      messageHelperStub.errUnauthorizedMessage.returns({ status: 'error', data: { message: 'Unauthorized' } });

      await fileSystemManager.downloadAppsFile(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.errUnauthorizedMessage.calledOnce).to.be.true;
    });

    it('should handle missing file parameter', async () => {
      const req = {
        params: { appname: 'testapp', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'file and component parameters are mandatory' } });

      await fileSystemManager.downloadAppsFile(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(messageHelperStub.createErrorMessage.calledOnce).to.be.true;
    });

    it('should handle application volume not found error', async () => {
      const req = {
        params: { appname: 'testapp', file: 'testfile.txt', component: 'testcomp' },
        query: {},
      };
      const res = {
        json: sinon.stub(),
        write: sinon.stub(),
        end: sinon.stub(),
      };

      verificationHelperStub.verifyPrivilege.resolves(true);
      volumeTargetStub.resolveVolumeTarget.rejects(new Error('Application volume not found'));
      messageHelperStub.createErrorMessage.returns({ status: 'error', data: { message: 'Application volume not found' } });

      await fileSystemManager.downloadAppsFile(req, res);

      expect(res.write.calledOnce).to.be.true;
      expect(logStub.error.called).to.be.true;
    });
  });

  // fileUpload had no coverage at all while it lived in IOUtils. It resolves a
  // volume and then writes into it, so it is the handler where landing on the
  // wrong replica matters most.
  describe('fileUpload', () => {
    let mkdirStub;

    beforeEach(() => {
      mkdirStub = sinon.stub(require('fs').promises, 'mkdir').resolves();
    });

    function uploadReq(params = {}, query = {}) {
      return { params: { appname: 'testapp', component: 'testcomp', ...params }, query };
    }

    function uploadRes() {
      return { write: sinon.stub(), end: sinon.stub(), connection: { destroy: sinon.stub() } };
    }

    it('uploads into the resolved volume, under the folder given', async () => {
      const res = uploadRes();
      verificationHelperStub.verifyPrivilege.resolves(true);
      serviceHelperStub.runCommand.resolves({});

      await fileSystemManager.fileUpload(uploadReq({ type: 'file', folder: 'sub' }), res);

      sinon.assert.calledOnce(volumeTargetStub.resolveVolumeTarget);
      sinon.assert.calledWith(mkdirStub, '/mnt/testapp/sub', { recursive: true });
      // argv, never a shell string built from request input
      sinon.assert.calledOnceWithExactly(serviceHelperStub.runCommand, 'chmod', {
        runAsRoot: true,
        params: ['777', '/mnt/testapp/sub'],
      });
      sinon.assert.calledOnce(formStub.parse);
    });

    it('puts a backup upload in the volume backup/upload directory', async () => {
      const res = uploadRes();
      verificationHelperStub.verifyPrivilege.resolves(true);
      serviceHelperStub.runCommand.resolves({});

      await fileSystemManager.fileUpload(uploadReq({ type: 'backup' }), res);

      sinon.assert.calledWith(mkdirStub, '/mnt/testapp/backup/upload', { recursive: true });
    });

    it('refuses an unauthorized upload before touching the volume', async () => {
      const res = uploadRes();
      verificationHelperStub.verifyPrivilege.resolves(false);

      await fileSystemManager.fileUpload(uploadReq({ type: 'file' }), res);

      expect(volumeTargetStub.resolveVolumeTarget.called).to.be.false;
      expect(mkdirStub.called).to.be.false;
      expect(res.connection.destroy.calledOnce).to.be.true;
    });

    it('does not upload when the volume cannot be resolved (co-located, no replica named)', async () => {
      const res = uploadRes();
      verificationHelperStub.verifyPrivilege.resolves(true);
      volumeTargetStub.resolveVolumeTarget.rejects(new Error('testapp is co-located on this node — specify which replica with ?replica='));

      await fileSystemManager.fileUpload(uploadReq({ type: 'file' }), res);

      expect(mkdirStub.called).to.be.false;
      expect(serviceHelperStub.runCommand.called).to.be.false;
      expect(logStub.error.called).to.be.true;
    });

    it('requires a type', async () => {
      const res = uploadRes();
      verificationHelperStub.verifyPrivilege.resolves(true);

      await fileSystemManager.fileUpload(uploadReq({}), res);

      expect(volumeTargetStub.resolveVolumeTarget.called).to.be.false;
      expect(logStub.error.called).to.be.true;
    });
  });
});
