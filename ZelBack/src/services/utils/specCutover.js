const { getSpec, getSpecBackend } = require('./specLibs');
const legacyCryptoProvider = require('../providers/FluxOSLegacyCryptoProvider');
const cryptoProvider = require('../providers/FluxOSCryptoProvider');
const log = require('../../lib/log');

let providersRegistered = false;

async function ensureProvidersRegistered() {
  if (providersRegistered) return;
  const { EncryptedSpecV8, EncryptedSpecV9 } = await getSpecBackend();
  EncryptedSpecV8.registerProvider((name, owner) => legacyCryptoProvider.create(name, owner));
  EncryptedSpecV9.registerProvider((name, owner) => cryptoProvider.create(name, owner));
  providersRegistered = true;
}

async function deserializeSpec(plainSpec) {
  try {
    await getSpec();
    await ensureProvidersRegistered();
    const { deserializeSpec: impl } = await getSpecBackend();
    return impl(plainSpec);
  } catch (error) {
    const name = plainSpec?.name || 'unknown';
    const version = plainSpec?.version ?? '?';
    log.warn(`deserializeSpec: could not parse spec ${name} (v${version}): ${error.message}`);
    return null;
  }
}

async function resolveSpec(plainSpec) {
  const wireSpec = await deserializeSpec(plainSpec);
  if (!wireSpec) return null;
  if (!wireSpec.isEncrypted) return wireSpec;
  try {
    const provider = await wireSpec.createProvider();
    return wireSpec.decrypt(provider);
  } catch (error) {
    log.warn(`resolveSpec: could not decrypt ${wireSpec.name}: ${error.message}`);
    return null;
  }
}

module.exports = {
  deserializeSpec,
  resolveSpec,
  ensureProvidersRegistered,
};
