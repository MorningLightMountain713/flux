'use strict';

// The mesh membership voucher: proof that this node's per-app authority was
// presented by a genuine Arcane node, for this registration, on this
// collateral, recently.
//
// The node builds the message over (authority bundle, app uuid, outpoint,
// anchor block hash) and the benchmark channel signs it verbatim under the
// mesh-purpose key with the domain prefixed server-side, so no caller can
// mint bytes shaped like another protocol's. Peers verify against the pinned
// mesh-purpose public key with no RPC.
//
// The voucher binds the registration uuid, not the app name: a name is a
// lease, and a verifier resolves the broadcast's name to its own row's uuid —
// so a voucher minted under a previous registration of the same name can
// never authorise a member into the successor's overlay.
//
// Fields are length-prefixed (4-byte big-endian) so the message has exactly
// one reading — bare concatenation would let bytes slide between fields. The
// message travels and is signed as base64 because the signing channel carries
// strings. The exact bytes are pinned by golden vectors in
// tests/unit/meshVoucher.test.js; minter and every verifier must agree
// byte-for-byte forever.
const config = require('config');

const benchmarkService = require('../benchmarkService');
const { verifyAttestationSignature } = require('../utils/arcaneAttestation');
const daemonServiceBlockchainRpcs = require('../daemonService/daemonServiceBlockchainRpcs');

/**
 * Network mesh-purpose attestation public key (base64, raw 32-byte Ed25519) —
 * the `purpose=mesh` key of the benchmark channel's attestation surface,
 * distinct from the default attestation key. Config can point a controlled
 * environment at a different keypair; production uses the constant.
 */
const DEFAULT_MESH_ATTESTATION_PUBKEY = 'B15YMLgv8ozC3cWXPmNySiu0DuEjMVzX5qh3UYspfXE=';
const MESH_ATTESTATION_PUBKEY = (config.arcane && config.arcane.meshAttestationPubkey)
  ?? DEFAULT_MESH_ATTESTATION_PUBKEY;

// Public domain separator; the signer prepends it server-side, verifiers
// rebuild it. Only the signing key is secret.
const VOUCHER_DOMAIN = 'FLUX_MESH_VOUCHER_v1:';

const HEX64_RE = /^[0-9a-f]{64}$/;
const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/;

function lengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * The exact voucher message string that gets signed (after the signer's
 * domain prefix): base64 over the length-prefixed fields.
 *
 * @param {{meshCa: string, appUuid: string, outpoint: string, blockHash: string}} fields
 *   meshCa is the authority bundle PEM exactly as published; blockHash is the
 *   anchor block every voucher in a broadcast commits to.
 * @returns {string}
 */
function buildVoucherMessage({
  meshCa, appUuid, outpoint, blockHash,
}) {
  if (typeof meshCa !== 'string' || meshCa === '') {
    throw new TypeError('meshCa must be the authority bundle PEM');
  }
  if (typeof appUuid !== 'string' || !HEX64_RE.test(appUuid)) {
    throw new TypeError('appUuid must be the app row\'s 64-hex registration uuid');
  }
  if (typeof outpoint !== 'string' || !OUTPOINT_RE.test(outpoint)) {
    throw new TypeError('outpoint must be a canonical "<txhash>:<outidx>" string');
  }
  if (typeof blockHash !== 'string' || !HEX64_RE.test(blockHash)) {
    throw new TypeError('blockHash must be a 64-hex block hash');
  }
  return Buffer.concat([
    lengthPrefixed(meshCa),
    lengthPrefixed(appUuid),
    lengthPrefixed(outpoint),
    lengthPrefixed(blockHash),
  ]).toString('base64');
}

/**
 * The chain anchor vouchers commit to: the node's current tip. Fetched once
 * per broadcast; every voucher in it shares the anchor.
 *
 * @returns {Promise<{height: number, hash: string}>}
 */
async function fetchVoucherAnchor() {
  const info = await daemonServiceBlockchainRpcs.getBlockchainInfo();
  if (!info || info.status !== 'success' || !info.data || !HEX64_RE.test(info.data.bestblockhash)) {
    throw new Error('The daemon did not return a usable chain tip for the mesh voucher anchor');
  }
  return { height: info.data.blocks, hash: info.data.bestblockhash };
}

/**
 * Mint a voucher: have the benchmark channel sign the message under the
 * mesh-purpose key. Throws when the signer is unreachable or refuses — a
 * broadcast without a voucher is not worth sending.
 *
 * @param {{meshCa: string, appUuid: string, outpoint: string, blockHash: string}} fields
 * @returns {Promise<string>} base64 Ed25519 signature
 */
async function mintVoucher(fields) {
  const message = buildVoucherMessage(fields);
  const returned = await benchmarkService.attest({ message, purpose: 'mesh' });
  // Two envelopes: executeCall wraps { status: 'success'|'error', data }, and
  // data is the signer's own JSON string carrying { status: 'ok', signature }.
  if (!returned || returned.status !== 'success') {
    throw new Error('Could not reach the mesh voucher signer');
  }
  let signed;
  try {
    signed = typeof returned.data === 'string' ? JSON.parse(returned.data) : returned.data;
  } catch (error) {
    throw new Error('The mesh voucher signer returned an unreadable response');
  }
  if (!signed || signed.status !== 'ok' || !signed.signature) {
    throw new Error(`The mesh voucher was refused: ${signed && signed.message ? signed.message : 'no signature returned'}`);
  }
  return signed.signature;
}

/**
 * Verify a peer's voucher against the pinned mesh-purpose key. Malformed
 * input verifies as false rather than throwing — an unverifiable voucher is
 * simply invalid.
 *
 * @param {string} signatureB64 the peer's voucher
 * @param {{meshCa: string, appUuid: string, outpoint: string, blockHash: string}} fields
 *   rebuilt from the verifier's own view: the broadcast's meshCa, the
 *   verifier's row uuid for the app, the member's outpoint, the broadcast's
 *   anchor hash
 * @param {string} [publicKeyB64] the mesh-purpose key; overridable for tests
 * @returns {boolean}
 */
function verifyVoucher(signatureB64, fields, publicKeyB64 = MESH_ATTESTATION_PUBKEY) {
  let message;
  try {
    message = buildVoucherMessage(fields);
  } catch (error) {
    return false;
  }
  return verifyAttestationSignature(VOUCHER_DOMAIN + message, publicKeyB64, signatureB64);
}

module.exports = {
  MESH_ATTESTATION_PUBKEY,
  VOUCHER_DOMAIN,
  buildVoucherMessage,
  fetchVoucherAnchor,
  mintVoucher,
  verifyVoucher,
};
