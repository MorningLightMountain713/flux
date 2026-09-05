import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// test-infra/config/shared.js is the fleet's config: every node reads it
// through the `config` package inside its container, where it is CommonJS.
// The runner is ESM and test-infra's package.json says so, so Node parses
// that same file as an ES module and a require of it answers an empty
// object. A suite that must know what its fleet runs on — a grace, a TTL —
// evaluates the file here as the CommonJS module it is.
const SHARED_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'shared.js');

let cached = null;

/** @returns {object} the shared fleet config, as the nodes read it */
export function sharedConfig() {
  if (cached) return cached;
  const module = { exports: {} };
  const require = createRequire(pathToFileUrl(SHARED_PATH));
  new Function('module', 'exports', 'require', readFileSync(SHARED_PATH, 'utf-8'))(module, module.exports, require);
  cached = module.exports;
  return cached;
}

function pathToFileUrl(path) {
  return `file://${path}`;
}
