// Flux transparent (t1) chain crypto for the harness: derive addresses and build
// signed foundation self-send transactions that carry soft-fork OP_RETURN messages
// (price/rate/oracle-key/…). The harness plays the foundation for these tests.
//
// Derivation and DER signatures match what FluxOS validates: the t1 address is
// base58check(0x1cb8 ‖ ripemd160(sha256(compressedPubkey))) — identical to
// fluxCryptoUtils.pubKeyToAddr — and the scriptSig carries a real DER signature
// (secp256k1) plus a SIGHASH_ALL byte, which explorerService.inputSignsAllOutputs
// checks. Latest noble/curves + scure/base, all pure-JS.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { base58check } from '@scure/base';

const b58check = base58check(sha256);

// Flux t1 (P2PKH transparent) address version prefix.
const FLUX_T1_PREFIX = Uint8Array.from([0x1c, 0xb8]);
const SIGHASH_ALL = 0x01;

// Fixed test foundation keys. Deterministic scalars, never real keys — the
// authority signs Price/OracleKey/Modifier/Marketplace/Policy; the oracle (whose
// pubkey the authority publishes via OracleKeyMessage) signs Rate. Distinct by
// design: the authority authorises the oracle, which may rotate.
export const AUTHORITY_PRIVKEY = 'a1'.repeat(32);
export const ORACLE_PRIVKEY = '02'.repeat(32);

function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function privBytes(privHex) {
  return Uint8Array.from(Buffer.from(privHex, 'hex'));
}

/** 33-byte compressed secp256k1 public key for a private key. */
export function compressedPubkey(privHex) {
  return secp256k1.getPublicKey(privBytes(privHex), true);
}

/** The Flux t1 (transparent P2PKH) address for a private key. */
export function t1Address(privHex) {
  const h160 = ripemd160(sha256(compressedPubkey(privHex)));
  return b58check.encode(concatBytes(FLUX_T1_PREFIX, h160));
}

// A standard P2PKH scriptSig: push(DER signature ‖ SIGHASH_ALL) push(compressed
// pubkey). The signature is real (over a deterministic per-tx digest); the stub
// isn't a consensus node, so it validates the DER + sighash byte, not the full
// consensus sighash — but the signature genuinely comes from the signer's key.
function p2pkhScriptSigHex(privHex, digest) {
  const compact = secp256k1.sign(digest, privBytes(privHex), { lowS: true, prehash: false });
  const der = secp256k1.Signature.fromBytes(compact, 'compact').toBytes('der');
  const sigWithType = concatBytes(der, Uint8Array.from([SIGHASH_ALL]));
  const pub = compressedPubkey(privHex);
  const scriptSig = concatBytes(
    Uint8Array.from([sigWithType.length]), sigWithType,
    Uint8Array.from([pub.length]), pub,
  );
  return Buffer.from(scriptSig).toString('hex');
}

/**
 * Build a foundation self-send transaction carrying a soft-fork OP_RETURN,
 * signed by signerPrivHex. Self-send (sender == receiver == signer) so it clears
 * the recognized-signer entry gate; the per-type authority check then verifies
 * the specific signer for the message type.
 *
 * Returns { tx, prevTx, address }: `tx` for /advance-block, and `prevTx` to seed
 * via /seed-transaction so getSender(prevTxid, 0) resolves the sender address on
 * the processStandard block path.
 *
 * @param {object} opts
 * @param {string} opts.signerPrivHex - signer private key (hex)
 * @param {Uint8Array} opts.messageBytes - encoded soft-fork message (version byte first)
 * @param {string} opts.txid
 * @param {string} opts.prevTxid
 */
export function buildSignedSoftForkTx({
  signerPrivHex, messageBytes, txid, prevTxid,
}) {
  const address = t1Address(signerPrivHex);
  const opReturnHex = Buffer.from(messageBytes).toString('hex');
  const digest = sha256(concatBytes(Uint8Array.from(Buffer.from(txid, 'utf8')), messageBytes));
  const scriptSigHex = p2pkhScriptSigHex(signerPrivHex, digest);
  const tx = {
    txid,
    version: 1,
    vin: [{ txid: prevTxid, vout: 0, address, scriptSig: { hex: scriptSigHex } }],
    vout: [
      { valueSat: 100000, scriptPubKey: { addresses: [address], asm: '', hex: '' } },
      { valueSat: 0, scriptPubKey: { addresses: [], asm: `OP_RETURN ${opReturnHex}` } },
    ],
  };
  const prevTx = {
    txid: prevTxid,
    version: 1,
    vin: [],
    vout: [{ value: 1, n: 0, scriptPubKey: { addresses: [address] } }],
    blockhash: '',
    confirmations: 1,
    time: 0,
    blocktime: 0,
  };
  return { tx, prevTx, address };
}

/** The derived foundation authority address (for messageAuthorityAddress config). */
export function authorityAddress() { return t1Address(AUTHORITY_PRIVKEY); }
/** The derived oracle address (published via OracleKeyMessage; signs RateMessages). */
export function oracleAddress() { return t1Address(ORACLE_PRIVKEY); }
