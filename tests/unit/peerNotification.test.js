const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

function mockInstantiatedSpec({ name, version, hash, componentNames }) {
  return {
    name,
    version,
    hash,
    spec: {
      componentNames: () => componentNames,
      componentEntries: () => componentNames.map((n) => [n, {}]),
    },
  };
}

describe('peerNotification tests', () => {
  let peerNotification;
  let logStub;
  let monitorAndRecoverAppsStub;
  let getAppLocationStub;

  beforeEach(() => {
    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    monitorAndRecoverAppsStub = sinon.stub().resolves({ masterSlaveAppsInstalled: [], startedApps: [] });
    getAppLocationStub = sinon.stub().resolves(null);

    peerNotification = proxyquire('../../ZelBack/src/services/appMessaging/peerNotification', {
      config: {
        fluxapps: {
          peerNotifyIntervalMs: 3600000,
        },
      },
      '../fluxNetworkHelper': {
        getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127'),
      },
      '../geolocationService': {
        isStaticIP: sinon.stub().returns(true),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToOutgoing: sinon.stub().resolves(),
        broadcastMessageToIncoming: sinon.stub().resolves(),
        broadcastMessageToAll: sinon.stub().resolves(),
      },
      './messageStore': {
        storeAppRunningMessage: sinon.stub().resolves(),
        storeAppStateEvent: sinon.stub().resolves(),
        APP_STATE_EVENT_TYPES: { APPRUNNING: 'apprunning' },
      },
      '../appMonitoring/containerHealthMonitor': {
        monitorAndRecoverApps: monitorAndRecoverAppsStub,
      },
      '../appDatabase/appsRepository': {
        listInstalledAppsRaw: sinon.stub().resolves([
          { name: 'app1', version: 4, compose: [{ name: 'c1', containerData: '' }] },
        ]),
        listInstalledApps: sinon.stub().resolves([
          mockInstantiatedSpec({ name: 'app1', version: 4, hash: 'abc123', componentNames: ['c1'] }),
        ]),
        getAppLocation: getAppLocationStub,
      },
      '../appQuery/appQueryService': {
        listRunningApps: sinon.stub().resolves({
          status: 'success',
          data: [{ Names: ['/fluxc1_app1'] }],
        }),
      },
      '../nodeConfirmationService': {
        canSendMessages: sinon.stub().returns(true),
        onMessageCapabilityChange: sinon.stub(),
      },
      '../utils/globalState': {
        backupInProgress: [],
        restoreInProgress: [],
        runningAppsCache: new Set(),
      },
      '../utils/fluxEventBus': {
        publish: sinon.stub(),
      },
      '../../lib/log': logStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkAndNotifyPeersOfRunningApps', () => {
    it('should be exported as a function', () => {
      expect(peerNotification.checkAndNotifyPeersOfRunningApps).to.be.a('function');
    });

    it('should call monitorAndRecoverApps with raw specs', async () => {
      await peerNotification.checkAndNotifyPeersOfRunningApps();

      expect(monitorAndRecoverAppsStub.calledOnce).to.be.true;
      const [ip, apps, runningNames] = monitorAndRecoverAppsStub.firstCall.args;
      expect(ip).to.equal('192.168.1.1:16127');
      expect(apps).to.have.length(1);
      expect(apps[0].name).to.equal('app1');
      expect(apps[0].compose).to.be.an('array');
      expect(runningNames).to.deep.equal(['c1_app1']);
    });

    it('should use appsRepository.getAppLocation for location lookup', async () => {
      getAppLocationStub.resolves({ runningSince: '2025-01-01T00:00:00.000Z' });

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      expect(getAppLocationStub.calledOnce).to.be.true;
      expect(getAppLocationStub.firstCall.args).to.deep.equal(['app1', '192.168.1.1:16127']);
    });
  });
});
