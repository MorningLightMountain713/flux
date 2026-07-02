// Bootstraps v9 on-chain pricing for a harness fleet the way it happens in
// production: real OP_RETURN soft-fork messages, mined into blocks, ingested by
// explorerService as it follows the chain. A fresh harness chain quotes no price,
// so every v9 registration fee resolves to 0 and is fail-closed rejected until
// these are in force.
//
// Sequence (each a foundation self-send carrying one message):
//   1. OracleKeyMessage (authority-signed) — publishes the oracle pubkey, so
//      isOracleSigner can resolve the oracle address for the rate message.
//   2. RateMessage (oracle-signed) — the FLUX/USD rate.
//   3. PriceMessage (authority-signed) — the commodity rates + minPrice floor.
//
// The authority address must match the node's messageAuthorityAddress config —
// the harness default in test-infra/config/shared.js is authorityAddress() from
// flux-chain-crypto.js; suites testing authority rotation override it per-suite.
import {
  PriceMessage, RateMessage, OracleKeyMessage, SOFT_FORK_EFFECTIVE_DEPTH,
} from '@runonflux/flux-spec-policy';
import {
  buildSignedSoftForkTx, compressedPubkey, AUTHORITY_PRIVKEY, ORACLE_PRIVKEY,
} from './flux-chain-crypto.js';
import { injectBlock, seedTransaction, advanceBlocks } from './daemon-control.js';

// Modest, non-zero defaults: a small app floors at minPrice (well under the 2 FLUX
// the stub's registration tx pays), so pricing is in force without underpaying.
// microdollar rates; minPriceFluxSats is the FLUX-satoshi backstop.
const DEFAULT_PRICE_FIELDS = {
  cpuRate: 1000,
  memoryRate: 100,
  storageRate: 100,
  minPrice: 10000, // $0.01 in microdollars
  minPriceFluxSats: 1000000, // 0.01 FLUX
  standardPeriodSeconds: 2640000, // legacy month
};
const DEFAULT_FLUX_USD_E4 = 10000; // $1.00 / FLUX

async function injectSoftForkMessage(signerPrivHex, messageBytes, label) {
  const txid = `softfork-${label}`;
  const prevTxid = `softfork-${label}-prev`;
  const { tx, prevTx } = buildSignedSoftForkTx({
    signerPrivHex, messageBytes, txid, prevTxid,
  });
  // Seed the input's source tx first so the processStandard path resolves the
  // sender address, then mine the message tx into the next block.
  await seedTransaction(prevTxid, prevTx);
  await injectBlock(tx);
}

/**
 * Bootstrap v9 pricing into the harness chain. Call after the fleet has booted
 * and before any v9 app is confirmed on-chain.
 *
 * @param {object} [opts]
 * @param {object} [opts.priceFields] - PriceMessage tag fields (microdollar rates)
 * @param {number} [opts.fluxUsdPriceE4] - FLUX/USD × 10000
 * @param {number} [opts.timestamp] - RateMessage unix-seconds timestamp
 */
export async function bootstrapPricing(opts = {}) {
  const priceFields = opts.priceFields || DEFAULT_PRICE_FIELDS;
  const fluxUsdPriceE4 = opts.fluxUsdPriceE4 || DEFAULT_FLUX_USD_E4;
  const timestamp = opts.timestamp || 1700000000;
  // A soft-fork message only takes effect SOFT_FORK_EFFECTIVE_DEPTH blocks after it
  // is mined (reorg safety). So the oracle key must be effective before the rate
  // message can resolve it, and all three must be effective before the first
  // registration fee is computed — hence the empty-block gaps.
  const gap = SOFT_FORK_EFFECTIVE_DEPTH + 1;

  await injectSoftForkMessage(
    AUTHORITY_PRIVKEY,
    OracleKeyMessage.encode({ pubkey: compressedPubkey(ORACLE_PRIVKEY) }),
    'oraclekey',
  );
  await advanceBlocks(gap); // oracle key becomes effective

  await injectSoftForkMessage(
    ORACLE_PRIVKEY,
    RateMessage.encode({ timestamp, fluxUsdPriceE4 }),
    'rate',
  );
  await injectSoftForkMessage(
    AUTHORITY_PRIVKEY,
    PriceMessage.encode(priceFields),
    'price',
  );
  await advanceBlocks(gap); // rate + price become effective
}
