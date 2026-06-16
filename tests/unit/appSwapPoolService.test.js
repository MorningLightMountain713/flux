const chai = require('chai');
const sinon = require('sinon');
const fs = require('node:fs/promises');

const { expect } = chai;

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const hostStorageCapability = require('../../ZelBack/src/services/utils/hostStorageCapability');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const appSwapPoolService = require('../../ZelBack/src/services/appLifecycle/appSwapPoolService');

function deployment(...swaps) {
  return { componentEntries: () => swaps.map((swapGb, i) => [`c${i}`, { swapGb }]) };
}

describe('appSwapPoolService tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('computeNeed', () => {
    it('sums swapGb across all installed components and tracks the largest', async () => {
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([deployment(2, 2), deployment(8)]);

      const { totalGb, maxComponentGb } = await appSwapPoolService.computeNeed();

      expect(totalGb).to.equal(12);
      expect(maxComponentGb).to.equal(8);
    });
  });

  describe('doReconcile', () => {
    it('does nothing on a node without the new-mechanism host config', async () => {
      sinon.stub(hostStorageCapability, 'supportsManagedStorage').resolves(false);
      const runCommand = sinon.stub(serviceHelper, 'runCommand');

      await appSwapPoolService.doReconcile();

      expect(runCommand.called).to.equal(false);
    });

    it('grows the pool with fixed-size chunks and swaps them on to cover the need', async () => {
      sinon.stub(hostStorageCapability, 'supportsManagedStorage').resolves(true);
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([deployment(8, 8)]); // need 16
      sinon.stub(fs, 'readdir').resolves([]); // no existing chunks
      const runCommand = sinon.stub(serviceHelper, 'runCommand').callsFake(() => Promise.resolve({ error: null, stdout: '' }));

      await appSwapPoolService.doReconcile();

      const calls = runCommand.getCalls();
      const fallocate = calls.filter((c) => c.args[0] === 'fallocate');
      const mkswap = calls.filter((c) => c.args[0] === 'mkswap');
      const swapon = calls.filter((c) => c.args[0] === 'swapon' && !c.args[1].params.includes('--show=NAME'));
      // need 16G / 8G chunks -> 2 chunks created and activated
      expect(fallocate.length).to.equal(2);
      expect(fallocate[0].args[1].params).to.include('8G');
      expect(mkswap.length).to.equal(2);
      expect(swapon.length).to.equal(2);
    });

    it('does not grow when existing capacity already covers the need', async () => {
      sinon.stub(hostStorageCapability, 'supportsManagedStorage').resolves(true);
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([deployment(4)]); // need 4
      sinon.stub(fs, 'readdir').resolves(['chunk-0000.swap']);
      sinon.stub(fs, 'stat').resolves({ size: 8 * 1024 * 1024 * 1024 }); // 8G existing
      // existing chunk already active -> no swapon, no shrink (8G - 8G < 4G)
      const runCommand = sinon.stub(serviceHelper, 'runCommand').callsFake((cmd, opts) => {
        if (cmd === 'swapon' && opts.params.includes('--show=NAME')) {
          return Promise.resolve({ error: null, stdout: '/dat/app-swap/chunk-0000.swap' });
        }
        return Promise.resolve({ error: null, stdout: '' });
      });

      await appSwapPoolService.doReconcile();

      const fallocate = runCommand.getCalls().filter((c) => c.args[0] === 'fallocate');
      const swapoff = runCommand.getCalls().filter((c) => c.args[0] === 'swapoff');
      expect(fallocate.length).to.equal(0);
      expect(swapoff.length).to.equal(0);
    });
  });
});
