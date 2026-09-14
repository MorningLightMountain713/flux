'use strict';

/**
 * Refuses a runtime dependency that will not run on the oldest node in the
 * fleet.
 *
 * FluxOS installs its dependencies unattended on production nodes, so a package
 * whose engines.node excludes the fleet floor does not fail where anyone is
 * watching: npm prints a warning nobody reads, the install succeeds, and the
 * break arrives later as a syntax error or a missing API on whichever nodes are
 * oldest. The floor is package.json's own engines.node, so there is one number
 * to change when the fleet moves.
 *
 * Only the shipped tree is checked. Dev tooling is allowed a higher floor
 * because it never reaches a node - `npm install --omit=dev` is what the
 * watchdog runs - and holding the whole toolchain to the oldest node in the
 * fleet costs real versions for no safety.
 */

const fs = require('fs');
const path = require('path');
const semver = require('semver');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

const declared = manifest.engines && manifest.engines.node;
if (!declared) {
  console.error('package.json declares no engines.node, so there is no floor to check against.');
  process.exit(2);
}

const floor = semver.minVersion(declared);
if (!floor) {
  console.error(`engines.node is '${declared}', which names no lowest version.`);
  process.exit(2);
}

const refused = [];
let checked = 0;

for (const [key, pkg] of Object.entries(lock.packages || {})) {
  if (!key.startsWith('node_modules/')) continue;
  // dev: true is set on a package reached only through devDependencies.
  if (pkg.dev) continue;
  const range = pkg.engines && pkg.engines.node;
  if (!range) continue;
  checked += 1;
  // An unparseable range is reported rather than skipped: a range this cannot
  // read is one npm may read differently, and silence would be a guess.
  let satisfied;
  try {
    satisfied = semver.satisfies(floor.version, range);
  } catch {
    refused.push({ name: key.replace(/^node_modules\//, ''), version: pkg.version, range: `${range} (unreadable)` });
    continue;
  }
  if (!satisfied) {
    refused.push({ name: key.replace(/^node_modules\//, ''), version: pkg.version, range });
  }
}

if (refused.length) {
  console.error(`${refused.length} shipped package(s) refuse Node ${floor.version}, the floor package.json declares:\n`);
  for (const r of refused) {
    console.error(`  ${r.name}@${r.version} needs ${r.range}`);
  }
  console.error('\nEither hold the package at a version that runs on the floor, or raise the floor');
  console.error('deliberately - which means engines.node, both CI workflows and the node image together.');
  console.error('See docs/dependency-policy.md.');
  process.exit(1);
}

console.log(`${checked} shipped packages declare a Node engine; all run on ${floor.version}.`);
