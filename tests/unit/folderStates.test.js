const { expect } = require('chai');
const { loadSpecLibrary, V9_SUBMISSION, v9Spec } = require('./fixtures/fluxSpec');
const folderStates = require('../../ZelBack/src/services/appMonitoring/folderStates');
const { folderStates: folderStateMap } = require('../../ZelBack/src/services/utils/globalState');

describe('folderStates tests', () => {
  beforeEach(() => {
    folderStateMap.clear();
  });

  afterEach(() => {
    folderStateMap.clear();
  });

  describe('installed', () => {
    const storage = (mode) => ({
      sizeGb: 5, mounts: { '/data': { source: 'data', destination: '/data' } }, ...(mode ? { sync: { mode } } : {}),
    });
    let flux;

    before(async function loadLibrary() {
      this.timeout(30_000);
      flux = await loadSpecLibrary();
    });

    async function deploymentOf(components, opts = {}) {
      const built = {};
      Object.entries(components).forEach(([name, mode], index) => {
        built[name] = {
          ...V9_SUBMISSION.components.web,
          name,
          ports: { http: { containerPort: 80, hostPort: 31_000 + index } },
          persistentStorage: storage(mode),
        };
      });
      const spec = await v9Spec({ name: 'app', components: built });
      return flux.DeploymentSpec.fromSpec(spec, '/apps/', { replica: null, registrationVersion: 9, ...opts });
    }

    it('records each activeStandby and syncFirst component of an app, and no sync or unsynced one', async () => {
      const deployment = await deploymentOf({
        primary: 'activeStandby', first: 'syncFirst', every: 'sync', plain: null,
      });
      const folderOf = (name) => deployment.getComponent(name).syncFolderId;

      folderStates.installed(deployment);

      expect([...folderStateMap.keys()]).to.have.members([folderOf('primary'), folderOf('first')]);
      expect(folderStateMap.get(folderOf('primary'))).to.deep.equal({ state: 'notLookedAt' });
    });

    it('records the folder of an app registered before v9 under its folder id', async () => {
      const deployment = await deploymentOf({ primary: 'activeStandby' }, {
        identity: 'ab12cd34ef56', names: { primary: { syncFolderId: 'fluxprimary_app', aliases: [] } },
      });
      expect(deployment.getComponent('primary').identifier, 'the fixture\'s folder id is not its identifier').to.not.equal('fluxprimary_app');

      folderStates.installed(deployment);

      expect([...folderStateMap.keys()]).to.deep.equal(['fluxprimary_app']);
    });

    it('keeps the state of a folder it already has', async () => {
      const deployment = await deploymentOf({ primary: 'activeStandby' });
      const folderId = deployment.getComponent('primary').syncFolderId;
      folderStateMap.set(folderId, { state: 'heldOut' });

      folderStates.installed(deployment);

      expect(folderStateMap.get(folderId)).to.deep.equal({ state: 'heldOut' });
    });
  });

  describe('measured', () => {
    it('records what it holds as a claim', () => {
      folderStates.measured('fluxa', { bytes: 10, newestModified: 2 });

      expect(folderStates.claimOf('fluxa')).to.deep.equal({ bytes: 10, newestModified: 2 });
    });

    it('records holdings it could not read as no claim', () => {
      folderStates.measured('fluxa', { bytes: 10, newestModified: 2 });
      folderStates.measured('fluxa', null);

      expect(folderStateMap.get('fluxa')).to.deep.equal({ state: 'noClaim' });
      expect(folderStates.claimOf('fluxa')).to.equal(folderStates.NO_CLAIM_ANSWER);
    });
  });

  describe('claimOf', () => {
    it('claims nothing, and is not no claim, for a folder not looked at or not held', () => {
      folderStateMap.set('fluxa', { state: 'notLookedAt' });

      expect(folderStates.claimOf('fluxa')).to.equal(undefined);
      expect(folderStates.claimOf('fluxmissing')).to.equal(undefined);
    });

    it('answers no claim for a folder held out', () => {
      folderStates.heldOut('fluxa');

      expect(folderStates.claimOf('fluxa')).to.equal(folderStates.NO_CLAIM_ANSWER);
    });
  });

  describe('the folder lifecycle', () => {
    it('makes a promoted folder no claim, and keeps it so once it no longer sends', () => {
      folderStates.measured('fluxa', { bytes: 10, newestModified: 2 });

      folderStates.sending('fluxa');

      expect(folderStates.answer(new Set())).to.deep.equal({
        holding: { fluxa: { unreadable: true } }, notLookedAt: [], heldOut: [], volumeGone: [],
      });
    });

    it('makes a recreated volume not looked at', () => {
      folderStates.measured('fluxa', { bytes: 10, newestModified: 2 });

      folderStates.recreated('fluxa');

      expect(folderStates.answer(new Set()).notLookedAt).to.deep.equal(['fluxa']);
    });

    it('forgets a removed folder', () => {
      folderStates.heldOut('fluxa');

      folderStates.removed('fluxa');

      expect(folderStateMap.has('fluxa')).to.equal(false);
    });
  });

  describe('answer', () => {
    it('lists each folder in one list by its state, and leaves out writable ones', () => {
      folderStateMap.set('fluxwait', { state: 'notLookedAt' });
      folderStateMap.set('fluxheld', { state: 'measured', bytes: 5, newestModified: 1 });
      folderStateMap.set('fluxnone', { state: 'noClaim' });
      folderStateMap.set('fluxout', { state: 'heldOut' });
      folderStateMap.set('fluxgone', { state: 'volumeGone' });
      folderStateMap.set('fluxsend', { state: 'measured', bytes: 9, newestModified: 9 });
      folderStateMap.set('fluxsendwait', { state: 'notLookedAt' });

      expect(folderStates.answer(new Set(['fluxsend', 'fluxsendwait']))).to.deep.equal({
        holding: {
          fluxheld: { bytes: 5, newestModified: 1 },
          fluxnone: { unreadable: true },
        },
        notLookedAt: ['fluxwait'],
        heldOut: ['fluxout'],
        volumeGone: ['fluxgone'],
      });
    });

    it('keeps a folder whose volume image is gone when it is found unmounted without asking why, and holds out any other', () => {
      folderStates.volumeGone('fluxgone');
      folderStates.measured('fluxmeasured', { bytes: 5, newestModified: 1 });

      folderStates.notMounted('fluxgone');
      folderStates.notMounted('fluxmeasured');

      expect(folderStateMap.get('fluxgone')).to.deep.equal({ state: 'volumeGone' });
      expect(folderStateMap.get('fluxmeasured')).to.deep.equal({ state: 'heldOut' });
    });

    it('keeps a folder whose volume image is gone when its app\'s spec cannot be read, and holds out any other', () => {
      folderStates.volumeGone('fluxgone');
      folderStates.measured('fluxmeasured', { bytes: 5, newestModified: 1 });
      folderStates.recreated('fluxwait');

      ['fluxgone', 'fluxmeasured', 'fluxwait', 'fluxnew'].forEach((folderId) => folderStates.specUnreadable(folderId));

      expect(folderStateMap.get('fluxgone')).to.deep.equal({ state: 'volumeGone' });
      expect(folderStateMap.get('fluxmeasured')).to.deep.equal({ state: 'heldOut' });
      expect(folderStateMap.get('fluxwait')).to.deep.equal({ state: 'heldOut' });
      expect(folderStateMap.get('fluxnew')).to.deep.equal({ state: 'heldOut' });
    });

    it('holds out a folder whose volume image was gone once the mount check finds it on the node', () => {
      folderStates.volumeGone('fluxa');

      folderStates.heldOut('fluxa');

      expect(folderStateMap.get('fluxa')).to.deep.equal({ state: 'heldOut' });
    });
  });
});
