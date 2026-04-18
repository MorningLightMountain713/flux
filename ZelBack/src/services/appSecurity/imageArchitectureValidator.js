/**
 * Platform-level image and architecture validation for app submissions.
 *
 * Separate from imageManager's registry-mechanics functions
 * (verifyRepository, checkApplicationImagesCompliance) because those
 * are PROBES — they talk to Docker registries, the blocked-repo DB,
 * and other external systems. This module is a COMPOSITOR: it takes a
 * spec, runs the probes across every component, and applies the
 * network-wide architecture rules (enterprise = amd64-only, non-
 * enterprise = at least one common arch across components).
 *
 * Extracted from appValidator.verifyAppSpecifications during the v9
 * migration. Called on the user-submission path only — peer relay
 * skips these slow registry probes.
 */

const { supportedArchitectures, enterpriseRequiredArchitectures } = require('../utils/appConstants');
const { findCommonArchitectures } = require('../utils/appUtilities');
const imageManager = require('./imageManager');

/**
 * Verify every component's image against the Docker registry, collect
 * the architectures each image supports, and enforce:
 *
 *   - No component references a blocked or unreachable repo.
 *   - Enterprise (v8+) apps: every component must support every entry
 *     in `enterpriseRequiredArchitectures` (Arcane nodes are amd64-only).
 *   - Non-enterprise apps: components must share at least one common
 *     architecture (the spawner needs one arch all components can run).
 *
 * v7 enterprise apps with repoauth fields short-circuit with `true`:
 * repoauth is PGP-encrypted per-node, so only selected nodes can
 * decrypt and verify. Any other node fails open.
 *
 * @param {object} appSpecifications - formatted spec (v1-v8 or v9-shape)
 * @returns {Promise<boolean>}
 * @throws {Error} on blocked repo, failed registry probe, or arch mismatch
 */
async function verifyImageRegistryAndArchitectures(appSpecifications) {
  await imageManager.checkApplicationImagesCompliance(appSpecifications);

  const componentArchitectures = [];

  if (appSpecifications.version <= 3) {
    const result = await imageManager.verifyRepository(appSpecifications.repotag);
    componentArchitectures.push({
      name: appSpecifications.name,
      repotag: appSpecifications.repotag,
      architectures: result.supportedArchitectures,
    });
  } else {
    for (const appComponent of appSpecifications.compose) {
      const skipVerification = appSpecifications.version === 7 && appComponent.repoauth;
      if (skipVerification) return true;

      // eslint-disable-next-line no-await-in-loop
      const result = await imageManager.verifyRepository(appComponent.repotag, {
        repoauth: appComponent.repoauth,
        specVersion: appSpecifications.version,
        appName: appSpecifications.name,
      });

      componentArchitectures.push({
        name: appComponent.name,
        repotag: appComponent.repotag,
        architectures: result.supportedArchitectures,
      });
    }

    const isEnterpriseArcane = appSpecifications.version >= 8 && appSpecifications.enterprise;

    if (isEnterpriseArcane) {
      const missing = componentArchitectures.filter(
        (comp) => !enterpriseRequiredArchitectures.every((arch) => comp.architectures.includes(arch)),
      );
      if (missing.length > 0) {
        const names = missing.map((c) => `${c.name} (${c.repotag})`).join(', ');
        throw new Error(
          `Enterprise application '${appSpecifications.name}' must support ${enterpriseRequiredArchitectures.join(', ')} `
          + `architecture on ALL components. The following components do not support ${enterpriseRequiredArchitectures.join(', ')}: ${names}. `
          + 'Arcane nodes are amd64-only.',
        );
      }
    } else {
      const common = findCommonArchitectures(componentArchitectures);
      if (common.length === 0) {
        const details = componentArchitectures
          .map((c) => `  - ${c.name} (${c.repotag}): ${c.architectures.join(', ') || 'none'}`)
          .join('\n');
        throw new Error(
          `Application '${appSpecifications.name}' components do not share a common architecture. `
          + `All components must support at least one common architecture (${supportedArchitectures.join(' or ')}). `
          + `Component architectures:\n${details}`,
        );
      }
    }
  }

  return true;
}

module.exports = {
  verifyImageRegistryAndArchitectures,
};
