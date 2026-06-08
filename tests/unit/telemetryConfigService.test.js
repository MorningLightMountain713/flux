const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('telemetryConfigService tests', () => {
  let service;
  let fsStub;
  let serviceHelperStub;
  let generalServiceStub;
  let logStub;

  beforeEach(() => {
    fsStub = {
      promises: {
        access: sinon.stub().resolves(),
        writeFile: sinon.stub().resolves(),
        rename: sinon.stub().resolves(),
        unlink: sinon.stub().resolves(),
      },
      constants: { W_OK: 2 },
    };

    serviceHelperStub = {
      runCommand: sinon.stub().resolves({ error: null, stdout: 'inactive\n', stderr: '' }),
    };

    generalServiceStub = {
      obtainNodeCollateralInformation: sinon.stub().resolves({
        txhash: 'abc123def456789012345678901234567890123456789012345678901234abcd',
        txindex: 0,
      }),
    };

    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    service = proxyquire('../../ZelBack/src/services/telemetryConfigService', {
      'node:fs': fsStub,
      '../lib/log': logStub,
      './serviceHelper': serviceHelperStub,
      './generalService': generalServiceStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  // --- deriveOpaqueId ----------------------------------------------------

  describe('deriveOpaqueId', () => {
    it('should return a 64-char hex string', async () => {
      const id = await service.deriveOpaqueId();
      expect(id).to.be.a('string');
      expect(id).to.match(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic for the same txhash', async () => {
      const id1 = await service.deriveOpaqueId();
      const id2 = await service.deriveOpaqueId();
      expect(id1).to.equal(id2);
    });

    it('should differ for different txhashes', async () => {
      const id1 = await service.deriveOpaqueId();

      generalServiceStub.obtainNodeCollateralInformation.resolves({
        txhash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        txindex: 0,
      });
      const id2 = await service.deriveOpaqueId();

      expect(id1).to.not.equal(id2);
    });

    it('should throw when collateral info unavailable', async () => {
      generalServiceStub.obtainNodeCollateralInformation.resolves(null);
      try {
        await service.deriveOpaqueId();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('collateral tx hash unavailable');
      }
    });
  });

  // --- buildToml ---------------------------------------------------------

  describe('buildToml', () => {
    it('produces TOML with only the node section', () => {
      const toml = service.buildToml('opaque123');

      expect(toml).to.include('[node]');
      expect(toml).to.include('opaqueId = "opaque123"');
      // Per-app sinks travel on the identity socket, not in config.toml.
      expect(toml).to.not.include('[telemetry]');
      expect(toml).to.not.include('apiKey');
    });
  });

  // --- ensureNode --------------------------------------------------------

  describe('ensureNode', () => {
    it('writes config and starts the daemon when not running', async () => {
      serviceHelperStub.runCommand.resolves({ error: null, stdout: 'inactive\n', stderr: '' });

      await service.ensureNode();

      expect(fsStub.promises.writeFile.calledOnce).to.be.true;
      expect(fsStub.promises.rename.calledOnce).to.be.true;

      const actions = serviceHelperStub.runCommand.getCalls().map((c) => c.args[1].params.join(' '));
      expect(actions).to.include(`is-active ${service.SERVICE_NAME}`);
      expect(actions).to.include(`start ${service.SERVICE_NAME}`);

      // The config is group-owned to flux-telemetry so the daemon can read it.
      const chgrpCalls = serviceHelperStub.runCommand.getCalls().filter((c) => c.args[0] === 'chgrp');
      expect(chgrpCalls.some((c) => c.args[1].params.includes(service.CONFIG_PATH))).to.be.true;
      expect(chgrpCalls.every((c) => c.args[1].params[0] === 'flux-telemetry')).to.be.true;
    });

    it('does not restart when the daemon is already running', async () => {
      serviceHelperStub.runCommand.callsFake((cmd, opts) => {
        if (opts.params[0] === 'is-active') {
          return Promise.resolve({ error: null, stdout: 'active\n', stderr: '' });
        }
        return Promise.resolve({ error: null, stdout: '', stderr: '' });
      });

      await service.ensureNode();

      const actions = serviceHelperStub.runCommand.getCalls().map((c) => c.args[1].params.join(' '));
      expect(actions).to.not.include(`start ${service.SERVICE_NAME}`);
      expect(actions).to.not.include(`restart ${service.SERVICE_NAME}`);
    });

    it('is a no-op when the runtime dir is not available (non-Arcane)', async () => {
      fsStub.promises.access.rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await service.ensureNode();

      expect(fsStub.promises.writeFile.called).to.be.false;
      expect(serviceHelperStub.runCommand.called).to.be.false;
    });

    it('cleans up the temp file on write failure', async () => {
      fsStub.promises.writeFile.rejects(new Error('disk full'));
      try {
        await service.ensureNode();
        expect.fail('should have thrown');
      } catch {
        expect(fsStub.promises.unlink.called).to.be.true;
      }
    });
  });

  // --- remove ------------------------------------------------------------

  describe('remove', () => {
    it('should stop daemon and remove config file', async () => {
      await service.remove();

      const calls = serviceHelperStub.runCommand.getCalls();
      const actions = calls.map((c) => c.args[1].params.join(' '));
      expect(actions).to.include(`stop ${service.SERVICE_NAME}`);
      expect(fsStub.promises.unlink.calledOnce).to.be.true;
    });

    it('should not throw if config file already gone', async () => {
      fsStub.promises.unlink.rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      await service.remove(); // should not throw
    });
  });
});
