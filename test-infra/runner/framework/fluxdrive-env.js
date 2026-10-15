// The environment of the real FluxDrive in the harness (createTestEnv({
// fluxDrive: 'real' })); the API and its GC runner read the same variables.
// Only what the harness changes is set. Every other variable keeps FluxDrive's
// default: the suite network has no route off the fleet, so a default naming a
// production host fails to connect rather than reaching it.

/** The API's database name in its own mongo. */
export const FLUXDRIVE_DB = 'fluxdrive';

const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * The variables the harness sets. The GC asks every node and needs a majority
 * of them to answer; a pending write is decided by a majority of the fleet.
 * With no ipfs-cluster nodes a cluster pin or unpin fails and is logged, and
 * the blob row alone decides what is served.
 * @param {{mongoUrl:string, ipfsHost:string, nodeUrls:string[], arcanePublicKey:string}} opts
 *   nodeUrls: every fleet node's API, `http://<ip>:16127`
 *   arcanePublicKey: the benchmark channel's blob-write key (daemon-control blobUploadPublicKey)
 * @returns {Record<string,string>}
 */
export function fluxDriveEnv({ mongoUrl, ipfsHost, nodeUrls, arcanePublicKey }) {
  if (!Array.isArray(nodeUrls) || nodeUrls.length === 0) {
    throw new Error('fluxDriveEnv: the fleet needs at least one node');
  }
  if (typeof arcanePublicKey !== 'string' || Buffer.from(arcanePublicKey, 'base64').length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Error(`fluxDriveEnv: arcanePublicKey must be a base64 32-byte Ed25519 public key, got ${arcanePublicKey}`);
  }
  const fleet = nodeUrls.length;
  const majority = Math.floor(fleet / 2) + 1;
  return {
    ATLAS_URI: mongoUrl,
    MDB_DB_NAME: FLUXDRIVE_DB,
    IPFS_NODE: ipfsHost,
    IPFS_PORT: '5001',
    TEST_MODE: 'true',
    NODE_ENV: 'test',
    BLOB_ARCANE_PUBLIC_KEY: arcanePublicKey,
    FLUX_API_GLOBAL_SPECS: `${nodeUrls[0]}/apps/globalappsspecifications`,
    CONTENT_GC_NODELIST_URLS: nodeUrls.join(','),
    CONTENT_GC_SAMPLE_SIZE: String(fleet),
    CONTENT_GC_MIN_RESPONDERS: String(majority),
    CONTENT_PENDING_MAX_ASKED: String(fleet),
    CONTENT_PENDING_ANSWERS: String(majority),
  };
}
