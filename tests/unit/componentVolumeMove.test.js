'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

const APPS = '/apps/';
const FORMER = 'idlegacy';
const NEXT = 'web_idlegacy';
const IMAGE = '/dat/appvolumes/idlegacyFLUXFSVOL';
const MOVED_IMAGE = '/dat/appvolumes/web_idlegacyFLUXFSVOL';

describe('componentVolumeMove', () => {
  let stubs;
  let files;
  let componentVolumeMove;

  const component = (identifier, { stateless = false, syncthing = false } = {}) => ({
    identifier,
    isStateless: stateless,
    hasSyncthing: () => syncthing,
    syncFolderId: 'folder-1',
    image: 'repo/web:v2',
    networkAliases: ['web'],
  });
  const commands = () => stubs.serviceHelper.runCommand.getCalls().map((call) => [call.args[0], ...(call.args[1].params ?? [])]);

  beforeEach(() => {
    files = new Set([`${APPS}${FORMER}`]);
    stubs = {
      fs: { access: async (p) => { if (!files.has(p)) throw new Error(`ENOENT ${p}`); } },
      instanceResources: {
        removeComponent: sinon.stub().resolves(),
        addComponent: sinon.stub().resolves(true),
        setComponent: sinon.stub().resolves(),
      },
      instanceResourceObserver: {
        discoverVolumeImage: sinon.stub().resolves({ path: IMAGE, fsUuid: 'uuid-1' }),
        diskOf: (file) => (file.startsWith('/dat/appvolumes/') ? '/' : file),
      },
      volumeService: {
        recordedVolumeImage: sinon.stub().resolves({ path: IMAGE, fsUuid: 'uuid-1' }),
        isPathMounted: sinon.stub().resolves(true),
        getVolumeFilePath: sinon.stub().resolves({ path: null }),
        imageFsUuid: sinon.stub().resolves('uuid-1'),
        ensureAppVolumeMounted: sinon.stub().resolves({ mounted: true }),
      },
      appsRuntimeState: { rekey: sinon.stub().resolves(true) },
      syncthingService: { getConfigFolders: sinon.stub().resolves({ id: 'folder-1', path: `${APPS}${FORMER}` }) },
      syncthingFolderWrites: { patchFolder: sinon.stub().resolves({ status: 'success' }) },
      serviceHelper: { runCommand: sinon.stub().resolves({ error: null }) },
    };
    componentVolumeMove = proxyquire('../../ZelBack/src/services/appLifecycle/componentVolumeMove', {
      'node:fs/promises': stubs.fs,
      '../appDatabase/appRecords': { instanceResources: () => stubs.instanceResources },
      './instanceResourceObserver': stubs.instanceResourceObserver,
      '../utils/volumeService': stubs.volumeService,
      '../appManagement/appsRuntimeState': stubs.appsRuntimeState,
      '../syncthingService': stubs.syncthingService,
      '../appMonitoring/syncthingFolderWrites': stubs.syncthingFolderWrites,
      '../serviceHelper': stubs.serviceHelper,
      '../utils/appConstants': { appsFolder: APPS },
      '../../lib/log': { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
    });
  });

  afterEach(() => sinon.restore());

  describe('moveComponentVolume', () => {
    it('moves the runtime state, the image and the directory to the new identifier, and writes the block under it', async () => {
      await componentVolumeMove.moveComponentVolume('legacy', null, 'legacy', component(FORMER), component(NEXT));

      sinon.assert.calledOnceWithExactly(stubs.appsRuntimeState.rekey, FORMER, NEXT);
      expect(commands()).to.deep.include.members([
        ['umount', `${APPS}${FORMER}`],
        ['mv', IMAGE, MOVED_IMAGE],
        ['mv', `${APPS}${FORMER}`, `${APPS}${NEXT}`],
      ]);
      sinon.assert.calledOnceWithExactly(stubs.instanceResources.removeComponent, 'legacy', null, 'legacy');
      sinon.assert.calledOnceWithExactly(stubs.instanceResources.addComponent, 'legacy', null, 'legacy', {
        identifier: NEXT, image: 'repo/web:v2', syncFolder: null, aliases: ['web'],
      });
      sinon.assert.calledOnceWithExactly(stubs.instanceResources.setComponent, 'legacy', null, 'legacy', 'volume', {
        file: MOVED_IMAGE, disk: '/', fsUuid: 'uuid-1', mountDir: `${APPS}${NEXT}`,
      });
      sinon.assert.callOrder(stubs.instanceResources.removeComponent, stubs.instanceResources.addComponent, stubs.instanceResources.setComponent);
      sinon.assert.calledOnceWithExactly(stubs.volumeService.ensureAppVolumeMounted, NEXT);
      expect(stubs.instanceResources.setComponent.calledBefore(stubs.volumeService.ensureAppVolumeMounted), 'mounted before the block names the image').to.equal(true);
    });

    it('points the component\'s syncthing folder at the new directory', async () => {
      await componentVolumeMove.moveComponentVolume('legacy', null, 'legacy', component(FORMER, { syncthing: true }), component(NEXT, { syncthing: true }));

      sinon.assert.calledOnceWithExactly(stubs.syncthingFolderWrites.patchFolder, 'folder-1', { path: `${APPS}${NEXT}` });
      expect(stubs.instanceResources.addComponent.firstCall.args[3].syncFolder).to.deep.equal({ id: 'folder-1', path: `${APPS}${NEXT}` });
    });

    it('moves no volume of a component that has none, and still writes its block', async () => {
      await componentVolumeMove.moveComponentVolume('legacy', null, 'legacy', component(FORMER, { stateless: true }), component(NEXT, { stateless: true }));

      expect(commands()).to.deep.equal([]);
      sinon.assert.calledOnce(stubs.instanceResources.addComponent);
      sinon.assert.notCalled(stubs.instanceResources.setComponent);
      sinon.assert.notCalled(stubs.volumeService.ensureAppVolumeMounted);
    });

    it('fails when the moved volume does not mount', async () => {
      stubs.volumeService.ensureAppVolumeMounted.resolves({ mounted: false, reason: 'image missing' });

      await expect(componentVolumeMove.moveComponentVolume('legacy', null, 'legacy', component(FORMER), component(NEXT)))
        .to.be.rejectedWith(`the volume of ${NEXT} did not mount: image missing`);
    });
  });
});
