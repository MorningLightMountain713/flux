'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const appVolumeService = require('../../ZelBack/src/services/appLifecycle/appVolumeService');
const { asConfig } = require('./fixtures/config');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

describe('appVolumeService.writeStignore', () => {
  let tmp;
  // The platform's entries lead every ignore file, as the spec library lists them.
  let platform;

  before(async () => {
    const { PLATFORM_VOLUME_ENTRIES } = await loadSpecLibrary();
    // Less the names syncthing never indexes, which a line would state nothing about.
    platform = PLATFORM_VOLUME_ENTRIES.filter((name) => !['.stfolder', '.stignore'].includes(name))
      .map((name) => `/${name}`).join('\n');
    expect(platform).to.include('/backup');
    expect(platform).to.include('/io.runonflux');
  });

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stignore-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
    sinon.restore();
  });

  it('writes the reserved entries first, then the owner excludes, with injected paths relativized', async () => {
    const deployComp = {
      dir: tmp,
      sync: { exclude: ['/var/data', 'cache'] },
      injectedSyncExcludes: () => [`${tmp}/seed`, `${tmp}/io.runonflux/conf`],
    };

    await appVolumeService.writeStignore(deployComp);

    const content = await fs.readFile(path.join(tmp, '.stignore'), 'utf8');
    // reserved (the platform's entries + injected) precede owner excludes so
    // first-match-wins makes them non-overridable; the atomic slot is excluded
    // by its managed dir.
    expect(content).to.equal(`${platform}\n/.flux-op-*\n/seed\n/io.runonflux/conf\n/var/data\ncache\n`);
    // One derivation: the file seeds exactly what the monitor converges through the API.
    // eslint-disable-next-line global-require
    const { ignoreLinesFor } = require('../../ZelBack/src/services/appSystem/syncthingIgnorePolicy');
    expect(content).to.equal(`${(await ignoreLinesFor(deployComp)).join('\n')}\n`);
  });

  it('writes no .stignore when the component has no syncthing folder', async () => {
    await appVolumeService.writeStignore({ dir: tmp, sync: null, injectedSyncExcludes: () => [] });

    let missing = false;
    try {
      await fs.access(path.join(tmp, '.stignore'));
    } catch {
      missing = true;
    }
    expect(missing).to.equal(true);
  });

  it('removes lingering .stignore/.stfolder when sync was dropped on a kept volume', async () => {
    await fs.writeFile(path.join(tmp, '.stignore'), '/backup\n');
    await fs.mkdir(path.join(tmp, '.stfolder'));

    await appVolumeService.writeStignore({ dir: tmp, sync: null, injectedSyncExcludes: () => [] });

    const survivors = await fs.readdir(tmp);
    expect(survivors).to.not.include('.stignore');
    expect(survivors).to.not.include('.stfolder');
  });

  it('reports a change to an existing ignore set so the caller can request a scan', async () => {
    await fs.writeFile(path.join(tmp, '.stignore'), '/backup\n/old\n');

    const changed = await appVolumeService.writeStignore({
      dir: tmp,
      sync: { exclude: ['/new'] },
      injectedSyncExcludes: () => [],
    });

    const content = await fs.readFile(path.join(tmp, '.stignore'), 'utf8');
    expect(content).to.equal(`${platform}\n/.flux-op-*\n/new\n`);
    expect(changed).to.equal(true);
  });

  it('reports no change on a first write or when the ignore set is unchanged', async () => {
    const deployComp = {
      dir: tmp,
      sync: { exclude: [] },
      injectedSyncExcludes: () => [],
    };

    // first write: the folder is not registered with syncthing yet
    expect(await appVolumeService.writeStignore(deployComp)).to.equal(false);
    // unchanged content: nothing to enforce
    expect(await appVolumeService.writeStignore(deployComp)).to.equal(false);
  });

  it('dedups against the reserved entries and drops empty patterns', async () => {
    const deployComp = {
      dir: tmp,
      sync: { exclude: ['/backup', ''] },
      injectedSyncExcludes: () => [`${tmp}/seed`],
    };

    await appVolumeService.writeStignore(deployComp);

    const content = await fs.readFile(path.join(tmp, '.stignore'), 'utf8');
    expect(content).to.equal(`${platform}\n/.flux-op-*\n/seed\n`);
  });
});

