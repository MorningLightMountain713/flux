'use strict';

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

/**
 * Resolve the cleartext view of an InstantiatedSpec we already hold.
 *
 * Unlike resolveSpec (which takes a plain doc and deserializes it), this
 * decrypts the held spec instance directly. Serializing an InstantiatedSpec
 * would append the event-level contentHash, which EncryptedSpecV9.deserialize
 * rejects — and re-parsing a spec we already have is wasteful either way.
 *
 * Cleartext apps return the CanonicalSpec instance; encrypted apps return the
 * DecryptedCanonicalSpec wrapper (never a raw serializable plaintext spec — the
 * decrypted spec stays inside the boundary type). Read the priced/deployed
 * fields through it; the deployment path takes decrypted.spec at its call site.
 *
 * @param {object} instantiated - InstantiatedSpec instance
 * @returns {Promise<object|null>} CanonicalSpec | DecryptedCanonicalSpec | null on decrypt failure
 */
async function resolveInstantiatedSpec(instantiated) {
  if (!instantiated.isEncrypted) return instantiated.spec;
  await ensureProvidersRegistered();
  try {
    const provider = await instantiated.spec.createProvider();
    return await instantiated.spec.decrypt(provider);
  } catch (error) {
    log.warn(`resolveInstantiatedSpec: could not decrypt ${instantiated.name}: ${error.message}`);
    return null;
  }
}

module.exports = {
  deserializeSpec,
  resolveSpec,
  resolveInstantiatedSpec,
  ensureProvidersRegistered,
};
