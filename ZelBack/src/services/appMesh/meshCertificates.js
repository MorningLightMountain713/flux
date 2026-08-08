// Per-(node, app) mesh certificate authority and host certificate management.
//
// Each node is its own authority for each mesh app it hosts: it generates an
// Ed25519 CA with nebula-cert, signs its own host certificate with it, and
// publishes only the CA *certificate* (via the broadcast's meshCa field). The
// private keys never leave /dat/var/lib/flux-mesh/<instance>/ — the
// LUKS-encrypted data disk, outside any container mount. Issuance and renewal
// are entirely local; no signing round trip can fail because a remote service
// is down.
//
// Host certificates live 24 hours and are replaced by the periodic sweep
// (reconcileHostCertificate). A replacement is signed early and parked on
// disk, and only swapped into service once it is at least
// HOST_CERT_MIN_AGE_MS old: nebula validates NotBefore against the peer's
// clock and nebula-cert cannot backdate, so a just-signed certificate is
// rejected by any peer whose clock is behind the signer's. Ageing the
// certificate before deployment gives every peer the same tolerance a
// backdate would have, using the cert's real timestamp. The first certificate
// of a (node, app) has nothing older to keep serving and deploys fresh —
// peers cannot dial before the broadcast propagates, which dwarfs
// chrony-synced skew.
//
// Authority rotation is an overlap, never a flag day: the successor is
// created and published alongside the incumbent (trust bundle), the host
// certificate is re-signed under the successor once peers carry both, and
// only then is the incumbent retired. The three steps are separate calls
// because the waits between them are propagation waits the caller owns.
const fsp = require('node:fs/promises');
const path = require('node:path');

const log = require('../../lib/log');
const serviceHelper = require('../serviceHelper');
const meshDerivation = require('./meshDerivation');

const MESH_STATE_ROOT = '/dat/var/lib/flux-mesh';

// The CA is long-lived and not rotated on a schedule: its fingerprint is a
// hash of the whole certificate and every host certificate cites it, so
// rotation is disruptive by construction and reserved for key compromise.
const CA_VALIDITY = '87600h';
const HOST_CERT_VALIDITY = '24h';
// Renew while the old certificate still has hours of slack for a signer or
// sweep that is transiently unavailable (~2/3 of the 24 h life).
const HOST_CERT_RENEW_BEFORE_MS = 8 * 60 * 60 * 1000;
// Minimum age before a parked replacement goes into service. Sized to the
// real threat: chrony holds Arcane nodes within milliseconds and steps a
// freshly booted clock within a minute, so ten minutes covers any peer whose
// clock lags the signer's with three orders of magnitude to spare.
const HOST_CERT_MIN_AGE_MS = 10 * 60 * 1000;
const MESH_GROUP = 'flux-mesh';

// What one sweep step did — 'deployed' means host.crt changed and the caller
// must reload nebula.
const HostCertificateAction = Object.freeze({
  DEPLOYED: 'deployed',
  PARKED: 'parked',
  NONE: 'none',
});

const FILES = {
  caKey: 'ca.key',
  caCert: 'ca.crt',
  successorKey: 'ca-successor.key',
  successorCert: 'ca-successor.crt',
  hostKey: 'host.key',
  hostCert: 'host.crt',
  nextKey: 'host-next.key',
  nextCert: 'host-next.crt',
};

// The per-app directory name is the app's deployment identity segment —
// uuid-derived, so a re-registered name can never pick up a dead app's CA key.
function meshAppDir(instance) {
  if (typeof instance !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(instance)) {
    throw new TypeError('instance must be the app\'s identity segment');
  }
  return path.join(MESH_STATE_ROOT, instance);
}

