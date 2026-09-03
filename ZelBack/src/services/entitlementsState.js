'use strict';

const config = require('config');
const { inChainOrder } = require('./utils/softForkRows');
const bs58check = require('bs58check');
const dbHelper = require('./dbHelper');
const log = require('../lib/log');
const { getSpecPolicy } = require('./utils/specLibs');

let policyGroupHistory;
let featureEntitlements;

function ensureUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value && value.buffer) return new Uint8Array(value.buffer);
  return value;
}

// Membership messages carry fluxid addresses as nested Uint8Arrays, which
// round-trip through mongo as BSON Binary. Restore them before replaying.
function restorePolicyGroupBinary(message) {
  if (message && message.subtype === 'membership' && Array.isArray(message.fluxids)) {
    for (const fluxid of message.fluxids) {
      fluxid.bytes = ensureUint8Array(fluxid.bytes);
    }
  }
}

async function rebuildPolicyGroupState() {
  const { PolicyGroupHistory, FeatureEntitlements } = await getSpecPolicy();

  policyGroupHistory = new PolicyGroupHistory();
  featureEntitlements = new FeatureEntitlements({ groupHistory: policyGroupHistory });

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.chainparams.database);

  const docs = await dbHelper.findInDatabase(
    database, config.database.chainparams.collections.policyGroupMessages,
    {}, { projection: { _id: 0 } },
  );
  inChainOrder(docs, 'policyGroupMessages');
  for (const doc of docs) {
    restorePolicyGroupBinary(doc.message);
    policyGroupHistory.add(doc.message, doc.height, doc.txIndex);
  }

  log.info(`Policy group state rebuilt: ${docs.length} policy-group messages`);
}

function removeAtHeight(height) {
  if (policyGroupHistory) policyGroupHistory.removeAtHeight(height);
}

function getPolicyGroupHistory() { return policyGroupHistory; }

function getFeatureEntitlements() { return featureEntitlements; }

/**
 * Strict feature-entitlement gate for a v9 submission. Rejects a spec that
 * uses a gated feature (mesh, telemetry, networkSharing, …) the owner's
 * policy groups do not grant at the given height.
 *
 * Fails open only when the entitlement state is not yet built (node mid-init)
 * — an infrastructure gap, not a policy decision. Once the state is rebuilt,
 * the gate is strict: the required on-chain policy groups are expected to be
 * in place before any spec uses the feature.
 *
 * @param {object} canonicalSpec - v9 spec instance exposing toCanonical()
 * @param {string} owner - cleartext owner address
 * @param {number} height - daemon height to resolve entitlements at
 * @param {boolean} isEncrypted - whether the spec was submitted encrypted; flows
 *   into used-feature detection so an encryption-derived gated feature would be
 *   gated correctly (encryptedSpec itself is ungated, so inert today).
 */
async function assertSpecEntitled(canonicalSpec, owner, height, isEncrypted) {
  if (!featureEntitlements) {
    log.warn('entitlementsState - policy group state not built, skipping feature entitlement gate');
    return;
  }

  let fluxidBytes;
  try {
    fluxidBytes = new Uint8Array(bs58check.decode(owner));
  } catch (error) {
    throw new Error(`Owner address '${owner}' is not a valid fluxid for feature entitlement checks`);
  }

  const result = featureEntitlements.check(fluxidBytes, canonicalSpec.toCanonical(), height, isEncrypted);
  if (!result.allowed) {
    const err = new Error(`Feature not available: ${result.reason}`);
    err.code = 'FEATURE_NOT_ENTITLED';
    throw err;
  }
}

module.exports = {
  rebuildPolicyGroupState,
  removeAtHeight,
  getPolicyGroupHistory,
  getFeatureEntitlements,
  assertSpecEntitled,
};
