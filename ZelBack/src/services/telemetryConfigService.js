const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const generalService = require('./generalService');

const RUNTIME_DIR = '/run/flux/telemetry';
const CONFIG_PATH = path.join(RUNTIME_DIR, 'config.toml');
const SERVICE_NAME = 'flux-telemetryd.service';

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

  for (const [key, value] of Object.entries(telemetry)) {
    if (value !== undefined && value !== null) {
      lines.push(`${key} = ${JSON.stringify(String(value))}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

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

async function apply(telemetryConfig) {
  if (!telemetryConfig || !telemetryConfig.provider) {
    throw new Error('telemetryConfig must include at least a provider');
  }

  try {
    await fs.promises.access(RUNTIME_DIR, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`runtime directory ${RUNTIME_DIR} not available (${err.code})`);
  }

  const opaqueId = await deriveOpaqueId();
  const toml = buildToml(opaqueId, telemetryConfig);

  const tmpPath = path.join(RUNTIME_DIR, `.config.toml.${process.pid}.tmp`);
  try {
    await fs.promises.writeFile(tmpPath, toml, { mode: 0o440 });
    await fs.promises.rename(tmpPath, CONFIG_PATH);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  log.info(`telemetry config written to ${CONFIG_PATH}`);

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
  deriveOpaqueId,
  buildToml,
  CONFIG_PATH,
  SERVICE_NAME,
};
