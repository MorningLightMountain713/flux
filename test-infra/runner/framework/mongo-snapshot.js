// A Mongo data directory that already holds the IP location table in every
// node's local database, so a fleet's nodes adopt the table at boot instead of
// each loading its 1.5 million rows into the one shared mongod.
//
// Built once per key per host by the node's own code (test-infra/mongo-snapshot),
// stored as an uncompressed tar, and unpacked into the fleet's tmpfs by the mongo
// container's entrypoint before mongod starts.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { artifactForPublication, encodeIpLocationBinary } = require('../../external-http-stub/iplocation-artifact.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILDER_DIR = join(__dirname, '..', '..', 'mongo-snapshot');
const BUILDER_FILES = ['build.cjs', 'load-node.cjs'];
const SNAPSHOT_DIR = process.env.E2E_MONGO_SNAPSHOT_DIR || join(tmpdir(), 'flux-e2e-mongo-snapshots');
// A build takes one fleet's load, about a minute for sixteen nodes; a lock older
// than this belongs to a builder that died.
const STALE_LOCK_MS = 15 * 60 * 1000;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
// Where the fleet's mongo container finds its snapshot.
export const SNAPSHOT_MOUNT = '/snapshot/mongo.tar';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', error: err });
    });
  });
}

async function docker(args, timeoutMs = 60000) {
  const res = await run('docker', args, timeoutMs);
  if (!res.ok) throw new Error(`docker ${args[0]} failed: ${res.stderr.trim() || res.error?.message}`);
  return res.stdout.trim();
}

/**
 * The artifact bytes a fleet boots onto: what the stub serves for this
 * publication body, or for its default when the suite publishes none.
 * @param {object|null} locationTable createTestEnv's locationTable
 * @returns {{bytes: Buffer, sha256: string}|null} null when no node would load
 *   it: no artifact, one the reader cannot parse, or one below the row floor
 */
export function bootArtifact(locationTable) {
  const { artifact, pad } = artifactForPublication(locationTable ?? {});
  if (!pad) return null;
  const { bytes, rowCount } = encodeIpLocationBinary(artifact, { pad });
  if (!bytes || rowCount === null) return null;
  return { bytes, sha256: sha256Hex(bytes) };
}

/**
 * Make sure the snapshot for this fleet exists, building it when it does not.
 * @param {object} options
 * @param {number} options.nodes How many node databases to load
 * @param {{bytes: Buffer, sha256: string}} options.artifact From bootArtifact
 * @param {string} options.nodeImage The node image whose code loads the table
 * @param {string} options.mongoImage The fleet's mongo image reference
 * @param {string[]} options.mongoArgs The fleet's mongod arguments
 * @returns {Promise<string>} Host path of the snapshot tar
 */
export async function ensureIpLocationSnapshot({
  nodes, artifact, nodeImage, mongoImage, mongoArgs,
}) {
  const nodeImageId = await docker(['image', 'inspect', '-f', '{{.Id}}', nodeImage]);
  const builder = BUILDER_FILES.map((f) => readFileSync(join(BUILDER_DIR, f), 'utf8')).join('\0');
  const key = sha256Hex(JSON.stringify({
    artifact: artifact.sha256, nodes, nodeImageId, mongoImage, mongoArgs, builder: sha256Hex(builder),
  })).slice(0, 32);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const tarPath = join(SNAPSHOT_DIR, `${key}.tar`);
  const lockPath = join(SNAPSHOT_DIR, `${key}.lock`);

  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  while (!existsSync(tarPath)) {
    let owned = false;
    try {
      mkdirSync(lockPath);
      owned = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
    }
    if (owned) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await buildSnapshot({
          tarPath, nodes, artifact, nodeImage, mongoImage, mongoArgs,
        });
      } finally {
        rmSync(lockPath, { recursive: true, force: true });
      }
      break;
    }
    if (Date.now() > deadline) throw new Error(`mongo snapshot ${key}: another build held its lock for ${BUILD_TIMEOUT_MS / 60000} minutes`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
  return tarPath;
}

/**
 * A scratch mongod on tmpfs, the node image's loader beside it on its network,
 * then a clean shutdown: the container's own shell tars the data directory once
 * mongod has exited, into a host directory, and the tar is renamed into place.
 */
async function buildSnapshot({
  tarPath, nodes, artifact, nodeImage, mongoImage, mongoArgs,
}) {
  const work = join(SNAPSHOT_DIR, `build-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'iplocation.bin.gz'), artifact.bytes);
  let mongoId = null;
  try {
    const script = 'docker-entrypoint.sh mongod "$@"; rc=$?; tar cf /out/mongo.tar -C /data/db . && echo $rc > /out/mongod.rc';
    mongoId = await docker([
      'run', '-d', '--tmpfs', '/data/db:rw,size=4g', '-v', `${work}:/out`,
      '--entrypoint', 'sh', mongoImage, '-c', script, 'sh', ...mongoArgs,
    ]);
    const up = Date.now() + 60000;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const ping = await run('docker', ['exec', mongoId, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ ping: 1 }).ok'], 15000);
      if (ping.ok && ping.stdout.trim() === '1') break;
      if (Date.now() > up) throw new Error('the scratch mongod never answered');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    const loaded = await run('docker', [
      'run', '--rm', '--network', `container:${mongoId}`, '-v', `${work}/iplocation.bin.gz:/tmp/iplocation.bin.gz:ro`,
      '--entrypoint', 'node', nodeImage, '/flux/test-infra/mongo-snapshot/build.cjs', '/tmp/iplocation.bin.gz', '127.0.0.1', String(nodes),
    ], BUILD_TIMEOUT_MS);
    if (!loaded.ok) throw new Error(`loading the table failed: ${loaded.stderr.trim() || loaded.error?.message}`);
    const digests = loaded.stdout.trim().split('\n').map((line) => JSON.parse(line).sha256);
    if (digests.length !== nodes || digests.some((d) => d !== artifact.sha256)) {
      throw new Error(`the loader stored ${digests.length} record(s) for ${nodes} node(s), digests ${[...new Set(digests)].join(', ')} against ${artifact.sha256}`);
    }
    // A shutdown command's connection drops as mongod exits; the exit status of the container is the answer.
    await run('docker', ['exec', mongoId, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ shutdown: 1 })'], 60000);
    const exited = await docker(['wait', mongoId], 120000);
    if (exited !== '0') throw new Error(`the scratch mongo container exited ${exited}`);
    const mongodRc = readFileSync(join(work, 'mongod.rc'), 'utf8').trim();
    if (mongodRc !== '0') throw new Error(`mongod exited ${mongodRc} at shutdown`);
    renameSync(join(work, 'mongo.tar'), tarPath);
  } finally {
    if (mongoId) await run('docker', ['rm', '-f', mongoId], 60000);
    // The tar and the rc are root's, written from the container; the directory is ours.
    await run('docker', ['run', '--rm', '-v', `${work}:/out`, '--entrypoint', 'sh', mongoImage, '-c', 'rm -rf /out/*'], 60000);
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The fleet mongo container's entrypoint: unpack the snapshot into the tmpfs,
 * then start mongod exactly as the image would.
 * @returns {string[]}
 */
export function snapshotEntrypoint() {
  return ['sh', '-c', `tar xf ${SNAPSHOT_MOUNT} -C /data/db && exec docker-entrypoint.sh mongod "$@"`, 'sh'];
}
