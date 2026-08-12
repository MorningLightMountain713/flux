'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const mastershipGrantGate = require('../../ZelBack/src/services/quorumGrant/mastershipGrantGate');
const { buildDeviceConfiguration } = require('../../ZelBack/src/services/appMonitoring/syncthingMonitorHelpers');

// The peer fence: a deposed master that cannot clean up after itself is
// struck off the folder's device list until ITS OWN attestation — demoted
// and reverted — re-admits it. Silence keeps the fence; timers appear
// nowhere.

const DEPOSED = `${'7'.repeat(64)}:0`;
const DEPOSED_HOST = '10.7.0.1';

function membership() {
  return [
    {
      txhash: '7'.repeat(64), outidx: 0, pubkey: 'owner-7', ip: `${DEPOSED_HOST}:16127`,
    },
    {
      txhash: '8'.repeat(64), outidx: 0, pubkey: 'owner-8', ip: '10.8.0.1:16127',
    },
  ];
}

describe('quorumGrant peer fence', () => {
  beforeEach(() => {
    mastershipGrantGate.resetForTests({ enabled: true });
    sinon.stub(networkStateService, 'membershipFingerprint').returns('f'.repeat(64));
    sinon.stub(networkStateService, 'membershipAt').returns(membership());
    sinon.stub(serviceHelper, 'axiosPost').rejects(new Error('unreachable'));
  });

  afterEach(() => {
    mastershipGrantGate.resetForTests();
    sinon.restore();
  });

  describe('raising and holding', () => {
    it('a raised fence names the deposed node by host and address', () => {
      mastershipGrantGate.raiseFence('myapp', DEPOSED);
      const fence = mastershipGrantGate.fenceFor('myapp');
      expect(fence.host).to.equal(DEPOSED_HOST);
      expect(fence.address).to.equal(`${DEPOSED_HOST}:16127`);
      expect(fence.outpoint).to.equal(DEPOSED);
    });

    it('a deposed node no longer on the list raises nothing', () => {
      mastershipGrantGate.raiseFence('myapp', `${'9'.repeat(64)}:0`);
      expect(mastershipGrantGate.fenceFor('myapp')).to.equal(null);
    });

    it('silence keeps the fence — an unreachable node stays fenced', async () => {
      mastershipGrantGate.raiseFence('myapp', DEPOSED);
      mastershipGrantGate.fenceFor('myapp'); // kicks the lift poll
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(mastershipGrantGate.fenceFor('myapp')).to.not.equal(null);
    });

    it('the deposed node\'s own attestation lifts the fence', async () => {
      serviceHelper.axiosPost.resolves({
        data: { status: 'success', data: { holding: false, folderDemotedAt: 12345 } },
      });
      mastershipGrantGate.raiseFence('myapp', DEPOSED);
      mastershipGrantGate.fenceFor('myapp');
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(mastershipGrantGate.fenceFor('myapp')).to.equal(null);
    });

    it('an attestation from a node that still claims to hold does not lift', async () => {
      serviceHelper.axiosPost.resolves({
        data: { status: 'success', data: { holding: true, folderDemotedAt: 12345 } },
      });
      mastershipGrantGate.raiseFence('myapp', DEPOSED);
      mastershipGrantGate.fenceFor('myapp');
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(mastershipGrantGate.fenceFor('myapp')).to.not.equal(null);
    });

    it('a reply without the attestation does not lift', async () => {
      serviceHelper.axiosPost.resolves({
        data: { status: 'success', data: { holding: false, folderDemotedAt: null } },
      });
      mastershipGrantGate.raiseFence('myapp', DEPOSED);
      mastershipGrantGate.fenceFor('myapp');
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(mastershipGrantGate.fenceFor('myapp')).to.not.equal(null);
    });
  });

  describe('the folder device list under a fence', () => {
    async function builtDevices(fencedHost) {
      const deviceCache = new Map([
        [`${DEPOSED_HOST}:16127`, `DEVICE-${'7'.repeat(8)}`],
        ['10.8.0.1:16127', `DEVICE-${'8'.repeat(8)}`],
      ]);
      const devicesConfiguration = [];
      const devicesIds = [];
      return buildDeviceConfiguration(
        [{ ip: `${DEPOSED_HOST}:16127` }, { ip: '10.8.0.1:16127' }],
        '10.9.0.1:16127',
        'MY-DEVICE',
        deviceCache,
        devicesConfiguration,
        devicesIds,
        { data: [] },
        fencedHost,
      );
    }

    it('a fenced device is left off the folder, its peers stay on', async () => {
      const devices = await builtDevices(DEPOSED_HOST);
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
