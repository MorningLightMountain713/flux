'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const generalService = require('./generalService');

const RUNTIME_DIR = '/run/flux/telemetry';
const CONFIG_PATH = path.join(RUNTIME_DIR, 'config.toml');
const SERVICE_NAME = 'flux-telemetryd.service';

// The daemon runs as this unprivileged user; root-created runtime files are
// group-owned by it so the daemon can read them via group membership.
const RUNTIME_GROUP = 'flux-telemetry';

const OPAQUE_ID_SALT = 'flux-telemetry-v1';

async function deriveOpaqueId() {
  const collateralInfo = await generalService.obtainNodeCollateralInformation();
  if (!collateralInfo || !collateralInfo.txhash) {
    throw new Error('cannot derive opaqueId: collateral tx hash unavailable');
  }
  return crypto
    .createHash('sha256')
    .update(OPAQUE_ID_SALT)
    .update(collateralInfo.txhash)
    .digest('hex');
}

// The config carries only the node's opaque id now. Per-app Datadog sinks
// travel on the identity socket (see telemetryIdentityService), so a single
// node config routes many co-located apps to their own backends.
function buildToml(opaqueId) {
  const lines = [
    '# Written by fluxos — do not edit by hand.',
    `# Generated ${new Date().toISOString()}`,
    '',
    '[node]',
    `opaqueId = ${JSON.stringify(opaqueId)}`,
    '',
  ];

  return lines.join('\n');
}

// chgrp the target to the daemon's group and set its mode, so the
// unprivileged daemon can reach it. Best-effort; only called on Arcane,
// where the group exists and FluxOS can elevate.
async function chownGroup(target, mode) {
  const grp = await serviceHelper.runCommand('chgrp', {
    runAsRoot: true,
    params: [RUNTIME_GROUP, target],
    logError: false,
  });
  if (grp.error) {
    log.warn(`telemetry: chgrp ${RUNTIME_GROUP} ${target} failed: ${grp.error.message}`);
  }
  if (mode) {
    const chm = await serviceHelper.runCommand('chmod', {
      runAsRoot: true,
      params: [mode, target],
      logError: false,
    });
    if (chm.error) {
      log.warn(`telemetry: chmod ${mode} ${target} failed: ${chm.error.message}`);
    }
  }
}

async function systemctl(action) {
  const result = await serviceHelper.runCommand('systemctl', {
    runAsRoot: true,
    params: [action, SERVICE_NAME],
    timeout: 30000,
    logError: false,
  });
  if (result.error) {
    // stopping a unit that is not loaded is the desired end state, not a fault
    const notLoaded = action === 'stop' && /not loaded/i.test(result.error.message);
    if (!notLoaded) log.warn(`systemctl ${action} ${SERVICE_NAME}: ${result.error.message}`);
  }
  return result;
}

/**
 * Ensure the node config exists and the daemon is running. Idempotent — safe
 * to call on every telemetry-app install and at boot. A no-op on non-Arcane
 * nodes (no runtime dir). No restart needed: the config only ever holds the
 * opaque id, which does not change.
 */
async function ensureNode() {
  try {
    await fs.promises.access(RUNTIME_DIR, fs.constants.W_OK);
  } catch (err) {
    return;
  }

  const opaqueId = await deriveOpaqueId();
  const toml = buildToml(opaqueId);

  const tmpPath = path.join(RUNTIME_DIR, `.config.toml.${process.pid}.tmp`);
  try {
    await fs.promises.writeFile(tmpPath, toml, { mode: 0o440 });
    await fs.promises.rename(tmpPath, CONFIG_PATH);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  log.info(`telemetry config written to ${CONFIG_PATH}`);

  // The daemon (flux-telemetry) must traverse the dir and read the config.
  await chownGroup(RUNTIME_DIR, '0750');
  await chownGroup(CONFIG_PATH, '0440');

  const status = await serviceHelper.runCommand('systemctl', {
    runAsRoot: true,
    params: ['is-active', SERVICE_NAME],
    timeout: 10000,
    logError: false,
  });

  const isRunning = status.stdout && status.stdout.trim() === 'active';
  if (!isRunning) {
    await systemctl('start');
    log.info(`${SERVICE_NAME} started`);
  }
}

async function remove() {
  // The same gate as ensureNode: no runtime dir means telemetryd is not
  // provisioned on this node - nothing to stop, no config to remove.
  try {
    await fs.promises.access(RUNTIME_DIR, fs.constants.W_OK);
  } catch (err) {
    return;
  }

  await systemctl('stop');

  try {
    await fs.promises.unlink(CONFIG_PATH);
    log.info(`telemetry config removed from ${CONFIG_PATH}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`telemetry config removal failed: ${err.message}`);
    }
  }
}

module.exports = {
  ensureNode,
  remove,
  chownGroup,
  deriveOpaqueId,
  buildToml,
  CONFIG_PATH,
  SERVICE_NAME,
};
