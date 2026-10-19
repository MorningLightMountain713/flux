'use strict';

const pricingRegime = require('../pricing/pricingRegime');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const { lookupBlockTime } = require('../appMessaging/confirmedMessageStore');
const appsRepository = require('../appDatabase/appsRepository');
const { specActivationHeights } = require('../utils/nodeChain');

/**
 * This node's chain state, as flux-spec's decideName asks it: activation
 * heights, fees, entitlement, who may sign, the secrets mined before a
 * payment, and block times. One chain serves one run of the decider; it
 * remembers the block times it looks up, and reads the v7 secret uses once.
 *
 * @returns {Promise<import('@runonflux/flux-spec-backend').DecisionChain>}
 */
async function createChain() {
  const blockTimes = new Map();
  let v7SecretUses = null;

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
      return specActivationHeights()[version];
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
      v7SecretUses ??= appsRepository.listV7SecretUses();
      return appsRepository.secretUsesBefore(await v7SecretUses, record);
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