describe('appVolumeService.removeOrphanedInjectedContent', () => {
  afterEach(() => sinon.restore());

  it('removes injected files dropped from the new spec, keeping the surviving ones', async () => {
    const run = sinon.stub(serviceHelper, 'runCommand').resolves();
    const oldComp = {
      injectedContentFiles: () => ['/c/seed', '/c/io.runonflux/conf/a.conf', '/c/io.runonflux/conf/b.conf'],
    };
    // b.conf survives inside a still-mounted shared atomic dir; a.conf + seed are dropped.
    const newComp = { injectedContentFiles: () => ['/c/io.runonflux/conf/b.conf'] };

    await appVolumeService.removeOrphanedInjectedContent(oldComp, newComp);

    const removed = run.getCalls().map((c) => c.args[1].params[1]);
    expect(removed).to.have.members(['/c/seed', '/c/io.runonflux/conf/a.conf']);
    expect(removed).to.not.include('/c/io.runonflux/conf/b.conf');
    run.getCalls().forEach((c) => {
      expect(c.args[0]).to.equal('rm');
      expect(c.args[1].runAsRoot).to.equal(true);
    });
  });

  it('removes nothing when the injected set is unchanged', async () => {
    const run = sinon.stub(serviceHelper, 'runCommand').resolves();
    const comp = { injectedContentFiles: () => ['/c/seed'] };

    await appVolumeService.removeOrphanedInjectedContent(comp, comp);

    expect(run.called).to.equal(false);
  });
});

