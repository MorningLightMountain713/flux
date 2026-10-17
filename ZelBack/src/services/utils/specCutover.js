'use strict';

const { getSpec, getSpecBackend } = require('./specLibs');
const legacyCryptoProvider = require('../providers/FluxOSLegacyCryptoProvider');
const cryptoProvider = require('../providers/FluxOSCryptoProvider');
const log = require('../../lib/log');
const { nodeChain } = require('./nodeChain');

let providersRegistered = false;

async function ensureProvidersRegistered() {
  if (providersRegistered) return;
  const { SealedSpecV8, SealedSpecV9 } = await getSpecBackend();
  SealedSpecV8.registerProvider((name, owner) => legacyCryptoProvider.create(name, owner));
  SealedSpecV9.registerProvider((name, owner) => cryptoProvider.create(name, owner));
  providersRegistered = true;
}

async function deserializeSpec(plainSpec) {
  try {
    await getSpec();
    await ensureProvidersRegistered();
    const { deserializeSpec: impl } = await getSpecBackend();
    return impl(plainSpec, { chain: nodeChain() });
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
 * Resolve the cleartext view of an RegisteredSpec we already hold.
 *
 * Unlike resolveSpec (which takes a plain doc and deserializes it), this
 * decrypts the held spec instance directly. Serializing an RegisteredSpec
 * would append the event-level contentHash, which SealedSpecV9.deserialize
 * rejects — and re-parsing a spec we already have is wasteful either way.
 *
 * Cleartext apps return the CanonicalSpec instance; encrypted apps return the
 * OpenedSpec wrapper (never a raw serializable plaintext spec — the
 * decrypted spec stays inside the boundary type). Read the priced/deployed
 * fields through it - the wrapper delegates them, and reaching for an inner
 * spec is the thing not to do.
 *
 * @param {object} registered - RegisteredSpec instance
 * @returns {Promise<object|null>} CanonicalSpec | OpenedSpec | null on decrypt failure
 */
async function resolveRegisteredSpec(registered) {
  if (!registered.isEncrypted) return registered.spec;
  await ensureProvidersRegistered();
  try {
    const provider = await registered.spec.createProvider();
    return await registered.spec.decrypt(provider);
  } catch (error) {
    log.warn(`resolveRegisteredSpec: could not decrypt ${registered.name}: ${error.message}`);
    return null;
  }
}

module.exports = {
  deserializeSpec,
  resolveSpec,
  resolveRegisteredSpec,
  ensureProvidersRegistered,
};
