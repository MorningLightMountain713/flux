const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('fileOperationRecovery tests', () => {
  const APPS_FOLDER = '/test/apps/folder/';

  let executorStub;
  let storeStub;
  let dockerStub;
  let deviceHelperStub;
  let logStub;
  let recovery;

  const mount = (target) => ({
    source: '/dev/loop3', target, fstype: 'ext4', sizeBytes: 2e9, usedBytes: 1e9, availableBytes: 1e9, usePercent: 50,
  });

  beforeEach(() => {
    executorStub = {
      reapOrphanedContainers: sinon.stub().resolves(0),
      sweepStagingDirectories: sinon.stub().resolves({ removed: [] }),
      adoptOperation: sinon.stub().resolves(),
    };
    storeStub = {
      listOperations: sinon.stub().resolves([]),
      forgetOperation: sinon.stub().resolves(),
    };
    dockerStub = { dockerContainerInspect: sinon.stub().resolves({ State: { Running: true } }) };
    deviceHelperStub = { listMountedFilesystems: sinon.stub().resolves([]) };
    logStub = {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    };

    // The real one. What the sweep is handed has to be a session the executor
    // will accept paths from, and a stub that merely looks like one would let a
    // caller pass something the executor refuses without this test noticing.
    const volumeSession = proxyquire('../../ZelBack/src/services/appSystem/volumeSession', {
      '../deviceHelper': deviceHelperStub,
      '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
      '../IOUtils': { getFolderSize: sinon.stub(), getFileSize: sinon.stub() },
      '../utils/appConstants': { appsFolder: APPS_FOLDER },
    });

    recovery = proxyquire('../../ZelBack/src/services/appSystem/fileOperationRecovery', {
      '../deviceHelper': deviceHelperStub,
      './volumeExecutor': executorStub,
      './fileOperationStore': storeStub,
      '../dockerService': dockerStub,
      './volumeSession': volumeSession,
      '../../lib/log': logStub,
      '../utils/appConstants': { appsFolder: APPS_FOLDER },
    });
  });

  afterEach(() => sinon.restore());

  describe('an operation the restart left running', () => {
    const record = {
      containerId: 'c0ffee1234567890', jobId: 'op_abc', stagingRoot: '/test/apps/folder/app/.flux-op-1', identifier: 'app', kind: 'Copying...',
    };

    // The container is detached from the process that started it, so a restart
    // does not stop the copy - it keeps running and publishes itself. Only this
    // node's memory of which containers are legitimate is lost, and without the
    // record the reaper destroys work that was minutes from finishing.
    it('adopts it rather than reaping it', async () => {
      storeStub.listOperations.resolves([record]);
      dockerStub.dockerContainerInspect.resolves({ State: { Running: true } });

      const result = await recovery.recoverInterruptedFileOperations();

      sinon.assert.calledOnceWithExactly(executorStub.adoptOperation, record);
      sinon.assert.notCalled(storeStub.forgetOperation);
      expect(result.adopted).to.equal(1);
    });

    // Order is the whole point: the reaper removes every file-operation
    // container no live operation owns, so adopting afterwards adopts what was
    // just destroyed.
    it('adopts BEFORE anything reaps', async () => {
      storeStub.listOperations.resolves([record]);

      await recovery.recoverInterruptedFileOperations();

      sinon.assert.callOrder(executorStub.adoptOperation, executorStub.reapOrphanedContainers);
    });

    // The negative case, and without it the adoption above would pass on a
    // recovery that adopts everything it is told about and reaps nothing.
    it('drops a record whose container has already exited, and lets the reap run', async () => {
      storeStub.listOperations.resolves([record]);
      dockerStub.dockerContainerInspect.resolves({ State: { Running: false } });

      const result = await recovery.recoverInterruptedFileOperations();

      sinon.assert.notCalled(executorStub.adoptOperation);
      sinon.assert.calledOnceWithExactly(storeStub.forgetOperation, record.containerId);
      expect(result.adopted).to.equal(0);
    });

    it('drops a record whose container docker has never heard of', async () => {
      storeStub.listOperations.resolves([record]);
      dockerStub.dockerContainerInspect.rejects(new Error('No such container'));

      const result = await recovery.recoverInterruptedFileOperations();

      sinon.assert.notCalled(executorStub.adoptOperation);
      sinon.assert.calledOnceWithExactly(storeStub.forgetOperation, record.containerId);
      expect(result.adopted).to.equal(0);
    });

    // Fail-open: an unreadable store leaves this node doing exactly what it did
    // before the record existed, rather than refusing to recover at all.
    it('reaps as before when the store cannot be read', async () => {
      storeStub.listOperations.resolves([]);
      executorStub.reapOrphanedContainers.resolves(2);

      const result = await recovery.recoverInterruptedFileOperations();

      sinon.assert.notCalled(executorStub.adoptOperation);
      expect(result).to.deep.equal({ containers: 2, removed: 0, adopted: 0 });
    });
  });

  it('reaps containers a restart left running', async () => {
    // The container is detached from the process that started it, so a restart
    // leaves it working with nobody waiting for its exit code.
    executorStub.reapOrphanedContainers.resolves(2);

    const result = await recovery.recoverInterruptedFileOperations();

    expect(result.containers).to.equal(2);
  });

  it('sweeps every mounted app volume', async () => {
    deviceHelperStub.listMountedFilesystems.resolves([
      mount(`${APPS_FOLDER}fluxcomp_one`),
      mount(`${APPS_FOLDER}fluxcomp_two`),
    ]);

    await recovery.recoverInterruptedFileOperations();

    const swept = executorStub.sweepStagingDirectories.getCalls().map((c) => c.args[0].mount);
    expect(swept).to.deep.equal([`${APPS_FOLDER}fluxcomp_one`, `${APPS_FOLDER}fluxcomp_two`]);
  });

  it('sweeps only paths under the apps folder', async () => {
    // Everything else in the mount table belongs to the node, not to an app.
    deviceHelperStub.listMountedFilesystems.resolves([
      mount('/'),
      mount('/dat'),
      mount(`${APPS_FOLDER}fluxcomp_one`),
      mount('/boot'),
    ]);

    await recovery.recoverInterruptedFileOperations();

    const swept = executorStub.sweepStagingDirectories.getCalls().map((c) => c.args[0].mount);
    expect(swept).to.deep.equal([`${APPS_FOLDER}fluxcomp_one`]);
  });

  it('reads volumes from the mount table rather than the apps directory', async () => {
    // An app whose volume is NOT mounted has a bare host directory under the
    // apps folder. Listing the directory would walk that; the mount table only
    // reports what is actually mounted, so an unmounted app is skipped rather
    // than swept on the wrong filesystem.
    deviceHelperStub.listMountedFilesystems.resolves([]);

    const result = await recovery.recoverInterruptedFileOperations();

    expect(executorStub.sweepStagingDirectories.called).to.equal(false);
    expect(result).to.deep.equal({ containers: 0, removed: 0, adopted: 0 });
  });

  it('totals what was reclaimed', async () => {
    deviceHelperStub.listMountedFilesystems.resolves([
      mount(`${APPS_FOLDER}fluxcomp_one`),
      mount(`${APPS_FOLDER}fluxcomp_two`),
    ]);
    executorStub.sweepStagingDirectories
      .onFirstCall().resolves({ removed: ['.flux-op-a', '.flux-op-b'] })
      .onSecondCall().resolves({ removed: ['.flux-op-c'] });

    const result = await recovery.recoverInterruptedFileOperations();

    expect(result).to.deep.equal({ containers: 0, removed: 3, adopted: 0 });
  });

  it('still reports the containers it reaped when the mount table cannot be read', async () => {
    // Losing the mount table costs the sweep, not the reap - the containers
    // were already gone by then, and reporting zero would misstate that.
    executorStub.reapOrphanedContainers.resolves(1);
    deviceHelperStub.listMountedFilesystems.rejects(new Error('findmnt failed'));

    const result = await recovery.recoverInterruptedFileOperations();

    expect(result).to.deep.equal({ containers: 1, removed: 0, adopted: 0 });
    expect(logStub.error.called).to.equal(true);
  });

  it('sweeps the remaining volumes when one of them throws', async () => {
    // One unreadable volume must not strand the debris on every other app.
    deviceHelperStub.listMountedFilesystems.resolves([
      mount(`${APPS_FOLDER}fluxcomp_one`),
      mount(`${APPS_FOLDER}fluxcomp_two`),
    ]);
    executorStub.sweepStagingDirectories
      .onFirstCall().rejects(new Error('EACCES'))
      .onSecondCall().resolves({ removed: ['.flux-op-b'] });

    const result = await recovery.recoverInterruptedFileOperations();

    expect(result.removed).to.equal(1);
    expect(executorStub.sweepStagingDirectories.callCount).to.equal(2);
  });

  it('reaps before sweeping, so a live container cannot rewrite what was just cleaned', async () => {
    deviceHelperStub.listMountedFilesystems.resolves([mount(`${APPS_FOLDER}fluxcomp_one`)]);

    await recovery.recoverInterruptedFileOperations();

    expect(executorStub.reapOrphanedContainers.calledBefore(executorStub.sweepStagingDirectories)).to.equal(true);
  });




});
