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
      './fluxBroadcastHelper': {
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

    it('signs the request with the node key', async () => {
      axiosGet.resolves({ data: ['A=1'] });
      await fluxStorageRefs.obtainPayloadFromStorage('https://storage.runonflux.io/v1/env/abc', 'myapp');
      const { headers } = axiosGet.firstCall.args[1];
      expect(headers['flux-signature']).to.equal('sig');
      expect(headers['flux-message']).to.match(/^1https:\/\/storage\.runonflux\.io\/v1\/env\/abc\d+$/);
      expect(headers['flux-app']).to.equal('myapp');
    });
  });
});
