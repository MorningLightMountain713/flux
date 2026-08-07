import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'node-manifest.json'), 'utf-8'));
const require = createRequire(import.meta.url);

// Collection names are read from the production config, never copied into here.
// A name production declares and a node config omits resolves to `undefined`,
// which mongo rejects on every operation against it — and the callers that catch
// that return a warning and a permissive zero, so the omission stays quiet.
const production = require(join(__dirname, '..', '..', 'ZelBack', 'config', 'default.js')).database;

// Each node gets its own databases on the one mongo; the collections within them
// are production's.
function databaseConfig(prefix) {
  const database = { url: '198.18.0.2', port: 27017 };
  for (const [name, section] of Object.entries(production)) {
    if (typeof section !== 'object' || section === null) continue;
    database[name] = { ...section, database: `${prefix}${section.database}` };
  }
  return database;
}

/**
 * What every per-node config file should contain. Exported so the runner can
 * check the committed files still match rather than trusting that whoever last
 * touched the production config remembered to regenerate.
 */
export function buildNodeConfigs() {
  return manifest.nodes.map((_, i) => {
    const num = String(i + 1).padStart(2, '0');
    const dir = join(__dirname, `node-${num}`);
    return {
      dir,
      path: join(dir, 'default.js'),
      content: `const shared = require('../shared');

module.exports = {
  ...shared,
  database: ${JSON.stringify(databaseConfig(`node${num}_`), null, 4)},
};
`,
    };
  });
}

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runDirectly) {
  const configs = buildNodeConfigs();
  for (const { dir, path, content } of configs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`Generated ${configs.length} per-node config directories`);
}
