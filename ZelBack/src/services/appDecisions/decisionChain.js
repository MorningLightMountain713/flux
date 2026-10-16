'use strict';

const config = require('config');

const pricingRegime = require('../pricing/pricingRegime');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const { lookupBlockTime } = require('../appMessaging/confirmedMessageStore');
const appsRepository = require('../appDatabase/appsRepository');

/**
 * This node's chain state, as flux-spec's decideName asks it: activation
 * heights, fees, entitlement, who may sign, the secrets mined before a
 * payment, and block times. One chain serves one run of the decider; it
 * remembers the block times it looks up.
 *
 * @returns {Promise<import('@runonflux/flux-spec-backend').DecisionChain>}
 */
async function createChain() {
  const blockTimes = new Map();

  async function timeAt(height) {
    if (!blockTimes.has(height)) {
      const time = await lookupBlockTime(height);
      if (!Number.isFinite(time)) throw new Error(`no block time for height ${height}`);
      blockTimes.set(height, time);
    }
    return blockTimes.get(height);
  }

  return {
    activationHeight(version) {
      return config.get('fluxapps.appSpecsEnforcementHeights')[version];
    },

    async registrationFee(spec, height) {
      return (await pricingRegime.regimeFor(spec)).registrationFee(spec, height);
    },

    async pricedAt(spec, height) {
      return (await pricingRegime.regimeFor(spec)).pricedAt(height);
    },

    async updateFee(spec, prevSpec, ctx) {
      return pricingRegime.updateFee(spec, prevSpec, ctx);
    },

    async entitlementRefusal(spec, height) {
      return (await pricingRegime.regimeFor(spec)).entitlementRefusal(spec, height);
    },

    updateSignersAt(event, height) {
      return appEventVerifier.updateSignersAt(event, height);
    },

    renewalSignersAt(height) {
      return appEventVerifier.renewalSignersAt(height);
    },

    async historicalV7SecretsBefore(record) {
      return appsRepository.listHistoricalV7SecretsBefore(record);
    },

    /** The height the name hold is judged from, null while not scheduled. */
    nameReservedActivation() {
      const height = config.get('fluxapps.nameReservedActivationHeight');
      return Number.isInteger(height) && height > 0 ? height : null;
    },

    /** The time of a mined block, for a term that ended at a height. */
    async blockTimeAtHeight(height) {
      return timeAt(height);
    },

    /** The confirming block's time of an entry, from its record or the daemon. */
    async blockTime(entry) {
      if (Number.isFinite(entry.record.blockTime)) return entry.record.blockTime;
      return timeAt(entry.record.height);
    },
  };
}

module.exports = { createChain };
