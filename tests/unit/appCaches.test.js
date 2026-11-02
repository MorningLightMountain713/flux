'use strict';

const chai = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const { expect } = chai;

describe('appCaches tests', () => {
  // A component of an app registered before v9: shared under its 8.x folder id, its
  // volume mounted at the directory its identifier names.
  const APP_ID = 'fluxcomp_myapp';
  const IDENTIFIER = 'comp_ab12cd34ef56';
  let volumeServiceStub;
  let logStub;
  let appCaches;
  let marks;

  beforeEach(() => {
    volumeServiceStub = { appVolumeFilesystemId: sinon.stub() };
    logStub = {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    };
    marks = new Map();
    appCaches = proxyquire('../../ZelBack/src/services/utils/appCaches', {
      './globalState': {
        receiveOnlySyncthingAppsCache: new Map(),
        syncthingDevicesIDCache: new Map(),
      },
      './volumeService': volumeServiceStub,
      '../../lib/log': logStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('setSyncedMark tests', () => {
    it('should stamp the mark with the identity of the volume it describes', async () => {
      volumeServiceStub.appVolumeFilesystemId.resolves('uuid-v1');

      const stored = await appCaches.setSyncedMark(marks, APP_ID, IDENTIFIER, { restarted: true });

      expect(stored).to.eql({ restarted: true, volumeUuid: 'uuid-v1' });
      expect(marks.get(APP_ID)).to.eql({ restarted: true, volumeUuid: 'uuid-v1' });
    });

    it('should store a null stamp when the volume is not mounted rather than refusing the write', async () => {
      // during boot the mark can legitimately be written before the volume is remounted
      volumeServiceStub.appVolumeFilesystemId.resolves(null);

      await appCaches.setSyncedMark(marks, APP_ID, IDENTIFIER, { numberOfExecutions: 1 });

      expect(marks.get(APP_ID)).to.eql({ numberOfExecutions: 1, volumeUuid: null });
    });

    it('stores the mark it was given, so work begun on it still finds it current', async () => {
      volumeServiceStub.appVolumeFilesystemId.resolves('uuid-v1');
      const mark = { restarted: true };

      await appCaches.setSyncedMark(marks, APP_ID, IDENTIFIER, mark);

      expect(marks.get(APP_ID)).to.equal(mark);
    });

    it('stamps the volume mounted at the component\'s directory, not at its folder id', async () => {
      volumeServiceStub.appVolumeFilesystemId.resolves('uuid-v1');

      await appCaches.setSyncedMark(marks, APP_ID, IDENTIFIER, { restarted: true });

      sinon.assert.calledOnceWithExactly(volumeServiceStub.appVolumeFilesystemId, IDENTIFIER);
    });
  });

  describe('syncedMark tests', () => {
    it('should drop a mark describing a volume that has since been replaced', async () => {
      // the whole point: a rebuilt volume runs mke2fs and mints a fresh filesystem, so a
      // surviving mark would certify an empty disk as synced and promote this node
      marks.set(APP_ID, { restarted: true, volumeUuid: 'uuid-v1' });
      volumeServiceStub.appVolumeFilesystemId.resolves('uuid-v2');

      const mark = await appCaches.syncedMark(marks, APP_ID, IDENTIFIER);

      expect(mark).to.equal(null);
      expect(marks.has(APP_ID)).to.equal(false);
      sinon.assert.calledWith(volumeServiceStub.appVolumeFilesystemId, IDENTIFIER);
    });

    it('should honour the mark when the volume is unchanged', async () => {
      // the other direction, and the one that matters for data safety: a recreate that
      // aborts in its pre-flight leaves the original volume and its data intact, and the
      // mark still describes them. Dropping it here is what destroys a survivable failure.
      marks.set(APP_ID, { restarted: true, volumeUuid: 'uuid-v1' });
      volumeServiceStub.appVolumeFilesystemId.resolves('uuid-v1');

      const mark = await appCaches.syncedMark(marks, APP_ID, IDENTIFIER);

      expect(mark.restarted).to.equal(true);
      expect(marks.has(APP_ID)).to.equal(true);
    });

    it('should honour the mark when the live volume identity cannot be read', async () => {
      // absence of evidence is not evidence of staleness - invalidating here would re-run
      // the receive-only bootstrap for every app on the node after every reboot
      marks.set(APP_ID, { restarted: true, volumeUuid: 'uuid-v1' });
      volumeServiceStub.appVolumeFilesystemId.resolves(null);

      const mark = await appCaches.syncedMark(marks, APP_ID, IDENTIFIER);

      expect(mark.restarted).to.equal(true);
      expect(marks.has(APP_ID)).to.equal(true);
    });

    it('should honour an unstamped mark without probing the volume', async () => {
      marks.set(APP_ID, { restarted: true });

      const mark = await appCaches.syncedMark(marks, APP_ID, IDENTIFIER);

      expect(mark.restarted).to.equal(true);
      expect(volumeServiceStub.appVolumeFilesystemId.called).to.equal(false);
    });

    it('should return null when the component has no mark at all', async () => {
      const mark = await appCaches.syncedMark(marks, APP_ID, IDENTIFIER);

      expect(mark).to.equal(null);
      expect(volumeServiceStub.appVolumeFilesystemId.called).to.equal(false);
    });
  });
});
