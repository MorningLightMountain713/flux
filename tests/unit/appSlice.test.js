const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const os = require('os');
const path = require('path');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const appSlice = require('../../ZelBack/src/services/appLifecycle/appSlice');

describe('appSlice tests', () => {
  let root;
  let runCommand;
  // unit -> its cgroup, as systemd reports it
  let units;
  // systemd runs in a container here, so its tree starts below the filesystem's root
  const SYSTEMD_ROOT = '/init';
  // where systemd puts flux-apps.slice: each '-' in a slice's name is a level
  const APPS = path.join('flux.slice', 'flux-apps.slice');

  function slice(unit, populated) {
    const dir = path.join(root, SYSTEMD_ROOT, APPS, unit);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cgroup.events'), `populated ${populated ? 1 : 0}\nfrozen 0\n`);
    units.set('flux-apps.slice', path.join(SYSTEMD_ROOT, APPS));
    units.set(unit, path.join(SYSTEMD_ROOT, APPS, unit));
  }
  const stops = () => runCommand.getCalls().filter((call) => call.args[1].params[0] === 'stop');
  const stopped = () => stops().map((call) => call.args[1].params.at(-1));
  let stopResult;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'appslice-'));
    appSlice.useCgroupRoot(root);
    units = new Map();
    stopResult = { error: null };
    runCommand = sinon.stub(serviceHelper, 'runCommand').callsFake((cmd, { params }) => Promise.resolve(params[0] === 'show'
      ? { stdout: `${units.get(params[4]) ?? ''}\n`, error: null }
      : stopResult));
  });

  afterEach(() => {
    appSlice.useCgroupRoot('/sys/fs/cgroup');
    fs.rmSync(root, { recursive: true, force: true });
    sinon.restore();
  });

  describe('sliceName', () => {
    it('names the app\'s slice under flux-apps.slice', () => {
      expect(appSlice.sliceName('palworld1790205120183')).to.equal('flux-apps-palworld1790205120183.slice');
    });

    it('escapes each hyphen, so one app\'s slice never nests inside another\'s', () => {
      expect(appSlice.sliceName('my-app')).to.equal('flux-apps-my\\x2dapp.slice');
      expect(appSlice.sliceName('my-app')).to.not.equal(`${appSlice.sliceName('my').slice(0, -'.slice'.length)}-app.slice`);
    });

    it('names no slice for a name no app can have', () => {
      ['', 'a_b', 'a.b', '../x', 'a b', null, undefined].forEach((name) => {
        expect(appSlice.sliceName(name), String(name)).to.equal(null);
      });
    });
  });

  describe('the slices apps share', () => {
    it('no app\'s name names the shared apps slice or the playground\'s', () => {
      expect(appSlice.sliceName('apps')).to.equal('flux-apps-apps.slice');
      expect(appSlice.sliceName('playground')).to.equal('flux-apps-playground.slice');
      for (const name of ['apps', 'playground', 'x']) {
        expect(appSlice.sliceName(name), name).to.not.be.oneOf(['flux-apps.slice', 'flux-playground.slice', 'flux.slice']);
      }
    });

    it('reads an app back from its slice, and nothing from a slice that is not an app\'s', () => {
      expect(appSlice.appOfSlice(appSlice.sliceName('my-app'))).to.equal('my-app');
      for (const unit of ['flux-apps.slice', 'flux-playground.slice', 'flux.slice', 'system.slice']) {
        expect(appSlice.appOfSlice(unit), unit).to.equal(null);
      }
    });
  });

  describe('release', () => {
    it('stops the app\'s slice once nothing lives in it', async () => {
      slice('flux-apps-my\\x2dapp.slice', false);

      await appSlice.release('my-app');

      expect(stops().map((call) => call.args)).to.deep.equal([['systemctl', { runAsRoot: true, params: ['stop', '--no-block', 'flux-apps-my\\x2dapp.slice'] }]]);
    });

    it('leaves a slice a process still lives in', async () => {
      slice('flux-apps-busy.slice', true);

      await appSlice.release('busy');

      expect(stops()).to.be.empty;
    });

    it('does nothing for an app with no slice', async () => {
      await appSlice.release('absent');

      expect(stops()).to.be.empty;
    });
  });

  describe('stopEmptySlices', () => {
    it('stops every empty app slice, and leaves those in use and anything else', async () => {
      slice('flux-apps-gone.slice', false);
      slice('flux-apps-gone\\x2dtoo.slice', false);
      slice('flux-apps-running.slice', true);
      slice('other.slice', false);

      const count = await appSlice.stopEmptySlices();

      expect(count).to.equal(2);
      expect(stopped()).to.have.members(['flux-apps-gone.slice', 'flux-apps-gone\\x2dtoo.slice']);
    });

    it('counts no slice systemd could not stop', async () => {
      slice('flux-apps-gone.slice', false);
      stopResult = { error: new Error('unit busy') };

      expect(await appSlice.stopEmptySlices()).to.equal(0);
    });

    it('does nothing when there is no flux-apps.slice', async () => {
      expect(await appSlice.stopEmptySlices()).to.equal(0);
      expect(stops()).to.be.empty;
    });
  });
});
