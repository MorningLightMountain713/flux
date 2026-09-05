import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_PATH = path.join(HERE, '../../config/shared.js');

/**
 * config/shared.js is CJS text inside a package declaring "type": "module", so
 * it can be neither imported nor required - it is evaluated.
 * @returns {object} The shared harness config.
 */
export function loadSharedConfig() {
  const sandbox = { module: { exports: {} }, exports: null };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(fs.readFileSync(SHARED_PATH, 'utf8'), sandbox);
  return sandbox.module.exports;
}
