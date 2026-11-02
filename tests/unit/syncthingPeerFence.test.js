'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const log = require('../../ZelBack/src/lib/log');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const peerIdentityService = require('../../ZelBack/src/services/peerIdentityService');
const syncthingPeerFence = require('../../ZelBack/src/services/appMonitoring/syncthingPeerFence');
const { buildDeviceConfiguration } = require('../../ZelBack/src/services/appMonitoring/syncthingMonitorHelpers');

// The peer fence: a replaced master is struck off the app's folders until it
// shows, in an answer it signed for the call, that it holds none of the app's
// activeStandby components. Silence, or an answer it cannot be shown to have
// signed, keeps the fence; timers appear nowhere.

const REPLACED = `${'7'.repeat(64)}:0`;
const REPLACED_HOST = '10.7.0.1';
// A pre-v9 app: its folder id is not its identifier, and a peer may hold it under either.
const NAMES = ['web_ab12cd34ef56', 'fluxweb_myapp'];

function membership() {
  return [
    {
      txhash: '7'.repeat(64), outidx: 0, pubkey: 'owner-7', ip: `${REPLACED_HOST}:16127`,
    },
    {
      txhash: '8'.repeat(64), outidx: 0, pubkey: 'owner-8', ip: '10.8.0.1:16127',
    },
  ];
}

const verified = (held) => ({ verdict: peerIdentityService.IdentityVerdict.VERIFIED, answer: { held } });

async function consult() {
  syncthingPeerFence.fenceFor('myapp', NAMES);
  await syncthingPeerFence.liftAsksSettled();
  return syncthingPeerFence.fenceFor('myapp', NAMES);
}

