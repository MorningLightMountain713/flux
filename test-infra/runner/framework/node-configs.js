// The per-node configs are generated from the production config by
// `test-infra/config/generate-configs.js`, and nothing runs that generator for
// you — so a collection added to production reaches the fleet only if whoever
// added it remembered. One that does not arrive resolves to `undefined`, which
// mongo rejects on every operation against it ("collection name has invalid
// type null"). Most callers catch that and answer with a warning and a
// permissive zero, so the fleet limps and the suite blames the product;
// `limitCounterRecords.prepareCollection` has no local catch, so instead it
// restarts FluxOS startup every 15 seconds and nothing registered after it ever
// runs.
//
// Comparing the committed files against what the generator produces right now
// catches both halves: a production config that moved on, and a hand-edit.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNodeConfigs } from '../../config/generate-configs.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GENERATE_CMD = 'node test-infra/config/generate-configs.js';

let checked = false;

/**
 * Throws unless every committed per-node config is what the generator would
 * write today. Memoized: the answer cannot change while a suite runs.
 */
export function assertNodeConfigsCurrent() {
  if (checked) return;

  const stale = buildNodeConfigs()
    .filter(({ path, content }) => (existsSync(path) ? readFileSync(path, 'utf-8') : null) !== content)
    .map(({ path }) => `  ${relative(repoRoot, path)}${existsSync(path) ? '' : ' (missing)'}`);

  if (stale.length) {
    throw new Error(
      `${stale.length} per-node config(s) no longer match the production config they derive from:\n`
      + `${stale.join('\n')}\n  run: ${GENERATE_CMD}`,
    );
  }

  checked = true;
}