async function readIfPresent(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeIfPresent(filePath) {
  await fsp.rm(filePath, { force: true });
}

async function runNebulaCert(params) {
  const result = await serviceHelper.runCommand('nebula-cert', { runAsRoot: true, params });
  if (result.error) {
    throw new Error(`nebula-cert ${params[0]} failed: ${result.error.message} ${result.stderr || ''}`.trim());
  }
  return result;
}

function parsePrintedCertificate(cert) {
  const notAfter = new Date(cert.details.notAfter);
  if (Number.isNaN(notAfter.getTime())) return null;
  return {
    name: cert.details.name,
    notAfter,
    issuer: cert.details.issuer,
    fingerprint: cert.fingerprint,
    isCa: cert.details.isCa === true,
    networks: cert.details.networks ?? [],
    unsafeNetworks: cert.details.unsafeNetworks ?? [],
    groups: cert.details.groups ?? [],
  };
}

/**
 * Every certificate in a PEM file, parsed — `nebula-cert print -json` emits an
 * array, one element per certificate in the bundle. Null when the file is
 * missing or any certificate is unreadable: a bundle that cannot be read whole
 * cannot be judged.
 *
 * @param {string} certPath
 * @returns {Promise<Array<{name: string, notAfter: Date, issuer: string,
 *   fingerprint: string, isCa: boolean, networks: string[],
 *   unsafeNetworks: string[], groups: string[]}>|null>}
 */
async function certificateBundleDetails(certPath) {
  try {
    const result = await serviceHelper.runCommand('nebula-cert', {
      runAsRoot: true, params: ['print', '-json', '-path', certPath],
    });
    if (result.error) return null;
    const parsed = JSON.parse(result.stdout);
    const certs = (Array.isArray(parsed) ? parsed : [parsed]).map(parsePrintedCertificate);
    return certs.every((cert) => cert !== null) ? certs : null;
  } catch (error) {
    return null;
  }
}

/**
 * The first certificate of a file, for single-cert reads (host.crt, one CA).
 * @param {string} certPath
 * @returns {Promise<object|null>}
 */
async function certificateDetails(certPath) {
  const certs = await certificateBundleDetails(certPath);
  return certs && certs.length > 0 ? certs[0] : null;
}

/**
 * Generate one CA pair with nebula-cert into `dir` under the given file
 * names, atomically: signed into temp names, key landed before cert, so a
 * crash never leaves a certificate whose key is missing — a pair with no
 * cert is retried whole by the caller's existence check.
 */
async function generateAuthority(dir, appUuid, outpoint, keyFile, certFile) {
  const keyPath = path.join(dir, keyFile);
  const certPath = path.join(dir, certFile);
  const tmpKey = `${keyPath}.tmp`;
  const tmpCert = `${certPath}.tmp`;
  await removeIfPresent(keyPath);
  await removeIfPresent(certPath);
  const prefix = meshDerivation.appPrefix(appUuid);
  await runNebulaCert([
    'ca',
    '-name', `flux-mesh-${meshDerivation.nodeId(outpoint)}`,
    '-duration', CA_VALIDITY,
    // Constraints are pinned on the authority because unset means
    // unconstrained: an unpinned CA would let its holder mint a leaf claiming
    // unsafe routes over the whole overlay space of every app.
    '-networks', prefix,
    '-unsafe-networks', prefix,
    '-groups', MESH_GROUP,
    '-out-key', tmpKey,
    '-out-crt', tmpCert,
  ]);
  await fsp.chmod(tmpKey, 0o600);
  await fsp.rename(tmpKey, keyPath);
  await fsp.rename(tmpCert, certPath);
  return fsp.readFile(certPath, 'utf8');
}

/**
 * The app's mesh authority on this node, created on first use.
 *
 * @param {{instance: string, appUuid: string, outpoint: string}} app
 * @returns {Promise<string>} the CA certificate PEM
 */
async function ensureAuthority({ instance, appUuid, outpoint }) {
  const dir = meshAppDir(instance);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const [caCert, caKey] = await Promise.all([
    readIfPresent(path.join(dir, FILES.caCert)),
    readIfPresent(path.join(dir, FILES.caKey)),
  ]);
  if (caCert && caKey) return caCert;
  log.info(`Mesh authority created for ${instance}`);
  return generateAuthority(dir, appUuid, outpoint, FILES.caKey, FILES.caCert);
}

/**
 * What this node publishes as its authority: the incumbent CA certificate,
 * with the successor appended during a rotation overlap. This exact PEM string
 * is what the membership voucher covers.
 *
 * @param {string} instance
 * @returns {Promise<string>}
 */
async function authorityBundle(instance) {
  const dir = meshAppDir(instance);
  const incumbent = await readIfPresent(path.join(dir, FILES.caCert));
  if (!incumbent) {
    throw new Error(`No mesh authority exists for ${instance}`);
  }
  const successor = await readIfPresent(path.join(dir, FILES.successorCert));
  return successor ? `${incumbent}${successor}` : incumbent;
}

/**
 * Sign a host certificate into the parked (next) slot. The certificate names
 * the node, claims the node's own overlay address, and routes its block:
 * peers reach this node's containers behind it.
 *
 * @param {{instance: string, appUuid: string, outpoint: string}} app
 * @param {{ authority?: 'incumbent'|'successor' }} [opts]
 * @returns {Promise<void>}
 */
async function signHostCertificate({ instance, appUuid, outpoint }, { authority = 'incumbent' } = {}) {
  const dir = meshAppDir(instance);
  const caKey = path.join(dir, authority === 'successor' ? FILES.successorKey : FILES.caKey);
  const caCert = path.join(dir, authority === 'successor' ? FILES.successorCert : FILES.caCert);
  const keyPath = path.join(dir, FILES.nextKey);
  const certPath = path.join(dir, FILES.nextCert);
  const tmpKey = `${keyPath}.tmp`;
  const tmpCert = `${certPath}.tmp`;
  const prefixLength = meshDerivation.appPrefix(appUuid).split('/')[1];
  await runNebulaCert([
    'sign',
    '-ca-key', caKey,
    '-ca-crt', caCert,
    '-name', meshDerivation.nodeId(outpoint),
    // The address carries the overlay prefix length, not /128: nebula tests a
    // packet's destination against the sender's own networks, so a narrower
    // prefix would leave this node an overlay of one.
    '-networks', `${meshDerivation.nodeAddress(appUuid, outpoint)}/${prefixLength}`,
    '-unsafe-networks', meshDerivation.nodeBlock(appUuid, outpoint),
    '-groups', MESH_GROUP,
    '-duration', HOST_CERT_VALIDITY,
    '-out-key', tmpKey,
    '-out-crt', tmpCert,
  ]);
  await fsp.chmod(tmpKey, 0o600);
  await fsp.rename(tmpKey, keyPath);
  await fsp.rename(tmpCert, certPath);
}

async function promoteParkedCertificate(dir) {
  // Key first: anything reading the pair after seeing the new cert can rely
  // on the matching key being in place. The caller reloads nebula after.
  await fsp.rename(path.join(dir, FILES.nextKey), path.join(dir, FILES.hostKey));
  await fsp.rename(path.join(dir, FILES.nextCert), path.join(dir, FILES.hostCert));
}

/**
 * One sweep step for one app's host certificate. Idempotent; call it
 * periodically.
 *
 *   DEPLOYED — a certificate went into service (first issue, or an aged
 *              replacement was promoted)
 *   PARKED   — a replacement was signed and left to age
 *   NONE     — nothing was due
 *
 * @param {{instance: string, appUuid: string, outpoint: string}} app
 * @param {number} [nowMs] injectable for tests
 * @returns {Promise<string>} a HostCertificateAction member
 */
async function reconcileHostCertificate({ instance, appUuid, outpoint }, nowMs = Date.now()) {
  const dir = meshAppDir(instance);
  const app = { instance, appUuid, outpoint };
  const hostCertPath = path.join(dir, FILES.hostCert);
  const nextCertPath = path.join(dir, FILES.nextCert);

  const hostCert = await readIfPresent(hostCertPath);
  const hostKey = await readIfPresent(path.join(dir, FILES.hostKey));
  if (!hostCert || !hostKey) {
    // First certificate (or a broken half-pair): nothing older exists to keep
    // serving, so it deploys fresh — the ageing rule only defends replacements.
    await signHostCertificate(app);
    await promoteParkedCertificate(dir);
    log.info(`Mesh host certificate issued for ${instance}`);
    return HostCertificateAction.DEPLOYED;
  }

  let nextStat = null;
  try {
    nextStat = await fsp.stat(nextCertPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (nextStat) {
    // mtime is the signing moment: the file is written once by
    // signHostCertificate and rename preserves it.
    if (nowMs - nextStat.mtimeMs >= HOST_CERT_MIN_AGE_MS) {
      await promoteParkedCertificate(dir);
      log.info(`Mesh host certificate renewed for ${instance}`);
      return HostCertificateAction.DEPLOYED;
    }
    return HostCertificateAction.NONE;
  }

  const details = await certificateDetails(hostCertPath);
  if (!details || details.notAfter.getTime() - nowMs < HOST_CERT_RENEW_BEFORE_MS) {
    // Renew under the authority that signed the current certificate, so a
    // rotation in progress is neither undone nor jumped ahead of.
    const successorDetails = await certificateDetails(path.join(dir, FILES.successorCert));
    const authority = details && successorDetails && details.issuer === successorDetails.fingerprint
      ? 'successor' : 'incumbent';
    await signHostCertificate(app, { authority });
    return HostCertificateAction.PARKED;
  }
  return HostCertificateAction.NONE;
}

/**
 * Start an authority rotation: create the successor CA. From here
 * authorityBundle() publishes both authorities; nothing signs with the
 * successor yet. Idempotent.
 *
 * @param {{instance: string, appUuid: string, outpoint: string}} app
 * @returns {Promise<void>}
 */
async function beginAuthorityRotation({ instance, appUuid, outpoint }) {
  const dir = meshAppDir(instance);
  const [cert, key] = await Promise.all([
    readIfPresent(path.join(dir, FILES.successorCert)),
    readIfPresent(path.join(dir, FILES.successorKey)),
  ]);
  if (cert && key) return;
  await generateAuthority(dir, appUuid, outpoint, FILES.successorKey, FILES.successorCert);
  log.info(`Mesh authority rotation begun for ${instance}`);
}

/**
 * Re-sign the host certificate under the successor. Call once peers carry the
 * two-authority bundle; the replacement ages and deploys through the normal
 * sweep.
 *
 * @param {{instance: string, appUuid: string, outpoint: string}} app
 * @returns {Promise<void>}
 */
async function adoptSuccessorAuthority({ instance, appUuid, outpoint }) {
  const successor = await readIfPresent(path.join(meshAppDir(instance), FILES.successorCert));
  if (!successor) {
    throw new Error(`No successor authority exists for ${instance}`);
  }
  await signHostCertificate({ instance, appUuid, outpoint }, { authority: 'successor' });
}

/**
 * Retire the incumbent: the successor becomes the authority and the old key
 * is destroyed. Refuses while the deployed host certificate still cites the
 * incumbent — concluding then would strand the node's own leaf outside the
 * published bundle.
 *
 * @param {string} instance
 * @returns {Promise<void>}
 */
async function concludeAuthorityRotation(instance) {
  const dir = meshAppDir(instance);
  const [host, successor] = await Promise.all([
    certificateDetails(path.join(dir, FILES.hostCert)),
    certificateDetails(path.join(dir, FILES.successorCert)),
  ]);
  if (!successor) {
    throw new Error(`No successor authority exists for ${instance}`);
  }
  if (!host || host.issuer !== successor.fingerprint) {
    throw new Error(`The host certificate for ${instance} is not yet signed by the successor authority`);
  }
  await fsp.rename(path.join(dir, FILES.successorKey), path.join(dir, FILES.caKey));
  await fsp.rename(path.join(dir, FILES.successorCert), path.join(dir, FILES.caCert));
  log.info(`Mesh authority rotation concluded for ${instance}`);
}

/**
 * Remove every mesh artifact of an app on this node — CA keys included.
 * @param {string} instance
 * @returns {Promise<void>}
 */
async function removeAppMaterial(instance) {
  await fsp.rm(meshAppDir(instance), { recursive: true, force: true });
}

module.exports = {
  HostCertificateAction,
  MESH_STATE_ROOT,
  HOST_CERT_MIN_AGE_MS,
  HOST_CERT_RENEW_BEFORE_MS,
  meshAppDir,
  certificateDetails,
  ensureAuthority,
  authorityBundle,
  signHostCertificate,
  reconcileHostCertificate,
  beginAuthorityRotation,
  adoptSuccessorAuthority,
  concludeAuthorityRotation,
  removeAppMaterial,
};
