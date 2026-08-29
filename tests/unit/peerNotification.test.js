'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const {
  loadSpecLibrary, v9Spec, sealedV8Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. What this module actually handles is the row appsRepository hydrates
// (a real InstantiatedSpec) and the cleartext view the cutover seam resolves it
// to (a real FluxAppSpecV9, or a real DecryptedCanonicalSpec for an enterprise
// app). Both are built for real below; what stays stubbed is I/O — the peer
// transport, mongo, the mesh material — and the cutover seam itself, because
// FluxOS's own crypto providers need a benchmark channel.
//
// The two stubbed collaborators that RECEIVE these objects are guarded: what
// they were handed is read back and asked for exactly what the real
// collaborator reads off it (meshBroadcast reads name/uuid/identity off the
// row and network/instances off the view; specCutover reads isEncrypted and
// spec off the row). Without that, a delegation could vanish from flux-spec
// with this suite still green.

// The message hash of the app event this row projects — 32 bytes, as every
// stored row carries.
const APP_HASH = `${'a1'.repeat(32)}`;
const ENC_HASH = `${'b2'.repeat(32)}`;
// The identity segment container names are built from, and the registration
// uuid mesh derivation keys on. Both are node-side columns, stated on the row.
const APP_IDENTITY = 'ab12cd34ef56';
const APP_UUID = '5db6f53acbbd9b38e949307e96601e573bd6437ddec08707e76a33f771b358ea';

