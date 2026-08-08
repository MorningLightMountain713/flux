// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const appUtilities = require('../../ZelBack/src/services/utils/appUtilities');
const dockerService = require('../../ZelBack/src/services/dockerService');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const log = require('../../ZelBack/src/lib/log');

describe('appUtilities tests', () => {
  afterEach(() => {
    sinon.restore();
  });
  // which require proper system access. These should be tested in integration tests.

  describe('getContainerStorage tests', () => {
    it('should handle containers with no mounts', async () => {
      sinon.stub(dockerService, 'dockerContainerInspect').resolves({
        SizeRootFs: 1000000,
        Mounts: [],
      });

      const result = await appUtilities.getContainerStorage('testapp');

      expect(result.bind).to.equal(0);
      expect(result.volume).to.equal(0);
      expect(result.rootfs).to.equal(1000000);
      expect(result.used).to.equal(1000000);
      expect(result.status).to.equal('success');
    });

    it('should return error status on failure', async () => {
      sinon.stub(dockerService, 'dockerContainerInspect').rejects(new Error('Container not found'));
      sinon.stub(log, 'error');

      const result = await appUtilities.getContainerStorage('missingapp');

      expect(result.status).to.equal('error');
      expect(result.message).to.include('Container not found');
      expect(result.used).to.equal(0);
    });

    // The mount size cache is keyed by source path and survives across tests,
    // so each test below uses paths of its own.
    it('should sum bind and volume mount sizes measured by du', async () => {
      sinon.stub(dockerService, 'dockerContainerInspect').resolves({
        SizeRootFs: 500,
        Mounts: [
          { Type: 'bind', Source: '/appdata/sumtest/bind' },
          { Type: 'volume', Source: '/appdata/sumtest/volume' },
        ],
      });
      const runCommandStub = sinon.stub(serviceHelper, 'runCommand');
      runCommandStub.withArgs('du', sinon.match({ params: ['-sb', '/appdata/sumtest/bind'] }))
        .resolves({ error: null, stdout: '1000\t/appdata/sumtest/bind' });
      runCommandStub.withArgs('du', sinon.match({ params: ['-sb', '/appdata/sumtest/volume'] }))
        .resolves({ error: null, stdout: '2000\t/appdata/sumtest/volume' });

      const result = await appUtilities.getContainerStorage('testapp');

      expect(result.bind).to.equal(1000);
      expect(result.volume).to.equal(2000);
      expect(result.rootfs).to.equal(500);
      expect(result.used).to.equal(3500);
      expect(result.status).to.equal('success');
    });

    it('should serve a fresh measurement from the cache instead of running du again', async () => {
      sinon.stub(dockerService, 'dockerContainerInspect').resolves({
        SizeRootFs: 0,
        Mounts: [{ Type: 'bind', Source: '/appdata/cachetest/bind' }],
      });
      const runCommandStub = sinon.stub(serviceHelper, 'runCommand')
        .resolves({ error: null, stdout: '4096\t/appdata/cachetest/bind' });

      const first = await appUtilities.getContainerStorage('testapp');
      const second = await appUtilities.getContainerStorage('testapp');

      expect(first.bind).to.equal(4096);
      expect(second.bind).to.equal(4096);
      sinon.assert.calledOnce(runCommandStub);
    });

    it('should count a failed measurement as zero and not cache it', async () => {
      sinon.stub(dockerService, 'dockerContainerInspect').resolves({
        SizeRootFs: 100,
        Mounts: [{ Type: 'bind', Source: '/appdata/failtest/bind' }],
      });
      sinon.stub(log, 'warn');
      const runCommandStub = sinon.stub(serviceHelper, 'runCommand');
      runCommandStub.onFirstCall().resolves({ error: new Error('du failed'), stdout: '' });
      runCommandStub.onSecondCall().resolves({ error: null, stdout: '512\t/appdata/failtest/bind' });

      const first = await appUtilities.getContainerStorage('testapp');
      const second = await appUtilities.getContainerStorage('testapp');

      expect(first.bind).to.equal(0);
      expect(first.status).to.equal('success');
      expect(second.bind).to.equal(512);
      sinon.assert.calledTwice(runCommandStub);
    });
  });

  describe('module exports tests', () => {
    it('should export all required functions', () => {
      expect(appUtilities.appPricePerMonth).to.be.a('function');
      expect(appUtilities.getContainerStorage).to.be.a('function');
      expect(appUtilities.findCommonArchitectures).to.be.a('function');
    });
  });
});
