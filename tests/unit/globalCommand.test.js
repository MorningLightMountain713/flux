// Set NODE_CONFIG_DIR before any requires
if (!process.env.NODE_CONFIG_DIR) {
  process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;
}

const sinon = require('sinon');
const axios = require('axios');
const globalCommand = require('../../ZelBack/src/services/appManagement/globalCommand');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');

describe('globalCommand tests', () => {
  let axiosStub;

  beforeEach(() => {
    // Every dependency the fan-out reaches is stubbed here rather than in the
    // individual tests: this runs un-awaited from the route handlers, so anything
    // left unstubbed is dialled for real the moment a test's stubs are restored.
    sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('192.168.1.9:16127');
    // the fan-out paces itself with a real delay per instance; the pacing is not
    // what these assert, and awaiting it makes the file take seconds.
    sinon.stub(serviceHelper, 'delay').resolves();
    axiosStub = sinon.stub(axios, 'get').resolves({ status: 200 });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('sends the command to every instance running the app', async () => {
    sinon.stub(appsRepository, 'appLocationFromEvents').resolves([
      { ip: '192.168.1.1:16127', name: 'TestApp' },
      { ip: '192.168.1.2:16127', name: 'TestApp' },
    ]);

    await globalCommand.executeAppGlobalCommand('TestApp', 'appstart', 'test-auth');

    sinon.assert.calledTwice(axiosStub);
    sinon.assert.calledWithMatch(axiosStub, 'http://192.168.1.1:16127/apps/appstart/TestApp');
    sinon.assert.calledWithMatch(axiosStub, 'http://192.168.1.2:16127/apps/appstart/TestApp');
  });

  it('skips this node when bypassMyIp is set', async () => {
    sinon.stub(appsRepository, 'appLocationFromEvents').resolves([
      { ip: '192.168.1.9:16127', name: 'TestApp' },
      { ip: '192.168.1.2:16127', name: 'TestApp' },
    ]);

    await globalCommand.executeAppGlobalCommand('TestApp', 'appstart', 'test-auth', null, true);

    sinon.assert.calledOnce(axiosStub);
    sinon.assert.calledWithMatch(axiosStub, 'http://192.168.1.2:16127/apps/appstart/TestApp');
  });

  it('a replica-scoped command reaches only the node holding that replica', async () => {
    sinon.stub(appsRepository, 'appLocationFromEvents').resolves([
      { ip: '192.168.1.1:16127', name: 'TestApp', replica: 'r0' },
      { ip: '192.168.1.2:16127', name: 'TestApp', replica: 'r1' },
    ]);

    await globalCommand.executeAppGlobalCommand('TestApp', 'appstop', 'test-auth', undefined, undefined, 'r1');

    sinon.assert.calledOnce(axiosStub);
    sinon.assert.calledWithMatch(axiosStub, 'http://192.168.1.2:16127/apps/appstop/TestApp?replica=r1');
  });

  it('forwards the caller authorization so each peer re-authorizes', async () => {
    sinon.stub(appsRepository, 'appLocationFromEvents').resolves([
      { ip: '192.168.1.1:16127', name: 'TestApp' },
    ]);

    await globalCommand.executeAppGlobalCommand('TestApp', 'appstart', 'the-auth-header');

    sinon.assert.calledWithMatch(axiosStub, sinon.match.string, { headers: { zelidauth: 'the-auth-header' } });
  });

  it('swallows a location lookup failure rather than rejecting into the caller', async () => {
    // the handlers fire this without awaiting, so a rejection here would surface
    // as an unhandled rejection rather than an error anyone can act on.
    sinon.stub(appsRepository, 'appLocationFromEvents').rejects(new Error('db down'));

    await globalCommand.executeAppGlobalCommand('TestApp', 'appstart', 'test-auth');

    sinon.assert.notCalled(axiosStub);
  });
});
