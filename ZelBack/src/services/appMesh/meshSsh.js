'use strict';

// FluxOS's channel into nebula's embedded SSH interface — the daemon's only
// query surface, read by the impersonation detector (list-hostmap) and the
// renewal read-back (print-cert). One node-wide client keypair authenticates
// FluxOS to every app's daemon: the key only proves root-FluxOS to its own
// local processes, and per-app copies would add material without adding a
// boundary. Each app's sshd has its own host key, minted here at bring-up
// with its known_hosts pin written in the same step — the client verifies the
// exact key we generated, never trust-on-first-use.
//
// The exec channel always reports exit status 0, so failure is judged from
// the output: a reply that does not parse as the expected JSON is a failure,
// whatever the exit code said.
const fsp = require('node:fs/promises');
const path = require('node:path');

const serviceHelper = require('../serviceHelper');
const { meshAppDir, MESH_STATE_ROOT } = require('./meshCertificates');
const meshNamespace = require('./meshNamespace');
const { SSHD_LISTEN, SSHD_USER, SSH_HOST_KEY_FILE } = require('./meshRuntimeConfig');

const CLIENT_KEY_PATH = path.join(MESH_STATE_ROOT, 'ssh_client_ed25519');
const KNOWN_HOSTS_FILE = 'known_hosts';

const [SSHD_HOST, SSHD_PORT] = SSHD_LISTEN.split(':');

async function readIfPresent(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// ssh-keygen refuses existing paths, so pairs are generated under temp names
// and renamed in, private key first — a crash never leaves a public half
// whose private key is missing.
async function generateKeypair(keyPath) {
  const tmp = `${keyPath}.tmp`;
  await fsp.rm(tmp, { force: true });
  await fsp.rm(`${tmp}.pub`, { force: true });
  const result = await serviceHelper.runCommand('ssh-keygen', {
    runAsRoot: true,
    params: ['-q', '-t', 'ed25519', '-N', '', '-C', 'flux-mesh', '-f', tmp],
  });
  if (result.error) {
    throw new Error(`ssh-keygen failed: ${result.error.message} ${result.stderr || ''}`.trim());
  }
  await fsp.chmod(tmp, 0o600);
  await fsp.rename(tmp, keyPath);
  await fsp.rename(`${tmp}.pub`, `${keyPath}.pub`);
  return (await fsp.readFile(`${keyPath}.pub`, 'utf8')).trim();
}

/**
 * The node-wide client public key, generating the keypair on first use.
 * The returned line is what nebulaConfig inlines as the authorized key.
 *
 * @returns {Promise<string>} single-line OpenSSH public key
 */
async function ensureClientKeypair() {
  const [key, pub] = await Promise.all([
    readIfPresent(CLIENT_KEY_PATH),
    readIfPresent(`${CLIENT_KEY_PATH}.pub`),
  ]);
  if (key && pub) return pub.trim();
  await fsp.mkdir(MESH_STATE_ROOT, { recursive: true, mode: 0o755 });
  return generateKeypair(CLIENT_KEY_PATH);
}

/**
 * The app's sshd host key and its known_hosts pin, minted together on first
 * use. Idempotent.
 *
 * @param {string} instance the app's identity segment
 * @returns {Promise<void>}
 */
async function ensureHostKey(instance) {
  const dir = meshAppDir(instance);
  const keyPath = path.join(dir, SSH_HOST_KEY_FILE);
  const knownHostsPath = path.join(dir, KNOWN_HOSTS_FILE);
  const [key, knownHosts] = await Promise.all([
    readIfPresent(keyPath),
    readIfPresent(knownHostsPath),
  ]);
  if (key && knownHosts) return;
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const pub = await generateKeypair(keyPath);
  const tmp = `${knownHostsPath}.tmp`;
  await fsp.writeFile(tmp, `[${SSHD_HOST}]:${SSHD_PORT} ${pub}\n`);
  await fsp.rename(tmp, knownHostsPath);
}

async function sshExec(instance, command) {
  const dir = meshAppDir(instance);
  const result = await serviceHelper.runCommand('ip', {
    runAsRoot: true,
    logError: false,
    timeout: 15000,
    params: [
      'netns', 'exec', meshNamespace.netnsName(instance),
      'ssh',
      '-i', CLIENT_KEY_PATH,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${path.join(dir, KNOWN_HOSTS_FILE)}`,
      '-o', 'ConnectTimeout=5',
      '-p', SSHD_PORT,
      `${SSHD_USER}@${SSHD_HOST}`,
      command,
    ],
  });
  if (result.error) {
    throw new Error(`nebula sshd ${command} for ${instance} failed: ${result.error.message} ${result.stderr || ''}`.trim());
  }
  return result.stdout;
}

/**
 * The daemon's live peer table: every established tunnel with the peer's
 * claimed addresses and presented certificate. What the detector compares
 * against the derivation.
 *
 * @param {string} instance
 * @returns {Promise<Array<{vpnAddrs: string[], cert: object}>>}
 */
async function listHostmap(instance) {
  const stdout = await sshExec(instance, 'list-hostmap -json');
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`nebula sshd returned an unreadable hostmap for ${instance}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`nebula sshd returned an unreadable hostmap for ${instance}`);
  }
  return parsed;
}

/**
 * The certificate the daemon is actually serving — the renewal read-back.
 *
 * @param {string} instance
 * @returns {Promise<{details: object, fingerprint: string}>}
 */
async function printOwnCert(instance) {
  const stdout = await sshExec(instance, 'print-cert -json');
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`nebula sshd returned an unreadable certificate for ${instance}`);
  }
  if (!parsed || typeof parsed.fingerprint !== 'string') {
    throw new Error(`nebula sshd returned an unreadable certificate for ${instance}`);
  }
  return parsed;
}

module.exports = {
  CLIENT_KEY_PATH,
  KNOWN_HOSTS_FILE,
  ensureClientKeypair,
  ensureHostKey,
  listHostmap,
  printOwnCert,
};
