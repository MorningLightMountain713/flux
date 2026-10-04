'use strict';

// Loads the IP location artifact into the one node database its config names,
// through the calls a node makes when it fetches the table: setArtifact, then
// the stored artifact and its digest. Started by build.cjs with NODE_CONFIG set.
//   node load-node.cjs <artifact file>

const fs = require('fs');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const ipLocationStore = require('../../ZelBack/src/services/appPlacement/ipLocationStore');
const policyArtifactRepository = require('../../ZelBack/src/services/appDatabase/policyArtifactRepository');

// ipLocationSync's registry key for the table. A snapshot stored under another
// key leaves the node refetching, which the harness's adoption check refuses.
const ARTIFACT_NAME = 'ipLocationTable';

async function main() {
  const bytes = fs.readFileSync(process.argv[2]);
  await dbHelper.initiateDB();
  const installed = await ipLocationStore.setArtifact(bytes);
  await policyArtifactRepository.writeArtifactBytes(ARTIFACT_NAME, bytes);
  const record = await policyArtifactRepository.getArtifactRecord(ARTIFACT_NAME);
  if (!record?.sha256) throw new Error('the stored artifact record carries no digest');
  console.log(JSON.stringify({ database: config.get('database.local.database'), ...installed, sha256: record.sha256 }));
  await dbHelper.databaseConnection().close();
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
