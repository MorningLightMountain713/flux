// Real policy messages on the harness chain.
//
// The content suites satisfy the entitlement gate with a precondition: a group-0
// grant injected straight into each node's policy collection before boot
// (policy-helper.js). That is the fast path for suites that are not about
// policy, and it is not the path mainnet takes — which is why, from 2026-09-03
// to 2026-09-07, a row the product had started refusing at boot went unnoticed
// until the first gate that ran a gated suite. The suites in the 14xx block go
// the other way: a real PolicyGroupMessage in an OP_RETURN, in a block the daemon
// stub serves, ingested by the node's own explorer through the same
// authority, signature and ordering checks a mainnet message meets.
//
// What the node checks (explorerService): the transaction has an input from
// the configured message authority address that signs all outputs — a genuine
// DER signature whose hash type is SIGHASH_ALL, imported before it is read, so
// a fake one must at least be a real signature — and the payload's first byte
// is the policy version byte. The signature is never verified against the
// input (the stub is not a chain), so any key signs it; the ADDRESS is what the
// authority check reads, and a message from any other address is dropped at
// the gate before it is parsed.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { PolicyGroupMessage, encodeGrantBitmap } from '@runonflux/flux-spec-policy';
import { injectBlockWith, getState } from './daemon-control.js';
import { loadSharedConfig } from './coupled-knobs.js';
import { waitForBlockProcessed } from './wait.js';

/** The v9 message authority the harness nodes are configured with. */
export const MESSAGE_AUTHORITY = loadSharedConfig().fluxapps.messageAuthorityAddress;
/** The stub's stock sender, which is no authority of any kind. */
export const STRANGER = 'stub-sender-address';

const SIGHASH_ALL = 0x01;
const SIGHASH_NONE = 0x02;
// Any key: the node imports the DER and reads its hash type, and checks nothing
// against the input. Fixed so the scriptSig is the same bytes on every run.
const SIGNING_KEY = new Uint8Array(32).fill(0x2a);
const SIGNED_DIGEST = new Uint8Array(32).fill(0x07);

let derSignature = null;
function signature() {
  if (!derSignature) {
    const compact = secp256k1.sign(SIGNED_DIGEST, SIGNING_KEY, { lowS: true, prehash: false });
    derSignature = secp256k1.Signature.fromBytes(compact, 'compact').toBytes('der');
  }
  return derSignature;
}

/**
 * The input's scriptSig as fluxd would carry it: one direct push of the DER
 * signature with the hash type appended.
 * @param {number} hashType SIGHASH_ALL for a signed input; anything else for one that does not sign all outputs
 */
function scriptSig(hashType) {
  const sig = Buffer.concat([Buffer.from(signature()), Buffer.from([hashType])]);
  return { hex: Buffer.concat([Buffer.from([sig.length]), sig]).toString('hex') };
}

let minted = 0;

/**
 * A transaction carrying one soft-fork message, in the shape the stub serves
 * and the explorer reads (see buildAppRegistrationTx in the stub for the app
 * transaction it mirrors).
 *
 * @param {Uint8Array} bytes the encoded message, version byte first
 * @param {object} [opts]
 * @param {string} [opts.sender] the input's address — the authority unless the suite says otherwise
 * @param {boolean} [opts.signsAllOutputs] false for an input whose signature does not cover every output
 * @returns {object} the transaction
 */
export function policyTx(bytes, { sender = MESSAGE_AUTHORITY, signsAllOutputs = true } = {}) {
  minted += 1;
  const hex = Buffer.from(bytes).toString('hex');
  return {
    txid: `policy-${Date.now()}-${minted}`,
    version: 1,
    vin: [{
      txid: 'prev-tx-stub', vout: 0, address: sender, scriptSig: scriptSig(signsAllOutputs ? SIGHASH_ALL : SIGHASH_NONE),
    }],
    vout: [{ valueSat: 0, scriptPubKey: { addresses: [], asm: `OP_RETURN ${hex}` } }],
  };
}

/**
 * A group definition: the features named are granted, every other allocated
 * bit is closed. An empty list closes the group.
 * @param {{groupId?: number, features?: string[], action?: string}} opts
 * @returns {Uint8Array}
 */
export function definitionBytes({ groupId = PolicyGroupMessage.DEFAULT_GROUP_ID, features = [], action = 'upsert' } = {}) {
  const grants = Object.fromEntries(features.map((name) => [name, true]));
  return PolicyGroupMessage.encodeDefinition({ groupId, bitmap: encodeGrantBitmap(grants), action });
}

/**
 * A membership message: the fluxids named join (upsert) or leave (delete) the group.
 * @param {{groupId: number, fluxids: string[], action?: string}} opts
 * @returns {Uint8Array}
 */
export function membershipBytes({ groupId, fluxids, action = 'upsert' }) {
  return PolicyGroupMessage.encodeMembership({
    groupId, fluxids: fluxids.map((id) => PolicyGroupMessage.encodeFluxid(id)), action,
  });
}

/**
 * One block carrying the messages given, in that order — the order is the
 * transaction's position in the block, which is what the node orders two
 * messages for the same group by.
 *
 * @param {Array<{bytes: Uint8Array, sender?: string, signsAllOutputs?: boolean}>} messages
 * @returns {Promise<{height: number, txids: string[]}>} the block's height
 */
export async function mintPolicyBlock(messages) {
  const txs = messages.map((m) => policyTx(m.bytes, { sender: m.sender, signsAllOutputs: m.signsAllOutputs }));
  await injectBlockWith(txs);
  const { currentHeight } = await getState();
  return { height: currentHeight, txids: txs.map((tx) => tx.txid) };
}

export async function mintDefinition(opts = {}) {
  return mintPolicyBlock([{ bytes: definitionBytes(opts), sender: opts.sender, signsAllOutputs: opts.signsAllOutputs }]);
}

export async function mintMembership(opts) {
  return mintPolicyBlock([{ bytes: membershipBytes(opts), sender: opts.sender, signsAllOutputs: opts.signsAllOutputs }]);
}

/**
 * Every node has processed the block at `height` — the point from which its
 * entitlement state includes what the block carried.
 * @param {Array<object>} clients
 * @param {number} height
 */
export async function policyProcessed(clients, height, timeout = 60000) {
  await Promise.all(clients.map((c) => waitForBlockProcessed(c, (d) => d.height >= height, timeout)));
}
