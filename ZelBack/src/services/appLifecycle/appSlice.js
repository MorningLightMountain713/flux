'use strict';

/**
 * Every app's containers live in their own systemd slice, inside flux-apps.slice,
 * so the app's processes are found and killed from its name alone, without docker
 * or the database. The apps together are one group under it: they share the
 * host-swap fence, and under contention they share the machine against the
 * system services, so they cannot starve FluxOS's own dependencies.
 *
 * A slice outlives its last container until it is stopped. Removing an app
 * stops its slice, and boot stops every slice left empty.
 *
 * Where a unit's cgroup is, systemd says: its tree starts wherever systemd itself
 * runs, which is the filesystem's root on a host and below it when systemd runs
 * in a container.
 */

const fs = require('fs').promises;
const path = require('path');
const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');

// systemd reads each '-' in a slice's name as one level: flux-apps-<app>.slice
// sits inside flux-apps.slice, which sits inside flux.slice.
const PARENT = 'flux-apps.slice';
const PREFIX = 'flux-apps-';
const APP_NAME = /^[A-Za-z0-9-]+$/;
// systemd answers from memory; a question it has not answered by then gets no answer
const SYSTEMD_ANSWER_MS = 10 * 1000;

let cgroupRoot = '/sys/fs/cgroup';

/**
 * @param {string} root Where the cgroup filesystem is mounted.
 */
function useCgroupRoot(root) {
  cgroupRoot = root;
}

/**
 * The app's slice unit. The app's name is escaped the way systemd-escape does,
 * so it is one level: unescaped, `my-app` would land inside `my`'s slice.
 * @param {string} appName
 * @returns {string|null} Null for a name no app can have.
 */
function sliceName(appName) {
  if (typeof appName !== 'string' || !APP_NAME.test(appName)) return null;
  return `${PREFIX}${appName.replace(/-/g, '\\x2d')}.slice`;
}

/**
 * The app whose slice a unit is.
 * @param {string} unit
 * @returns {string|null} Null for a unit that is not an app's slice.
 */
function appOfSlice(unit) {
  if (typeof unit !== 'string' || !unit.startsWith(PREFIX) || !unit.endsWith('.slice')) return null;
  const appName = unit.slice(PREFIX.length, -'.slice'.length).replace(/\\x2d/g, '-');
  return APP_NAME.test(appName) ? appName : null;
}

/**
 * The unit's cgroup directory, as systemd reports it.
 * @param {string} unit Any systemd unit: a slice, a scope, a service.
 * @returns {Promise<string|null>} Null when systemd has no such unit, or no answer.
 */
async function controlGroup(unit) {
  const { stdout, error } = await serviceHelper.runCommand('systemctl', {
    params: ['show', '-p', 'ControlGroup', '--value', unit], timeout: SYSTEMD_ANSWER_MS, logError: false,
  });
  const group = (stdout ?? '').trim();
  return error || !group ? null : path.join(cgroupRoot, group);
}

/**
 * @param {string} unit
 * @returns {Promise<boolean|null>} Whether any process lives in the slice, or
 *   null when the slice does not exist.
 */
async function isPopulated(unit) {
  const dir = await controlGroup(unit);
  const events = dir ? await fs.readFile(path.join(dir, 'cgroup.events'), 'utf8').catch(() => null) : null;
  if (events === null) return null;
  return /^populated 1$/m.test(events);
}

/**
 * Stop a slice that holds no process. A slice in use is left alone.
 *
 * The stop is queued and not waited for: an empty slice has nothing to stop, and
 * systemd's own bus timeout bounds the request.
 * @param {string} unit
 * @returns {Promise<boolean>} True when systemd took the stop.
 */
async function stopIfEmpty(unit) {
  if (await isPopulated(unit) !== false) return false;
  const { error } = await serviceHelper.runCommand('systemctl', { runAsRoot: true, params: ['stop', '--no-block', unit] });
  if (error) {
    log.error(`appSlice - ${unit} could not be stopped: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Stop the app's slice, once its containers are gone.
 * @param {string} appName
 */
async function release(appName) {
  const unit = sliceName(appName);
  if (unit) await stopIfEmpty(unit);
}

/**
 * Stop every app slice that holds no process: those whose app was removed
 * while FluxOS was not running to stop them.
 * @returns {Promise<number>} How many were stopped.
 */
async function stopEmptySlices() {
  const parent = await controlGroup(PARENT);
  const entries = parent ? await fs.readdir(parent).catch(() => []) : [];
  const slices = entries.filter((entry) => appOfSlice(entry) !== null);
  let stopped = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const unit of slices) {
    // eslint-disable-next-line no-await-in-loop
    if (await stopIfEmpty(unit)) stopped += 1;
  }
  if (stopped) log.info(`appSlice - stopped ${stopped} empty app slice(s)`);
  return stopped;
}

module.exports = {
  sliceName,
  appOfSlice,
  controlGroup,
  release,
  stopEmptySlices,
  useCgroupRoot,
};
