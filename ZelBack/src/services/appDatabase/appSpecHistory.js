const appsRepository = require('./appsRepository');
const { resolveSpec } = require('../utils/specCutover');

const validTypes = ['zelappregister', 'fluxappregister', 'zelappupdate', 'fluxappupdate'];

async function getPreviousAppSpecifications(specifications, verificationTimestamp) {
  const messages = await appsRepository.listAppMessagesByName(specifications.name);

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

  return resolveSpec(appSpecs);
}

module.exports = {
  getPreviousAppSpecifications,
};
