'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const axios = require('axios');
const fsp = require('node:fs/promises');
const path = require('node:path');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const volumeService = require('../../ZelBack/src/services/utils/volumeService');
const syncthingService = require('../../ZelBack/src/services/syncthingService');
const log = require('../../ZelBack/src/lib/log');
const helpers = require('../../ZelBack/src/services/appMonitoring/syncthingMonitorHelpers');
const peerIdentityService = require('../../ZelBack/src/services/peerIdentityService');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');

const { IdentityVerdict } = peerIdentityService;

describe('syncthingMonitorHelpers tests', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('sortAndFilterLocations', () => {
    it('should sort locations by IP address', () => {
      const locations = [
        { ip: '10.0.0.3:16127' },
        { ip: '10.0.0.1:16127' },
        { ip: '10.0.0.2:16127' },
      ];
      const myIP = '10.0.0.4:16127';

      const result = helpers.sortAndFilterLocations(locations, myIP);

      expect(result).to.have.lengthOf(3);
      expect(result[0].ip).to.equal('10.0.0.1:16127');
      expect(result[1].ip).to.equal('10.0.0.2:16127');
      expect(result[2].ip).to.equal('10.0.0.3:16127');
    });

    it('should filter out current node IP', () => {
      const locations = [
        { ip: '10.0.0.1:16127' },
        { ip: '10.0.0.2:16127' },
        { ip: '10.0.0.3:16127' },
      ];
      const myIP = '10.0.0.2:16127';

      const result = helpers.sortAndFilterLocations(locations, myIP);

      expect(result).to.have.lengthOf(2);
      expect(result.find((loc) => loc.ip === myIP)).to.be.undefined;
    });

    it('should handle empty locations', () => {
      const result = helpers.sortAndFilterLocations([], '10.0.0.1:16127');
      expect(result).to.be.an('array').that.is.empty;
    });
  });

  describe('getContainerFolderPath', () => {
    it('should return /appdata for first container (primary mount)', () => {
      const containersData = ['/data', 'r:/config'];
      const result = helpers.getContainerFolderPath(containersData, 0);
      expect(result).to.equal('/appdata');
    });

    it('should return path at same level as appdata for subsequent containers', () => {
      const containersData = ['/data', 'r:/data/config'];
      const result = helpers.getContainerFolderPath(containersData, 1);
      expect(result).to.equal('/config');
    });

    it('should handle multiple nested paths', () => {
      const containersData = ['/app', 'r:/app/data/sub'];
      const result = helpers.getContainerFolderPath(containersData, 1);
      expect(result).to.equal('/data/sub');
    });
  });

  describe('createSyncthingFolderConfig', () => {
    it('builds the fields the monitor owns, and no type', () => {
      const devices = [{ deviceID: 'ABC123' }];
      const result = helpers.createSyncthingFolderConfig(
        'test-id',
        'test-label',
        '/path/to/folder',
        devices,
      );

      expect(result).to.deep.include({
        id: 'test-id',
        label: 'test-label',
        path: '/path/to/folder',
        paused: false,
        rescanIntervalS: 900,
        maxConflicts: 0,
        syncOwnership: true,
      });
      expect(result.devices).to.deep.equal(devices);
      expect(result, 'a type left in would be written whenever any field changes').to.not.have.property('type');
    });
  });

  describe('folderNeedsUpdate', () => {
    // The folder as syncthing returns it: devices sorted, once each, in its
    // full shape, and fields the monitor never writes.
    const held = () => ({
      id: 'fluxweb_app',
      label: 'fluxweb_app',
      path: '/apps/fluxweb_app',
      type: 'receiveonly',
      paused: false,
      rescanIntervalS: 900,
      maxConflicts: 0,
      syncOwnership: true,
      fsWatcherEnabled: true,
      markerName: '.stfolder',
      devices: ['AAA', 'MINE', 'ZZZ'].map((deviceID) => ({ deviceID, introducedBy: '', encryptionPassword: '' })),
    });
    // The config the monitor builds for it: its own device first, peers in the
    // order it found them.
    const built = (type = 'receiveonly') => ({
      ...helpers.createSyncthingFolderConfig('fluxweb_app', 'fluxweb_app', '/apps/fluxweb_app',
        ['MINE', 'ZZZ', 'AAA'].map((deviceID) => ({ deviceID }))),
      ...(type ? { type } : {}),
    });

    it('writes a folder syncthing does not have', () => {
      expect(helpers.folderNeedsUpdate(null, built())).to.equal(true);
    });

    it('writes nothing when syncthing holds what the monitor would write, whatever order and shape it holds the devices in', () => {
      expect(helpers.folderNeedsUpdate(held(), built())).to.equal(false);
    });

    it('writes a folder any field of which differs from what the monitor would write', () => {
      const fields = Object.keys(built()).filter((field) => field !== 'devices');
      expect(fields, 'fixture: the built config names the fields the monitor writes').to.include.members(['path', 'label', 'paused', 'type', 'rescanIntervalS', 'maxConflicts', 'syncOwnership']);
      fields.forEach((field) => {
        const differs = { ...held(), [field]: `not ${held()[field]}` };
        expect(helpers.folderNeedsUpdate(differs, built()), field).to.equal(true);
      });
    });

    it('writes a folder whose devices gained, lost or swapped one', () => {
      const withDevices = (ids) => ({ ...held(), devices: ids.map((deviceID) => ({ deviceID, introducedBy: '', encryptionPassword: '' })) });
      expect(helpers.folderNeedsUpdate(withDevices(['AAA', 'MINE']), built()), 'lost').to.equal(true);
      expect(helpers.folderNeedsUpdate(withDevices(['AAA', 'MINE', 'NEW', 'ZZZ']), built()), 'gained').to.equal(true);
      expect(helpers.folderNeedsUpdate(withDevices(['AAA', 'MINE', 'NEW']), built()), 'swapped').to.equal(true);
    });

    it('does not compare the type of a folder config that carries none', () => {
      expect(helpers.folderNeedsUpdate({ ...held(), type: 'sendreceive' }, built('receiveonly')), 'fixture: a differing type is a change').to.equal(true);

      expect(helpers.folderNeedsUpdate({ ...held(), type: 'sendreceive' }, built(null))).to.equal(false);
    });

    it('does not compare a field the monitor does not write', () => {
      expect(helpers.folderNeedsUpdate({ ...held(), fsWatcherEnabled: false, markerName: 'other' }, built())).to.equal(false);
    });
  });

  describe('sortRunningAppList', () => {
    it('should sort by runningSince first', () => {
      const appList = [
        { ip: '10.0.0.1', runningSince: 2000, broadcastedAt: 1000 },
        { ip: '10.0.0.2', runningSince: null, broadcastedAt: 1000 },
        { ip: '10.0.0.3', runningSince: 1000, broadcastedAt: 1000 },
      ];

      const result = helpers.sortRunningAppList(appList);

      // Null runningSince should come first, then sorted by runningSince
      expect(result[0].ip).to.equal('10.0.0.2');
      expect(result[1].ip).to.equal('10.0.0.3');
      expect(result[2].ip).to.equal('10.0.0.1');
    });

    it('should use broadcastedAt as tiebreaker', () => {
      const appList = [
        { ip: '10.0.0.1', runningSince: null, broadcastedAt: 2000 },
        { ip: '10.0.0.2', runningSince: null, broadcastedAt: 1000 },
        { ip: '10.0.0.3', runningSince: null, broadcastedAt: 3000 },
      ];

      const result = helpers.sortRunningAppList(appList);

      expect(result[0].broadcastedAt).to.equal(1000);
      expect(result[1].broadcastedAt).to.equal(2000);
      expect(result[2].broadcastedAt).to.equal(3000);
    });

    it('should use IP as final tiebreaker', () => {
      const appList = [
        { ip: '10.0.0.3', runningSince: null, broadcastedAt: 1000 },
        { ip: '10.0.0.1', runningSince: null, broadcastedAt: 1000 },
        { ip: '10.0.0.2', runningSince: null, broadcastedAt: 1000 },
      ];

      const result = helpers.sortRunningAppList(appList);

      expect(result[0].ip).to.equal('10.0.0.1');
      expect(result[1].ip).to.equal('10.0.0.2');
      expect(result[2].ip).to.equal('10.0.0.3');
    });
  });

  describe('getDeviceID', () => {
    it('should return device ID on successful response', async () => {
      const axiosStub = sandbox.stub(axios, 'get').resolves({
        data: { status: 'success', data: 'DEVICE-ID-123' },
      });

      const result = await helpers.getDeviceID('10.0.0.1:16127');

      expect(result).to.equal('DEVICE-ID-123');
      expect(axiosStub.calledOnce).to.be.true;
    });

    it('should return null on error', async () => {
      sandbox.stub(axios, 'get').rejects(new Error('Network error'));

      const result = await helpers.getDeviceID('10.0.0.1:16127');

      expect(result).to.be.null;
    });

    it('should return null on non-success status', async () => {
      sandbox.stub(axios, 'get').resolves({
        data: { status: 'error', data: null },
      });

      const result = await helpers.getDeviceID('10.0.0.1:16127');

      expect(result).to.be.null;
    });

    it('should retry on failure when retries specified', async () => {
      const axiosStub = sandbox.stub(axios, 'get');
      axiosStub.onFirstCall().rejects(new Error('Network error'));
      axiosStub.onSecondCall().resolves({
        data: { status: 'success', data: 'DEVICE-ID-123' },
      });

      const result = await helpers.getDeviceID('10.0.0.1:16127', 1);

      expect(result).to.equal('DEVICE-ID-123');
      expect(axiosStub.callCount).to.equal(2);
    });
  });

  describe('getDeviceIDCached', () => {
    let verifyPeer;
    let introducedPeer;
    let count;

    // The source this lookup counted, which a harness suite waits on to know a
    // monitor pass has decided a device.
    const counted = (source) => sinon.assert.calledOnceWithExactly(count, 'syncthing:deviceSource', '10.0.0.1:16127', source);

    beforeEach(() => {
      count = sandbox.stub(fluxEventBus, 'count');
      // A peer that predates the identity endpoint unless a test says otherwise.
      verifyPeer = sandbox.stub(peerIdentityService, 'verifyPeer')
        .resolves({ verdict: IdentityVerdict.UNVERIFIABLE, reason: 'answered 404' });
      introducedPeer = sandbox.stub(peerIdentityService, 'introducedPeer').returns(null);
    });

    // The palworld case once the partner has called in: HK's calls to UAE reach
    // its neighbour, but UAE asking HK who it is told HK which device UAE is.
    it('takes the device a partner proved by calling in, when this node\'s own call was answered by another node', async () => {
      const cache = new Map([['10.0.0.1:16127', 'DEVICE-OF-A-NEIGHBOUR']]);
      verifyPeer.resolves({ verdict: IdentityVerdict.MISROUTED, answeredAs: '10.0.0.9:16147' });
      introducedPeer.withArgs('10.0.0.1:16127').returns({ socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: 'INTRODUCED-DEVICE' });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', cache)).to.equal('INTRODUCED-DEVICE');
      expect(cache.get('10.0.0.1:16127')).to.equal('INTRODUCED-DEVICE');
      counted('introduced');
    });

    it('prefers a partner\'s introduction over an unsigned answer', async () => {
      introducedPeer.withArgs('10.0.0.1:16127').returns({ socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: 'INTRODUCED-DEVICE' });
      const unsigned = sandbox.stub(axios, 'get').resolves({ data: { status: 'success', data: 'UNSIGNED-DEVICE' } });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', new Map())).to.equal('INTRODUCED-DEVICE');
      sinon.assert.notCalled(unsigned);
    });

    it('takes what a peer signs when asked over an older introduction', async () => {
      verifyPeer.resolves({
        verdict: IdentityVerdict.VERIFIED,
        identity: { socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: 'SIGNED-DEVICE-ID' },
      });
      introducedPeer.returns({ socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: 'INTRODUCED-DEVICE' });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', new Map())).to.equal('SIGNED-DEVICE-ID');
    });

    it('ignores an introduction that names no device', async () => {
      verifyPeer.resolves({ verdict: IdentityVerdict.MISROUTED, answeredAs: '10.0.0.9:16147' });
      introducedPeer.returns({ socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: null });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', new Map())).to.equal(null);
    });

    it('takes the device a verified peer signs, over whatever was held for its address', async () => {
      const cache = new Map([['10.0.0.1:16127', 'DEVICE-OF-A-NEIGHBOUR']]);
      verifyPeer.resolves({
        verdict: IdentityVerdict.VERIFIED,
        identity: { socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: 'SIGNED-DEVICE-ID' },
      });
      const unsigned = sandbox.stub(axios, 'get');

      const result = await helpers.getDeviceIDCached('10.0.0.1:16127', cache);

      expect(result).to.equal('SIGNED-DEVICE-ID');
      expect(cache.get('10.0.0.1:16127')).to.equal('SIGNED-DEVICE-ID');
      sinon.assert.notCalled(unsigned);
      counted('verified');
    });

    it('keeps what it held while a verified peer\'s syncthing has not answered yet', async () => {
      const cache = new Map([['10.0.0.1:16127', 'HELD-DEVICE-ID']]);
      verifyPeer.resolves({
        verdict: IdentityVerdict.VERIFIED,
        identity: { socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: null },
      });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', cache)).to.equal('HELD-DEVICE-ID');
      counted('verifiedNoDevice');
      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', new Map())).to.equal(null);
    });

    // A listed holder whose FluxOS has stopped answering, asked by a node whose
    // FluxOS restarted and so holds nothing for it.
    it('keeps the device syncthing has configured under the address of a listed peer that does not answer', async () => {
      const cache = new Map();
      sandbox.stub(axios, 'get').rejects(new Error('connect ETIMEDOUT'));

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', cache, 'CONFIGURED-DEVICE')).to.equal('CONFIGURED-DEVICE');
      expect(cache.has('10.0.0.1:16127'), 'a configured device is asked again on the next pass').to.equal(false);
      counted('configured');
    });

    it('keeps the configured device while a verified peer\'s syncthing has not answered and nothing is held', async () => {
      verifyPeer.resolves({
        verdict: IdentityVerdict.VERIFIED,
        identity: { socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: null },
      });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', new Map(), 'CONFIGURED-DEVICE')).to.equal('CONFIGURED-DEVICE');
      counted('configured');
    });

    it('takes a peer\'s unsigned answer over the device configured under its address', async () => {
      sandbox.stub(axios, 'get').resolves({ data: { status: 'success', data: 'ANSWERED-DEVICE' } });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', new Map(), 'CONFIGURED-DEVICE')).to.equal('ANSWERED-DEVICE');
      counted('unsigned');
    });

    it('configures no device for an address another node answered, whatever is configured under it', async () => {
      verifyPeer.resolves({ verdict: IdentityVerdict.MISROUTED, answeredAs: '10.0.0.9:16147' });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', new Map(), 'CONFIGURED-DEVICE')).to.equal(null);
      counted('withheld');
    });

    // The palworld case: HK held its neighbour's device under UAE's name for five
    // days, and the folder never synced.
    it('configures no device for an address another node answered, and forgets the one it held', async () => {
      const cache = new Map([['10.0.0.1:16127', 'DEVICE-OF-A-NEIGHBOUR']]);
      verifyPeer.resolves({ verdict: IdentityVerdict.MISROUTED, answeredAs: '10.0.0.9:16147' });
      const unsigned = sandbox.stub(axios, 'get').resolves({ data: { status: 'success', data: 'DEVICE-OF-A-NEIGHBOUR' } });

      const result = await helpers.getDeviceIDCached('10.0.0.1:16127', cache);

      expect(result).to.equal(null);
      expect(cache.has('10.0.0.1:16127')).to.equal(false);
      sinon.assert.notCalled(unsigned);
      counted('withheld');
    });

    it('uses what it held when the peer cannot be reached', async () => {
      const cache = new Map([['10.0.0.1:16127', 'HELD-DEVICE-ID']]);
      verifyPeer.resolves({ verdict: IdentityVerdict.UNREACHABLE, reason: 'timeout' });

      expect(await helpers.getDeviceIDCached('10.0.0.1:16127', cache)).to.equal('HELD-DEVICE-ID');
      counted('held');
    });

    it('should return cached value if available', async () => {
      const cache = new Map();
      cache.set('10.0.0.1:16127', 'CACHED-DEVICE-ID');

      const result = await helpers.getDeviceIDCached('10.0.0.1:16127', cache);

      expect(result).to.equal('CACHED-DEVICE-ID');
    });

    it('should fetch and cache if not available', async () => {
      const cache = new Map();
      sandbox.stub(axios, 'get').resolves({
        data: { status: 'success', data: 'NEW-DEVICE-ID' },
      });

      const result = await helpers.getDeviceIDCached('10.0.0.1:16127', cache);

      expect(result).to.equal('NEW-DEVICE-ID');
      expect(cache.get('10.0.0.1:16127')).to.equal('NEW-DEVICE-ID');
      counted('unsigned');
    });

    it('should not cache on failure', async () => {
      const cache = new Map();
      sandbox.stub(axios, 'get').rejects(new Error('Network error'));

      const result = await helpers.getDeviceIDCached('10.0.0.1:16127', cache);

      expect(result).to.be.null;
      expect(cache.has('10.0.0.1:16127')).to.be.false;
    });
  });

  describe('buildDeviceConfiguration', () => {
    const LOCAL = '10.0.0.9:16127';

    beforeEach(() => {
      sandbox.stub(peerIdentityService, 'introducedPeer').returns(null);
      sandbox.stub(peerIdentityService, 'verifyPeer').resolves({
        verdict: IdentityVerdict.VERIFIED,
        identity: { socketAddress: '10.0.0.1:16127', pubKey: 'PUB', deviceId: 'REAL-DEVICE' },
      });
    });

    it('configures the signed device for a peer whose name syncthing holds under another device', async () => {
      const devicesConfiguration = [];
      const devicesIds = [];
      const allDevices = [{ name: '10.0.0.1:16127', deviceID: 'DEVICE-OF-A-NEIGHBOUR' }];

      const devices = await helpers.buildDeviceConfiguration(
        [{ ip: '10.0.0.1:16127' }], LOCAL, 'MY-DEVICE', new Map(), devicesConfiguration, devicesIds, allDevices,
      );

      expect(devices).to.deep.equal([{ deviceID: 'MY-DEVICE' }, { deviceID: 'REAL-DEVICE' }]);
      expect(devicesConfiguration.map((d) => [d.name, d.deviceID])).to.deep.equal([['10.0.0.1:16127', 'REAL-DEVICE']]);
      // The stale entry is not among the devices in use, so the sweep of unused
      // devices removes it.
      expect(devicesIds).to.deep.equal(['REAL-DEVICE']);
    });

    describe('a listed peer that gives no device', () => {
      beforeEach(() => {
        peerIdentityService.verifyPeer.resolves({ verdict: IdentityVerdict.UNVERIFIABLE, reason: 'connect ETIMEDOUT' });
        sandbox.stub(axios, 'get').rejects(new Error('connect ETIMEDOUT'));
      });

      it('stays in the folder on the device configured under its address', async () => {
        const devicesIds = [];
        const allDevices = [{ name: '10.0.0.1:16127', deviceID: 'CONFIGURED-DEVICE' }];

        const devices = await helpers.buildDeviceConfiguration(
          [{ ip: '10.0.0.1:16127' }], LOCAL, 'MY-DEVICE', new Map(), [], devicesIds, allDevices,
        );

        expect(devices).to.deep.equal([{ deviceID: 'MY-DEVICE' }, { deviceID: 'CONFIGURED-DEVICE' }]);
        expect(devicesIds, 'the sweep of unused devices would remove it').to.deep.equal(['CONFIGURED-DEVICE']);
      });

      it('leaves the folder while more than one device is configured under its address', async () => {
        const allDevices = [
          { name: '10.0.0.1:16127', deviceID: 'CONFIGURED-DEVICE' },
          { name: '10.0.0.1:16127', deviceID: 'DEVICE-OF-A-NEIGHBOUR' },
        ];

        const devices = await helpers.buildDeviceConfiguration(
          [{ ip: '10.0.0.1:16127' }], LOCAL, 'MY-DEVICE', new Map(), [], [], allDevices,
        );

        expect(devices).to.deep.equal([{ deviceID: 'MY-DEVICE' }]);
      });
    });

    it('configures a new peer device not to auto-accept folders', async () => {
      const devicesConfiguration = [];

      await helpers.buildDeviceConfiguration(
        [{ ip: '10.0.0.1:16127' }], LOCAL, 'MY-DEVICE', new Map(), devicesConfiguration, [], [],
      );

      expect(devicesConfiguration.map((d) => d.deviceID)).to.deep.equal(['REAL-DEVICE']);
      expect(devicesConfiguration[0].autoAcceptFolders, 'an auto-accepted folder takes syncthing\'s default type, sendreceive').to.equal(false);
    });

    it('reaches a new peer device over TCP alone', async () => {
      const devicesConfiguration = [];

      await helpers.buildDeviceConfiguration(
        [{ ip: '10.0.0.1:16127' }], LOCAL, 'MY-DEVICE', new Map(), devicesConfiguration, [], [],
      );

      expect(devicesConfiguration[0].addresses).to.deep.equal(['tcp://10.0.0.1:16129']);
    });

    it('adds nothing for a peer syncthing already holds as that device', async () => {
      const devicesConfiguration = [];
      const allDevices = [{ name: '10.0.0.1:16127', deviceID: 'REAL-DEVICE' }];

      await helpers.buildDeviceConfiguration(
        [{ ip: '10.0.0.1:16127' }], LOCAL, 'MY-DEVICE', new Map(), devicesConfiguration, [], allDevices,
      );

      expect(devicesConfiguration).to.deep.equal([]);
    });

    it('leaves a peer another node answered for out of the folder', async () => {
      peerIdentityService.verifyPeer.resolves({ verdict: IdentityVerdict.MISROUTED, answeredAs: '10.0.0.7:16147' });
      const devicesConfiguration = [];

      const devices = await helpers.buildDeviceConfiguration(
        [{ ip: '10.0.0.1:16127' }], LOCAL, 'MY-DEVICE', new Map(), devicesConfiguration, [], [],
      );

      expect(devices).to.deep.equal([{ deviceID: 'MY-DEVICE' }]);
      expect(devicesConfiguration).to.deep.equal([]);
    });
  });

  describe('ensureStignoreCovers', () => {
    const ID = 'fluxcomp_app';

    it('posts the current ignores plus the missing policy lines', async () => {
      // syncthing owns .stignore and writes it atomically; FluxOS sets the
      // patterns through it rather than touching the file. POST replaces the
      // whole set, so the current lines are kept and the missing ones appended.
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: ['/backup'] });
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.calledOnceWithExactly(set, ID, ['/backup', '/.flux-op-*']);
    });

    it('seeds both lines when the folder has no ignores yet', async () => {
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: null });
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.calledOnceWithExactly(set, ID, ['/backup', '/.flux-op-*']);
    });

    it('posts nothing when every policy line is already present', async () => {
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: ['/backup', '/.flux-op-*'] });
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.notCalled(set);
    });

    it('keeps ignores it did not write, below its own', async () => {
      // An owner can add patterns of their own; asserting OUR lines does not mean
      // destroying theirs. They move below ours rather than away.
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: ['/backup', 'cache/**'] });
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.calledOnceWithExactly(set, ID, ['/backup', '/.flux-op-*', 'cache/**']);
    });

    it('lifts a policy line that sits below a pattern of the owners', async () => {
      // Presence is not the guarantee - position is. syncthing takes the FIRST
      // pattern that matches, so a policy line below anything is a policy line
      // something else can answer for.
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: ['cache/**', '/backup', '/.flux-op-*'] });
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.calledOnceWithExactly(set, ID, ['/backup', '/.flux-op-*', 'cache/**']);
    });

    it('demotes a negation that would otherwise answer for a policy line', async () => {
      // The case the position rule exists for: !/backup above /backup un-ignores
      // the backup directory, and the old presence test called that converged.
      // The negation is kept - it is the owner's - it just stops winning.
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: ['!/backup', '/backup', '/.flux-op-*'] });
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.calledOnceWithExactly(set, ID, ['/backup', '/.flux-op-*', '!/backup']);
    });

    it('collapses a policy line the folder holds more than once', async () => {
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: ['/backup', 'cache/**', '/backup'] });
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.calledOnceWithExactly(set, ID, ['/backup', '/.flux-op-*', 'cache/**']);
    });

    it('posts nothing on a folder already led by the policy lines', async () => {
      // Idempotent: a converged folder is neither rewritten nor rescanned, which
      // is what keeps this safe to run on every monitor pass.
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: ['/backup', '/.flux-op-*', 'cache/**'] });
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.notCalled(set);
    });

    it('logs and posts nothing when the read fails, rather than failing the pass', async () => {
      // The read throws, and the converge is abandoned rather than run against
      // an ignore list this node never actually read.
      sandbox.stub(syncthingService, 'getFolderIgnores').rejects(new Error('syncthing restarting'));
      const set = sandbox.stub(syncthingService, 'setFolderIgnores').resolves({});
      const logError = sandbox.stub(log, 'error');

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.notCalled(set);
      sinon.assert.calledOnce(logError);
    });

    it('logs when the write fails, rather than failing the pass', async () => {
      sandbox.stub(syncthingService, 'getFolderIgnores').resolves({ ignore: [] });
      sandbox.stub(syncthingService, 'setFolderIgnores').rejects(new Error('folder paused'));
      const logError = sandbox.stub(log, 'error');

      await helpers.ensureStignoreCovers(ID);

      sinon.assert.calledOnce(logError);
    });
  });

  describe('ensureStfolderExists', () => {
    it('refuses to create the marker on an unmounted dir (the rootfs-leak regression)', async () => {
      // a .stfolder created on the bare mountpoint re-arms syncthing onto the
      // host filesystem and defeats syncthing's own missing-marker guard
      sandbox.stub(volumeService, 'isPathMounted').resolves(false);
      const runCommand = sandbox.stub(serviceHelper, 'runCommand');

      const result = await helpers.ensureStfolderExists('/apps/fluxcomp_app');

      expect(result).to.be.false;
      sinon.assert.notCalled(runCommand);
    });

    it('creates the marker inside a mounted volume', async () => {
      sandbox.stub(volumeService, 'isPathMounted').resolves(true);
      sandbox.stub(fsp, 'stat').rejects(new Error('ENOENT'));
      const runCommand = sandbox.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: '', stderr: '' });

      const result = await helpers.ensureStfolderExists('/apps/fluxcomp_app');

      expect(result).to.be.true;
      sinon.assert.calledWith(runCommand, 'mkdir', sinon.match({ runAsRoot: true, params: ['-p', '/apps/fluxcomp_app/.stfolder'] }));
    });

    it('does not recreate an existing marker (creation is one-time setup, not a per-pass ritual)', async () => {
      sandbox.stub(volumeService, 'isPathMounted').resolves(true);
      sandbox.stub(fsp, 'stat').resolves({ isDirectory: () => true });
      const runCommand = sandbox.stub(serviceHelper, 'runCommand');

      const result = await helpers.ensureStfolderExists('/apps/fluxcomp_app');

      expect(result).to.be.true;
      sinon.assert.notCalled(runCommand);
    });

    it('reports failure when the marker cannot be created', async () => {
      sandbox.stub(volumeService, 'isPathMounted').resolves(true);
      sandbox.stub(serviceHelper, 'runCommand').resolves({ error: new Error('EPERM'), stdout: '', stderr: '' });

      const result = await helpers.ensureStfolderExists('/apps/fluxcomp_app');

      expect(result).to.be.false;
    });
  });

  describe('removeSyncthingFolder', () => {
    // the module derives the same base at load time
    const appsBase = `${process.env.FLUX_APPS_FOLDER || path.join(process.env.HOME, 'zelflux', 'ZelApps')}/`;

    it('removes a composed component folder matched by its identifier-derived path', async () => {
      // getConfigFolders answers the rows themselves; the envelope goes back on
      // only in the Api half.
      sandbox.stub(syncthingService, 'getConfigFolders')
        .resolves([{ id: 'fluxweb_app', path: `${appsBase}fluxweb_app` }]);
      const adjust = sandbox.stub(syncthingService, 'adjustConfigFolders').resolves({ status: 'success', data: {} });
      sandbox.stub(syncthingService, 'getConfigRestartRequired').resolves({ status: 'success', data: { requiresRestart: false } });

      await helpers.removeSyncthingFolder('web_app');

      sinon.assert.calledOnceWithExactly(adjust, { method: 'delete', id: 'fluxweb_app' });
    });

    // Only a removal syncthing accepted is reported as one - an uninstall
    // otherwise claims a folder deregistered that syncthing still holds.
    it('does not report a removal syncthing refused', async () => {
      sandbox.stub(syncthingService, 'getConfigFolders')
        .resolves([{ id: 'fluxweb_app', path: `${appsBase}fluxweb_app` }]);
      const adjust = sandbox.stub(syncthingService, 'adjustConfigFolders')
        .rejects(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8384'), { code: 'ECONNREFUSED' }));
      const restart = sandbox.stub(syncthingService, 'getConfigRestartRequired').resolves({ requiresRestart: true });
      const emitted = [];

      await helpers.removeSyncthingFolder('web_app', (line) => emitted.push(String(line)));

      sinon.assert.calledOnceWithExactly(adjust, { method: 'delete', id: 'fluxweb_app' });
      expect(emitted.some((line) => line.includes('Syncthing adjusted')), `a refused removal was reported as done: ${JSON.stringify(emitted)}`).to.be.false;
      expect(emitted.some((line) => line.includes('could not be removed')), 'and the caller is told').to.be.true;
      // nothing downstream of the removal runs on a removal that did not happen
      sinon.assert.notCalled(restart);
    });

    it('does not match a composed folder by the bare app name', async () => {
      // getConfigFolders answers the rows themselves; the envelope goes back on
      // only in the Api half.
      sandbox.stub(syncthingService, 'getConfigFolders')
        .resolves([{ id: 'fluxweb_app', path: `${appsBase}fluxweb_app` }]);
      const adjust = sandbox.stub(syncthingService, 'adjustConfigFolders').resolves({ status: 'success', data: {} });
      sandbox.stub(syncthingService, 'getConfigRestartRequired').resolves({ status: 'success', data: { requiresRestart: false } });

      await helpers.removeSyncthingFolder('app');

      sinon.assert.notCalled(adjust);
    });
  });

  describe('requestFolderScan', () => {
    it('requests a db scan of the component identifier-derived folder id', async () => {
      const scanFolder = sandbox.stub(syncthingService, 'scanFolder').resolves({ status: 'success' });

      await helpers.requestFolderScan('web_app');

      sinon.assert.calledOnceWithExactly(scanFolder, 'fluxweb_app');
    });

    it('swallows a failed scan request (the watcher/rescan remains the fallback)', async () => {
      const scanFolder = sandbox.stub(syncthingService, 'scanFolder').rejects(new Error('syncthing down'));
      const logWarn = sandbox.stub(log, 'warn');

      await helpers.requestFolderScan('web_app');

      sinon.assert.calledOnceWithExactly(scanFolder, 'fluxweb_app');
      sinon.assert.calledWithMatch(logWarn, /scan request for web_app failed - syncthing down/);
    });
  });
});
