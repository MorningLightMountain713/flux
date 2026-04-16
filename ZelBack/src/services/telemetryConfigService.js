/**
 * Telemetry Config Service
 *
 * Writes the flux-telemetryd runtime config file and manages the
 * daemon's systemd unit lifecycle. The caller (v9 spec ingestion,
 * future work) provides the already-decrypted telemetry config object.
 *
 * Config file: /run/flux/telemetry/config.toml
 * Systemd unit: flux-telemetryd.service
 *
 * The runtime directory is owned by systemd (RuntimeDirectory= on the
 * fluxos unit). This service only writes/removes files inside it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const generalService = require('./generalService');

// --- constants -----------------------------------------------------------

const RUNTIME_DIR = '/run/flux/telemetry';
const CONFIG_PATH = path.join(RUNTIME_DIR, 'config.toml');
const SERVICE_NAME = 'flux-telemetryd.service';

// Domain separator for the opaqueId hash. Changing this rotates every
// node's opaqueId, which breaks Datadog dashboard continuity — treat
// it as a versioned constant.
const OPAQUE_ID_SALT = 'flux-telemetry-v1';

// --- opaqueId derivation -------------------------------------------------

/**
 * Derive a stable, non-reversible node identifier from the collateral
 * transaction hash. Customers see this as the "node" tag in Datadog
 * but cannot map it back to a physical Flux node without the salt.
 *
 * @returns {Promise<string>} hex-encoded SHA-256 hash
 */
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

// --- TOML generation -----------------------------------------------------

/**
 * Build the TOML config string from a telemetry config object.
 *
 * @param {string} opaqueId
 * @param {Object} telemetry - { provider, site?, apiKey, ... }
 * @returns {string} TOML content
 */
function buildToml(opaqueId, telemetry) {
  const lines = [
    '# Written by fluxos — do not edit by hand.',
    `# Generated ${new Date().toISOString()}`,
    '',
    '[node]',
    `opaqueId = ${JSON.stringify(opaqueId)}`,
    '',
    '[telemetry]',
  ];

  // Write all telemetry fields as camelCase TOML key/value pairs.
  // The daemon's serde config expects camelCase.
  for (const [key, value] of Object.entries(telemetry)) {
    if (value !== undefined && value !== null) {
      lines.push(`${key} = ${JSON.stringify(String(value))}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// --- systemd helpers -----------------------------------------------------

async function systemctl(action) {
  const result = await serviceHelper.runCommand('systemctl', {
    runAsRoot: true,
    params: [action, SERVICE_NAME],
    timeout: 30000,
  });
  if (result.error) {
    log.warn(`systemctl ${action} ${SERVICE_NAME}: ${result.error.message}`);
  }
  return result;
}

// --- public API ----------------------------------------------------------

/**
 * Apply a telemetry configuration. Writes the config file via atomic
 * rename and starts or restarts the daemon.
 *
 * @param {Object} telemetryConfig - Plain telemetry object from the
 *   decrypted v9 spec, e.g. { provider: "datadog", site: "datadoghq.com", apiKey: "..." }
 */
async function apply(telemetryConfig) {
  if (!telemetryConfig || !telemetryConfig.provider) {
    throw new Error('telemetryConfig must include at least a provider');
  }

  // Verify runtime directory exists (systemd creates it).
  try {
    await fs.promises.access(RUNTIME_DIR, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`runtime directory ${RUNTIME_DIR} not available (${err.code})`);
  }

  const opaqueId = await deriveOpaqueId();
  const toml = buildToml(opaqueId, telemetryConfig);

  // Atomic write: write to a temp file in the same directory, then rename.
  // rename() on the same filesystem is atomic — no window where the
  // daemon sees a partial file.
  const tmpPath = path.join(RUNTIME_DIR, `.config.toml.${process.pid}.tmp`);
  try {
    await fs.promises.writeFile(tmpPath, toml, { mode: 0o440 });
    await fs.promises.rename(tmpPath, CONFIG_PATH);
  } catch (err) {
    // Clean up temp file on failure
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  log.info(`telemetry config written to ${CONFIG_PATH}`);

  // Check if the daemon is already running. Restart if so, start if not.
  const status = await serviceHelper.runCommand('systemctl', {
    runAsRoot: true,
    params: ['is-active', SERVICE_NAME],
    timeout: 10000,
    logError: false,
  });

  const isRunning = status.stdout && status.stdout.trim() === 'active';
  if (isRunning) {
    await systemctl('restart');
    log.info(`${SERVICE_NAME} restarted`);
  } else {
    await systemctl('start');
    log.info(`${SERVICE_NAME} started`);
  }
}

/**
 * Remove the telemetry configuration. Stops the daemon and removes
 * the config file.
 */
async function remove() {
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
  apply,
  remove,
  // Exported for testing:
  deriveOpaqueId,
  buildToml,
  CONFIG_PATH,
  SERVICE_NAME,
};
