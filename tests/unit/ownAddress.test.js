const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const daemonServiceFluxnodeRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceFluxnodeRpcs');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const geolocationService = require('../../ZelBack/src/services/geolocationService');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const fluxNetworkMonitor = require('../../ZelBack/src/services/fluxNetworkMonitor');
const nodeIdentityRepository = require('../../ZelBack/src/services/appDatabase/nodeIdentityRepository');
const nodeConfirmationService = require('../../ZelBack/src/services/nodeConfirmationService');
const nodeDosState = require('../../ZelBack/src/services/nodeDosState');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const { stubHostedInstances, installedRecord } = require('./fixtures/appRecords');
const { requireMongo } = require('./dbTestHelper');

describe('fluxNetworkHelper own address tests', () => {
  before(requireMongo);

  const PEERS = ['203.0.113.201:16127', '203.0.113.202:16127', '203.0.113.203:16127'];

  let records;
  let moved;
  let restarted;
  let listedHere;
  let hosted;

  const configure = (ipaddress) => {
    nodeIdentityRepository.getLastKnownIp.resolves(ipaddress);
  };
  const installed = (...apps) => apps.map(({ name, staticIp = false }) => installedRecord({ name, placement: { staticIp } }));
  const adopt = (socketAddress, movedFrom = null) => records.insertOne({ _id: 'own', socketAddress, movedFrom });
  const record = () => records.findOne({ _id: 'own' }, { projection: { _id: 0, socketAddress: 1, movedFrom: 1 } });

  beforeEach(async () => {
    await dbHelper.initiateDB();
    records = dbHelper.databaseConnection().db(config.database.local.database).collection(config.database.local.collections.ownAddress);
    await records.deleteMany({});
    sinon.stub(nodeIdentityRepository, 'getLastKnownIp').resolves(null);
    sinon.stub(nodeIdentityRepository, 'setLastKnownIp').resolves(true);
    sinon.stub(daemonServiceFluxnodeRpcs, 'createConfirmationTransaction').resolves({ value: {} });
    hosted = stubHostedInstances();
    hosted.apps.resolves([]);
    sinon.stub(registryManager, 'appLocation').resolves([]);
    sinon.stub(daemonServiceFluxnodeRpcs, 'getFluxNodeStatus').resolves({ status: 'error' });
    sinon.stub(geolocationService, 'setNodeGeolocation');
    sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('unreachable'));
    // the peers asked whether a Flux node is at an address: none finds one unless a case says
    serviceHelper.axiosGet.withArgs(sinon.match(/\/flux\/checkfluxavailability/)).resolves({ data: { status: 'error' } });
    sinon.stub(networkStateService, 'getRandomExternalObserver')
      .callsFake(async (own, { exclude = [] } = {}) => PEERS.find((peer) => !exclude.includes(peer)) ?? null);
    sinon.stub(serviceHelper, 'delay').resolves();
    moved = sinon.stub().resolves();
    fluxNetworkMonitor.setOnOwnAddressMoved(moved);
    restarted = sinon.stub().callsFake(async (apps) => ({ asked: apps.length, components: apps.length }));
    fluxNetworkMonitor.setOnAddressChanged(restarted);
    // the installed apps the network lists at an address: none unless a case says
    listedHere = sinon.stub().resolves([]);
    fluxNetworkMonitor.setInstalledAppsListedAt(listedHere);
    fluxNetworkHelper.setLocalSocketAddress(null);
  });

  afterEach(async () => {
    sinon.restore();
    fluxNetworkMonitor.setOnOwnAddressMoved(null);
    fluxNetworkMonitor.setOnAddressChanged(null);
    fluxNetworkMonitor.setInstalledAppsListedAt(null);
    await records.deleteMany({});
  });

  it('adopts the reported address when it holds none and the configured IP is the reported one', async () => {
    configure('198.51.100.1');

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.1:16127');

    sinon.assert.notCalled(moved);
    expect(await record()).to.deep.equal({ socketAddress: '198.51.100.1:16127', movedFrom: null });
  });

  it('takes a port moved away from the adopted address as a move, and keeps the apps where they are', async () => {
    configure('198.51.100.2');
    await adopt('198.51.100.2:16127');

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.2:16157');

    sinon.assert.calledOnceWithExactly(moved, '198.51.100.2:16127', '198.51.100.2:16157', sinon.match.number);
    sinon.assert.notCalled(serviceHelper.axiosGet);
    sinon.assert.calledOnce(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
    sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
    sinon.assert.notCalled(hosted.apps);
    sinon.assert.notCalled(geolocationService.setNodeGeolocation);
    expect(await record()).to.deep.equal({ socketAddress: '198.51.100.2:16157', movedFrom: '198.51.100.2:16127' });
  });

  it('takes an IP moved away from the adopted address as a move whatever the chain already lists', async () => {
    configure('198.51.100.3');
    await adopt('198.51.100.3:16127');
    daemonServiceFluxnodeRpcs.getFluxNodeStatus.resolves({ status: 'success', data: { ip: '198.51.100.33:16127' } });

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.33:16127');

    sinon.assert.calledOnceWithExactly(moved, '198.51.100.3:16127', '198.51.100.33:16127', sinon.match.number);
    sinon.assert.calledWith(nodeIdentityRepository.setLastKnownIp, '198.51.100.33');
    sinon.assert.calledOnce(geolocationService.setNodeGeolocation);
    expect(await record()).to.deep.equal({ socketAddress: '198.51.100.33:16127', movedFrom: '198.51.100.3:16127' });
  });

  it('holding no address, takes the configured IP at the port the network lists it at as the address it left', async () => {
    configure('198.51.100.4');
    daemonServiceFluxnodeRpcs.getFluxNodeStatus.resolves({ status: 'success', data: { ip: '198.51.100.4:16137' } });
    listedHere.withArgs('198.51.100.4:16137').resolves(['ranthere']);

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.44:16137');

    sinon.assert.calledOnceWithExactly(moved, '198.51.100.4:16137', '198.51.100.44:16137', sinon.match.number);
    sinon.assert.calledTwice(serviceHelper.axiosGet.withArgs('http://198.51.100.4:16137/flux/version'));
  });

  describe('holding no address, with nothing answering at the configured one', () => {
    it('tells the network it moved when it ran apps there, and confirms the new address', async () => {
      configure('198.51.100.15');
      listedHere.withArgs('198.51.100.15:16127').resolves(['ranthere']);

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.16:16127');

      sinon.assert.calledOnceWithExactly(moved, '198.51.100.15:16127', '198.51.100.16:16127', sinon.match.number);
      sinon.assert.calledOnce(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      sinon.assert.calledWith(nodeIdentityRepository.setLastKnownIp, '198.51.100.16');
      expect(await record()).to.deep.equal({ socketAddress: '198.51.100.16:16127', movedFrom: '198.51.100.15:16127' });
    });

    it('adopts the new address without a move when it ran no apps there', async () => {
      configure('198.51.100.17');

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.18:16127');

      sinon.assert.notCalled(moved);
      sinon.assert.calledOnce(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      sinon.assert.calledWith(nodeIdentityRepository.setLastKnownIp, '198.51.100.18');
      sinon.assert.calledOnce(geolocationService.setNodeGeolocation);
      expect(await record()).to.deep.equal({ socketAddress: '198.51.100.18:16127', movedFrom: '198.51.100.17:16127' });
    });

    it('restarts its installed apps on the new address, without a move, when the network lists none of them there', async () => {
      configure('198.51.100.19');
      hosted.apps.resolves(installed({ name: 'expiredrows' }));

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.20:16127');

      sinon.assert.notCalled(moved);
      sinon.assert.calledOnce(restarted);
      expect(restarted.firstCall.args[0].map((app) => app.name)).to.deep.equal(['expiredrows']);
    });

    it('adopts nothing while whether it ran apps there cannot be read, and acts on the address again later', async () => {
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
      configure('198.51.100.90');
      listedHere.rejects(new Error('db down'));

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.91:16127');

      sinon.assert.notCalled(moved);
      sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
      expect(await record()).to.equal(null);

      listedHere.resolves(['ranthere']);
      fluxNetworkHelper.setLocalSocketAddress('198.51.100.91:16127');
      const told = new Promise((resolve) => { moved.callsFake(async () => resolve()); });
      await clock.tickAsync(60 * 1000);
      await told;
      // queued behind the retry, so it returns once the retry has finished
      await fluxNetworkMonitor.handleOwnAddress('198.51.100.91:16127');

      sinon.assert.calledOnceWithExactly(moved, '198.51.100.90:16127', '198.51.100.91:16127', sinon.match.number);
      expect(await record()).to.deep.equal({ socketAddress: '198.51.100.91:16127', movedFrom: '198.51.100.90:16127' });
    });

    it('adopts the new address without a move when nothing reports what it ran', async () => {
      configure('198.51.100.21');
      fluxNetworkMonitor.setInstalledAppsListedAt(null);

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.22:16127');

      sinon.assert.notCalled(moved);
      sinon.assert.calledOnce(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
    });
  });

  it('tells the network it moved from an address it recorded, whatever the network lists there', async () => {
    configure('198.51.100.23');
    await adopt('198.51.100.23:16127');

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.24:16127');

    sinon.assert.notCalled(listedHere);
    sinon.assert.calledOnceWithExactly(moved, '198.51.100.23:16127', '198.51.100.24:16127', sinon.match.number);
  });

  it('holding no address, adopts the reported one without a move while a Flux node answers at the configured address', async () => {
    configure('198.51.100.11');
    serviceHelper.axiosGet.withArgs('http://198.51.100.11:16127/flux/version').resolves({ data: { status: 'success' } });

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.12:16127');

    sinon.assert.notCalled(moved);
    sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
    sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
    expect(await record()).to.deep.equal({ socketAddress: '198.51.100.12:16127', movedFrom: null });
  });

  it('holding no address, makes no move when it cannot reach the configured address but a peer can', async () => {
    configure('198.51.100.15');
    listedHere.resolves(['ranthere']);
    serviceHelper.axiosGet.withArgs(sinon.match(/\/flux\/checkfluxavailability/)).resolves({ data: { status: 'success' } });

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.16:16127');

    sinon.assert.notCalled(moved);
    sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
    sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
    expect(await record()).to.deep.equal({ socketAddress: '198.51.100.16:16127', movedFrom: null });
  });

  it('holding no address, makes no move while fewer peers than it needs answer whether a node is at the configured address', async () => {
    configure('198.51.100.17');
    listedHere.resolves(['ranthere']);
    serviceHelper.axiosGet.withArgs(sinon.match(/\/flux\/checkfluxavailability/)).rejects(new Error('unreachable'));

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.18:16127');

    sinon.assert.notCalled(moved);
    sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
  });

  it('holding no address, makes no move while the peers asked do not list the configured address', async () => {
    configure('198.51.100.19');
    listedHere.resolves(['ranthere']);
    serviceHelper.axiosGet.withArgs(sinon.match(/\/flux\/checkfluxavailability/))
      .resolves({ data: { status: 'error', data: { message: fluxNetworkHelper.NOT_LISTED_MESSAGE } } });

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.20:16127');

    sinon.assert.notCalled(moved);
    sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
  });

  it('holding no address, makes no move when the node at the configured address answers once the restart grace has passed', async () => {
    configure('198.51.100.13');
    serviceHelper.axiosGet.withArgs('http://198.51.100.13:16127/flux/version')
      .onFirstCall().rejects(new Error('restarting'))
      .onSecondCall().resolves({ data: { status: 'success' } });

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.14:16127');

    sinon.assert.calledOnce(serviceHelper.delay);
    sinon.assert.notCalled(moved);
    sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
  });

  it('does nothing for the address it already holds', async () => {
    configure('198.51.100.5');
    await adopt('198.51.100.5:16127');

    await fluxNetworkMonitor.handleOwnAddress('198.51.100.5:16127');

    sinon.assert.notCalled(moved);
    sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
  });

  it('handles changes one at a time, so the same move is made once', async () => {
    configure('198.51.100.6');
    await adopt('198.51.100.6:16127');

    await Promise.all([
      fluxNetworkMonitor.handleOwnAddress('198.51.100.6:16157'),
      fluxNetworkMonitor.handleOwnAddress('198.51.100.6:16157'),
    ]);

    sinon.assert.calledOnce(moved);
  });

  it('handles the address it already knows when the watch starts', async () => {
    configure('198.51.100.7');
    await adopt('198.51.100.7:16127');
    fluxNetworkHelper.setLocalSocketAddress('198.51.100.7:16157');

    const stop = fluxNetworkMonitor.startOwnAddressWatch();
    expect(fluxNetworkMonitor.startOwnAddressWatch(), 'a second start returns the same watch').to.be.a('function');
    await fluxNetworkMonitor.handleOwnAddress('198.51.100.7:16157');
    stop();
    fluxNetworkHelper.setLocalSocketAddress(null);

    sinon.assert.calledOnceWithExactly(moved, '198.51.100.7:16127', '198.51.100.7:16157', sinon.match.number);
  });

  it('acts on each change of the address once the watch has started, and on none once it has stopped', async () => {
    configure('198.51.100.10');
    await adopt('198.51.100.10:16127');
    fluxNetworkHelper.setLocalSocketAddress('198.51.100.10:16127');

    const stop = fluxNetworkMonitor.startOwnAddressWatch();
    fluxNetworkHelper.setLocalSocketAddress('198.51.100.10:16157');
    await fluxNetworkMonitor.handleOwnAddress('198.51.100.10:16157');
    stop();
    fluxNetworkHelper.setLocalSocketAddress('198.51.100.10:16167');
    await fluxNetworkMonitor.handleOwnAddress('198.51.100.10:16157');
    fluxNetworkHelper.setLocalSocketAddress(null);

    sinon.assert.calledOnceWithExactly(moved, '198.51.100.10:16127', '198.51.100.10:16157', sinon.match.number);
  });

  describe('where this node is, for an address benchmark reports', () => {
    it('gives the address it moved to for one it moved away from, and any other as given', async () => {
      configure('198.51.100.31');
      await adopt('198.51.100.31:16127');

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.32:16127');

      expect(fluxNetworkHelper.ownAddressFor('198.51.100.31:16127')).to.equal('198.51.100.32:16127');
      expect(fluxNetworkHelper.ownAddressFor('198.51.100.31')).to.equal('198.51.100.32:16127');
      expect(fluxNetworkHelper.ownAddressFor('198.51.100.32:16127')).to.equal('198.51.100.32:16127');
      expect(fluxNetworkHelper.ownAddressFor('198.51.100.33:16127')).to.equal('198.51.100.33:16127');
    });

    it('gives the address it holds now for both, after moving away and back', async () => {
      configure('198.51.100.34');
      await adopt('198.51.100.34:16127');

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.35:16127');
      await fluxNetworkMonitor.handleOwnAddress('198.51.100.34:16127');

      expect(fluxNetworkHelper.ownAddressFor('198.51.100.35:16127')).to.equal('198.51.100.34:16127');
      expect(fluxNetworkHelper.ownAddressFor('198.51.100.34:16127')).to.equal('198.51.100.34:16127');
    });

    it('knows a move recorded before this process started, once it reads the record', async () => {
      configure('198.51.100.36');
      await adopt('198.51.100.37:16127', '198.51.100.36:16127');

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.37:16127');

      expect(fluxNetworkHelper.ownAddressFor('198.51.100.36:16127')).to.equal('198.51.100.37:16127');
    });

    it('holds the new address from the moment the move carries its rows', async () => {
      configure('198.51.100.38');
      await adopt('198.51.100.38:16127');
      let seenWhileMoving;
      moved.callsFake(async () => { seenWhileMoving = fluxNetworkHelper.ownAddressFor('198.51.100.38:16127'); });

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.39:16127');

      expect(seenWhileMoving).to.equal('198.51.100.39:16127');
    });
  });

  describe('a move finished across passes', () => {
    const HOUR = 60 * 60 * 1000;
    const KEEPS = { name: 'keeps' };
    const fullRecord = () => records.findOne({ _id: 'own' });
    // A pass of the reconcile: benchmark reports the address the record holds.
    const pass = (address) => fluxNetworkMonitor.handleOwnAddress(address);

    it('finishes a move a failing step stopped, counting its IP change once and announcing it once', async () => {
      configure('198.51.100.51');
      await adopt('198.51.100.51:16127');
      nodeIdentityRepository.setLastKnownIp.onFirstCall().rejects(new Error('database unavailable'));

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.52:16127');
      sinon.assert.notCalled(moved);
      await pass('198.51.100.52:16127');

      sinon.assert.calledOnceWithExactly(moved, '198.51.100.51:16127', '198.51.100.52:16127', sinon.match.number);
      sinon.assert.calledWith(nodeIdentityRepository.setLastKnownIp, '198.51.100.52');
      expect((await fullRecord()).recentIpChanges).to.have.lengthOf(1);
    });

    it('announces a move once when a pass stopped after announcing it, and asks the restart again under the same key', async () => {
      configure('198.51.100.53');
      await adopt('198.51.100.53:16127');
      hosted.apps.resolves(installed(KEEPS));
      restarted.onFirstCall().rejects(new Error('reconciler unavailable'));

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.54:16127');
      await pass('198.51.100.54:16127');

      sinon.assert.calledOnce(moved);
      sinon.assert.calledTwice(restarted);
      const { movedAt } = await fullRecord();
      expect(restarted.getCalls().map((call) => call.args[2])).to.deep.equal([`ownMove:${movedAt}`, `ownMove:${movedAt}`]);
      expect((await fullRecord()).appsHandledAt).to.equal(movedAt);
    });

    describe('the apps a move handles', () => {
      const STATIC = { name: 'needsfixedip', staticIp: true };
      const handledAt = async () => (await fullRecord()).appsHandledAt;

      it('handles them on the next pass when the installed apps could not be read', async () => {
        configure('198.51.100.71');
        await adopt('198.51.100.71:16127');
        hosted.apps.onFirstCall().rejects(new Error('db unavailable'));
        hosted.apps.resolves(installed(KEEPS));

        await fluxNetworkMonitor.handleOwnAddress('198.51.100.72:16127');
        expect(await handledAt(), 'after the pass that could not read them').to.equal(null);
        sinon.assert.notCalled(restarted);
        await pass('198.51.100.72:16127');

        sinon.assert.calledOnceWithExactly(restarted, sinon.match((apps) => apps[0].name === 'keeps'), sinon.match.string, `ownMove:${(await fullRecord()).movedAt}`);
        expect(await handledAt()).to.equal((await fullRecord()).movedAt);
      });

      it('removes on a later pass an app whose removal was refused or failed', async () => {
        configure('198.51.100.73');
        await adopt('198.51.100.73:16127');
        hosted.apps.resolves(installed(STATIC));
        const remove = sinon.stub(appUninstaller, 'uninstallApplication');
        remove.onCall(0).resolves({ status: appUninstaller.UninstallStatus.DEFERRED });
        remove.onCall(1).resolves({ status: appUninstaller.UninstallStatus.FAILED });
        remove.onCall(2).resolves({ status: appUninstaller.UninstallStatus.REMOVED });

        await fluxNetworkMonitor.handleOwnAddress('198.51.100.74:16127');
        expect(await handledAt(), 'after a removal refused as busy').to.equal(null);
        await pass('198.51.100.74:16127');
        expect(await handledAt(), 'after a removal that failed').to.equal(null);
        await pass('198.51.100.74:16127');

        sinon.assert.calledThrice(remove);
        expect(await handledAt()).to.equal((await fullRecord()).movedAt);
      });

      it('counts an app already gone as handled', async () => {
        configure('198.51.100.75');
        await adopt('198.51.100.75:16127');
        hosted.apps.resolves(installed(STATIC));
        sinon.stub(appUninstaller, 'uninstallApplication').resolves({ status: appUninstaller.UninstallStatus.SKIPPED });

        await fluxNetworkMonitor.handleOwnAddress('198.51.100.76:16127');

        expect(await handledAt()).to.equal((await fullRecord()).movedAt);
      });

      it('asks again, under the same key, for a restart that was not asked of every component', async () => {
        configure('198.51.100.79');
        await adopt('198.51.100.79:16127');
        hosted.apps.resolves(installed(KEEPS));
        restarted.onFirstCall().resolves({ asked: 1, components: 2 });
        restarted.onSecondCall().resolves({ asked: 2, components: 2 });

        await fluxNetworkMonitor.handleOwnAddress('198.51.100.80:16127');
        expect(await handledAt(), 'after one component of two was asked').to.equal(null);
        await pass('198.51.100.80:16127');

        const { movedAt } = await fullRecord();
        expect(restarted.getCalls().map((call) => call.args[2])).to.deep.equal([`ownMove:${movedAt}`, `ownMove:${movedAt}`]);
        expect(await handledAt()).to.equal(movedAt);
      });

      it('asks no restart again once the move\'s apps are handled', async () => {
        configure('198.51.100.85');
        await adopt('198.51.100.85:16127');
        hosted.apps.resolves(installed(KEEPS));

        await fluxNetworkMonitor.handleOwnAddress('198.51.100.86:16127');
        await pass('198.51.100.86:16127');

        sinon.assert.calledOnce(restarted);
      });

      it('takes a restart that reports nothing as not asked', async () => {
        configure('198.51.100.81');
        await adopt('198.51.100.81:16127');
        hosted.apps.resolves(installed(KEEPS));
        restarted.resolves(undefined);

        await fluxNetworkMonitor.handleOwnAddress('198.51.100.82:16127');

        expect(await handledAt()).to.equal(null);
      });

      it('does not settle a move whose apps are not handled, though the chain lists the new address', async () => {
        configure('198.51.100.83');
        await adopt('198.51.100.83:16127');
        daemonServiceFluxnodeRpcs.getFluxNodeStatus.resolves({ status: 'success', data: { ip: '198.51.100.84' } });
        hosted.apps.onFirstCall().rejects(new Error('db unavailable'));
        hosted.apps.resolves(installed(KEEPS));

        await fluxNetworkMonitor.handleOwnAddress('198.51.100.84:16127');
        expect((await fullRecord()).settledAt, 'listed at the new address, its apps not yet handled').to.equal(null);
        await pass('198.51.100.84:16127');

        const { movedAt, settledAt } = await fullRecord();
        sinon.assert.calledOnce(restarted);
        expect(settledAt).to.equal(movedAt);
      });
    });

    it('asks again for a refused confirmation, not again for an accepted one, and does nothing once the chain lists the new address', async () => {
      configure('198.51.100.55');
      await adopt('198.51.100.55:16127');
      const confirm = daemonServiceFluxnodeRpcs.createConfirmationTransaction;
      confirm.onFirstCall().resolves({ value: null, reason: { message: 'benchmark unreachable' } });
      confirm.onSecondCall().resolves({ value: { status: 'Successfully Sent' } });

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.56:16127');
      await pass('198.51.100.56:16127');
      await pass('198.51.100.56:16127');
      expect(confirm.callCount, 'refused, then accepted, then not asked again').to.equal(2);

      daemonServiceFluxnodeRpcs.getFluxNodeStatus.resolves({ status: 'success', data: { ip: '198.51.100.56' } });
      await pass('198.51.100.56:16127');
      const { movedAt, settledAt } = await fullRecord();
      expect(settledAt).to.equal(movedAt);
      daemonServiceFluxnodeRpcs.getFluxNodeStatus.resetHistory();
      await pass('198.51.100.56:16127');
      sinon.assert.notCalled(daemonServiceFluxnodeRpcs.getFluxNodeStatus);
      expect(confirm.callCount).to.equal(2);
    });

    it('takes a node out of service for its second IP change within 20 hours, as the record holds them across a restart', async () => {
      configure('198.51.100.57');
      await records.insertOne({ _id: 'own', socketAddress: '198.51.100.57:16127', movedFrom: null, recentIpChanges: [Date.now() - HOUR] });
      hosted.names.resolves(['removed']);
      sinon.stub(appUninstaller, 'uninstallApplication').resolves({ status: appUninstaller.UninstallStatus.REMOVED });

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.58:16127');

      sinon.assert.calledWith(appUninstaller.uninstallApplication, 'removed');
      expect(fluxNetworkMonitor.getMaxNumberOfIpChanges()).to.equal(2);
      fluxNetworkMonitor.setDosTooManyIpChanges(false);
    });

    it('counts no IP change older than 20 hours', async () => {
      configure('198.51.100.59');
      await records.insertOne({ _id: 'own', socketAddress: '198.51.100.59:16127', movedFrom: null, recentIpChanges: [Date.now() - 21 * HOUR] });
      const remove = sinon.stub(appUninstaller, 'uninstallApplication').resolves({ status: appUninstaller.UninstallStatus.REMOVED });

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.60:16127');

      sinon.assert.notCalled(remove);
      expect((await fullRecord()).recentIpChanges).to.have.lengthOf(1);
    });

    it('decides a move once when a second caller decides it again', async () => {
      configure('198.51.100.61');
      await adopt('198.51.100.61:16127');
      listedHere.resolves(['ranthere']);

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.62:16127');
      const { movedAt } = await fullRecord();
      await fluxNetworkMonitor.leaveConfiguredAddress('198.51.100.61:16127', '198.51.100.62:16127');

      expect((await fullRecord()).movedAt).to.equal(movedAt);
      expect((await fullRecord()).recentIpChanges).to.have.lengthOf(1);
      sinon.assert.calledOnce(moved);
    });

    it('rewrites no configured IP, handles no apps and counts nothing for a move of the port alone', async () => {
      configure('198.51.100.63');
      await adopt('198.51.100.63:16127');
      hosted.apps.resolves(installed({ name: 'stays' }));

      await fluxNetworkMonitor.handleOwnAddress('198.51.100.63:16157');

      sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
      sinon.assert.notCalled(restarted);
      expect((await fullRecord()).recentIpChanges).to.deep.equal([]);
      sinon.assert.calledOnce(moved);
    });
  });

  describe('the collision check', () => {
    let clock;
    // A pass that finds nothing answering at the listed address, and the pass that
    // judges it once the grace has run.
    const passesAcrossTheGrace = async () => {
      await fluxNetworkMonitor.checkDeterministicNodesCollisions();
      clock.tick(fluxNetworkMonitor.ANSWER_GRACE_MS);
      await fluxNetworkMonitor.checkDeterministicNodesCollisions();
    };

    beforeEach(() => {
      fluxNetworkMonitor.resetForTests();
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'Date'], shouldAdvanceTime: true });
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true });
      sinon.stub(networkStateService, 'isReady').returns(true);
      sinon.stub(nodeConfirmationService, 'isDaemonReachable').returns(true);
    });

    function collateralListedAt(listed, own) {
      sinon.stub(benchmarkService, 'getBenchmarks').resolves({ value: { ipaddress: own } });
      sinon.stub(fluxCommunicationUtils, 'deterministicFluxList').resolves([{ ip: listed, collateral: 'C' }]);
      sinon.stub(nodeConfirmationService, 'getNodeStatus').returns({ status: 'CONFIRMED', collateral: 'C', ip: own });
      daemonServiceFluxnodeRpcs.getFluxNodeStatus.resolves({ status: 'success', data: { status: 'CONFIRMED', collateral: 'C', ip: listed } });
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(false);
    }

    it('leaves a listing at the address this node recorded moving from to the move', async () => {
      configure('198.51.100.8');
      await adopt('198.51.100.8:16157', '198.51.100.8:16127');
      collateralListedAt('198.51.100.8:16127', '198.51.100.8:16157');

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      sinon.assert.notCalled(serviceHelper.axiosGet);
      sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
    });

    it('takes a listing at its own configured IP that nothing answers, where it ran apps, as its move, and adopts the new address', async () => {
      configure('198.51.100.9');
      collateralListedAt('198.51.100.9:16127', '198.51.100.9:16157');
      listedHere.withArgs('198.51.100.9:16127').resolves(['ranthere']);

      await passesAcrossTheGrace();

      sinon.assert.calledOnceWithExactly(moved, '198.51.100.9:16127', '198.51.100.9:16157', sinon.match.number);
      expect(await record()).to.deep.equal({ socketAddress: '198.51.100.9:16157', movedFrom: '198.51.100.9:16127' });
    });

    it('adopts nothing from a listing at its own configured IP that nothing answers, while whether it ran apps there cannot be read', async () => {
      configure('198.51.100.92');
      collateralListedAt('198.51.100.92:16127', '198.51.100.93:16127');
      listedHere.rejects(new Error('db down'));

      await passesAcrossTheGrace();

      sinon.assert.notCalled(moved);
      sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
      sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      expect(await record()).to.equal(null);
    });

    it('adopts the new address without a move from a listing at its own configured IP that nothing answers, where it ran no apps', async () => {
      configure('198.51.100.25');
      collateralListedAt('198.51.100.25:16127', '198.51.100.26:16127');

      await passesAcrossTheGrace();

      sinon.assert.notCalled(moved);
      sinon.assert.calledOnce(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      sinon.assert.calledWith(nodeIdentityRepository.setLastKnownIp, '198.51.100.26');
      expect(await record()).to.deep.equal({ socketAddress: '198.51.100.26:16127', movedFrom: '198.51.100.25:16127' });
    });

    it('leaves the configured address it adopted another beside, once nothing answers there, where it ran no apps', async () => {
      configure('198.51.100.31');
      await adopt('198.51.100.32:16127');
      collateralListedAt('198.51.100.31:16127', '198.51.100.32:16127');

      await passesAcrossTheGrace();

      sinon.assert.notCalled(moved);
      sinon.assert.calledOnce(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      sinon.assert.calledWith(nodeIdentityRepository.setLastKnownIp, '198.51.100.32');
      expect(await record()).to.deep.equal({ socketAddress: '198.51.100.32:16127', movedFrom: '198.51.100.31:16127' });
    });

    it('takes over a listing at another machine\'s IP that nothing answers, with a confirmation and no move', async () => {
      configure('198.51.100.27');
      collateralListedAt('198.51.100.28:16127', '198.51.100.27:16127');
      listedHere.resolves(['ranthere']);

      await passesAcrossTheGrace();

      sinon.assert.notCalled(moved);
      sinon.assert.calledOnce(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      sinon.assert.notCalled(nodeIdentityRepository.setLastKnownIp);
    });

    it('holds itself out of service while something answers at the address its collateral is listed at', async () => {
      configure('198.51.100.29');
      collateralListedAt('198.51.100.30:16127', '198.51.100.29:16127');
      serviceHelper.axiosGet.resolves({ data: { status: 'success' } });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      sinon.assert.notCalled(moved);
      sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      expect(nodeDosState.getDosStateValue()).to.equal(100);
      nodeDosState.setDosMessage(null);
      nodeDosState.setDosStateValue(0);
    });
  });
});
