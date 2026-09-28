'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const log = require('../../ZelBack/src/lib/log');
const capabilities = require('../../ZelBack/src/services/utils/capabilities');

const generateResponse = () => {
  const res = { test: 'testing' };
  res.status = sinon.stub().returns(res);
  res.json = sinon.fake((param) => `Response: ${param}`);
  return res;
};

describe('daemonStatus tests', () => {
  describe('isInsightExplorer tests', () => {
    let serviceUtilsStub;

    beforeEach(() => {
      daemonStatus.setIsDaemonInsightExplorer(null);
      serviceUtilsStub = sinon.stub(daemonServiceUtils, 'getConfigValue');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return the isDaemonInsightExplorer value if it is already set', () => {
      daemonStatus.setIsDaemonInsightExplorer(1);

      const result = daemonStatus.isInsightExplorer();

      expect(result).to.eql(1);
      sinon.assert.notCalled(serviceUtilsStub);
    });

    it('should return config value and set isDaemonInsightExplorer to true if getConfigValue returns 1', () => {
      serviceUtilsStub.returns(1);

      const result = daemonStatus.isInsightExplorer();

      expect(result).to.eql(true);
      expect(daemonStatus.getIsDaemonInsightExplorer()).to.eql(true);
      sinon.assert.calledOnceWithExactly(serviceUtilsStub, 'insightexplorer');
    });

    it('should return config value and set isDaemonInsightExplorer to true if getConfigValue returns \'1\'', () => {
      serviceUtilsStub.returns('1');

      const result = daemonStatus.isInsightExplorer();

      expect(result).to.eql(true);
      expect(daemonStatus.getIsDaemonInsightExplorer()).to.eql(true);
      sinon.assert.calledOnceWithExactly(serviceUtilsStub, 'insightexplorer');
    });

    it('should return config value and set isDaemonInsightExplorer to false if getConfigValue returns anything but 1', () => {
      serviceUtilsStub.returns(2);

      const result = daemonStatus.isInsightExplorer();

      expect(result).to.eql(false);
      expect(daemonStatus.getIsDaemonInsightExplorer()).to.eql(false);
      sinon.assert.calledOnceWithExactly(serviceUtilsStub, 'insightexplorer');
    });
  });

  describe('isDaemonSynced tests', () => {
    beforeEach(() => {
      daemonStatus.setCurrentDaemonHeight(0);
      daemonStatus.setLastChainUpdateAgeMs(0);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return isDaemonSynced message if current height is less than header height, no response passed', () => {
      daemonStatus.setCurrentDaemonHeight(0);
      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setLastChainUpdateAgeMs(0);
      const expectedResponse = {
        status: 'success',
        data: { header: 249_187, height: 0, synced: false },
      };

      const result = daemonStatus.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });

    it('should return isDaemonSynced message if current height is more than header height, no response passed', () => {
      daemonStatus.setCurrentDaemonHeight(259_187);
      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setLastChainUpdateAgeMs(0);
      const expectedResponse = {
        status: 'success',
        data: { header: 249_187, height: 259_187, synced: true },
      };

      const result = daemonStatus.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });

    it('should return isDaemonSynced message if current height is more than header height, response passed', () => {
      daemonStatus.setCurrentDaemonHeight(249_192);
      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setLastChainUpdateAgeMs(0);
      const expectedResponse = {
        status: 'success',
        data: { header: 249_187, height: 249_192, synced: true },
      };
      const res = generateResponse();

      const result = daemonStatus.isDaemonSynced(undefined, res);

      expect(result).to.eql(`Response: ${expectedResponse}`);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
    });

    it('should return unsynced when the chain has never been updated', () => {
      daemonStatus.setCurrentDaemonHeight(249_192);
      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setLastChainUpdateAgeMs(null);
      const expectedResponse = {
        status: 'success',
        data: { header: 249_187, height: 249_192, synced: false },
      };

      const result = daemonStatus.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });

    it('should return unsynced when the last chain update is older than 300 seconds', () => {
      daemonStatus.setCurrentDaemonHeight(249_192);
      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setLastChainUpdateAgeMs(301 * 1000);
      const expectedResponse = {
        status: 'success',
        data: { header: 249_187, height: 249_192, synced: false },
      };

      const result = daemonStatus.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });

    it('should return synced when the chain updated recently and height is close to header', () => {
      daemonStatus.setCurrentDaemonHeight(249_192);
      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setLastChainUpdateAgeMs(299 * 1000);
      const expectedResponse = {
        status: 'success',
        data: { header: 249_187, height: 249_192, synced: true },
      };

      const result = daemonStatus.isDaemonSynced();

      expect(result).to.eql(expectedResponse);
    });
  });

  describe('fluxDaemonBlockchainInfo tests', () => {
    let daemonServiceBlockchainRpcsStub;
    let logInfoSpy;

    beforeEach(() => {
      daemonServiceBlockchainRpcsStub = sinon.stub(daemonServiceUtils, 'executeCall');
      logInfoSpy = sinon.spy(log, 'info');
      capabilities.resetForTests();

      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setCurrentDaemonHeight(0);
    });

    afterEach(() => {
      sinon.restore();
      capabilities.resetForTests();
    });

    it('should set new current header and height', async () => {
      daemonServiceBlockchainRpcsStub.resolves({
        status: 'success',
        data: {
          blocks: 123_456,
          headers: 555_555,
          message: 'testmessage',
        },
      });

      daemonStatus.setLastChainUpdateAgeMs(60_000);

      await daemonStatus.fluxDaemonBlockchainInfo();

      expect(daemonStatus.getCurrentDaemonHeader()).to.eql(555_555);
      expect(daemonStatus.getCurrentDaemonHeight()).to.eql(123_456);
      expect(daemonStatus.getElapsedSinceChainUpdateMs()).to.be.below(1000);

      sinon.assert.calledWithExactly(logInfoSpy, `Daemon Sync status: ${123_456}/${555_555}`);
    });

    it('should follow the header down, because a reorg genuinely shortens the chain', async () => {
      daemonServiceBlockchainRpcsStub.resolves({
        status: 'success',
        data: {
          blocks: 123_456,
          headers: 1234,
          message: 'testmessage',
        },
      });

      await daemonStatus.fluxDaemonBlockchainInfo();

      expect(daemonStatus.getCurrentDaemonHeader()).to.eql(1234);
      expect(daemonStatus.getCurrentDaemonHeight()).to.eql(123_456);
      sinon.assert.calledWithExactly(logInfoSpy, `Daemon Sync status: ${123_456}/${1234}`);
    });

    it('raises daemonSynced on a reading within five blocks of the header, and lowers it on one behind', async () => {
      capabilities.setForTests('daemonReachable', true);
      daemonServiceBlockchainRpcsStub.resolves({ status: 'success', data: { blocks: 1000, headers: 1002 } });
      await daemonStatus.fluxDaemonBlockchainInfo();
      expect(capabilities.isUp('daemonSynced')).to.equal(true);

      daemonServiceBlockchainRpcsStub.resolves({ status: 'success', data: { blocks: 1000, headers: 1100 } });
      await daemonStatus.fluxDaemonBlockchainInfo();
      expect(capabilities.isUp('daemonSynced')).to.equal(false);
    });

    it('raises daemonSynced from a pushed tip at the header', () => {
      capabilities.setForTests('daemonReachable', true);
      daemonStatus.setCurrentDaemonHeader(2000);
      daemonStatus.recordChainTip(2000);
      expect(capabilities.isUp('daemonSynced')).to.equal(true);
    });

    it('should not refresh the chain update time when the RPC call fails', async () => {
      daemonStatus.setLastChainUpdateAgeMs(60_000);

      daemonServiceBlockchainRpcsStub.resolves({
        status: 'error',
        data: {
          message: 'Connection failed',
        },
      });

      await daemonStatus.fluxDaemonBlockchainInfo();

      expect(daemonStatus.getElapsedSinceChainUpdateMs()).to.be.at.least(60_000);
    });

    it('should not refresh the chain update time when the RPC call throws', async () => {
      daemonStatus.setLastChainUpdateAgeMs(60_000);

      daemonServiceBlockchainRpcsStub.rejects(new Error('Network error'));

      await daemonStatus.fluxDaemonBlockchainInfo();

      expect(daemonStatus.getElapsedSinceChainUpdateMs()).to.be.at.least(60_000);
    });
  });

  describe('recordChainTip tests', () => {
    beforeEach(() => {
      daemonStatus.setCurrentDaemonHeight(0);
      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setLastChainUpdateAgeMs(null);
    });

    it('should set the height and refresh the chain update time', () => {
      daemonStatus.recordChainTip(300_000);

      expect(daemonStatus.getCurrentDaemonHeight()).to.eql(300_000);
      expect(daemonStatus.getElapsedSinceChainUpdateMs()).to.be.below(1000);
    });

    it('should carry the header up with the tip so a pushed height reads as synced', () => {
      daemonStatus.recordChainTip(300_000);

      expect(daemonStatus.getCurrentDaemonHeader()).to.eql(300_000);
      expect(daemonStatus.isDaemonSynced().data.synced).to.eql(true);
    });

    it('should let the tip move down on a reorg without lowering the header', () => {
      daemonStatus.recordChainTip(300_000);
      daemonStatus.recordChainTip(299_998);

      expect(daemonStatus.getCurrentDaemonHeight()).to.eql(299_998);
      expect(daemonStatus.getCurrentDaemonHeader()).to.eql(300_000);
    });

    it('should ignore a non integer height rather than corrupt the tip', () => {
      daemonStatus.recordChainTip(300_000);
      daemonStatus.recordChainTip(undefined);

      expect(daemonStatus.getCurrentDaemonHeight()).to.eql(300_000);
    });
  });

  describe('isDaemonSynced staleness tests', () => {
    it('should not be aged out by a wall clock jump', () => {
      daemonStatus.setCurrentDaemonHeight(249_192);
      daemonStatus.setCurrentDaemonHeader(249_187);
      daemonStatus.setLastChainUpdateAgeMs(0);

      const clock = sinon.useFakeTimers({ now: Date.now() + 3_600_000, toFake: ['Date'] });
      try {
        expect(daemonStatus.isDaemonSynced().data.synced).to.eql(true);
      } finally {
        clock.restore();
      }
    });
  });
});
