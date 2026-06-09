const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('drainServer tests', () => {
  let drainServer;
  let drainingAppsMap;
  let rebroadcastStub;

  beforeEach(() => {
    drainingAppsMap = new Map();
    rebroadcastStub = sinon.stub();
    drainServer = proxyquire('../../ZelBack/src/services/appMessaging/drainServer', {
      '../utils/globalState': { drainingApps: drainingAppsMap },
      './peerNotification': { checkAndNotifyPeersOfRunningApps: rebroadcastStub },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('handleRequest', () => {
    it('marks the app draining and triggers a rebroadcast on drain_app', () => {
      const response = drainServer.handleRequest(JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'drain_app',
        params: { app_name: 'myapp', component_name: 'web', owner_flux_id: '1abc', reason: 'reboot', deadline: 123 },
      }));

      expect(response).to.deep.equal({ jsonrpc: '2.0', id: 7, result: { ok: true } });
      expect(drainingAppsMap.get('myapp')).to.equal('draining');
      expect(rebroadcastStub.calledOnce).to.be.true;
    });

    it('errors when drain_app omits app_name', () => {
      const response = drainServer.handleRequest(JSON.stringify({ id: 1, method: 'drain_app', params: {} }));

      expect(response.error.code).to.equal(-32000);
      expect(response.error.message).to.contain('app_name required');
      expect(rebroadcastStub.called).to.be.false;
    });

    it('errors on an unknown method', () => {
      const response = drainServer.handleRequest(JSON.stringify({ id: 2, method: 'nope', params: {} }));

      expect(response.error.code).to.equal(-32601);
      expect(drainingAppsMap.size).to.equal(0);
    });

    it('errors on malformed JSON', () => {
      const response = drainServer.handleRequest('{ not json');

      expect(response.error.code).to.equal(-32700);
    });
  });
});
