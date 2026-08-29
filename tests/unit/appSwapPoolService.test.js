'use strict';

const chai = require('chai');
const sinon = require('sinon');
const fs = require('node:fs/promises');

const { expect } = chai;

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const hostStorageCapability = require('../../ZelBack/src/services/utils/hostStorageCapability');
const deploymentProvider = require('../../ZelBack/src/services/appRuntime/deploymentProvider');
const appSwapPoolService = require('../../ZelBack/src/services/appLifecycle/appSwapPoolService');
const { appsFolder } = require('../../ZelBack/src/services/utils/appConstants');
const {
  loadSpecLibrary, V9_SUBMISSION, V8_SUBMISSION, v8Spec, v9Spec,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. The pool is sized purely from what DeploymentComponent.swapGb answers,
// and that answer is version-dependent (v9 carries a declared field defaulting to
// 0; every legacy component version returns a fixed 2G) — a fact no hand-written
// double expresses. What stays stubbed here is I/O: the host-capability probe,
// the filesystem, and every root command.

describe('appSwapPoolService tests', () => {
  let flux;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  /**
   * A real DeploymentSpec for a v9 app whose components declare the given swap
   * sizes — the class deploymentProvider hands the pool service. Two components
   * may not share a hostPort, so each gets its own.
   */
  async function v9Deployment(appName, swapGbs) {
    let hostPort = 31000;
    const components = {};
    swapGbs.forEach((swapGb, i) => {
      hostPort += 1;
      const name = `c${i}`;
      components[name] = {
        ...V9_SUBMISSION.components.web,
        name,
        swapGb,
        ports: { http: { containerPort: 80, hostPort } },
      };
    });
    const spec = await v9Spec({ name: appName, components });
    return flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null });
  }

  /** A real DeploymentSpec for a legacy v8 app — swap is not a field it carries. */
  async function v8Deployment(appName, componentNames) {
    const [template] = V8_SUBMISSION.compose;
    let hostPort = 31100;
    const compose = componentNames.map((name) => {
      hostPort += 1;
      return { ...template, name, ports: [hostPort] };
    });
    const spec = await v8Spec({ name: appName, compose });
    return flux.DeploymentSpec.fromSpec(spec, appsFolder, { replica: null });
  }

  afterEach(() => {
    sinon.restore();
  });

  describe('computeNeed', () => {
    it('sums swapGb across all installed components and tracks the largest', async () => {
      const twoSmall = await v9Deployment('twosmall', [2, 2]);
      const oneBig = await v9Deployment('onebig', [8]);
      // A component that declares no swap at all: the v9 default is 0, so it must
      // add nothing. The old double could only ever state a number.
      const noSwap = await v9Deployment('noswap', [0]);
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([twoSmall, oneBig, noSwap]);

      const { totalGb, maxComponentGb } = await appSwapPoolService.computeNeed();

      expect(totalGb).to.equal(12);
      expect(maxComponentGb).to.equal(8);
      // Cross-checked against the library's own aggregate: the service's loop and
      // flux-spec's resourceTotals must agree on the same quantity, so a component
      // the service skipped (or double-counted) shows up here.
      const libraryTotal = [twoSmall, oneBig, noSwap]
        .reduce((sum, d) => sum + d.resourceTotals().swapGb, 0);
      expect(totalGb).to.equal(libraryTotal);
    });

    it('counts a legacy app at the fixed swap its component class reports', async () => {
      // Legacy specs have no swap field; every pre-v9 component version answers a
      // flat 2G, and the pool must be sized for it. Nothing in a stored v8 spec
      // says "2" — only the real class does.
      const legacy = await v8Deployment('legacy', ['web', 'db']);
      expect(legacy.componentEntries().map(([, c]) => c.swapGb)).to.deep.equal([2, 2]);
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([legacy]);

      const { totalGb, maxComponentGb } = await appSwapPoolService.computeNeed();

      expect(totalGb).to.equal(4);
      expect(maxComponentGb).to.equal(2);
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
      const big = await v9Deployment('bigswap', [8, 8]); // need 16
      sinon.stub(hostStorageCapability, 'supportsManagedStorage').resolves(true);
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([big]);
      sinon.stub(fs, 'readdir').resolves([]); // no existing chunks
      const runCommand = sinon.stub(serviceHelper, 'runCommand').callsFake(() => Promise.resolve({ error: null, stdout: '' }));

      await appSwapPoolService.doReconcile();

      const calls = runCommand.getCalls();
      const fallocate = calls.filter((c) => c.args[0] === 'fallocate');
      const mkswap = calls.filter((c) => c.args[0] === 'mkswap');
      const swapon = calls.filter((c) => c.args[0] === 'swapon' && !c.args[1].params.includes('--show=NAME'));
      // need 16G / 8G chunks -> 2 chunks created and activated
      expect(fallocate.length).to.equal(2);
      // The chunk is sized to the LARGEST single component's declared swap, read
      // off the real deployment rather than restated here.
      const largest = Math.max(...big.componentEntries().map(([, c]) => c.swapGb));
      expect(fallocate[0].args[1].params).to.include(`${largest}G`);
      expect(mkswap.length).to.equal(2);
      expect(swapon.length).to.equal(2);
    });

    it('does not grow when existing capacity already covers the need', async () => {
      const small = await v9Deployment('smallswap', [4]); // need 4
      sinon.stub(hostStorageCapability, 'supportsManagedStorage').resolves(true);
      sinon.stub(deploymentProvider, 'listInstalledDeployments').resolves([small]);
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
