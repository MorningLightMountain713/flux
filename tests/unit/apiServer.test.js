'use strict';

const fs = require('node:fs');
const { expect } = require('chai');
const sinon = require('sinon');

const apiServer = require('../../apiServer');
const fluxServer = require('../../ZelBack/src/lib/fluxServer');
const moduleLoader = require('../../ZelBack/src/lib/moduleLoader');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const systemdNotify = require('../../ZelBack/src/services/utils/systemdNotify');
const dnsLookup = require('../../ZelBack/src/services/utils/dnsLookup');

describe('apiServer initiate readiness', () => {
  let listen;
  let notifyReady;
  let start;
  let uncaughtBefore;

  beforeEach(() => {
    uncaughtBefore = process.listeners('uncaughtException');
    listen = sinon.stub().resolves();
    sinon.stub(fluxServer, 'FluxServer').callsFake(() => ({ listen, app: {}, socketIo: {} }));
    notifyReady = sinon.stub(systemdNotify, 'notifyReady').resolves(true);
    start = sinon.stub();
    sinon.stub(moduleLoader, 'load').withArgs('services/nodeProcess').returns({ start });
    sinon.stub(dnsLookup, 'install');
    sinon.stub(fs, 'existsSync').returns(true);
    const readFileSync = fs.readFileSync.bind(fs);
    sinon.stub(fs, 'readFileSync').callsFake((file, ...rest) => (
      String(file).includes('certs/v1.') ? 'pem' : readFileSync(file, ...rest)));
  });

  afterEach(() => {
    sinon.restore();
    process.listeners('uncaughtException')
      .filter((listener) => !uncaughtBefore.includes(listener))
      .forEach((listener) => process.removeListener('uncaughtException', listener));
  });

  it('reports ready once both listeners are up, before the node process starts the services', async () => {
    await apiServer.initiate();

    sinon.assert.calledTwice(listen);
    sinon.assert.calledOnce(notifyReady);
    sinon.assert.callOrder(listen, notifyReady, start);
  });

  it('does not hold startup on the readiness report', async () => {
    notifyReady.returns(new Promise(() => {}));

    await apiServer.initiate();

    sinon.assert.calledOnce(notifyReady);
    sinon.assert.calledOnce(start);
  });

  it('reports nothing when the API cannot listen', async () => {
    listen.rejects(new Error('EADDRINUSE'));
    sinon.stub(serviceHelper, 'delay').resolves();
    sinon.stub(process, 'exit');

    await apiServer.initiate();

    sinon.assert.notCalled(notifyReady);
    sinon.assert.notCalled(start);
  });

  ['http', 'https'].forEach((mode, failing) => {
    it(`exits as a configuration error when the ${mode} listener cannot listen`, async () => {
      listen.onCall(failing).rejects(new Error('EADDRINUSE'));
      sinon.stub(serviceHelper, 'delay').resolves();
      const exit = sinon.stub(process, 'exit');

      await apiServer.initiate();
      await new Promise(setImmediate);

      sinon.assert.calledOnceWithExactly(exit, systemdNotify.EXIT_CONFIG);
      expect(start.called).to.equal(false);
    });
  });
});
