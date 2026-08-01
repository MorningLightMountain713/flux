const { supportedArchitectures, arcaneRequiredArchitectures } = require('../utils/appConstants');
const { findCommonArchitectures } = require('../utils/appUtilities');
const imageManager = require('./imageManager');

async function verifyImageRegistryAndArchitectures(spec, options = {}) {
  const { owner = null, hash = null, isEncrypted = false } = options;

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
      appName: spec.name,
    });

    componentArchitectures.push({
      name: comp.name,
      image: comp.image,
      architectures: result.supportedArchitectures,
    });

    // Authoritative rootFs-fit reject: the decompressed image is what lands on
    // disk, and it is read from the layers' own size records at verification. When
    // a gzip trailer wrapped with more than one plausible answer the declaration
    // has to clear the larger candidate — refusing into safety, because the
    // alternative is a spec that is paid for and then fails to install everywhere.
    // Version-blind: legacy components are never charged.
    if (result.decompressedSizeBytes) {
      const requiredBytes = result.decompressedSizeClearanceBytes;
      const ambiguous = requiredBytes > result.decompressedSizeBytes;

      if (!comp.imageFitsRootFs(requiredBytes)) {
        const measured = `${(result.decompressedSizeBytes / 1e9).toFixed(2)}GB`;
        const sizeDetail = ambiguous
          ? `decompresses to at least ${measured}, and its gzip size record wrapped, so it may be as `
            + `large as ${(requiredBytes / 1e9).toFixed(2)}GB`
          : `decompresses to ${measured}`;

        throw new Error(
          `Component '${comp.name}' image (${comp.image}) ${sizeDetail}, `
          + `which exceeds its rootFsGb budget of ${comp.rootFsGb}GB. `
          + `Declare a rootFsGb of at least ${Math.ceil(requiredBytes / 1e9)}, or rebuild the image with `
          + 'zstd compression (which records an exact decompressed size), or split the oversized layer.',
        );
      }
    } else if (result.imageSizeBytes && !comp.imageFitsRootFs(result.imageSizeBytes)) {
      // Unmeasured (a private image with no readable manifest, a registry that
      // refuses Range): the compressed sum is still a lower bound worth rejecting
      // on, and the install-time inspect stays authoritative.
      throw new Error(
        `Component '${comp.name}' image (${comp.image}) is ${(result.imageSizeBytes / 1e9).toFixed(2)}GB compressed, `
        + `which already exceeds its rootFsGb budget of ${comp.rootFsGb}GB. `
        + 'rootFsGb must budget the decompressed image plus writable-layer headroom.',
      );
    }
  }

  // Encrypted apps run on Arcane nodes (amd64-only), so every component must
  // support amd64. `isEncrypted` is supplied by the caller — a decrypted spec
  // instance reports isEncrypted=false, so it can't be read off the spec here.
  if (isEncrypted) {
    const missing = componentArchitectures.filter(
      (c) => !arcaneRequiredArchitectures.every((arch) => c.architectures.includes(arch)),
    );
    if (missing.length > 0) {
      const names = missing.map((c) => `${c.name} (${c.image})`).join(', ');
      throw new Error(
        `Encrypted application '${spec.name}' must support ${arcaneRequiredArchitectures.join(', ')} `
        + `architecture on ALL components. The following components do not support ${arcaneRequiredArchitectures.join(', ')}: ${names}. `
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