describe('appVolumeService.createAppVolume (disk selection + in-lock recheck)', () => {
  const deployComp = {
    identifier: 'web_testapp', appName: 'testapp', storage: 10, mounts: [],
  };
  // placementVolumesInGib's rows: whole GiB, emptiest first.
  const disk = (mount, available) => ({
    filesystem: `/dev/${mount.replace(/\//g, '') || 'root'}`, mount, size: 1000, used: 1000 - available, available,
  });

  function load({
    disks, condemned = false, teardownOwed = false, recordFails = false, fsStub = null,
  } = {}) {
    const runCommand = sinon.stub().resolves({ error: null });
    const recordNewVolumeImage = recordFails
      ? sinon.stub().rejects(new Error('record write failed')) : sinon.stub().resolves();
    const svc = proxyquire('../../ZelBack/src/services/appLifecycle/appVolumeService', {
      config: asConfig({ lockedSystemResources: { extrahdd: 5 } }),
      '../serviceHelper': { ensureString: (x) => x, runCommand },
      '../dockerService': { getAppIdentifier: (id) => `flux${id}` },
      '../utils/volumeService': { placementVolumesInGib: sinon.stub().resolves(disks), recordNewVolumeImage },
      '../utils/hostMutationLock': { withHostMutationLock: (fn) => fn() },
      '../appManagement/appsRuntimeState': { isCondemned: sinon.stub().resolves(condemned) },
      './pendingTeardownStore': { teardownOwedFor: sinon.stub().resolves(teardownOwed) },
      '../messageHelper': { createSuccessMessage: (m) => ({ status: 'success', data: m }) },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      ...(fsStub ? { 'node:fs/promises': fsStub } : {}),
    });
    return { svc, runCommand, recordNewVolumeImage };
  }

  // [{ cmd, params }] for every runCommand call
  const cmdCalls = (runCommand) => runCommand.getCalls().map((c) => ({ cmd: c.args[0], params: (c.args[1] || {}).params || [] }));

  it('places the FLUXFSVOL on the emptiest usable disk and builds it (fallocate/mke2fs/mount)', async () => {
    const { svc, runCommand } = load({ disks: [disk('/dat', 500), disk('/mnt/root', 40)] });
    await svc.createAppVolume(deployComp, null, false);
    const calls = cmdCalls(runCommand);
    expect(calls.some((c) => c.cmd === 'fallocate' && c.params.some((p) => String(p).includes('/dat/'))), 'allocated the volume file on /dat').to.be.true;
    expect(calls.some((c) => c.cmd === 'mke2fs'), 'made the filesystem').to.be.true;
    expect(calls.some((c) => c.cmd === 'mount' && c.params.includes('loop')), 'mounted it').to.be.true;
    // the bare mountpoint is set immutable BEFORE the mount shadows it, so a write
    // while the volume is unmounted fails EPERM instead of landing on the host fs
    const chattrIdx = calls.findIndex((c) => c.cmd === 'chattr' && c.params[0] === '+i');
    const mountIdx = calls.findIndex((c) => c.cmd === 'mount' && c.params.includes('loop'));
    expect(chattrIdx, 'set the mountpoint immutable').to.be.greaterThan(-1);
    expect(chattrIdx, 'immutable flag set before the mount shadows the bare dir').to.be.lessThan(mountIdx);
  });

  // The UUID is this node's stamp on the image, and the record is what lets a later
  // boot look the image up and tell it from a file left under the same name.
  it('formats the image with a UUID of its own and records the image by it', async () => {
    const { svc, runCommand, recordNewVolumeImage } = load({ disks: [disk('/dat', 500)] });
    await svc.createAppVolume(deployComp, null, false);
    const mke2fs = cmdCalls(runCommand).find((c) => c.cmd === 'mke2fs');
    const uuid = mke2fs.params[mke2fs.params.indexOf('-U') + 1];
    expect(uuid).to.match(/^[0-9a-f-]{36}$/);
    // The image is named by the docker form and recorded under the identifier.
    sinon.assert.calledOnceWithExactly(recordNewVolumeImage, 'web_testapp', '/dat/fluxweb_testappFLUXFSVOL', uuid);
  });

  it('fails the install when the image cannot be recorded', async () => {
    const { svc } = load({ disks: [disk('/dat', 500)], recordFails: true });
    let threw = null;
    try { await svc.createAppVolume(deployComp, null, false); } catch (e) { threw = e; }
    expect(threw, 'aborted').to.be.an('error');
    expect(threw.message).to.include('record write failed');
  });

  [['directory', 'mkdir'], ['file', 'touch']].forEach(([sourceType, cmd]) => {
    it(`fails the volume when a ${sourceType} mount source cannot be made`, async () => {
      const { svc, runCommand } = load({ disks: [disk('/dat', 500)] });
      runCommand.withArgs(cmd).resolves({ error: new Error(`${cmd} failed`) });
      const withSource = {
        ...deployComp,
        dir: '/apps/fluxweb_testapp',
        mounts: [{ Source: '/apps/fluxweb_testapp/source', sourceType, perms: null }],
      };

      let threw = null;
      try { await svc.createAppVolume(withSource, null, false); } catch (e) { threw = e; }

      expect(threw, 'a volume without its mount source was handed on').to.be.an('error');
      expect(threw.message).to.include(`${cmd} failed`);
    });
  });

  // The volume is created before syncthing is told about the folder, so the ignore
  // set it is created with is the one the folder is first scanned under.
  it('seeds the ignore set when it creates a replicated volume', async () => {
    const fsStub = { writeFile: sinon.stub().resolves(), readFile: sinon.stub().rejects(new Error('ENOENT')), rm: sinon.stub().resolves() };
    const { svc } = load({ disks: [disk('/dat', 500)], fsStub });
    const synced = {
      ...deployComp,
      dir: '/apps/fluxweb_testapp',
      sync: { mode: 'syncFirst', exclude: [] },
      injectedSyncExcludes: () => [],
    };

    await svc.createAppVolume(synced, null, false);

    expect(fsStub.writeFile.calledWith('/apps/fluxweb_testapp/.stignore'), 'the volume was created with no ignore set').to.equal(true);
  });

  it('aborts inside the lock without allocating when the app is condemned', async () => {
    const { svc, runCommand } = load({ disks: [disk('/dat', 500)], condemned: true });
    let threw = null;
    try { await svc.createAppVolume(deployComp, null, false); } catch (e) { threw = e; }
    expect(threw, 'aborted').to.be.an('error');
    expect(threw.message).to.include('arrived before volume creation');
    expect(cmdCalls(runCommand).some((c) => c.cmd === 'fallocate'), 'never allocated for a condemned app').to.be.false;
  });

  // Peers rank a seed on what each node says it holds, so a claim about the volume
  // being replaced describes data that is about to be gone.
  describe('the published holdings claim', () => {
    // eslint-disable-next-line global-require
    const globalState = require('../../ZelBack/src/services/utils/globalState');
    const claim = { bytes: 5_000_000, newestModified: 1000 };
    let saved;
    beforeEach(() => {
      saved = globalState.folderHoldings;
      globalState.folderHoldings = new Map([['fluxweb_testapp', claim], ['fluxother_app', claim]]);
    });
    afterEach(() => { globalState.folderHoldings = saved; });

    it('is withdrawn for this component before its volume is allocated', async () => {
      const { svc, runCommand } = load({ disks: [disk('/dat', 500)] });
      let heldAtAllocation;
      runCommand.withArgs('fallocate').callsFake(async () => {
        heldAtAllocation = globalState.folderHoldings.has('fluxweb_testapp');
        return { error: null };
      });
      await svc.createAppVolume(deployComp, null, false);
      expect(heldAtAllocation, 'withdrawn before the allocation').to.equal(false);
      expect(globalState.folderHoldings.get('fluxother_app'), 'another folder keeps its claim').to.equal(claim);
    });

    it('stands when creation aborts before anything is allocated', async () => {
      const { svc } = load({ disks: [disk('/dat', 500)], condemned: true });
      await svc.createAppVolume(deployComp, null, false).catch(() => {});
      expect(globalState.folderHoldings.get('fluxweb_testapp'), 'the volume and its data are untouched').to.equal(claim);
    });
  });

  it('takes the first disk with room for the volume and the reserve, in the order given', async () => {
    // 10 GiB volume + 5 GiB reserve: the first has 14, the second 16.
    const { svc, runCommand } = load({ disks: [disk('/dat', 14), disk('/mnt/data2', 16), disk('/mnt/data3', 900)] });
    await svc.createAppVolume(deployComp, null, false);
    const fallocate = cmdCalls(runCommand).find((c) => c.cmd === 'fallocate');
    expect(fallocate.params).to.deep.equal(['-l', '10G', '/mnt/data2/fluxweb_testappFLUXFSVOL']);
  });

  it('puts the image in the appvolumes directory when the chosen disk is the root', async () => {
    const { svc, runCommand } = load({ disks: [disk('/', 500)] });
    await svc.createAppVolume(deployComp, null, false);
    const fallocate = cmdCalls(runCommand).find((c) => c.cmd === 'fallocate');
    expect(fallocate.params[2]).to.match(/appvolumes\/fluxweb_testappFLUXFSVOL$/);
  });

  it('throws when no usable disk has room for the volume', async () => {
    const { svc, runCommand } = load({ disks: [disk('/dat', 14), disk('/mnt/root', 3)] });
    let threw = null;
    try { await svc.createAppVolume(deployComp, null, false); } catch (e) { threw = e; }
    expect(threw, 'aborted').to.be.an('error');
    expect(threw.message).to.include('Insufficient space');
    expect(cmdCalls(runCommand).some((c) => c.cmd === 'fallocate'), 'nothing allocated').to.be.false;
  });
});
