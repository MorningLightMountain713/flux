// The void of a paid app message on a harness chain, the way it happens in
// production: the foundation publishes the availability key under its role,
// and that key names a paid hash with an UnclaimedPaymentMessage inside the
// payment's void window. Both are real OP_RETURN soft-fork messages, mined
// into blocks and ingested by explorerService as it follows the chain.
import {
  OracleKeyMessage, UnclaimedPaymentMessage, SOFT_FORK_EFFECTIVE_DEPTH,
} from '@runonflux/flux-spec-policy';
import { compressedPubkey, AUTHORITY_PRIVKEY, AVAILABILITY_PRIVKEY } from './flux-chain-crypto.js';
import { injectSoftForkMessage } from './price-helper.js';
import { advanceBlocks } from './daemon-control.js';

export const { VOID_WINDOW_OPENS_AFTER_BLOCKS, PAYMENT_FINAL_AFTER_BLOCKS } = UnclaimedPaymentMessage;

/**
 * Put the availability key in force: the authority publishes it, and the
 * blocks that make a soft-fork message effective are mined. Call once the
 * fleet has booted and before the first void.
 */
export async function bootstrapAvailabilityKey() {
  await injectSoftForkMessage(
    AUTHORITY_PRIVKEY,
    OracleKeyMessage.encode({ role: OracleKeyMessage.ROLE.AVAILABILITY, pubkey: compressedPubkey(AVAILABILITY_PRIVKEY) }),
    'availabilitykey',
  );
  await advanceBlocks(SOFT_FORK_EFFECTIVE_DEPTH + 1);
}

/**
 * Publish a void for a paid hash, signed by the availability key, into the
 * next block. Whether it takes effect is the void window's rule, read against
 * the payment's height.
 * @param {string} hashHex the app message hash the payment carries
 * @param {string} label names the transaction, unique within the chain
 */
export async function publishVoid(hashHex, label) {
  await injectSoftForkMessage(AVAILABILITY_PRIVKEY, UnclaimedPaymentMessage.encode({ hash: hashHex }), label);
}
