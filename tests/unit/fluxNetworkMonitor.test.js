'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const { stubHostedInstances } = require('./fixtures/appRecords');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const daemonServiceFluxnodeRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceFluxnodeRpcs');
const nodeConfirmationService = require('../../ZelBack/src/services/nodeConfirmationService');
const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const geolocationService = require('../../ZelBack/src/services/geolocationService');
const fluxNetworkMonitor = require('../../ZelBack/src/services/fluxNetworkMonitor');
const nodeDosState = require('../../ZelBack/src/services/nodeDosState');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const { requireMongo } = require('./dbTestHelper');
const log = require('../../ZelBack/src/lib/log');
const availabilitySourceTest = require('../../ZelBack/src/services/utils/availabilitySourceTest');

chai.use(chaiAsPromised);

describe('fluxNetworkMonitor tests', () => {
  // adjustExternalIP fires setNodeGeolocation() without awaiting it; left real it does
  // a live ip-api lookup that writes nondeterministic geolocation to the shared test DB
  // (polluting suites that read it) and self-reschedules a 10s retry that outlives the
  // test. Neutralise it for every real-module describe in this file.
  beforeEach(() => {
    fluxNetworkMonitor.resetForTests();
    sinon.stub(geolocationService, 'setNodeGeolocation').resolves();
  });

  describe('checkMyFluxAvailability tests', () => {
    let getRandomExternalObserver;
    let uninstallApplication;

    before(requireMongo);

    beforeEach(() => {
      // An IP change here must never remove an app: the list is this test's, not
      // whatever another suite left in the shared database, and the uninstaller
      // is a canary asserted untouched.
      stubHostedInstances().apps.resolves([]);
      uninstallApplication = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      fluxNetworkHelper.setStoredFluxBenchAllowed('6.2.0');
      fluxNetworkHelper.setLocalSocketAddress('129.3.3.3');
      const deterministicFluxnodeListResponse = [
        {
          collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: '129.1.1.1',
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      sinon.stub(fluxCommunicationUtils, 'deterministicFluxList').returns(deterministicFluxnodeListResponse);
      sinon.stub(daemonServiceFluxnodeRpcs, 'createConfirmationTransaction').returns(true);
      sinon.stub(serviceHelper, 'delay').returns(true);
      // The peer this asks is an EXTERNAL observer, not any random node:
      // a node sharing our public address cannot answer whether the outside
      // world can reach us, because reaching us means leaving the router and
      // being sent straight back in. networkStateService exports both, and the
      // suite stubbed the other one - so the real observer lookup ran, found
      // nobody, and the function returned false before any of this mattered.
      getRandomExternalObserver = sinon.stub(networkStateService, 'getRandomExternalObserver');
    });

    afterEach(() => {
      nodeDosState.resetAvailabilityDos();
      nodeDosState.setDosStateValue(0);
      nodeDosState.setDosMessage(null);
      sinon.assert.notCalled(uninstallApplication);
      sinon.restore();
    });

    it('should return false if the flux bench version is lower than allowed', async () => {
      fluxNetworkHelper.setStoredFluxBenchAllowed('2.0.0');

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return false if fluxIp is null', async () => {
      fluxNetworkHelper.setLocalSocketAddress(null);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return false if axsiosGet throws error', async () => {
      sinon.stub(serviceHelper, 'axiosGet').rejects();

      getRandomExternalObserver.resolves('1.2.3.4:16127');

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return false if axsiosGet resolves null', async () => {
      sinon.stub(serviceHelper, 'axiosGet').resolves(null);

      getRandomExternalObserver.resolves('1.2.3.4:16127');

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });

    it('should return true if axios status response is success', async () => {
      const axiosGetResponse = {
        data: {
          status: 'success',
          data: {
            message: 'all is good!',
          },
        },
      };

      getRandomExternalObserver.resolves('1.2.3.4:16127');
      sinon.stub(serviceHelper, 'axiosGet').resolves(axiosGetResponse);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.true;
    });

    // The observer's call to this node carries the ask's nonce; the address it came
    // from is checked against the observer's own.
    describe('the source of the observer\'s call', () => {
      const answered = (from) => sinon.stub(serviceHelper, 'axiosGet').callsFake(async (url) => {
        const nonce = new URL(url).searchParams.get('nonce');
        if (from) availabilitySourceTest.record(nonce, from);
        return { data: { status: 'success', data: { message: 'all is good!' } } };
      });

      it('asks each observer with a nonce of its own', async () => {
        getRandomExternalObserver.resolves('1.2.3.4:16127');
        const axiosGet = answered('1.2.3.4');
        await fluxNetworkMonitor.checkMyFluxAvailability();
        const [url] = axiosGet.firstCall.args;
        expect(new URL(url).searchParams.get('nonce')).to.match(/^[0-9a-f]{32}$/);
      });

      it('holds a node every observer reaches from an address other than its own, and says why', async () => {
        getRandomExternalObserver.resolves('1.2.3.4:16127');
        answered('10.9.9.9');

        const result = await fluxNetworkMonitor.checkMyFluxAvailability();

        expect(result).to.equal(false);
        expect(nodeDosState.getRawDosMessage()).to.equal(nodeDosState.SOURCE_NAT_MESSAGE);
      });

      it('takes a call from the observer\'s own address as no evidence', async () => {
        getRandomExternalObserver.resolves('1.2.3.4:16127');
        answered('::ffff:1.2.3.4');
        expect(await fluxNetworkMonitor.checkMyFluxAvailability()).to.equal(true);
      });

      it('takes an observer that sent no nonce as no evidence', async () => {
        getRandomExternalObserver.resolves('1.2.3.4:16127');
        answered(null);
        expect(await fluxNetworkMonitor.checkMyFluxAvailability()).to.equal(true);
        expect(nodeDosState.getRawDosMessage()).to.not.equal(nodeDosState.SOURCE_NAT_MESSAGE);
      });
    });

    it('a node reachable from outside but short of peers past the DOS threshold is held, with the shortfall as the reason', async () => {
      getRandomExternalObserver.resolves('1.2.3.4:16127');
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { message: 'all is good!' } } });
      sinon.stub(fluxNetworkHelper, 'fluxUptime').returns(config.get('fluxapps.minUpTime') + 1);
      sinon.stub(fluxCommunicationUtils, 'getFluxnodeFromFluxList').resolves({ ip: '129.3.3.3' });
      sinon.stub(fluxCommunicationUtils, 'getNodeCount').resolves(config.get('fluxapps.minIncoming') + config.get('fluxapps.minOutgoing') + 1);
      sinon.stub(fluxNetworkHelper, 'isCommunicationEstablished').returns({ established: false, reason: 'too few outgoing peers' });
      nodeDosState.setDosStateValue(11);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
      expect(nodeDosState.getRawDosMessage()).to.equal('too few outgoing peers');
      nodeDosState.resetAvailabilityDos();
      nodeDosState.setDosStateValue(0);
      nodeDosState.setDosMessage(null);
    });

    describe('a good pass ends only what this check counted', () => {
      const ROUTER_DOS = 'Not possible to run applications on the node, router returning exceptions when creating UPNP ports mappings';

      beforeEach(() => {
        getRandomExternalObserver.resolves('1.2.3.4:16127');
        sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'success', data: { message: 'all is well' } } });
        sinon.stub(fluxNetworkHelper, 'fluxUptime').returns(0);
      });

      afterEach(() => {
        nodeDosState.resetAvailabilityDos();
        nodeDosState.setDosStateValue(0);
        nodeDosState.setDosMessage(null);
      });

      it('leaves another check\'s DOS standing', async () => {
        nodeDosState.setDosStateValue(100);
        nodeDosState.setDosMessage(ROUTER_DOS);

        await fluxNetworkMonitor.checkMyFluxAvailability();

        expect(nodeDosState.getRawDosMessage()).to.equal(ROUTER_DOS);
        expect(nodeDosState.isNodeDos()).to.equal(true);
      });

      it('ends what it counted against reaching the node, and its message', async () => {
        nodeDosState.countUnreachable(20);
        nodeDosState.holdAvailabilityDos(nodeDosState.UNREACHABLE_MESSAGE);

        await fluxNetworkMonitor.checkMyFluxAvailability();

        expect(nodeDosState.effectiveDosState()).to.equal(0);
        expect(nodeDosState.getRawDosMessage()).to.equal(null);
      });

      it('ends what it counted while another check\'s DOS stands, leaving that one', async () => {
        nodeDosState.setDosStateValue(100);
        nodeDosState.setDosMessage(ROUTER_DOS);
        nodeDosState.countUnreachable(20);

        await fluxNetworkMonitor.checkMyFluxAvailability();

        expect(nodeDosState.effectiveDosState()).to.equal(100);
        expect(nodeDosState.getRawDosMessage()).to.equal(ROUTER_DOS);
      });

      it('ends a failed UPnP mapping at boot, the node being reached over its api port', async () => {
        nodeDosState.addDosState(11);
        nodeDosState.setDosMessage('UPnP is enabled for this node but mapping port 16127 failed');

        await fluxNetworkMonitor.checkMyFluxAvailability();

        expect(nodeDosState.effectiveDosState()).to.equal(0);
        expect(nodeDosState.getRawDosMessage()).to.equal(null);
      });
    });

    it('an unreachable node whose benchmark cannot say its public IP is held, and says why', async () => {
      const getPublicIp = sinon.stub(benchmarkService, 'getPublicIp').returns({ value: null, reason: { message: 'benchmark down' } });
      getRandomExternalObserver.resolves('1.2.3.4:16127');
      sinon.stub(serviceHelper, 'axiosGet').resolves({ data: { status: 'error', data: { message: 'not reachable' } } });
      nodeDosState.setDosStateValue(11);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
      sinon.assert.calledOnce(getPublicIp);
      expect(nodeDosState.getRawDosMessage()).to.equal('Error getting publicIp from FluxBench');
      nodeDosState.resetAvailabilityDos();
      nodeDosState.setDosStateValue(0);
      nodeDosState.setDosMessage(null);
    });

    it('should return true if getPublicIp status is a success and has a proper ip', async () => {
      const readAddress = sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('129.0.0.1:16127');
      const getPublicIptResponse = { value: '129.0.0.1' };
      sinon.stub(benchmarkService, 'getPublicIp').returns(getPublicIptResponse);
      const axiosGetResponse = {
        data: {
          status: 'error',
          data: {
            message: 'all is good!',
          },
        },
      };

      getRandomExternalObserver.resolves('1.2.3.4:16127');
      sinon.stub(serviceHelper, 'axiosGet').resolves(axiosGetResponse);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.true;
      sinon.assert.calledOnceWithExactly(readAddress, { fresh: true });
    });

    it('should return false if getPublicIp status is a success but does not have a proper ip', async () => {
      const getPublicIptResponse = { value: '120' };
      sinon.stub(benchmarkService, 'getPublicIp').returns(getPublicIptResponse);
      const axiosGetResponse = {
        data: {
          status: 'error',
          data: {
            message: 'all is good!',
          },
        },
      };
      sinon.stub(serviceHelper, 'axiosGet').resolves(axiosGetResponse);

      const result = await fluxNetworkMonitor.checkMyFluxAvailability();

      expect(result).to.be.false;
    });
  });

  describe('checkDeterministicNodesCollisions tests', () => {
    let getBenchmarksStub;
    let daemonSyncStateStub;
    let deterministicFluxListStub;
    let getNodeStatusStub;
    let isDaemonReachableStub;
    let isReadyStub;
    let deterministicFluxnodeListResponse;

    const versionAsks = (axiosGetStub) => axiosGetStub.getCalls().filter((call) => String(call.args[0]).endsWith('/flux/version'));
    const peersAnswer = (axiosGetStub) => axiosGetStub.withArgs(sinon.match(/\/flux\/checkfluxavailability/));

    beforeEach(() => {
      let drawn = 0;
      sinon.stub(networkStateService, 'getRandomExternalObserver').callsFake(async () => {
        drawn += 1;
        return drawn <= 5 ? `198.51.100.${drawn}:16127` : null;
      });
      // EVERY path through this check re-arms itself on a timer (60s / 120s / 240s).
      // Left on the real clock those outlive the test, fire once sinon.restore() has
      // put the real collaborators back, and dial the benchmark RPC for real - which
      // the no-real-network guard reports against whichever unrelated test happened to
      // be running minutes later. Faking the clock for the whole block is what stops a
      // re-arm ever escaping; sinon.restore() in afterEach takes it away again.
      sinon.useFakeTimers();
      fluxNetworkHelper.setStoredFluxBenchAllowed('6.2.0');
      fluxNetworkHelper.setLocalSocketAddress('129.3.3.3');
      sinon.stub(daemonServiceFluxnodeRpcs, 'createConfirmationTransaction').returns(true);
      sinon.stub(serviceHelper, 'delay').returns(true);
      // The collision path probes the other node's /flux/version over HTTP; the
      // fixture IPs below are addresses this test must never actually dial.
      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('unreachable'));
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      deterministicFluxnodeListResponse = [
        {
          collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: '127.0.0.1:5050',
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        }];
      getBenchmarksStub = sinon.stub(benchmarkService, 'getBenchmarks');
      daemonSyncStateStub = sinon.stub(daemonStatus, 'daemonSyncState');
      deterministicFluxListStub = sinon.stub(fluxCommunicationUtils, 'deterministicFluxList');
      getNodeStatusStub = sinon.stub(nodeConfirmationService, 'getNodeStatus');
      isDaemonReachableStub = sinon.stub(nodeConfirmationService, 'isDaemonReachable').returns(true);
      // The list accessors wait for the network state to arrive, so the check
      // returns and re-arms until it has. Unstubbed that is false for the whole
      // suite: five collision tests failed on a DOS state nothing had set, and
      // the daemon-unreachable test below passed without reaching the gate it
      // names. The ordinary state is a node whose list is in.
      isReadyStub = sinon.stub(networkStateService, 'isReady').returns(true);
      nodeDosState.setDosMessage(null);
      nodeDosState.setDosStateValue(0);
    });

    afterEach(() => {
      sinon.restore();
      fluxNetworkHelper.setLocalSocketAddress(null);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should skip the check entirely when the daemon is unreachable', async () => {
      daemonSyncStateStub.returns({ synced: true });
      isDaemonReachableStub.returns(false);

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      // Both inputs come from the daemon; without a current answer the check would
      // only restate last cycle's conclusion.
      sinon.assert.notCalled(deterministicFluxListStub);
      sinon.assert.notCalled(getNodeStatusStub);
      expect(nodeDosState.getDosMessage()).to.be.null;
    });

    it('should skip the check entirely until the network state is ready', async () => {
      daemonSyncStateStub.returns({ synced: true });
      isReadyStub.returns(false);

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      // Reading an unknown list is worse than not reading one: every branch below
      // concludes this node is not in the confirmed list and skips the
      // availability check that is the only thing which clears its DOS state.
      sinon.assert.notCalled(deterministicFluxListStub);
      sinon.assert.notCalled(getNodeStatusStub);
      expect(nodeDosState.getDosMessage()).to.be.null;
    });

    it('should not change dosMessage', async () => {
      const ip = '127.0.0.1:5050';
      const getBenchmarkResponseData = { value: { ipaddress: ip } };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      daemonSyncStateStub.returns({ synced: true });
      deterministicFluxListStub.returns(deterministicFluxnodeListResponse);
      getNodeStatusStub.returns({
        status: 'CONFIRMED',
        collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
      });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(nodeDosState.getDosMessage()).to.be.null;
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('should skip availability check when node status is not CONFIRMED', async () => {
      const ip = '127.0.0.1:5050';
      const getBenchmarkResponseData = { value: { ipaddress: ip } };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      daemonSyncStateStub.returns({ synced: true });
      // Node is not in the deterministic list (expired)
      deterministicFluxListStub.returns([]);
      getNodeStatusStub.returns({
        status: 'expired',
        collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
      });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      // Node is expired and not in list — availability check is skipped, no DOS penalty
      expect(nodeDosState.getDosMessage()).to.be.null;
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('should skip availability check when IP is not in confirmed flux list', async () => {
      const ip = '127.0.0.1:5050';
      const getBenchmarkResponseData = { value: { ipaddress: ip } };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      daemonSyncStateStub.returns({ synced: true });
      deterministicFluxListStub.returns(deterministicFluxnodeListResponse);
      getNodeStatusStub.returns({
        status: 'CONFIRMED',
        collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
      });
      // Our IP changed and is not in the confirmed list
      fluxCommunicationUtils.socketAddressInFluxList.resolves(false);

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      // CONFIRMED but IP not in list — availability check is skipped, no DOS penalty
      expect(nodeDosState.getDosMessage()).to.be.null;
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('should find the same node instances and warn about earlier collision detection', async () => {
      const multipleNodesList = [
        deterministicFluxnodeListResponse[0],
        {
          collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: '127.0.0.1:5050',
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      const ip = '127.0.0.1:5050';
      fluxNetworkHelper.setLocalSocketAddress(ip);
      const getBenchmarkResponseData = { value: { ipaddress: ip } };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      daemonSyncStateStub.returns({ synced: true });
      deterministicFluxListStub.returns(multipleNodesList);
      getNodeStatusStub.returns({
        collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)',
      });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(nodeDosState.getDosMessage()).to.equal('Flux earlier collision detection on ip:127.0.0.1:5050');
      expect(nodeDosState.getDosStateValue()).to.equal(100);
    });

    it('should trigger collision detection if the collateral is not matching', async () => {
      const ip = '127.0.0.1:5050';
      fluxNetworkHelper.setLocalSocketAddress(ip);
      const getBenchmarkResponseData = { value: { ipaddress: ip } };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      daemonSyncStateStub.returns({ synced: true });
      deterministicFluxListStub.returns(deterministicFluxnodeListResponse);
      getNodeStatusStub.returns({
        collateral: 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e123556, 0)',
      });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(nodeDosState.getDosMessage()).to.equal('Flux collision detection. Another ip:port is confirmed on flux network with the same collateral transaction information.');
      expect(nodeDosState.getDosStateValue()).to.equal(100);
    });

    it('should trigger collision detection when same collateral exists on different IP and other node is reachable', async () => {
      const myIp = '192.168.1.100:16127';
      const otherIp = '192.168.1.200:16127';
      fluxNetworkHelper.setLocalSocketAddress(myIp);
      const sharedCollateral = 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)';
      const nodeListWithDifferentIp = [
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: myIp,
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: otherIp,
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      const getBenchmarkResponseData = { value: { ipaddress: myIp } };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      daemonSyncStateStub.returns({ synced: true });
      deterministicFluxListStub.returns(nodeListWithDifferentIp);
      getNodeStatusStub.returns({
        status: 'CONFIRMED',
        collateral: sharedCollateral,
      });

      // Mock successful axios call - other node is reachable
      const axiosGetStub = serviceHelper.axiosGet.resolves({ data: { version: '6.0.0' } });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(axiosGetStub.calledOnce).to.be.true;
      expect(axiosGetStub.firstCall.args[0]).to.include('192.168.1.200:16127');
      expect(nodeDosState.getDosMessage()).to.include('Node at 192.168.1.200:16127 is confirmed and reachable');
      expect(nodeDosState.getDosStateValue()).to.equal(100);
    });

    it('should take over collateral when same collateral exists on different IP and other node is unreachable after grace period', async () => {
      const myIp = '192.168.1.100:16127';
      const otherIp = '192.168.1.200:16127';
      fluxNetworkHelper.setLocalSocketAddress(myIp);
      const sharedCollateral = 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)';
      const nodeListWithDifferentIp = [
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: myIp,
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: otherIp,
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      const getBenchmarkResponseData = { value: { ipaddress: myIp } };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      daemonSyncStateStub.returns({ synced: true });
      deterministicFluxListStub.returns(nodeListWithDifferentIp);
      getNodeStatusStub.returns({
        status: 'CONFIRMED',
        collateral: sharedCollateral,
      });

      // the other node unreachable from here, and to the peers asked
      const axiosGetStub = serviceHelper.axiosGet.rejects(new Error('Connection refused'));
      peersAnswer(axiosGetStub).resolves({ data: { status: 'error' } });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(versionAsks(axiosGetStub)).to.have.lengthOf(2);
      sinon.assert.calledOnce(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      // DOS state should remain clear since we successfully took over
      expect(nodeDosState.getDosStateValue()).to.equal(0);
    });

    it('should handle case when other node comes back online during grace period', async () => {
      const myIp = '192.168.1.100:16127';
      const otherIp = '192.168.1.200:16127';
      fluxNetworkHelper.setLocalSocketAddress(myIp);
      const sharedCollateral = 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)';
      const nodeListWithDifferentIp = [
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: myIp,
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
        {
          collateral: sharedCollateral,
          txhash: '38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174',
          outidx: '0',
          ip: otherIp,
          network: '',
          added_height: 1_076_533,
          confirmed_height: 1_076_535,
          last_confirmed_height: 1_079_888,
          last_paid_height: 1_077_653,
          tier: 'CUMULUS',
          payment_address: 't1Z6mWoCrFC2g3iTCFdFkYdTfwtG84E3y2o',
          pubkey: '04378c8585d45861c8783f9c8cd0c85478164c12ce3fd13af1b44ebc8fe1ad6c786e92b211cb9566c596b6e2454d394a06bc44f748afb3c9ee48caa096d704abac',
          activesince: '1647197272',
          lastpaid: '1647333786',
          amount: '1000.00',
          rank: 0,
        },
      ];
      const getBenchmarkResponseData = { value: { ipaddress: myIp } };
      getBenchmarksStub.resolves(getBenchmarkResponseData);
      daemonSyncStateStub.returns({ synced: true });
      deterministicFluxListStub.returns(nodeListWithDifferentIp);
      getNodeStatusStub.returns({
        status: 'CONFIRMED',
        collateral: sharedCollateral,
      });

      // Mock axios to fail first call but succeed on second (node comes back online)
      const axiosGetStub = serviceHelper.axiosGet;
      axiosGetStub.onFirstCall().rejects(new Error('Connection refused'));
      axiosGetStub.onSecondCall().resolves({ data: { version: '6.0.0' } });

      await fluxNetworkMonitor.checkDeterministicNodesCollisions();

      expect(axiosGetStub.calledTwice).to.be.true;
      sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
      expect(nodeDosState.getDosStateValue()).to.equal(100);
    });

    describe('when this node cannot reach the other node after the grace', () => {
      const collateral = 'COutPoint(38c04da72786b08adb309259cdd6d2128ea9059d0334afca127a5dc4e75bf174, 0)';
      let axiosGetStub;
      let peerAsks;

      beforeEach(() => {
        fluxNetworkHelper.setLocalSocketAddress('192.168.1.101:16127');
        getBenchmarksStub.resolves({ value: { ipaddress: '192.168.1.101:16127' } });
        daemonSyncStateStub.returns({ synced: true });
        deterministicFluxListStub.returns([{ ...deterministicFluxnodeListResponse[0], collateral, ip: '192.168.1.201:16127' }]);
        getNodeStatusStub.returns({ status: 'CONFIRMED', collateral });
        axiosGetStub = serviceHelper.axiosGet.rejects(new Error('Connection refused'));
        peerAsks = peersAnswer(axiosGetStub);
      });

      it('holds itself out of service when a peer can', async () => {
        peerAsks.onFirstCall().resolves({ data: { status: 'error' } });
        peerAsks.onSecondCall().resolves({ data: { status: 'success' } });

        await fluxNetworkMonitor.checkDeterministicNodesCollisions();

        expect(versionAsks(axiosGetStub), 'fixture: it could not reach the other node itself').to.have.lengthOf(2);
        sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
        expect(nodeDosState.getDosStateValue()).to.equal(100);
      });

      it('takes nothing over once one peer reaches the other node, whatever the peers asked after it would say', async () => {
        peerAsks.resolves({ data: { status: 'error' } });
        peerAsks.onFirstCall().resolves({ data: { status: 'success' } });

        await fluxNetworkMonitor.checkDeterministicNodesCollisions();

        sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
        expect(nodeDosState.getDosStateValue()).to.equal(100);
      });

      it('takes nothing over while too few peers answer whether the other node is there', async () => {
        await fluxNetworkMonitor.checkDeterministicNodesCollisions();

        expect(peerAsks.callCount, 'every peer drawn was asked').to.equal(5);
        sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
        expect(nodeDosState.getDosStateValue(), 'no collision is claimed on too few answers').to.equal(0);
      });

      it('takes nothing over while the peers asked do not list the other node', async () => {
        peerAsks.resolves({ data: { status: 'error', data: { message: fluxNetworkHelper.NOT_LISTED_MESSAGE } } });

        await fluxNetworkMonitor.checkDeterministicNodesCollisions();

        sinon.assert.notCalled(daemonServiceFluxnodeRpcs.createConfirmationTransaction);
        expect(nodeDosState.getDosStateValue(), 'a peer that has not looked finds nothing either way').to.equal(0);
      });
    });
  });

  describe('ipChangesOverLimit', () => {
    let uninstallApplication;
    let hosted;

    beforeEach(() => {
      hosted = stubHostedInstances();
      uninstallApplication = sinon.stub(appUninstaller, 'uninstallApplication').resolves();
      sinon.stub(serviceHelper, 'delay').resolves();
    });

    afterEach(() => {
      sinon.restore();
      fluxNetworkMonitor.setDosTooManyIpChanges(false);
    });

    it('a first change within the window removes nothing', async () => {
      hosted.names.resolves(['alpha']);

      expect(await fluxNetworkMonitor.ipChangesOverLimit(1)).to.equal(false);
      sinon.assert.notCalled(uninstallApplication);
    });

    it('a second change within the window removes every hosted app without a broadcast', async () => {
      hosted.names.resolves(['alpha', 'beta']);

      expect(await fluxNetworkMonitor.ipChangesOverLimit(2)).to.equal(true);

      expect(uninstallApplication.args).to.deep.equal([['alpha', { forceKill: true }], ['beta', { forceKill: true }]]);
    });

    it('a second change when the hosted apps cannot be read removes nothing, logs it and still reports the limit', async () => {
      hosted.names.rejects(new Error('mongo down'));
      const logError = sinon.stub(log, 'error');

      expect(await fluxNetworkMonitor.ipChangesOverLimit(2)).to.equal(true);

      sinon.assert.notCalled(uninstallApplication);
      sinon.assert.calledWithMatch(logError, /cannot list the hosted apps: mongo down/);
    });
  });
});
