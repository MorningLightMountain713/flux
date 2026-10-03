'use strict';

const config = require('config');

const { getSpec, getSpecBackend } = require('../utils/specLibs');
const pricingRegime = require('../pricing/pricingRegime');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const { lookupBlockTime } = require('../appMessaging/confirmedMessageStore');
const appsRepository = require('../appDatabase/appsRepository');

/**
 * The chain-state answers the decision rule asks for, from this node's own
 * chain state: activation heights, fees, entitlement, who may sign, and block
 * times. One judge serves one run of the decider; it remembers the block times
 * it looks up.
 *
 * @returns {Promise<object>} the judge decisionRule.decideName reads
 */
async function createJudge() {
  const {
    UpdatePolicy, ValidationError, appUuid, registrationIdentity, isAppIdentity, contentInTheClear, v7SecretsRefusal,
  } = await getSpec();
  const { authorizeAppEvent, verifierFromRecovered } = await getSpecBackend();
  const blockTimes = new Map();

  return {
    activationHeight(version) {
      return config.get('fluxapps.appSpecsEnforcementHeights')[version];
    },

    async registrationFee(spec, height) {
      return (await pricingRegime.regimeFor(spec)).registrationFee(spec, height);
    },

    async updateFee(spec, prevSpec, ctx) {
      return pricingRegime.updateFee(spec, prevSpec, ctx);
    },

    async entitlementRefusal(spec, height) {
      return (await pricingRegime.regimeFor(spec)).entitlementRefusal(spec, height);
    },

    /**
     * Whether an update was signed by someone its predecessor makes an
     * authority, judged from the addresses its signature recovered to.
     */
    async authorized(entry, { height, previousState }) {
      const result = await authorizeAppEvent(entry.event, {
        verifyFn: verifierFromRecovered(entry.signers),
        previousState,
        updateSigners: appEventVerifier.updateSignersAt(entry.event, height),
        renewalSigners: appEventVerifier.renewalSignersAt(height),
      });
      return result.valid;
    },

    assertCompatible(prevSpec, spec) {
      UpdatePolicy.assertCompatible(prevSpec, spec);
    },

    /** The uuid of the app a registration makes, from its name and message hash. */
    mintUuid: appUuid,

    /** The identity of the app a registration makes: its uuid's, whatever version registered it. */
    identityFor: (spec, uuid) => registrationIdentity(uuid),

    /** Whether a name has an identity's form, which is reserved for identities. */
    isAppIdentity,

    /** Whether a readable v9 spec carries content, which only the encrypted path may. */
    contentInTheClear(spec) {
      return contentInTheClear(spec).length > 0;
    },

    /**
     * Why a message's component secrets are refused, or null: secrets another
     * owner used in a message mined before this one, unless the app's own
     * applied messages carry them. Read in chain order, so every node decides
     * the same whenever it decides.
     */
    async secretsRefusal(spec, { name, record, isRegistration, ownUses }) {
      const components = spec.getComponentSecrets();
      if (components.length === 0) return null;
      const earlier = await appsRepository.listHistoricalV7SecretsBefore(record);
      for (const { componentName, secrets } of components) {
        const refusal = v7SecretsRefusal(
          { secrets, appName: name, owner: spec.owner, componentName, isRegistration },
          { live: ownUses, earlier },
        );
        if (refusal) return refusal;
      }
      return null;
    },

    /** The time of a mined block, for a term that ended at a height. */
    async blockTimeAtHeight(height) {
      if (!blockTimes.has(height)) {
        const time = await lookupBlockTime(height);
        if (!Number.isFinite(time)) throw new Error(`no block time for height ${height}`);
        blockTimes.set(height, time);
      }
      return blockTimes.get(height);
    },

    /** The height the name hold is judged from, null while not scheduled. */
    nameReservedActivation() {
      const height = config.get('fluxapps.nameReservedActivationHeight');
      return Number.isInteger(height) && height > 0 ? height : null;
    },

    /** The confirming block's time of an entry, from its record or the daemon. */
    async blockTime(entry) {
      if (Number.isFinite(entry.record.blockTime)) return entry.record.blockTime;
      const { height } = entry.record;
      if (!blockTimes.has(height)) {
        const time = await lookupBlockTime(height);
        if (!Number.isFinite(time)) throw new Error(`no block time for height ${height}`);
        blockTimes.set(height, time);
      }
      return blockTimes.get(height);
    },

    isValidationError(error) {
      return error instanceof ValidationError;
    },
  };
}

module.exports = { createJudge };
