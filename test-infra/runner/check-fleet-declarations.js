#!/usr/bin/env node
// Every suite declares the fleet it puts on the box at once, and the declaration
// is at least what its own createTestEnv calls spell out. run-parallel.sh runs
// this before admitting anything; `node check-fleet-declarations.js` runs it alone.
// Exit 1 names every suite that fails, with the reason.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFleetDeclaration } from './framework/fleet-size.js';

const testsDir = join(dirname(fileURLToPath(import.meta.url)), 'tests');
const files = readdirSync(testsDir).filter((f) => /^\d+-.*\.js$/.test(f)).sort();
let failures = 0;
for (const f of files) {
  const verdict = checkFleetDeclaration(readFileSync(join(testsDir, f), 'utf8'));
  if (verdict.ok) continue;
  failures += 1;
  console.log(`${f}: ${verdict.reasons.join('; ')}`);
}
console.log(`fleet declarations: ${files.length - failures}/${files.length} ok`);
process.exit(failures ? 1 : 0);
