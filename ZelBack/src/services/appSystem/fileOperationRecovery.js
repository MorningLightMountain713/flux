'use strict';

const deviceHelper = require('../deviceHelper');
const log = require('../../lib/log');
const { appsFolder } = require('../utils/appConstants');
const executor = require('./volumeExecutor');
const fileOperationStore = require('./fileOperationStore');
const dockerService = require('../dockerService');
const { sessionForMountedVolume } = require('./volumeSession');
const fluxEventBus = require('../utils/fluxEventBus');

/**
 * Take back the file operations a FluxOS restart left running, and reclaim what
 * it left behind.
 *
 * An operation's container is detached from the process that started it, so a
 * restart does NOT interrupt the work - flux-op keeps copying and publishes its
 * own result. What the restart destroys is this process's memory of which
 * containers are legitimate, and the reaper removes every one it does not
 * recognise. So the durable record is read FIRST and anything still running is
 * adopted; only then does the reap run, over what is genuinely debris.
 *
 * A destination is never left inconsistent either way: a publish is one atomic
 * exchange, so it holds the old content or the new one.
 *
 * Runs at startup, after app volumes are mounted - but the API is already
 * answering by then, so an operation of THIS process can be in flight when it
 * runs. It removes only what no live operation owns: the executor records each
 * running operation's container and staging directory, and reap and sweep skip
 * those, so anything they reclaim belonged to a PREVIOUS process. Safe to run
 * more than once for the same reason, which matters because a startup that throws
 * is retried.
 *
 * @returns {Promise<{containers: number, removed: number}>}
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
    result = await sweepEveryMountedVolume();
  } finally {
    fluxEventBus.publish('fileops:recovered', result);
  }
  return result;
}

/**
 * Re-take the operations this node recorded as in flight and that are STILL
 * RUNNING, before anything reaps.
 *
 * Order matters and is the whole point: the reaper removes every
 * file-operation container no live operation owns, so adoption has to happen
 * first or it adopts what was just destroyed.
 *
 * A record whose container is gone, or has already exited, is dropped here -
 * its staging directory is debris and the sweep below clears it, exactly as
 * before this record existed.
 *
 * @returns {Promise<number>} how many were taken over
 */
async function adoptRunningOperations() {
  const records = await fileOperationStore.listOperations();
  if (!records.length) return 0;

  let adopted = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const record of records) {
    let running = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      const state = await dockerService.dockerContainerInspect(record.containerId, { identifierType: 'id' });
      running = Boolean(state?.State?.Running);
    } catch (error) {
      // No such container: it finished and reaped itself, or it is gone.
      running = false;
    }

    if (!running) {
      // eslint-disable-next-line no-await-in-loop
      await fileOperationStore.forgetOperation(record.containerId);
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await executor.adoptOperation(record);
    adopted += 1;
    log.info(`fileOperationRecovery - adopted ${record.kind || 'file operation'} on ${record.identifier} (container ${record.containerId.slice(0, 12)})`);
  }
  return adopted;
}

async function sweepEveryMountedVolume() {
  // BEFORE the reap, or it adopts containers the reap has already removed.
  const adopted = await adoptRunningOperations();
  const containers = await executor.reapOrphanedContainers();

  let mounts = [];
  try {
    mounts = await deviceHelper.listMountedFilesystems();
  } catch (error) {
    log.error(`fileOperationRecovery - could not read the mount table: ${error.message}`);
    return { containers, removed: 0, adopted };
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

  if (containers || removed) {
    log.info(`fileOperationRecovery - reaped ${containers} container(s), removed ${removed} artefact(s)`);
  }
  return { containers, removed, adopted };
}

module.exports = { recoverInterruptedFileOperations };
