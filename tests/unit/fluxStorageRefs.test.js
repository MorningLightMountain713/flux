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

  // A STORAGE LINK IS NOT AN ADDRESS THE SPECIFICATION AUTHOR CHOOSES. The node signs
  // the request, so a link it would follow anywhere is a request it signs for anyone.
  describe('obtainPayloadFromStorage', () => {
    [
      ['plain http', 'http://storage.runonflux.io/v1/env/abc'],
      ['another host', 'https://attacker.example/v1/env/abc'],
      ['a host that merely ends in the name', 'https://storage.runonflux.io.example.com/v1/env/abc'],
      ['a port', 'https://storage.runonflux.io:8443/v1/env/abc'],
      ['userinfo', 'https://user:pass@storage.runonflux.io/v1/env/abc'],
      ['something that is not a URL', 'not a url'],
    ].forEach(([what, link]) => {
      it(`refuses ${what} without fetching it`, async () => {
        let refused = null;
        await fluxStorageRefs.obtainPayloadFromStorage(link, 'myapp').catch((error) => { refused = error; });
        expect(refused, 'a foreign link was fetched').to.be.an('error');
        expect(refused.message).to.include('does not address Flux storage over https');
        sinon.assert.notCalled(axiosGet);
      });
    });

    // The host is the whole of the check, so a redirect off it would put the node back
    // where it started: fetching an address chosen by the response.
    it('fetches Flux storage and follows no redirect', async () => {
      axiosGet.resolves({ data: ['A=1'] });
      const payload = await fluxStorageRefs.obtainPayloadFromStorage('https://storage.runonflux.io/v1/env/abc', 'myapp');
      expect(payload).to.deep.equal(['A=1']);
      sinon.assert.calledOnce(axiosGet);
      expect(axiosGet.firstCall.args[1].maxRedirects).to.equal(0);
    });
  });

  describe('resolveStorageRefs', () => {
    it('inlines an F_S_ENV reference and reports a sensitive inline', async () => {
      axiosGet.resolves({ data: ['KEY=value', 'FOO=bar=baz'] });
      const components = { web: { env: { F_S_ENV: 'https://storage.runonflux.io/v1/env/abc', EXISTING: 'keep' } } };

      const inlined = await fluxStorageRefs.resolveStorageRefs(components, 'myapp');

      expect(inlined).to.equal(true);
      expect(components.web.env).to.deep.equal({ EXISTING: 'keep', KEY: 'value', FOO: 'bar=baz' });
      expect(components.web.env.F_S_ENV).to.equal(undefined);
    });

    it('inlines an F_S_CMD reference in place, preserving other argv', async () => {
      axiosGet.resolves({ data: ['--token', 'abc'] });
      const components = { web: { cmd: ['run', 'F_S_CMD=https://storage.runonflux.io/v1/cmd/abc', '--verbose'] } };

      const inlined = await fluxStorageRefs.resolveStorageRefs(components, 'myapp');

      expect(inlined).to.equal(true);
      expect(components.web.cmd).to.deep.equal(['run', '--token', 'abc', '--verbose']);
    });

    // The address is everything after the marker, so a link carrying the marker again
    // inside its own query is still fetched as the link it is.
    it('reads a command link whole', async () => {
      axiosGet.resolves({ data: ['--x'] });
      const link = 'https://storage.runonflux.io/v1/cmd/abc?next=F_S_CMD=more';
      const components = { web: { cmd: [`F_S_CMD=${link}`] } };

      await fluxStorageRefs.resolveStorageRefs(components, 'myapp');

      expect(axiosGet.firstCall.args[0]).to.equal(link);
    });

    it('returns false and fetches nothing when there are no references', async () => {
      const components = { web: { env: { A: '1' }, cmd: ['serve'] } };

      const inlined = await fluxStorageRefs.resolveStorageRefs(components, 'myapp');

      expect(inlined).to.equal(false);
      expect(axiosGet.called).to.equal(false);
    });

    it('fails hard when the storage fetch fails', async () => {
      axiosGet.rejects(new Error('network down'));
      const components = { web: { env: { F_S_ENV: 'https://storage.runonflux.io/v1/env/abc' } } };

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
      const components = { web: { env: { F_S_ENV: 'https://storage.runonflux.io/v1/env/abc' } } };

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
