// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const appUtilities = require('../../ZelBack/src/services/utils/appUtilities');
const geolocationService = require('../../ZelBack/src/services/geolocationService');
const dockerService = require('../../ZelBack/src/services/dockerService');
const log = require('../../ZelBack/src/lib/log');

describe('appUtilities tests', () => {
  afterEach(() => {
    sinon.restore();
  });


  // getAppFolderSize tests removed - they execute actual sudo commands
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

    // Tests that require sudo access removed - should be in integration tests
  });

  describe('module exports tests', () => {
    it('should export all required functions', () => {
      expect(appUtilities.appPricePerMonth).to.be.a('function');
      expect(appUtilities.getAppFolderSize).to.be.a('function');
      expect(appUtilities.getContainerStorage).to.be.a('function');
      expect(appUtilities.findCommonArchitectures).to.be.a('function');
    });
  });
});
