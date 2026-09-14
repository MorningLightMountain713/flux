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
    it('should create folder config with correct defaults', () => {
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
        type: 'sendreceive',
        rescanIntervalS: 900,
        maxConflicts: 0,
      });
      expect(result.devices).to.deep.equal(devices);
    });

    it('should allow custom type', () => {
      const devices = [{ deviceID: 'ABC123' }];
      const result = helpers.createSyncthingFolderConfig(
        'test-id',
        'test-label',
        '/path/to/folder',
        devices,
        'receiveonly',
      );

      expect(result.type).to.equal('receiveonly');
    });
  });

  describe('folderNeedsUpdate', () => {
    it('should return true if folder does not exist', () => {
      const newFolder = { type: 'sendreceive' };
      const result = helpers.folderNeedsUpdate(null, newFolder);
      expect(result).to.be.true;
    });

    it('should return true if maxConflicts differs', () => {
      const existing = {
        maxConflicts: 5, paused: false, type: 'sendreceive', devices: [],
      };
      const newFolder = {
        maxConflicts: 0, paused: false, type: 'sendreceive', devices: [],
      };
      const result = helpers.folderNeedsUpdate(existing, newFolder);
      expect(result).to.be.true;
    });

    it('should return true if paused status differs', () => {
      const existing = {
        maxConflicts: 0, paused: true, type: 'sendreceive', devices: [],
      };
      const newFolder = {
        maxConflicts: 0, paused: false, type: 'sendreceive', devices: [],
      };
      const result = helpers.folderNeedsUpdate(existing, newFolder);
      expect(result).to.be.true;
    });

    it('should return true if type differs', () => {
      const existing = {
        maxConflicts: 0, paused: false, type: 'receiveonly', devices: [],
      };
      const newFolder = {
        maxConflicts: 0, paused: false, type: 'sendreceive', devices: [],
      };
      const result = helpers.folderNeedsUpdate(existing, newFolder);
      expect(result).to.be.true;
    });

    it('should return true if devices differ', () => {
      const existing = {
        maxConflicts: 0,
        paused: false,
        type: 'sendreceive',
        devices: [{ deviceID: 'ABC' }],
      };
      const newFolder = {
        maxConflicts: 0,
        paused: false,
        type: 'sendreceive',
        devices: [{ deviceID: 'XYZ' }],
      };
      const result = helpers.folderNeedsUpdate(existing, newFolder);
      expect(result).to.be.true;
    });

    it('should return false if everything matches', () => {
      const devices = [{ deviceID: 'ABC' }];
      const existing = {
        maxConflicts: 0,
        paused: false,
        type: 'sendreceive',
        devices,
      };
      const newFolder = {
        maxConflicts: 0,
        paused: false,
        type: 'sendreceive',
        devices,
      };
      const result = helpers.folderNeedsUpdate(existing, newFolder);
      expect(result).to.be.false;
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
    });

    it('should not cache on failure', async () => {
      const cache = new Map();
      sandbox.stub(axios, 'get').rejects(new Error('Network error'));

      const result = await helpers.getDeviceIDCached('10.0.0.1:16127', cache);

      expect(result).to.be.null;
      expect(cache.has('10.0.0.1:16127')).to.be.false;
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
      const emitted = [];

      await helpers.removeSyncthingFolder('web_app', (line) => emitted.push(String(line)));

      sinon.assert.calledOnceWithExactly(adjust, { method: 'delete', id: 'fluxweb_app' });
      expect(emitted.some((line) => line.includes('Syncthing adjusted')), `a refused removal was reported as done: ${JSON.stringify(emitted)}`).to.be.false;
      expect(emitted.some((line) => line.includes('could not be removed')), 'and the caller is told').to.be.true;
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
      const dbScan = sandbox.stub(syncthingService, 'dbScan').resolves({ status: 'success' });

      await helpers.requestFolderScan('web_app');

      sinon.assert.calledOnceWithExactly(dbScan, 'fluxweb_app');
    });

    // A refused scan is reported and dropped: syncthing's own watcher and its
    // periodic rescan remain the fallback, so this must not end the caller.
    it('swallows a refused scan request (the watcher/rescan remains the fallback)', async () => {
      const dbScan = sandbox.stub(syncthingService, 'dbScan')
        .rejects(new Error('syncthing down'));
      const logWarn = sandbox.stub(log, 'warn');

      await helpers.requestFolderScan('web_app');

      sinon.assert.calledOnceWithExactly(dbScan, 'fluxweb_app');
      sinon.assert.calledWithMatch(logWarn, /scan request for web_app failed - syncthing down/);
    });
  });
});
