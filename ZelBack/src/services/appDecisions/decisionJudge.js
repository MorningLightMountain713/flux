'use strict';

const config = require('config');

const { getSpec, getSpecBackend } = require('../utils/specLibs');
const pricingRegime = require('../pricing/pricingRegime');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const { lookupBlockTime } = require('../appMessaging/confirmedMessageStore');
const { mintAppUuid, registrationIdentity } = require('../utils/appIdentity');

/**
 * The chain-state answers the decision rule asks for, from this node's own
 * chain state: activation heights, fees, entitlement, who may sign, and block
 * times. One judge serves one run of the decider; it remembers the block times
 * it looks up.
 *
 * @returns {Promise<object>} the judge decisionRule.decideName reads
 */
async function createJudge() {
  const { UpdatePolicy, ValidationError } = await getSpec();
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

    mintUuid: mintAppUuid,

    identityFor: registrationIdentity,

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