describe('peerNotification tests', () => {
  let peerNotification;
  let logStub;
  let enqueueAllStub;
  let getAppLocationStub;
  let resolveInstantiatedStub;
  let listInstalledAppsStub;
  let listInstalledIdentitiesStub;
  let broadcastAllStub;
  let drainingAppsMap;
  let meshFieldsStub;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    await loadSpecLibrary();
  });

  /** The installed row for a real spec — what listInstalledApps hydrates to. */
  const installedRow = (spec, state = {}) => instantiatedSpec(spec, {
    hash: APP_HASH, identity: APP_IDENTITY, uuid: APP_UUID, ...state,
  });

  /** The stub map every load of the module under test shares. */
  const moduleStubs = () => ({
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
    '../appMesh/meshBroadcast': {
      meshBroadcastFields: meshFieldsStub,
    },
    '../utils/specCutover': {
      resolveInstantiatedSpec: resolveInstantiatedStub,
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

  /**
   * The row and the view the stubbed mesh collaborator was handed, asserted to
   * answer what the REAL meshBroadcastFields reads off each: `name`, `uuid` and
   * `identity` on the row (it derives the overlay from them), and `network` and
   * `instances` on the view (it filters on the first and resolves the ordinal
   * slot with the second).
   */
  const meshHandover = () => {
    const [rows, views] = meshFieldsStub.firstCall.args;
    rows.forEach((row) => {
      expect(row).to.have.property('name').that.is.a('string');
      expect(row).to.have.property('uuid');
      expect(row).to.have.property('identity');
    });
    views.forEach((view) => {
      expect(view, 'meshBroadcast reads view.network').to.have.property('network');
      expect(view, 'meshBroadcast reads view.instances').to.have.property('instances');
    });
    return { rows, views };
  };

  beforeEach(async () => {
    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    enqueueAllStub = sinon.stub().resolves();
    getAppLocationStub = sinon.stub().resolves([]);
    // Mirrors specCutover.resolveInstantiatedSpec exactly: a cleartext row
    // yields its own spec, an encrypted one is decrypted through the wrapper's
    // own provider. Only the seam is a stub — the decrypt it performs is the
    // library's real one, against the fixture's test crypto provider.
    resolveInstantiatedStub = sinon.stub().callsFake(async (inst) => {
      if (!inst.isEncrypted) return inst.spec;
      const provider = await inst.spec.createProvider();
      return inst.spec.decrypt(provider);
    });
    listInstalledAppsStub = sinon.stub().resolves([
      await installedRow(await v9Spec({ name: 'app1' })),
    ]);
    // the installed set is the identity authority - docker is not consulted
    listInstalledIdentitiesStub = sinon.stub().resolves([]);
    broadcastAllStub = sinon.stub().resolves();
    drainingAppsMap = new Map();
    meshFieldsStub = sinon.stub().resolves({ anchor: null, perApp: new Map() });

    peerNotification = proxyquire('../../ZelBack/src/services/appMessaging/peerNotification', moduleStubs());
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkAndNotifyPeersOfRunningApps', () => {
    it('should be exported as a function', () => {
      expect(peerNotification.checkAndNotifyPeersOfRunningApps).to.be.a('function');
    });

    it('spreads mesh fields onto the app entry and anchors the message', async () => {
      // A real mesh-enabled v9 app: network.mesh is the spec's own answer, which
      // is the field the real meshBroadcastFields filters the broadcast on.
      listInstalledAppsStub.resolves([
        await installedRow(await v9Spec({ name: 'app1', network: { mesh: true } })),
      ]);
      const anchor = { height: 2843890, hash: 'a'.repeat(64) };
      meshFieldsStub.resolves({
        anchor,
        perApp: new Map([['app1', { meshCa: 'CA-PEM', meshVoucher: 'v-b64', meshPort: 16230 }]]),
      });

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      const { rows, views } = meshHandover();
      expect(rows.map((row) => row.name)).to.deep.equal(['app1']);
      expect(rows[0].uuid).to.equal(APP_UUID);
      expect(rows[0].identity).to.equal(APP_IDENTITY);
      expect(views.get('app1').network.mesh).to.equal(true);
      expect(views.get('app1').instances).to.equal(3);

      const broadcast = broadcastAllStub.firstCall.args[0];
      expect(broadcast.meshAnchor).to.deep.equal(anchor);
      expect(broadcast.apps[0]).to.include({
        name: 'app1', meshCa: 'CA-PEM', meshVoucher: 'v-b64', meshPort: 16230,
      });
    });

    it('a broadcast with no mesh apps carries no meshAnchor', async () => {
      await peerNotification.checkAndNotifyPeersOfRunningApps();

      // The default app is a real v9 spec that never asked for mesh, so the
      // view handed over says so itself rather than by the fixture's omission.
      const { views } = meshHandover();
      expect(views.get('app1').network.mesh).to.equal(false);

      const broadcast = broadcastAllStub.firstCall.args[0];
      expect(broadcast).to.not.have.property('meshAnchor');
      expect(broadcast.apps[0]).to.not.have.property('meshCa');
    });

    it('triggers the hourly reconciler sweep instead of monitor-driven recovery', async () => {
      await peerNotification.checkAndNotifyPeersOfRunningApps();

      expect(enqueueAllStub.calledOnceWith('hourly')).to.be.true;
    });

    it('resolves an encrypted installed app to its decrypted view and broadcasts it by name+hash', async () => {
      // A real enterprise row: EncryptedSpecV8 under a real InstantiatedSpec, so
      // isEncrypted is the class's own answer and the decrypt is the library's.
      const encInst = await installedRow(
        await sealedV8Spec({ name: 'encapp' }),
        { hash: ENC_HASH },
      );
      expect(encInst.isEncrypted).to.equal(true);
      listInstalledAppsStub.resolves([encInst]);

      await peerNotification.checkAndNotifyPeersOfRunningApps();

      // the encrypted instance is passed straight to the seam for decryption
      expect(resolveInstantiatedStub.calledOnceWith(encInst)).to.be.true;
      // and what came back is the readable wrapper, not the sealed row: it can
      // answer the introspection the resolved view exists for.
      const view = await resolveInstantiatedStub.firstCall.returnValue;
      expect(view.sealed).to.equal(false);
      assertAnswers(view, ['componentNames']);
      expect(view.componentNames()).to.deep.equal(['web']);
      meshHandover();
      // resolved app is broadcast by name+hash (presence, not the encrypted wrapper)
      expect(broadcastAllStub.calledOnce).to.be.true;
      const broadcast = broadcastAllStub.firstCall.args[0];
      expect(broadcast.apps).to.deep.include({
        name: 'encapp', hash: ENC_HASH, runningSince: broadcast.apps[0].runningSince, state: 'active',
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

    it('broadcasts an installed app as present whatever its containers are doing', async () => {
      // Presence is assignment, not liveness — so there is nothing to arrange
      // here: the module has no way to learn a container's state. That it
      // cannot is enforced by peerNotification.guard.test.js; this asserts the
      // consequence, that an installed app is announced regardless.
      await peerNotification.checkAndNotifyPeersOfRunningApps();

      const message = broadcastAllStub.firstCall.args[0];
      expect(message.apps.map((a) => a.name)).to.deep.equal(['app1']);
      expect(message.apps[0].state).to.equal('active');
      // The name and hash on the wire are the ROW's, read off the real
      // InstantiatedSpec rather than restated by the message builder.
      expect(message.apps[0].hash).to.equal(APP_HASH);
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
      // Loaded with a stub map that carries no docker seam at all — every
      // module the snapshot could ask about container state is absent, so the
      // replicas below can only have come from the installed set.
      const dockerless = proxyquire(
        '../../ZelBack/src/services/appMessaging/peerNotification',
        moduleStubs(),
      );

      await dockerless.checkAndNotifyPeersOfRunningApps();

      const message = broadcastAllStub.firstCall.args[0];
      expect(message.apps.map((a) => a.replica)).to.deep.equal(['r0', 'r1']);
    });
  });
});
