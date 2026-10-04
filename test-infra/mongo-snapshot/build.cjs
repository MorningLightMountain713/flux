'use strict';

// Builds the content of a fleet's Mongo snapshot: the IP location table loaded
// into every node's local database by the node's own code (load-node.cjs), so
// the data directory left behind is the state a node reaches after fetching
// and loading the table.
//
// Runs inside a fluxos-01 container sharing the scratch mongo's network:
//   node /flux/test-infra/mongo-snapshot/build.cjs <artifact file> <mongo host> <node count>
// One process per node, since a node's database name is fixed when its config
// loads.

const { spawn } = require('child_process');
const path = require('path');

const FLUX_ROOT = path.join(__dirname, '..', '..');

function loadNode(artifactFile, mongoHost, index) {
  const num = String(index).padStart(2, '0');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'load-node.cjs'), artifactFile], {
      env: {
        ...process.env,
        NODE_CONFIG_DIR: path.join(FLUX_ROOT, 'ZelBack/config'),
        NODE_CONFIG_ENV: 'development',
        // the per-node database the harness gives node NN (seedMongo, the node-NN configs)
        NODE_CONFIG: JSON.stringify({
          database: { url: mongoHost, port: 27017, local: { database: `node${num}_zelfluxlocal` } },
        }),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`node ${num}: loader exited ${code}`))));
  });
}

async function main() {
  const [artifactFile, mongoHost, count] = process.argv.slice(2);
  const nodes = Number(count);
  if (!artifactFile || !mongoHost || !Number.isInteger(nodes) || nodes < 1) {
    throw new Error('usage: build.cjs <artifact file> <mongo host> <node count>');
  }
  await Promise.all(Array.from({ length: nodes }, (unused, i) => loadNode(artifactFile, mongoHost, i + 1)));
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
