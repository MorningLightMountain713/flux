const log = require('../../lib/log');
const appsRepository = require('./appsRepository');
const { deserializeSpec } = require('../utils/specCutover');
const legacyCryptoProvider = require('../providers/FluxOSLegacyCryptoProvider');

async function getPreviousAppSpecifications(specifications, verificationTimestamp) {
  const messages = await appsRepository.listAppMessagesByName(specifications.name);

  const validTypes = ['zelappregister', 'fluxappregister', 'zelappupdate', 'fluxappupdate'];
  let latest;

  for (const message of messages) {
    if (!validTypes.includes(message.type)) continue;
    if (message.timestamp > verificationTimestamp) continue;

    if (!latest) {
      latest = message;
    } else if (latest.height <= message.height && latest.timestamp < message.timestamp) {
      latest = message;
    }
  }

  if (!latest) return null;

  const appSpecs = latest.appSpecifications || latest.zelAppSpecifications;
  if (!appSpecs) {
    throw new Error(`Previous specifications for ${specifications.name} update message does not exist`);
  }

  const wireSpec = await deserializeSpec(appSpecs);
  if (!wireSpec) throw new Error(`Could not deserialize previous specifications for ${specifications.name}`);

  if (!wireSpec.isEncrypted) return wireSpec;

  try {
    const provider = await legacyCryptoProvider.create(wireSpec.name, wireSpec.owner);
    return wireSpec.decrypt(provider);
  } catch (error) {
    log.warn(`getPreviousAppSpecifications: could not decrypt ${wireSpec.name}: ${error.message}`);
    return null;
  }
}

module.exports = {
  getPreviousAppSpecifications,
};
