'use strict';

const deviceHelper = require('../deviceHelper');
const log = require('../../lib/log');
const { appsFolder } = require('../utils/appConstants');
const executor = require('./volumeExecutor');
const fileOperationStore = require('./fileOperationStore');
const dockerService = require('../dockerService');
const { sessionForMountedVolume } = require('./volumeSession');
const fluxEventBus = require('../utils/fluxEventBus');
const capabilities = require('../utils/capabilities');

/**
 * Take back the file operations a FluxOS restart left behind, and reclaim what
 * it left behind.
 *
 * An operation's container is detached from the process that started it, so a
 * restart does NOT interrupt the work - flux-op keeps copying and publishes its
 * own result - and the container is kept after it exits, so its result waits
 * for FluxOS too. What the restart destroys is this process's memory of which
 * containers are legitimate, and the reaper removes every one it does not
 * recognise. So the durable record is read FIRST and every recorded operation
 * is taken back; only then does the reap run, over what is genuinely debris.
 *
 * A destination is never left inconsistent either way: a publish is one atomic
 * exchange, so it holds the old content or the new one.
 *
 * In two steps. The take-back needs Docker and the database and nothing else,
 * so it starts with the boot, before anything waits for the network, and a
 * caller polling a job is answered within seconds of the restart however long
 * the boot decision takes. The staging sweep needs the app volumes mounted, so
 * it runs where the boot mounts them, after the take-back.
 */

let takeBackPass = null;

/**
 * Re-take every operation this node recorded, then reap the containers no
 * operation owns. Once per process: every caller shares the first pass.
 *
 * @returns {Promise<{adopted: number, containers: number}>}
 */
function takeBackFileOperations() {
  if (!takeBackPass) {
    takeBackPass = (async () => {
      await capabilities.whenUp(['dockerReachable', 'mongoReachable']);
      const { adopted, unread } = await adoptRecordedOperations();
      // A recorded container docker could not describe may be running: nothing
      // is reaped this boot rather than risk removing it.
      if (unread) {
        log.warn(`fileOperationRecovery - ${unread} recorded container(s) could not be inspected; reaping nothing this boot`);
        return { adopted, containers: 0 };
      }
      const containers = await executor.reapOrphanedContainers();
      return { adopted, containers };
    })();
  }
  return takeBackPass;
}

/**
 * The boot's file-operation recovery, run once the app volumes are mounted:
 * the take-back, then the staging directories no live operation owns.
 *
 * The API is already answering by then, so an operation of THIS process can be
 * in flight. It removes only what no live operation owns: the executor records
 * each running operation's container and staging directory, and reap and sweep
 * skip those, so anything they reclaim belonged to a PREVIOUS process. Safe to
 * run more than once for the same reason, which matters because a startup that
 * throws is retried.
 *
 * @returns {Promise<{containers: number, removed: number, adopted: number}>}
 */
async function recoverInterruptedFileOperations() {
  // Published on every path that ENDS the pass - the one that found nothing,
  // and the one that threw. "The sweep ran and had nothing to do" is a
  // different fact from "the sweep has not run yet", and the log line below
  // cannot express the first because it only fires when there was something to
  // report. Anything that restarts a node to exercise boot recovery needs to
  // know the pass is over: without a signal it can only guess, and a pass that
  // lands after the guess reaches into whatever is running by then. A throw
  // still propagates - a startup that throws is retried, and the retry
  // publishes again, which is safe for the same reason the sweep is.
  let result = { containers: 0, removed: 0, adopted: 0 };
  try {
    const { adopted, containers } = await takeBackFileOperations();
    executor.noteVolumesMounted();
    const removed = await sweepEveryMountedVolume();
    result = { containers, removed, adopted };
    if (containers || removed) {
      log.info(`fileOperationRecovery - reaped ${containers} container(s), removed ${removed} artefact(s)`);
    }
  } finally {
    fluxEventBus.publish('fileops:recovered', result);
  }
  return result;
}

/**
 * Re-take every operation this node recorded, before anything reaps.
 *
 * Order matters and is the whole point: the reaper removes every
 * file-operation container no live operation owns, so the take-back has to
 * happen first or it takes back what was just destroyed.
 *
 * A record whose container docker cannot describe is left for the next boot.
 *
 * @returns {Promise<{adopted: number, unread: number}>} records taken back, and
 *   records left because their container could not be inspected
 */
async function adoptRecordedOperations() {
  const records = await fileOperationStore.listOperations();
  let adopted = 0;
  let unread = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const record of records) {
    let inspected;
    try {
      // null: no such container, the record outlived it
      // eslint-disable-next-line no-await-in-loop
      inspected = await dockerService.dockerContainerInspect(record.containerId, { identifierType: 'id' });
    } catch (error) {
      unread += 1;
      log.warn(`fileOperationRecovery - could not inspect recorded container ${record.containerId.slice(0, 12)}: ${error.message}`);
      // eslint-disable-next-line no-continue
      continue;
    }
    const state = inspected ? inspected.State : null;
    executor.adoptOperation(record, state, executor.mountOf(inspected));
    adopted += 1;
    log.info(`fileOperationRecovery - took back ${record.kind || 'file operation'} on ${record.identifier} (container ${record.containerId.slice(0, 12)}, ${state ? state.Status : 'gone'})`);
  }
  return { adopted, unread };
}

// How long a removal waits for the boot's take-back before ending what it can
// see. The take-back needs only Docker and MongoDB; past this, the removal still
// ends every file-operation container docker reports on the volume, and only
// the jobs of operations not yet taken back go unreported.
const TAKE_BACK_WAIT_MS = 30_000;

/**
 * End every file operation on an app volume about to be removed, once the
 * boot's take-back has made the operations a restart left behind known: their
 * jobs are then ended by the node like any other. See
 * volumeExecutor.endOperationsOn.
 *
 * @param {string} mount the volume's mount path
 * @param {string} reason told to each operation's caller
 * @returns {Promise<function(): void>} lets operations onto the volume again
 */
async function endFileOperationsOn(mount, reason) {
  let timer;
  const waited = new Promise((resolve) => { timer = setTimeout(resolve, TAKE_BACK_WAIT_MS); });
  await Promise.race([takeBackFileOperations().catch(() => {}), waited]);
  clearTimeout(timer);
  return executor.endOperationsOn(mount, reason);
}

/**
 * Sweep the staging directories on every mounted app volume.
 * @returns {Promise<number>} how many were removed
 */
async function sweepEveryMountedVolume() {
  let mounts = [];
  try {
    mounts = await deviceHelper.listMountedFilesystems();
  } catch (error) {
    log.error(`fileOperationRecovery - could not read the mount table: ${error.message}`);
    return 0;
  }

  // Only mounted app volumes. A staging directory can only exist on one, and
  // reading an unmounted mountpoint would walk the bare host directory
  // underneath it instead.
  const volumes = mounts.filter((mount) => mount.target.startsWith(appsFolder));

  let removed = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const volume of volumes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await executor.sweepStagingDirectories(sessionForMountedVolume(volume));
      removed += result.removed.length;
    } catch (error) {
      // One unreadable volume must not strand the debris on every other app.
      log.error(`fileOperationRecovery - could not sweep ${volume.target}: ${error.message}`);
    }
  }
  return removed;
}

module.exports = { takeBackFileOperations, recoverInterruptedFileOperations, endFileOperationsOn };
