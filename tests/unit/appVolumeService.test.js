const { expect } = require('chai');
const sinon = require('sinon');
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

  it('does nothing when the component has no syncthing folder', async () => {
    await appVolumeService.writeStignore({ dir: tmp, sync: null, injectedSyncExcludes: () => [] });

    let missing = false;
    try {
      await fs.access(path.join(tmp, '.stignore'));
    } catch {
      missing = true;
    }
    expect(missing).to.equal(true);
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