describe('syncthing peer fence', () => {
  beforeEach(() => {
    syncthingPeerFence.resetForTests();
    sinon.stub(networkStateService, 'membershipFingerprint').returns('f'.repeat(64));
    sinon.stub(networkStateService, 'membershipAt').returns(membership());
    sinon.stub(peerIdentityService, 'askSigned').resolves({ verdict: peerIdentityService.IdentityVerdict.UNREACHABLE });
  });

  afterEach(async () => {
    await syncthingPeerFence.liftAsksSettled();
    syncthingPeerFence.resetForTests();
    sinon.restore();
  });

  describe('raising', () => {
    it('is raised by the grant replacing another master', () => {
      let replaced = null;
      const fence = proxyquire('../../ZelBack/src/services/appMonitoring/syncthingPeerFence', {
        '../appLifecycle/mastershipGrantGate': { onMasterReplaced: (listener) => { replaced = listener; } },
      });
      expect(replaced, 'the fence listens for the grant replacing a master').to.be.a('function');
      replaced('myapp', REPLACED);
      expect(fence.fenceFor('myapp', NAMES).outpoint).to.equal(REPLACED);
    });

    it('a raised fence names the replaced node by host and address', () => {
      syncthingPeerFence.raiseFence('myapp', REPLACED);
      const fence = syncthingPeerFence.fenceFor('myapp', NAMES);
      expect(fence.host).to.equal(REPLACED_HOST);
      expect(fence.address).to.equal(`${REPLACED_HOST}:16127`);
      expect(fence.outpoint).to.equal(REPLACED);
    });

    it('a replaced node no longer on the list raises nothing', () => {
      syncthingPeerFence.raiseFence('myapp', `${'9'.repeat(64)}:0`);
      expect(syncthingPeerFence.fenceFor('myapp', NAMES)).to.equal(null);
    });
  });

  describe('lifting', () => {
    beforeEach(() => {
      syncthingPeerFence.raiseFence('myapp', REPLACED);
    });

    it('asks the replaced node what it holds, signed over the call', async () => {
      await consult();
      sinon.assert.calledWith(
        peerIdentityService.askSigned,
        `${REPLACED_HOST}:16127`,
        '/apps/heldcomponents',
        peerIdentityService.AnswerPurpose.HELD_COMPONENTS,
      );
    });

    it('silence keeps the fence - an unreachable node stays fenced', async () => {
      expect(await consult()).to.not.equal(null);
    });

    it('a signed answer holding none of the app\'s components lifts it', async () => {
      peerIdentityService.askSigned.resolves(verified(['other_ab12cd34ef99']));
      expect(await consult()).to.equal(null);
    });

    it('a node still holding a component under its identifier stays fenced', async () => {
      peerIdentityService.askSigned.resolves(verified(['web_ab12cd34ef56']));
      expect(await consult()).to.not.equal(null);
    });

    it('a node still holding a component under its folder id stays fenced', async () => {
      peerIdentityService.askSigned.resolves(verified(['fluxweb_myapp']));
      expect(await consult()).to.not.equal(null);
    });

    it('an answer that cannot be shown to be the node\'s own does not lift', async () => {
      peerIdentityService.askSigned.resolves({
        verdict: peerIdentityService.IdentityVerdict.UNVERIFIABLE, answer: { held: [] }, mayReadUnsigned: true,
      });
      expect(await consult()).to.not.equal(null);
    });

    it('a signed answer that does not list what it holds does not lift, and is not an error', async () => {
      const warn = sinon.stub(log, 'warn');
      peerIdentityService.askSigned.resolves({ verdict: peerIdentityService.IdentityVerdict.VERIFIED, answer: {} });
      expect(await consult()).to.not.equal(null);
      sinon.assert.notCalled(warn);
    });

    it('a failed ask keeps the fence', async () => {
      peerIdentityService.askSigned.rejects(new Error('boom'));
      expect(await consult()).to.not.equal(null);
    });

    it('asks once at a time however many folders consult the fence', async () => {
      syncthingPeerFence.fenceFor('myapp', NAMES);
      syncthingPeerFence.fenceFor('myapp', NAMES);
      syncthingPeerFence.fenceFor('myapp', NAMES);
      await syncthingPeerFence.liftAsksSettled();
      sinon.assert.calledOnce(peerIdentityService.askSigned);
    });

    it('a lift answers only the fence it was asked for, not one raised since', async () => {
      let answer;
      peerIdentityService.askSigned.returns(new Promise((resolve) => { answer = resolve; }));
      syncthingPeerFence.fenceFor('myapp', NAMES);
      syncthingPeerFence.raiseFence('myapp', REPLACED);
      answer(verified([]));
      await syncthingPeerFence.liftAsksSettled();
      expect(syncthingPeerFence.fenceFor('myapp', NAMES)).to.not.equal(null);
    });
  });

  describe('the folder device list under a fence', () => {
    beforeEach(() => {
      // Each device comes from the cache: the identity check finds nobody.
      sinon.stub(peerIdentityService, 'verifyPeer').resolves({ verdict: peerIdentityService.IdentityVerdict.UNREACHABLE });
    });

    async function builtDevices(fencedHost) {
      const deviceCache = new Map([
        [`${REPLACED_HOST}:16127`, `DEVICE-${'7'.repeat(8)}`],
        ['10.8.0.1:16127', `DEVICE-${'8'.repeat(8)}`],
      ]);
      const devicesConfiguration = [];
      const devicesIds = [];
      return buildDeviceConfiguration(
        [{ ip: `${REPLACED_HOST}:16127` }, { ip: '10.8.0.1:16127' }],
        '10.9.0.1:16127',
        'MY-DEVICE',
        deviceCache,
        devicesConfiguration,
        devicesIds,
        [],
        fencedHost,
      );
    }

    it('a fenced device is left off the folder, its peers stay on', async () => {
      const devices = await builtDevices(REPLACED_HOST);
      const ids = devices.map((device) => device.deviceID);
      expect(ids).to.include('MY-DEVICE');
      expect(ids).to.include(`DEVICE-${'8'.repeat(8)}`);
      expect(ids).to.not.include(`DEVICE-${'7'.repeat(8)}`);
    });

    it('no fence, full guest list', async () => {
      const devices = await builtDevices(null);
      expect(devices.map((device) => device.deviceID)).to.include(`DEVICE-${'7'.repeat(8)}`);
    });
  });
});
