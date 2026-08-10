'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('fluxStorageRefs tests', () => {
  let axiosGet;
  let fluxStorageRefs;

  beforeEach(() => {
    axiosGet = sinon.stub();
    fluxStorageRefs = proxyquire('../../ZelBack/src/services/utils/fluxStorageRefs', {
      '../serviceHelper': { axiosGet },
      '../fluxCommunicationMessagesSender': {
        getFluxMessageSignature: sinon.stub().resolves('sig'),
      },
      '../../lib/log': { error: sinon.stub(), info: sinon.stub() },
    });
  });

  afterEach(() => sinon.restore());

  describe('resolveStorageRefs', () => {
    it('inlines an F_S_ENV reference and reports a sensitive inline', async () => {
      axiosGet.resolves({ data: ['KEY=value', 'FOO=bar=baz'] });
      const components = { web: { env: { F_S_ENV: 'https://storage/env', EXISTING: 'keep' } } };

      const inlined = await fluxStorageRefs.resolveStorageRefs(components, 'myapp');

      expect(inlined).to.equal(true);
      expect(components.web.env).to.deep.equal({ EXISTING: 'keep', KEY: 'value', FOO: 'bar=baz' });
      expect(components.web.env.F_S_ENV).to.equal(undefined);
    });

    it('inlines an F_S_CMD reference in place, preserving other argv', async () => {
      axiosGet.resolves({ data: ['--token', 'abc'] });
      const components = { web: { cmd: ['run', 'F_S_CMD=https://storage/cmd', '--verbose'] } };

      const inlined = await fluxStorageRefs.resolveStorageRefs(components, 'myapp');

      expect(inlined).to.equal(true);
      expect(components.web.cmd).to.deep.equal(['run', '--token', 'abc', '--verbose']);
    });

    it('returns false and fetches nothing when there are no references', async () => {
      const components = { web: { env: { A: '1' }, cmd: ['serve'] } };

      const inlined = await fluxStorageRefs.resolveStorageRefs(components, 'myapp');

      expect(inlined).to.equal(false);
      expect(axiosGet.called).to.equal(false);
    });

    it('fails hard when the storage fetch fails', async () => {
      axiosGet.rejects(new Error('network down'));
      const components = { web: { env: { F_S_ENV: 'https://storage/env' } } };

      let threw;
      try {
        await fluxStorageRefs.resolveStorageRefs(components, 'myapp');
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an('error');
      expect(threw.message).to.include('failed to be obtained');
    });

    it('fails hard when the storage payload is not an array', async () => {
      axiosGet.resolves({ data: { not: 'an array' } });
      const components = { web: { env: { F_S_ENV: 'https://storage/env' } } };

      let threw;
      try {
        await fluxStorageRefs.resolveStorageRefs(components, 'myapp');
      } catch (e) {
        threw = e;
      }
      expect(threw).to.be.an('error');
      expect(threw.message).to.include('invalid');
    });
  });
});
