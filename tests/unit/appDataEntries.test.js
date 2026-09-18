'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

// The spec library is real: what is under test is that every walk of a volume
// root leaves out exactly the entries the library names, and that an archive's
// format is read from the archive rather than assumed. The shell-out and the
// filesystem are stubbed.

const VOL = '/apps/fluxweb_myapp';
const UUID = '0f1e2d3c-4b5a-4978-8877-66554433aabb';

describe('appDataEntries', () => {
  let flux;
  let runCommand;
  let IOUtils;
  let fsp;
  let appDataEntries;

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  beforeEach(() => {
    runCommand = sinon.stub().resolves({ error: null, stdout: '', stderr: '' });
    IOUtils = {
      createTarGz: sinon.stub().resolves({ status: true }),
      untarFile: sinon.stub().resolves({ status: true }),
      removeDirectory: sinon.stub().resolves(true),
    };
    fsp = {
      mkdir: sinon.stub().resolves(),
      writeFile: sinon.stub().resolves(),
      rm: sinon.stub().resolves(),
    };
    appDataEntries = proxyquire('../../ZelBack/src/services/utils/appDataEntries', {
      '../serviceHelper': { runCommand },
      '../IOUtils': IOUtils,
      'node:fs/promises': fsp,
      '../../lib/log': { info: sinon.stub(), error: sinon.stub() },
      './specLibs': { getSpecBackend: async () => flux },
    });
  });

  afterEach(() => sinon.restore());

  /** The find(1) walk's exclusions, read back from what was run. */
  function excludedNames(params) {
    const names = [];
    for (let i = 0; i < params.length; i += 1) {
      if (params[i] === '-not' && params[i + 1] === '-name') names.push(params[i + 2]);
    }
    return names;
  }

  function excludedRegex(params) {
    const at = params.indexOf('-regex');
    return at === -1 ? null : params[at - 1] === '-not' && params[at + 1];
  }

  describe('listAppDataEntries', () => {
    it('walks one level of the volume root as root, leaving out every platform entry', async () => {
      runCommand.resolves({ error: null, stdout: 'appdata\nlogs\n', stderr: '' });

      const entries = await appDataEntries.listAppDataEntries(VOL);

      expect(entries).to.deep.equal(['appdata', 'logs']);
      const [cmd, opts] = runCommand.firstCall.args;
      expect(cmd).to.equal('find');
      expect(opts.runAsRoot).to.equal(true);
      expect(opts.params.slice(0, 5)).to.deep.equal([VOL, '-mindepth', '1', '-maxdepth', '1']);
      expect(excludedNames(opts.params)).to.deep.equal([...flux.PLATFORM_VOLUME_ENTRIES]);
      expect(opts.params.indexOf('-regextype')).to.be.lessThan(opts.params.indexOf('-regex'));
      expect(opts.params[opts.params.indexOf('-regextype') + 1]).to.equal('posix-extended');
    });

    it('leaves out the earlier per-operation staging shape by its exact form, and nothing that merely resembles it', () => {
      // What find is told to skip, applied the way find applies it: to the whole path.
      const regex = new RegExp(`^${'.*/'}${flux.LEGACY_STAGING_ENTRY_PATTERN.slice(1, -1)}$`);
      expect(regex.test(`${VOL}/.flux-op-${UUID}`)).to.equal(true);
      expect(regex.test(`${VOL}/.flux-op-backups`)).to.equal(false);
      expect(regex.test(`${VOL}/.flux-op`)).to.equal(false);
    });

    it('passes the staging regex to find as the library states it', async () => {
      await appDataEntries.listAppDataEntries(VOL);

      const [, opts] = runCommand.firstCall.args;
      expect(excludedRegex(opts.params)).to.equal(`.*/${flux.LEGACY_STAGING_ENTRY_PATTERN.slice(1, -1)}`);
    });

    it('throws when the volume cannot be listed', async () => {
      runCommand.resolves({ error: new Error('exit 1'), stdout: '', stderr: 'find: No such file or directory' });

      await expect(appDataEntries.listAppDataEntries(VOL)).to.be.rejectedWith(/could not list/);
    });
  });

  describe('wipeAppData', () => {
    it('deletes the same set the listing names, in one find, and hands back the result', async () => {
      const result = await appDataEntries.wipeAppData(VOL);

      expect(result.error).to.equal(null);
      const [cmd, opts] = runCommand.firstCall.args;
      expect(cmd).to.equal('find');
      expect(opts.runAsRoot).to.equal(true);
      expect(opts.params.slice(-5)).to.deep.equal(['-exec', 'rm', '-rf', '{}', '+']);
      expect(excludedNames(opts.params)).to.deep.equal([...flux.PLATFORM_VOLUME_ENTRIES]);
    });

    it('resolves a failure rather than throwing, so a caller can retry a busy mount', async () => {
      runCommand.resolves({ error: new Error('busy'), stdout: '', stderr: 'Device or resource busy' });

      const result = await appDataEntries.wipeAppData(VOL);

      expect(result.error).to.be.an('Error');
    });
  });

  describe('archiveAppData', () => {
    it('archives the app entries behind a manifest that is the first member, and removes the manifest afterwards', async () => {
      runCommand.resolves({ error: null, stdout: 'appdata\nlogs\n', stderr: '' });

      const status = await appDataEntries.archiveAppData(VOL, `${VOL}/backup/local/backup_web.tar.gz`, { component: 'web', replica: null });

      expect(status).to.deep.equal({ status: true });
      const manifestPath = path.join(VOL, appDataEntries.MANIFEST_MEMBER);
      expect(fsp.writeFile.calledOnceWith(manifestPath)).to.equal(true);
      const manifest = JSON.parse(fsp.writeFile.firstCall.args[1]);
      expect(manifest).to.include({ format: appDataEntries.ARCHIVE_FORMAT, component: 'web', replica: null });
      expect(manifest.entries).to.deep.equal(['appdata', 'logs']);
      expect(IOUtils.createTarGz.firstCall.args).to.deep.equal([
        VOL, `${VOL}/backup/local/backup_web.tar.gz`, [appDataEntries.MANIFEST_MEMBER, 'appdata', 'logs'],
      ]);
      expect(fsp.rm.calledWith(manifestPath), 'the manifest lives in the archive, not the volume').to.equal(true);
    });

    it('removes the manifest even when the archive fails', async () => {
      IOUtils.createTarGz.resolves({ status: false, error: 'No space left on device' });

      const status = await appDataEntries.archiveAppData(VOL, `${VOL}/backup/local/backup_web.tar.gz`, { component: 'web', replica: null });

      expect(status.status).to.equal(false);
      expect(fsp.rm.calledWith(path.join(VOL, appDataEntries.MANIFEST_MEMBER))).to.equal(true);
    });
  });

  describe('archiveFormat', () => {
    it('reads the format from the first member alone', async () => {
      runCommand.resolves({ error: null, stdout: `${appDataEntries.MANIFEST_MEMBER}\n`, stderr: '' });

      expect(await appDataEntries.archiveFormat('/a.tar.gz')).to.equal(appDataEntries.ARCHIVE_FORMAT);
      const [cmd, opts] = runCommand.firstCall.args;
      expect(cmd).to.equal('tar');
      expect(opts.params).to.deep.equal(['-tzf', '/a.tar.gz', '--occurrence=1', appDataEntries.MANIFEST_MEMBER]);
    });

    it('is format 1 for an archive with no manifest', async () => {
      runCommand.resolves({ error: new Error('exit 2'), stdout: '', stderr: 'tar: backup/manifest.json: Not found in archive' });

      expect(await appDataEntries.archiveFormat('/a.tar.gz')).to.equal(1);
    });
  });

  describe('restoreAppData', () => {
    const format2 = () => runCommand.withArgs('tar').resolves({ error: null, stdout: `${appDataEntries.MANIFEST_MEMBER}\n`, stderr: '' });
    const format1 = () => runCommand.withArgs('tar').resolves({ error: new Error('exit 2'), stdout: '', stderr: '' });
    let legacyComp;
    let v9Comp;

    beforeEach(() => {
      legacyComp = { mounts: [{ Source: path.join(VOL, flux.LEGACY_PRIMARY_SOURCE), Target: '/data' }] };
      v9Comp = { mounts: [{ Source: path.join(VOL, 'data'), Target: '/data' }] };
    });

    it('format 2: wipes the app entries and unpacks at the volume root, then drops the manifest', async () => {
      format2();

      const status = await appDataEntries.restoreAppData(VOL, '/a.tar.gz', v9Comp);

      expect(status).to.deep.equal({ status: true });
      const wipe = runCommand.getCalls().find((call) => call.args[0] === 'find');
      expect(wipe, 'the wipe runs').to.not.equal(undefined);
      expect(IOUtils.untarFile.firstCall.args).to.deep.equal([VOL, '/a.tar.gz']);
      expect(fsp.rm.calledWith(path.join(VOL, appDataEntries.MANIFEST_MEMBER))).to.equal(true);
      expect(IOUtils.removeDirectory.called, 'no directory is cleared by name').to.equal(false);
    });

    it('format 2: a wipe that fails refuses before unpacking, in those words', async () => {
      format2();
      runCommand.withArgs('find').resolves({ error: new Error('busy'), stdout: '', stderr: 'Device or resource busy' });

      const status = await appDataEntries.restoreAppData(VOL, '/a.tar.gz', v9Comp);

      expect(status.status).to.equal(false);
      expect(status.error).to.match(/could not clear/);
      expect(IOUtils.untarFile.called).to.equal(false);
    });

    it('format 1: replaces the legacy primary directory alone', async () => {
      format1();
      const primaryDir = path.join(VOL, flux.LEGACY_PRIMARY_SOURCE);

      const status = await appDataEntries.restoreAppData(VOL, '/a.tar.gz', legacyComp);

      expect(status).to.deep.equal({ status: true });
      expect(IOUtils.removeDirectory.firstCall.args).to.deep.equal([primaryDir, true]);
      expect(IOUtils.untarFile.firstCall.args).to.deep.equal([primaryDir, '/a.tar.gz']);
      expect(runCommand.getCalls().some((call) => call.args[0] === 'find'), 'other app entries are untouched').to.equal(false);
    });

    it('format 1: is refused for a component with no legacy primary mount', async () => {
      format1();

      const status = await appDataEntries.restoreAppData(VOL, '/a.tar.gz', v9Comp);

      expect(status.status).to.equal(false);
      expect(status.error).to.match(/no such mount/);
      expect(IOUtils.untarFile.called).to.equal(false);
      expect(IOUtils.removeDirectory.called).to.equal(false);
    });
  });
});
