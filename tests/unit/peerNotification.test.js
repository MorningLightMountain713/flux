const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

function mockInstantiatedSpec({
  name, version, hash, componentNames, isEncrypted = false,
}) {
  const cleartext = {
    componentNames: () => componentNames,
    componentEntries: () => componentNames.map((n) => [n, {}]),
    hasSyncthing: () => false,
    hasActiveStandbySyncthing: () => false,
  };
  return {
    name,
    version,
    hash,
    isEncrypted,
    // Encrypted apps expose only metadata here (no componentNames) and must be
    // resolved via resolveSpec(serialize()); cleartext apps expose spec directly.
    spec: isEncrypted
      ? { componentNames() { throw new Error('encrypted wrapper has no componentNames'); } }
      : cleartext,
    serialize: () => ({ name, version, hash }),
    _cleartextView: cleartext,
  };
}

describe('peerNotification tests', () => {
  let peerNotification;
  let logStub;
  let monitorAndRecoverAppsStub;
  let getAppLocationStub;
  let resolveSpecStub;
  let listInstalledAppsStub;
  let broadcastAllStub;
  let listRunningAppsStub;
  let drainingAppsMap;

  beforeEach(() => {
    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    monitorAndRecoverAppsStub = sinon.stub().resolves({ masterSlaveAppsInstalled: [], startedApps: [] });
    getAppLocationStub = sinon.stub().resolves(null);
    resolveSpecStub = sinon.stub().resolves(null);
    listInstalledAppsStub = sinon.stub().resolves([
      mockInstantiatedSpec({ name: 'app1', version: 4, hash: 'abc123', componentNames: ['c1'] }),
    ]);
    broadcastAllStub = sinon.stub().resolves();
    listRunningAppsStub = sinon.stub().resolves({
      status: 'success',
      data: [{ Names: ['/fluxc1_app1'] }],
    });
    drainingAppsMap = new Map();

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
        broadcastMessageToAll: broadcastAllStub,
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
        listInstalledApps: listInstalledAppsStub,
        getAppLocation: getAppLocationStub,
      },
      '../utils/specCutover': {
        resolveSpec: resolveSpecStub,
      },
      '../appQuery/appQueryService': {
        listRunningApps: listRunningAppsStub,
      },
      '../nodeConfirmationService': {
        canSendMessages: sinon.stub().returns(true),
        onMessageCapabilityChange: sinon.stub(),
      },
      '../utils/globalState': {
        backupInProgress: [],
        restoreInProgress: [],
        runningAppsCache: new Set(),
        getAppLbState: (appName) => drainingAppsMap.get(appName) ?? null,
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

    it('should call monitorAndRecoverApps with InstantiatedSpec array and resolved views', async () => {
      await peerNotification.checkAndNotifyPeersOfRunningApps();

      expect(monitorAndRecoverAppsStub.calledOnce).to.be.true;
      const [ip, apps, runningNames, resolvedViews] = monitorAndRecoverAppsStub.firstCall.args;
      expect(ip).to.equal('192.168.1.1:16127');
      expect(apps).to.have.length(1);
      expect(apps[0].name).to.equal('app1');
      expect(apps[0].spec.componentNames()).to.deep.equal(['c1']);
      expect(runningNames).to.deep.equal(['c1_app1']);
      // cleartext app: view is the spec itself, keyed by name
      expect(resolvedViews).to.be.an.instanceOf(Map);
      expect(resolvedViews.get('app1').componentNames()).to.deep.equal(['c1']);
    });

    it('resolves an encrypted installed app via resolveSpec and broadcasts it by name+hash', async () => {
      const encInst = mockInstantiatedSpec({
        name: 'encapp', version: 8, hash: 'enchash', componentNames: ['c1'], isEncrypted: true,
      });
      listInstalledAppsStub.resolves([encInst]);
      // decrypted cleartext view supplied by resolveSpec
      resolveSpecStub.resolves({
        componentNames: () => ['c1'],
        hasSyncthing: () => false,
        hasActiveStandbySyncthing: () => false,
      });

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      // resolveSpec called with the encrypted app's wire form
      expect(resolveSpecStub.calledOnce).to.be.true;
      expect(resolveSpecStub.firstCall.args[0]).to.deep.equal({ name: 'encapp', version: 8, hash: 'enchash' });
      // view passed to the monitor under the app name (not the encrypted wrapper)
      const [, , , resolvedViews] = monitorAndRecoverAppsStub.firstCall.args;
      expect(resolvedViews.get('encapp').componentNames()).to.deep.equal(['c1']);
    });

    it('should use appsRepository.getAppLocation for location lookup', async () => {
      getAppLocationStub.resolves({ runningSince: '2025-01-01T00:00:00.000Z' });

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      expect(getAppLocationStub.calledOnce).to.be.true;
      expect(getAppLocationStub.firstCall.args).to.deep.equal(['app1', '192.168.1.1:16127']);
    });

    it('broadcasts an installed app as present even when no container is running', async () => {
      // Container is down: nothing running. Presence is assignment, not liveness.
      listRunningAppsStub.resolves({ status: 'success', data: [] });

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      const message = broadcastAllStub.firstCall.args[0];
      expect(message.apps.map((a) => a.name)).to.deep.equal(['app1']);
      expect(message.apps[0].state).to.equal('active');
    });

    it('stamps the draining state on an app the node is draining', async () => {
      drainingAppsMap.set('app1', 'draining');

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      const message = broadcastAllStub.firstCall.args[0];
      expect(message.apps[0].name).to.equal('app1');
      expect(message.apps[0].state).to.equal('draining');
    });
  });
});
