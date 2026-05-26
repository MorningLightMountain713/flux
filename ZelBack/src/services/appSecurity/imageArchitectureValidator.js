const { supportedArchitectures, enterpriseRequiredArchitectures } = require('../utils/appConstants');
const { findCommonArchitectures } = require('../utils/appUtilities');
const imageManager = require('./imageManager');

async function verifyImageRegistryAndArchitectures(spec, options = {}) {
  const { owner = null, hash = null } = options;

  const blockResult = await imageManager.isImageBlocked(spec.name, spec.allImages(), { owner, hash });
  if (blockResult.blocked) {
    throw new Error(blockResult.reason);
  }

  const componentArchitectures = [];

  for (const [, comp] of spec.componentEntries()) {
    if (spec.version === 7 && comp.imageAuth) return true;

    // eslint-disable-next-line no-await-in-loop
    const result = await imageManager.verifyRepository(comp.image, {
      repoauth: comp.imageAuth || null,
      specVersion: spec.version,
      appName: spec.name,
    });

    componentArchitectures.push({
      name: comp.name,
      image: comp.image,
      architectures: result.supportedArchitectures,
    });
  }

  const isEnterpriseArcane = spec.isEncrypted;

  if (isEnterpriseArcane) {
    const missing = componentArchitectures.filter(
      (c) => !enterpriseRequiredArchitectures.every((arch) => c.architectures.includes(arch)),
    );
    if (missing.length > 0) {
      const names = missing.map((c) => `${c.name} (${c.image})`).join(', ');
      throw new Error(
        `Enterprise application '${spec.name}' must support ${enterpriseRequiredArchitectures.join(', ')} `
        + `architecture on ALL components. The following components do not support ${enterpriseRequiredArchitectures.join(', ')}: ${names}. `
        + 'Arcane nodes are amd64-only.',
      );
    }
  } else if (componentArchitectures.length > 1) {
    const common = findCommonArchitectures(componentArchitectures);
    if (common.length === 0) {
      const details = componentArchitectures
        .map((c) => `  - ${c.name} (${c.image}): ${c.architectures.join(', ') || 'none'}`)
        .join('\n');
      throw new Error(
        `Application '${spec.name}' components do not share a common architecture. `
        + `All components must support at least one common architecture (${supportedArchitectures.join(' or ')}). `
        + `Component architectures:\n${details}`,
      );
    }
  }

  return true;
}

module.exports = {
  verifyImageRegistryAndArchitectures,
};
