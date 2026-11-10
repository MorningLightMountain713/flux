// An Arcane node's system shutdown, as its power pipeline runs it, for a fleet
// booted with createTestEnv({ shutdownd: 'real' }).
//
// The shutdown daemon is asked to begin the node pipeline over the system bus
// (BeginPipeline, the call the power button, the TUI and the updater make). It
// drains and stops every app container by the plans FluxOS handed it, then
// reports the pipeline ended. Where a node's privileged service would then power
// it off, FluxOS is sent the shutdown's SIGTERM (shutdownFluxosGracefully): it
// drains its folders to the connected peers and exits.
import { execInContainer, shutdownFluxosGracefully } from './container.js';
import { waitFor } from './wait.js';
import { NotPresentError } from './errors.js';

const SHUTDOWND = 'io.runonflux.Shutdownd';
const SHUTDOWND_PATH = '/io/runonflux/Shutdownd';

// `shutdownctl status` once a pipeline has run: "idle (last pipeline <id> ended <end state>)".
const ENDED = /^idle \(last pipeline (\d+) ended (\S+)\)/;

/**
 * Shut a node down through its shutdown daemon, then FluxOS.
 * @param {object} container - the node's container
 * @param {object} [options]
 * @param {string} [options.mode] - reboot, poweroff or halt
 * @param {number} [options.budgetS] - the pipeline's deadline, from now
 * @param {boolean} [options.hold] - keep the node down after FluxOS exits (releaseFluxos)
 * @param {boolean} [options.stopSyncthingAfter] - stop the node's syncthing once FluxOS exits
 * @returns {Promise<{pipelineId: number, endState: string, pid: number, exitedAt: number}>}
 */
export async function shutdownNodeGracefully(container, {
  mode = 'poweroff', budgetS = 300, hold = false, stopSyncthingAfter = false,
} = {}) {
  const deadline = Math.floor(Date.now() / 1000) + budgetS;
  const begun = await execInContainer(container,
    `busctl call ${SHUTDOWND} ${SHUTDOWND_PATH} ${SHUTDOWND} BeginPipeline ssst ${mode} harness tui ${deadline}`);
  if (begun.exitCode !== 0) {
    throw new Error(`shutdownNodeGracefully: BeginPipeline refused: ${(begun.stderr || begun.stdout || '').trim()}`);
  }
  const pipelineId = Number((begun.stdout.trim().match(/^t (\d+)$/) ?? [])[1]);
  if (!Number.isInteger(pipelineId)) throw new Error(`shutdownNodeGracefully: BeginPipeline answered ${begun.stdout.trim()}`);

  let endState = null;
  await waitFor(async () => {
    const { stdout } = await execInContainer(container, 'shutdownctl status');
    const ended = stdout.trim().match(ENDED);
    if (!ended || Number(ended[1]) !== pipelineId) throw new NotPresentError(`pipeline ${pipelineId}: ${stdout.trim()}`);
    [, , endState] = ended;
    return true;
  }, { timeout: (budgetS + 60) * 1000, interval: 1000, label: `shutdown pipeline ${pipelineId} ended` });

  const exited = await shutdownFluxosGracefully(container, { hold, stopSyncthingAfter });
  return { pipelineId, endState, ...exited };
}
