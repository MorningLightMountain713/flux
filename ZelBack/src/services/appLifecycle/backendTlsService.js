// Platform-managed backend-TLS certificates.
//
// For a component whose loadBalancing declares backendTls.verify === 'required',
// the node issues the TLS material the app serves HTTPS with:
//   1. generate an Ed25519 keypair + CSR (CN = appName) locally — the private
//      key never leaves the node;
//   2. get a 30-day host cert signed by the app's per-app CA through fluxbench
//      (benchmarkService.signCertificate);
//   3. atomically write cert.pem + key.pem into the container's reserved
//      /io.runonflux/tls/ mount source, so the app reads them from
//      FLUX_TLS_CERT_PATH / FLUX_TLS_KEY_PATH.
//
// The node needs only the leaf — the app presents it, and FDM verifies it
// against the per-app CA that FDM fetches itself. Certs are byte-independent
// per instance (each container gets its own keypair), and are re-issued on a
// timer well before their 30-day expiry (see backendTlsRenewal).
//
// No path in this module is constructed locally. The caller passes the paths
// flux-spec resolved (`deployComp.backendTlsPaths()`), which derive from the same
// reserved prefix the spec validator protects and the same file names the app's
// FLUX_TLS_*_PATH env vars point at. Rebuilding them here would be a second,
// unlinked copy of a contract whose whole point is that it cannot drift.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const execFileAsync = util.promisify(execFile);

const log = require('../../lib/log');
const benchmarkService = require('../benchmarkService');

// Re-issue this many days before expiry — ~2/3 of the 30-day host-cert life,
// leaving ~10 days of slack for a signer that is transiently unavailable.
const RENEW_BEFORE_EXPIRY_DAYS = 10;

/**
 * Generate an Ed25519 keypair and a CSR (CN = appName) in a throwaway temp dir.
 * Returns the CSR and the private key as PEM; the temp dir is always removed.
 * @param {string} appName
 * @returns {Promise<{ csr: string, keyPem: string }>}
 */
async function generateKeypairAndCsr(appName) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-tls-'));
  try {
    const keyPath = path.join(dir, 'key.pem');
    const csrPath = path.join(dir, 'req.csr');
    await execFileAsync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', keyPath]);
    await execFileAsync('openssl', ['req', '-new', '-key', keyPath, '-subj', `/CN=${appName}`, '-out', csrPath]);
    const [csr, keyPem] = await Promise.all([
      fsp.readFile(csrPath, 'utf8'),
      fsp.readFile(keyPath, 'utf8'),
    ]);
    return { csr, keyPem };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// Atomic write: land the bytes on a temp file in the same directory, then rename
// over the target. rename is atomic on one filesystem, so the app (reading over
// the bind mount) never observes a partial cert or key.
async function writeAtomic(filePath, contents, mode) {
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, contents, { mode });
  await fsp.rename(tmp, filePath);
}

/**
 * Issue (or renew) the backend-TLS cert for one component and write it into its
 * reserved TLS directory. Throws on failure — the caller decides whether that
 * blocks the install or just leaves the app unrouted this cycle.
 *
 * @param {string} appName the app name (CSR CN + per-app CA binding)
 * @param {{dir: string, certPath: string, keyPath: string}} tlsPaths from
 *   `deployComp.backendTlsPaths()` — never rebuilt here
 * @returns {Promise<void>}
 */
async function provisionCert(appName, tlsPaths) {
  const { dir, certPath, keyPath } = tlsPaths;
  await fsp.mkdir(dir, { recursive: true, mode: 0o755 });

  const { csr, keyPem } = await generateKeypairAndCsr(appName);

  // Two envelopes, both of which have to be unwrapped — the same shape
  // enterpriseHelper handles for decryptRSAMessage. benchmarkService.executeCall
  // wraps every result in { status: 'success' | 'error', data }, and `data` is
  // the signer's own JSON string carrying { status: 'ok', certificate }. Reading
  // the signer's status off the outer object silently never matches, because the
  // outer status is 'success', so every issue looks like a refusal to sign.
  const returned = await benchmarkService.signCertificate({ csr, appName });
  if (!returned || returned.status !== 'success') {
    throw new Error(`Could not reach the certificate signer for ${appName}`);
  }
  let signed;
  try {
    signed = typeof returned.data === 'string' ? JSON.parse(returned.data) : returned.data;
  } catch (error) {
    throw new Error(`The certificate signer returned an unreadable response for ${appName}`);
  }
  if (!signed || signed.status !== 'ok' || !signed.certificate) {
    throw new Error(`No backend-TLS cert was signed for ${appName}`);
  }

  // key first, then cert: a reader that sees the cert can rely on the key being
  // present. 0644 — readable by the app whatever uid the image runs as (the
  // container is single-tenant, so in-container world-read is acceptable; a
  // tighter uid-scoped mode is a future hardening).
  await writeAtomic(keyPath, keyPem, 0o644);
  await writeAtomic(certPath, signed.certificate, 0o644);
  log.info(`Backend-TLS cert provisioned for ${appName} at ${dir}`);
}

/**
 * When a component's delivered cert expires. Returns null when there is no
 * readable, parseable cert — an unprovisioned or damaged component, which the
 * renewal sweep treats the same as an expired one: re-issue.
 *
 * @param {{certPath: string}} tlsPaths from `deployComp.backendTlsPaths()`
 * @returns {Promise<Date|null>}
 */
async function certExpiry(tlsPaths) {
  try {
    const pem = await fsp.readFile(tlsPaths.certPath, 'utf8');
    // Parsed from `validTo` rather than read from `validToDate`: the Date accessor
    // arrived in Node 22.10, and no Node 20 release has it. On the versions the fleet
    // runs it reads as undefined, which threw in here and made every certificate look
    // unreadable — so every cert was permanently due for renewal.
    const { validTo } = new crypto.X509Certificate(pem);
    const expiry = new Date(validTo);
    return Number.isNaN(expiry.getTime()) ? null : expiry;
  } catch (error) {
    return null;
  }
}

/**
 * Is this component's cert missing, unreadable, or inside the renewal window?
 * Renewal is time-based and redeploy-independent: an app that runs for months
 * without a redeploy must still get a fresh leaf before the 30-day one expires.
 *
 * @param {{certPath: string}} tlsPaths from `deployComp.backendTlsPaths()`
 * @param {number} [nowMs] current time, injectable for tests
 * @returns {Promise<boolean>}
 */
async function needsRenewal(tlsPaths, nowMs = Date.now()) {
  const expiry = await certExpiry(tlsPaths);
  if (!expiry) return true;
  return expiry.getTime() - nowMs < RENEW_BEFORE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The owner's reload reaction for the managed cert, taken from the first
 * verify:required port (one cert per container, so one reaction). Returns
 * `{ action, signal }` to signal/restart, or null for self-watch.
 * @param {Object|null|undefined} loadBalancing
 * @returns {Object|null}
 */
function reloadReaction(loadBalancing) {
  const entry = Object.values(loadBalancing || {}).find(
    (lb) => lb && lb.backendTls && lb.backendTls.verify === 'required',
  );
  return entry ? entry.backendTls.reload : null;
}

module.exports = {
  provisionCert,
  generateKeypairAndCsr,
  certExpiry,
  needsRenewal,
  reloadReaction,
  RENEW_BEFORE_EXPIRY_DAYS,
};
