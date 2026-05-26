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
    it('should produce valid TOML with node and telemetry sections', () => {
      const toml = service.buildToml('opaque123', {
        provider: 'datadog',
        site: 'datadoghq.com',
        apiKey: 'dd-key-here',
      });

      expect(toml).to.include('[node]');
      expect(toml).to.include('opaqueId = "opaque123"');
      expect(toml).to.include('[telemetry]');
      expect(toml).to.include('provider = "datadog"');
      expect(toml).to.include('site = "datadoghq.com"');
      expect(toml).to.include('apiKey = "dd-key-here"');
    });

    it('should omit null/undefined values', () => {
      const toml = service.buildToml('id', {
        provider: 'datadog',
        site: null,
        apiKey: 'key',
      });

      expect(toml).to.include('provider = "datadog"');
      expect(toml).to.include('apiKey = "key"');
      expect(toml).to.not.include('site');
    });
  });

  // --- apply -------------------------------------------------------------

  describe('apply', () => {
    it('should write config and start the daemon when not running', async () => {
      // is-active returns 'inactive'
      serviceHelperStub.runCommand.resolves({ error: null, stdout: 'inactive\n', stderr: '' });

      await service.apply({ provider: 'datadog', site: 'datadoghq.com', apiKey: 'key' });

      // Should have written a temp file and renamed it
      expect(fsStub.promises.writeFile.calledOnce).to.be.true;
      expect(fsStub.promises.rename.calledOnce).to.be.true;

      // Should have called systemctl is-active, then start
      const calls = serviceHelperStub.runCommand.getCalls();
      const actions = calls.map((c) => c.args[1].params.join(' '));
      expect(actions).to.include(`is-active ${service.SERVICE_NAME}`);
      expect(actions).to.include(`start ${service.SERVICE_NAME}`);
    });

    it('should restart the daemon when already running', async () => {
      serviceHelperStub.runCommand.callsFake((cmd, opts) => {
        if (opts.params[0] === 'is-active') {
          return Promise.resolve({ error: null, stdout: 'active\n', stderr: '' });
        }
        return Promise.resolve({ error: null, stdout: '', stderr: '' });
      });

      await service.apply({ provider: 'datadog', site: 'datadoghq.com', apiKey: 'key' });

      const calls = serviceHelperStub.runCommand.getCalls();
      const actions = calls.map((c) => c.args[1].params.join(' '));
      expect(actions).to.include(`restart ${service.SERVICE_NAME}`);
      expect(actions).to.not.include(`start ${service.SERVICE_NAME}`);
    });

    it('should reject when no provider given', async () => {
      try {
        await service.apply({});
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('provider');
      }
    });

    it('should reject when runtime dir not available', async () => {
      fsStub.promises.access.rejects(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      try {
        await service.apply({ provider: 'datadog', apiKey: 'key' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('not available');
      }
    });

    it('should clean up temp file on write failure', async () => {
      fsStub.promises.writeFile.rejects(new Error('disk full'));
      try {
        await service.apply({ provider: 'datadog', apiKey: 'key' });
        expect.fail('should have thrown');
      } catch {
        // unlink should have been called to clean up
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
