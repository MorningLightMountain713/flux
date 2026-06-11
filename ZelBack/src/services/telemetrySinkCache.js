const deploymentProvider = require('./appRuntime/deploymentProvider');
const log = require('../lib/log');

// Per-app telemetry sink routing table. The customer's Datadog sink lives
// in the encrypted spec, so it is only known once an app's spec has been
// decrypted at install time (Arcane-only). We cache it here, keyed by app
// name, so the identity socket can attach the right sink to each container
// event without re-decrypting on the hot path.
const sinks = new Map();

function key(appName) {
  return String(appName).toLowerCase();
}

/**
 * Pull the sink out of a built deployment. Returns null when the app has
 * no telemetry or no usable credential. `site` is left to the spec/daemon
 * default when absent.
 */
function extractSink(deployment) {
  const telemetry = deployment && deployment.telemetry;
  if (!telemetry || !telemetry.apiKey) return null;

  const sink = { provider: telemetry.provider, apiKey: telemetry.apiKey };
  if (telemetry.site) sink.site = telemetry.site;
  return sink;
}

// Single change observer (the identity service registers its resync here).
// A plain callback rather than fluxEventBus: the bus is the harness's SSE
// test stream and publishes nothing in production.
let changeListener = null;

function onChange(listener) {
  changeListener = listener;
}

/** Set (or clear, when sink is null) the routing entry for an app. */
function setSink(appName, sink) {
  const k = key(appName);
  const prev = sinks.get(k) || null;
  if (sink && sink.apiKey) {
    sinks.set(k, sink);
  } else {
    sinks.delete(k);
  }
  const next = sinks.get(k) || null;
  if (changeListener && JSON.stringify(prev) !== JSON.stringify(next)) {
    changeListener();
  }
}

function getSink(appName) {
  return sinks.get(key(appName)) || null;
}

function deleteSink(appName) {
  setSink(appName, null);
}

function hasAnyTelemetryApps() {
  return sinks.size > 0;
}

/**
 * Rebuild the cache from every installed app. Used at boot so a restart
 * re-establishes routing. Encrypted apps that cannot be decrypted (a
 * non-Arcane node) are skipped by the deployment provider, so this is a
 * no-op there.
 */
async function reconcileFromInstalled() {
  let deployments = [];
  try {
    deployments = await deploymentProvider.listInstalledDeployments();
  } catch (err) {
    log.error(`telemetry sink cache: reconcile failed: ${err.message}`);
    return;
  }

  sinks.clear();
  for (const deployment of deployments) {
    setSink(deployment.appName, extractSink(deployment));
  }
}

module.exports = {
  extractSink,
  setSink,
  getSink,
  deleteSink,
  hasAnyTelemetryApps,
  reconcileFromInstalled,
  onChange,
};
