const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const appVolumeService = require('../../ZelBack/src/services/appLifecycle/appVolumeService');

describe('appVolumeService.writeStignore', () => {
  let tmp;

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
    // reserved (/backup + injected) precede owner excludes so first-match-wins makes
    // them non-overridable; the atomic slot is excluded by its managed dir.
    expect(content).to.equal('/backup\n/seed\n/io.runonflux/conf\n/var/data\ncache\n');
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
    expect(content).to.equal('/backup\n/new\n');
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
    expect(content).to.equal('/backup\n/seed\n');
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

describe('appVolumeService.createAppVolume (findmnt disk selection + in-lock recheck)', () => {
  const GiB = 1024 ** 3;
  const deployComp = {
    identifier: 'web_testapp', appName: 'testapp', storage: 10, mounts: [],
  };

  function load({ mount, condemned = false, teardownOwed = false } = {}) {
    const runCommand = sinon.stub().resolves({ error: null });
    const svc = proxyquire('../../ZelBack/src/services/appLifecycle/appVolumeService', {
      config: { lockedSystemResources: { extrahdd: 5 } },
      '../serviceHelper': { ensureString: (x) => x, runCommand },
      '../dockerService': { getAppIdentifier: (id) => id },
      '../deviceHelper': { mountForTarget: sinon.stub().resolves(mount) },
      '../utils/hostMutationLock': { withHostMutationLock: (fn) => fn() },
      '../appManagement/appsRuntimeState': { isCondemned: sinon.stub().resolves(condemned) },
      './pendingTeardownStore': { teardownOwedFor: sinon.stub().resolves(teardownOwed) },
      '../messageHelper': { createSuccessMessage: (m) => ({ status: 'success', data: m }) },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
    return { svc, runCommand };
  }

  // [{ cmd, params }] for every runCommand call
  const cmdCalls = (runCommand) => runCommand.getCalls().map((c) => ({ cmd: c.args[0], params: (c.args[1] || {}).params || [] }));

  it('places the FLUXFSVOL on the apps-folder filesystem and builds it (fallocate/mke2fs/mount)', async () => {
    const { svc, runCommand } = load({ mount: { source: '/dev/mapper/flux_crypt', target: '/dat', availableBytes: 500 * GiB } });
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

  it('aborts inside the lock without allocating when the app is condemned', async () => {
    const { svc, runCommand } = load({ mount: { source: '/dev/mapper/flux_crypt', target: '/dat', availableBytes: 500 * GiB }, condemned: true });
    let threw = null;
    try { await svc.createAppVolume(deployComp, null, false); } catch (e) { threw = e; }
    expect(threw, 'aborted').to.be.an('error');
    expect(threw.message).to.include('arrived before volume creation');
    expect(cmdCalls(runCommand).some((c) => c.cmd === 'fallocate'), 'never allocated for a condemned app').to.be.false;
  });

  it('throws when the apps-folder disk has no room for the volume', async () => {
    const { svc } = load({ mount: { source: '/dev/mapper/flux_crypt', target: '/dat', availableBytes: 1 * GiB } });
    let threw = null;
    try { await svc.createAppVolume(deployComp, null, false); } catch (e) { threw = e; }
    expect(threw, 'aborted').to.be.an('error');
    expect(threw.message).to.include('Insufficient space');
  });
});
