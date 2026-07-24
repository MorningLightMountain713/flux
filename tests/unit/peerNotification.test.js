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
    // Encrypted apps expose only metadata here (no componentNames); the seam
    // yields their decrypted view. Cleartext apps expose their spec directly.
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
  let enqueueAllStub;
  let getAppLocationStub;
  let resolveInstantiatedStub;
  let listInstalledAppsStub;
  let listInstalledIdentitiesStub;
  let broadcastAllStub;
  let listRunningAppsStub;
  let drainingAppsMap;

  beforeEach(() => {
    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    enqueueAllStub = sinon.stub().resolves();
    getAppLocationStub = sinon.stub().resolves([]);
    // cleartext instances resolve to their own spec; encrypted default to null
    // (unresolvable) unless a test supplies a decrypted view
    resolveInstantiatedStub = sinon.stub().callsFake(async (inst) => (inst.isEncrypted ? null : inst.spec));
    listInstalledAppsStub = sinon.stub().resolves([
      mockInstantiatedSpec({ name: 'app1', version: 4, hash: 'abc123', componentNames: ['c1'] }),
    ]);
    // the installed set is the identity authority - docker is not consulted
    listInstalledIdentitiesStub = sinon.stub().resolves([]);
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
        releaseInstallingClaims: sinon.stub().resolves({ released: 0 }),
        storeAppStateEvent: sinon.stub().resolves(),
        APP_STATE_EVENT_TYPES: { APPRUNNING: 'apprunning' },
      },
      '../appMonitoring/appReconciler': {
        enqueueAll: enqueueAllStub,
        waitForBootDrainSettled: sinon.stub().resolves(),
      },
      '../appDatabase/appsRepository': {
        listInstalledApps: listInstalledAppsStub,
        listInstalledIdentities: listInstalledIdentitiesStub,
        appLocationFromEvents: getAppLocationStub,
      },
      '../utils/specCutover': {
        resolveInstantiatedSpec: resolveInstantiatedStub,
      },
      '../appQuery/appQueryService': {
        listRunningApps: listRunningAppsStub,
      },
      '../nodeConfirmationService': {
        canSendMessages: sinon.stub().returns(true),
        onMessageCapabilityChange: sinon.stub(),
      },
      '../utils/globalState': {
        runningAppsCache: new Set(),
        getAppShutdownPipelineState: (appName) => drainingAppsMap.get(appName) ?? null,
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

    it('triggers the hourly reconciler sweep instead of monitor-driven recovery', async () => {
      await peerNotification.checkAndNotifyPeersOfRunningApps();

      expect(enqueueAllStub.calledOnceWith('hourly')).to.be.true;
    });

    it('resolves an encrypted installed app to its decrypted view and broadcasts it by name+hash', async () => {
      const encInst = mockInstantiatedSpec({
        name: 'encapp', version: 8, hash: 'enchash', componentNames: ['c1'], isEncrypted: true,
      });
      listInstalledAppsStub.resolves([encInst]);
      // decrypted cleartext view for the held encrypted instance
      resolveInstantiatedStub.resolves({
        componentNames: () => ['c1'],
        hasSyncthing: () => false,
        hasActiveStandbySyncthing: () => false,
      });

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      // the encrypted instance is passed straight to the seam for decryption
      expect(resolveInstantiatedStub.calledOnceWith(encInst)).to.be.true;
      // resolved app is broadcast by name+hash (presence, not the encrypted wrapper)
      expect(broadcastAllStub.calledOnce).to.be.true;
      const broadcast = broadcastAllStub.firstCall.args[0];
      expect(broadcast.apps).to.deep.include({
        name: 'encapp', hash: 'enchash', runningSince: broadcast.apps[0].runningSince, state: 'active',
      });
    });

    // runningSince originates here and every peer echoes it back, so it must survive
    // our own restarts - it is read off our previous announcement, never restamped.
    it('carries runningSince forward from our own previous announcement', async () => {
      getAppLocationStub.resolves([{ name: 'app1', ip: '192.168.1.1:16127', replica: null, runningSince: '2025-01-01T00:00:00.000Z' }]);

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      expect(getAppLocationStub.calledOnceWithExactly({ appname: 'app1', ip: '192.168.1.1:16127' })).to.be.true;
      expect(broadcastAllStub.firstCall.args[0].apps[0].runningSince).to.equal('2025-01-01T00:00:00.000Z');
    });

    it('stamps a fresh runningSince when we have never announced this app', async () => {
      getAppLocationStub.resolves([]);
      const before = Date.now();

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      const stamped = new Date(broadcastAllStub.firstCall.args[0].apps[0].runningSince).getTime();
      expect(stamped).to.be.at.least(before);
    });

    it('matches each replica to its own prior runningSince', async () => {
      listInstalledIdentitiesStub.resolves(['r0', 'r1']);
      getAppLocationStub.resolves([
        { name: 'app1', replica: 'r1', runningSince: '2025-02-02T00:00:00.000Z' },
        { name: 'app1', replica: 'r0', runningSince: '2025-01-01T00:00:00.000Z' },
      ]);

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      const { apps } = broadcastAllStub.firstCall.args[0];
      expect(apps.map((a) => [a.replica, a.runningSince])).to.deep.equal([
        ['r0', '2025-01-01T00:00:00.000Z'],
        ['r1', '2025-02-02T00:00:00.000Z'],
      ]);
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

    it('reports one entry per installed identity, read from the installed set', async () => {
      listInstalledIdentitiesStub.resolves(['r0', 'r1']);

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      expect(listInstalledIdentitiesStub.calledOnceWith('app1')).to.be.true;
      const message = broadcastAllStub.firstCall.args[0];
      expect(message.apps.map((a) => a.replica)).to.deep.equal(['r0', 'r1']);
    });

    it('omits replica on a loose install', async () => {
      listInstalledIdentitiesStub.resolves([null]);

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      const message = broadcastAllStub.firstCall.args[0];
      expect(message.apps).to.have.length(1);
      expect(message.apps[0]).to.not.have.property('replica');
    });

    it('does not consult docker to build the snapshot', async () => {
      // The message states what this node is ASSIGNED. Reading container state
      // made a restart look like news and let a docker blip silently drop a
      // co-located app's replica identities from the network's view.
      listInstalledIdentitiesStub.resolves(['r0', 'r1']);
      const dockerless = proxyquire('../../ZelBack/src/services/appMessaging/peerNotification', {
        config: { fluxapps: { peerNotifyIntervalMs: 3600000 } },
        '../fluxNetworkHelper': { getLocalSocketAddress: sinon.stub().resolves('192.168.1.1:16127') },
        '../geolocationService': { isStaticIP: sinon.stub().returns(true) },
        '../fluxCommunicationMessagesSender': { broadcastMessageToAll: broadcastAllStub },
        './messageStore': {
          releaseInstallingClaims: sinon.stub().resolves({ released: 0 }),
          storeAppStateEvent: sinon.stub().resolves(),
          APP_STATE_EVENT_TYPES: { APPRUNNING: 'apprunning' },
        },
        '../appMonitoring/appReconciler': { enqueueAll: enqueueAllStub, waitForBootDrainSettled: sinon.stub().resolves() },
        '../appDatabase/appsRepository': {
          listInstalledApps: listInstalledAppsStub,
          listInstalledIdentities: listInstalledIdentitiesStub,
          appLocationFromEvents: getAppLocationStub,
        },
        '../utils/specCutover': { resolveInstantiatedSpec: resolveInstantiatedStub },
        '../nodeConfirmationService': {
          canSendMessages: sinon.stub().returns(true),
          onMessageCapabilityChange: sinon.stub(),
        },
        '../utils/globalState': {
          runningAppsCache: new Set(),
          getAppShutdownPipelineState: () => null,
        },
        '../utils/fluxEventBus': { publish: sinon.stub() },
        '../../lib/log': logStub,
        // no dockerService stub: noCallThru would throw on any require of it
        '../dockerService': null,
      });

      await dockerless.checkAndNotifyPeersOfRunningApps();

      const message = broadcastAllStub.firstCall.args[0];
      expect(message.apps.map((a) => a.replica)).to.deep.equal(['r0', 'r1']);
    });
  });
});
