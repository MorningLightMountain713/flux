const sinon = require('sinon');
const { expect } = require('chai');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const log = require('../../ZelBack/src/lib/log');

const generateResponse = () => {
  const res = { test: 'testing' };
  res.status = sinon.stub().returns(res);
  res.json = sinon.fake((param) => `Response: ${param}`);
  return res;
};

describe('daemonServiceMiscRpcs tests', () => {
  describe('isInsightExplorer tests', () => {
    let serviceUtilsStub;

    beforeEach(() => {
      daemonServiceMiscRpcs.setIsDaemonInsightExplorer(null);
      serviceUtilsStub = sinon.stub(daemonServiceUtils, 'getConfigValue');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return the isDaemonInsightExplorer value if it is already set', () => {
      daemonServiceMiscRpcs.setIsDaemonInsightExplorer(1);

      const result = daemonServiceMiscRpcs.isInsightExplorer();

      expect(result).to.eql(1);
      sinon.assert.notCalled(serviceUtilsStub);
    });

    it('should return config value and set isDaemonInsightExplorer to true if getConfigValue returns 1', () => {
      serviceUtilsStub.returns(1);

      const result = daemonServiceMiscRpcs.isInsightExplorer();

      expect(result).to.eql(true);
      expect(daemonServiceMiscRpcs.getIsDaemonInsightExplorer()).to.eql(true);
      sinon.assert.calledOnceWithExactly(serviceUtilsStub, 'insightexplorer');
    });

    it('should return config value and set isDaemonInsightExplorer to true if getConfigValue returns \'1\'', () => {
      serviceUtilsStub.returns('1');

      const result = daemonServiceMiscRpcs.isInsightExplorer();

      expect(result).to.eql(true);
      expect(daemonServiceMiscRpcs.getIsDaemonInsightExplorer()).to.eql(true);
      sinon.assert.calledOnceWithExactly(serviceUtilsStub, 'insightexplorer');
    });

    it('should return config value and set isDaemonInsightExplorer to false if getConfigValue returns anything but 1', () => {
      serviceUtilsStub.returns(2);

      const result = daemonServiceMiscRpcs.isInsightExplorer();

      expect(result).to.eql(false);
      expect(daemonServiceMiscRpcs.getIsDaemonInsightExplorer()).to.eql(false);
      sinon.assert.calledOnceWithExactly(serviceUtilsStub, 'insightexplorer');
    });
  });

  describe('isDaemonSynced tests', () => {
    beforeEach(() => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(0);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(0);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return isDaemonSynced message if current height is less than header height, no response passed', () => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(0);
      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(0);
      const expectedResponse = {
        status: 'success',
        data: { header: 249187, height: 0, synced: false },
      };

      const result = daemonServiceMiscRpcs.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });

    it('should return isDaemonSynced message if current height is more than header height, no response passed', () => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(259187);
      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(0);
      const expectedResponse = {
        status: 'success',
        data: { header: 249187, height: 259187, synced: true },
      };

      const result = daemonServiceMiscRpcs.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });

    it('should return isDaemonSynced message if current height is more than header height, response passed', () => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(249192);
      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(0);
      const expectedResponse = {
        status: 'success',
        data: { header: 249187, height: 249192, synced: true },
      };
      const res = generateResponse();

      const result = daemonServiceMiscRpcs.isDaemonSynced(undefined, res);

      expect(result).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return unsynced when the chain has never been updated', () => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(249192);
      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(null);
      const expectedResponse = {
        status: 'success',
        data: { header: 249187, height: 249192, synced: false },
      };

      const result = daemonServiceMiscRpcs.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });

    it('should return unsynced when the last chain update is older than 300 seconds', () => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(249192);
      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(301 * 1000);
      const expectedResponse = {
        status: 'success',
        data: { header: 249187, height: 249192, synced: false },
      };

      const result = daemonServiceMiscRpcs.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });

    it('should return synced when the chain updated recently and height is close to header', () => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(249192);
      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(299 * 1000);
      const expectedResponse = {
        status: 'success',
        data: { header: 249187, height: 249192, synced: true },
      };

      const result = daemonServiceMiscRpcs.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });
  });

  describe('fluxDaemonBlockchainInfo tests', () => {
    let daemonServiceBlockchainRpcsStub;
    let logInfoSpy;

    beforeEach(() => {
      daemonServiceBlockchainRpcsStub = sinon.stub(daemonServiceUtils, 'executeCall');
      logInfoSpy = sinon.spy(log, 'info');

      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setCurrentDaemonHeight(0);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should set new current header and height', async () => {
      daemonServiceBlockchainRpcsStub.resolves({
        status: 'success',
        data: {
          blocks: 123456,
          headers: 555555,
          message: 'testmessage',
        },
      });

      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(60000);

      await daemonServiceMiscRpcs.fluxDaemonBlockchainInfo();

      expect(daemonServiceMiscRpcs.getCurrentDaemonHeader()).to.eql(555555);
      expect(daemonServiceMiscRpcs.getCurrentDaemonHeight()).to.eql(123456);
      expect(daemonServiceMiscRpcs.getElapsedSinceChainUpdateMs()).to.be.below(1000);

      sinon.assert.calledOnceWithExactly(logInfoSpy, `Daemon Sync status: ${123456}/${555555}`);
    });

    it('should follow the header down, because a reorg genuinely shortens the chain', async () => {
      daemonServiceBlockchainRpcsStub.resolves({
        status: 'success',
        data: {
          blocks: 123456,
          headers: 1234,
          message: 'testmessage',
        },
      });

      await daemonServiceMiscRpcs.fluxDaemonBlockchainInfo();

      expect(daemonServiceMiscRpcs.getCurrentDaemonHeader()).to.eql(1234);
      expect(daemonServiceMiscRpcs.getCurrentDaemonHeight()).to.eql(123456);
      sinon.assert.calledOnceWithExactly(logInfoSpy, `Daemon Sync status: ${123456}/${1234}`);
    });

    it('should not refresh the chain update time when the RPC call fails', async () => {
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(60000);

      daemonServiceBlockchainRpcsStub.resolves({
        status: 'error',
        data: {
          message: 'Connection failed',
        },
      });

      await daemonServiceMiscRpcs.fluxDaemonBlockchainInfo();

      expect(daemonServiceMiscRpcs.getElapsedSinceChainUpdateMs()).to.be.at.least(60000);
    });

    it('should not refresh the chain update time when the RPC call throws', async () => {
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(60000);

      daemonServiceBlockchainRpcsStub.rejects(new Error('Network error'));

      await daemonServiceMiscRpcs.fluxDaemonBlockchainInfo();

      expect(daemonServiceMiscRpcs.getElapsedSinceChainUpdateMs()).to.be.at.least(60000);
    });
  });

  describe('recordChainTip tests', () => {
    beforeEach(() => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(0);
      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(null);
    });

    it('should set the height and refresh the chain update time', () => {
      daemonServiceMiscRpcs.recordChainTip(300000);

      expect(daemonServiceMiscRpcs.getCurrentDaemonHeight()).to.eql(300000);
      expect(daemonServiceMiscRpcs.getElapsedSinceChainUpdateMs()).to.be.below(1000);
    });

    it('should carry the header up with the tip so a pushed height reads as synced', () => {
      daemonServiceMiscRpcs.recordChainTip(300000);

      expect(daemonServiceMiscRpcs.getCurrentDaemonHeader()).to.eql(300000);
      expect(daemonServiceMiscRpcs.isDaemonSynced().data.synced).to.eql(true);
    });

    it('should let the tip move down on a reorg without lowering the header', () => {
      daemonServiceMiscRpcs.recordChainTip(300000);
      daemonServiceMiscRpcs.recordChainTip(299998);

      expect(daemonServiceMiscRpcs.getCurrentDaemonHeight()).to.eql(299998);
      expect(daemonServiceMiscRpcs.getCurrentDaemonHeader()).to.eql(300000);
    });

    it('should ignore a non integer height rather than corrupt the tip', () => {
      daemonServiceMiscRpcs.recordChainTip(300000);
      daemonServiceMiscRpcs.recordChainTip(undefined);

      expect(daemonServiceMiscRpcs.getCurrentDaemonHeight()).to.eql(300000);
    });
  });

  describe('isDaemonSynced staleness tests', () => {
    it('should not be aged out by a wall clock jump', () => {
      daemonServiceMiscRpcs.setCurrentDaemonHeight(249192);
      daemonServiceMiscRpcs.setCurrentDaemonHeader(249187);
      daemonServiceMiscRpcs.setLastChainUpdateAgeMs(0);

      const clock = sinon.useFakeTimers({ now: Date.now() + 3600000, toFake: ['Date'] });
      try {
        expect(daemonServiceMiscRpcs.isDaemonSynced().data.synced).to.eql(true);
      } finally {
        clock.restore();
      }
    });
  });
});
