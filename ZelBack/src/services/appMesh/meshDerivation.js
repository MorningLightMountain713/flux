const crypto = require('crypto');

// Every value here is derived, never allocated: all nodes hosting an app
// compute identical prefixes, addresses and names from inputs they already
// share (the registration's uuid, the hosting set's outpoints, the spec's
// component names), so nothing needs to be agreed, published or stored.
// Addresses are permanent for the life of a (node, app) pairing — the
// impersonation detector treats any disagreement between a claimed address and
// this derivation as a cheat, so these functions must never change behaviour
// for existing inputs. The golden vectors in tests/unit/meshDerivation.test.js
// pin them.
//
// Address layout, 128 bits:
//   fd (8) | sha256("flux-mesh-app" ‖ appUuid)[0..5] (40)     → the /48 app prefix
//          | sha256("flux-mesh-node" ‖ appUuid ‖ outpoint)[0..6] (48)  → node block
//          | component slot, big-endian (32)
//
// appUuid is the app's registration identity — mintAppUuid's sha256(name‖txid)
// hex, read off the app row, fed here as the 64-hex string it is stored as. A
// name is a lease: the same string re-registered later is a DIFFERENT app, and
// keying the overlay on the uuid means the two registrations never derive the
// same addresses, so a stale member of the previous holder can never look
// address-correct inside the successor's overlay.
//
// The component slot comes from flux-spec's `meshComponentSlot` (via the CJS
// bridge) — the same derivation the spec's collision gate runs at submission.
// Callers pass it in.
const APP_PREFIX_DOMAIN = 'flux-mesh-app';
const NODE_BLOCK_DOMAIN = 'flux-mesh-node';
const TRANSLATOR_DOMAIN = 'flux-mesh-siit';

const APP_UUID_RE = /^[0-9a-f]{64}$/;
const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/;

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  parts.forEach((part) => hash.update(part));
  return hash.digest();
}

function assertAppUuid(appUuid) {
  if (typeof appUuid !== 'string' || !APP_UUID_RE.test(appUuid)) {
    throw new TypeError('appUuid must be the app row\'s 64-hex registration uuid');
  }
}

function assertOutpoint(outpoint) {
  if (typeof outpoint !== 'string' || !OUTPOINT_RE.test(outpoint)) {
    throw new TypeError('outpoint must be a canonical "<txhash>:<outidx>" string; use canonicalOutpoint()');
  }
}

/**
 * The canonical outpoint string every mesh derivation keys on:
 * lowercase 64-hex txhash, a colon, the output index in decimal.
 *
 * The daemon reports `outidx` as a string despite its typedef (its RPC help
 * types are unreliable), so both representations are accepted and normalised.
 *
 * @param {string} txhash collateral transaction hash, 64 hex chars
 * @param {(string|number)} outidx collateral output index
 * @returns {string} `<txhash>:<outidx>`
 */
function canonicalOutpoint(txhash, outidx) {
  if (typeof txhash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(txhash)) {
    throw new TypeError('txhash must be a 64-character hex string');
  }
  const idx = typeof outidx === 'string' && /^\d+$/.test(outidx) ? Number(outidx) : outidx;
  if (!Number.isSafeInteger(idx) || idx < 0) {
    throw new TypeError('outidx must be a non-negative integer');
  }
  return `${txhash.toLowerCase()}:${idx}`;
}

/**
 * RFC 5952 canonical text form of a 16-byte IPv6 address: lowercase, no
 * leading zeros, the longest run of two or more zero hextets compressed to
 * `::` (leftmost on a tie). One canonical spelling per address, so derived
 * strings are directly comparable wherever they end up (configs, logs,
 * detector output).
 *
 * @param {Buffer} bytes the 16 address bytes
 * @returns {string} canonical textual address
 */
function formatIpv6(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    throw new TypeError('formatIpv6 needs a 16-byte Buffer');
  }
  const hextets = [];
  for (let i = 0; i < 16; i += 2) {
    hextets.push(bytes.readUInt16BE(i).toString(16));
  }
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i <= 8; i += 1) {
    if (i < 8 && hextets[i] === '0') {
      if (runStart === -1) runStart = i;
      runLen += 1;
    } else {
      if (runLen > bestLen) {
        bestStart = runStart;
        bestLen = runLen;
      }
      runStart = -1;
      runLen = 0;
    }
  }
  if (bestLen < 2) return hextets.join(':');
  return `${hextets.slice(0, bestStart).join(':')}::${hextets.slice(bestStart + bestLen).join(':')}`;
}

function appPrefixBytes(appUuid) {
  return Buffer.concat([Buffer.from([0xfd]), sha256(APP_PREFIX_DOMAIN, appUuid).subarray(0, 5)]);
}

function nodeBlockBytes(appUuid, outpoint) {
  return sha256(NODE_BLOCK_DOMAIN, appUuid, outpoint).subarray(0, 6);
}

/**
 * The app's overlay prefix, identical on every node hosting this registration.
 *
 * @param {string} appUuid the app row's registration uuid
 * @returns {string} `<prefix>/48` in canonical form
 */
function appPrefix(appUuid) {
  assertAppUuid(appUuid);
  return `${formatIpv6(Buffer.concat([appPrefixBytes(appUuid), Buffer.alloc(10)]))}/48`;
}

/**
 * One node's address block within an app's overlay — what the node's host
 * certificate carries as `unsafeNetworks`.
 *
 * @param {string} appUuid the app row's registration uuid
 * @param {string} outpoint the node's canonical outpoint
 * @returns {string} `<block>/96` in canonical form
 */
function nodeBlock(appUuid, outpoint) {
  assertAppUuid(appUuid);
  assertOutpoint(outpoint);
  const bytes = Buffer.concat([appPrefixBytes(appUuid), nodeBlockBytes(appUuid, outpoint), Buffer.alloc(4)]);
  return `${formatIpv6(bytes)}/96`;
}

/**
 * The overlay address of one component instance on one node.
 *
 * @param {string} appUuid the app row's registration uuid
 * @param {string} outpoint the hosting node's canonical outpoint
 * @param {number} slot the component's slot from flux-spec's meshComponentSlot
 * @returns {string} canonical textual IPv6 address
 */
function memberAddress(appUuid, outpoint, slot) {
  assertAppUuid(appUuid);
  assertOutpoint(outpoint);
  if (!Number.isInteger(slot) || slot < 0 || slot > 0xffffffff) {
    throw new TypeError('slot must be an integer in 0..4294967295');
  }
  const slotBytes = Buffer.alloc(4);
  slotBytes.writeUInt32BE(slot);
  return formatIpv6(Buffer.concat([appPrefixBytes(appUuid), nodeBlockBytes(appUuid, outpoint), slotBytes]));
}

/**
 * The node's own overlay address inside an app — the base of its block, held
 * by the mesh tun. Components sit at name-derived slots; the spec gate keeps
 * component names off slot 0 so none can land on the tun's address.
 *
 * @param {string} appUuid the app row's registration uuid
 * @param {string} outpoint the node's canonical outpoint
 * @returns {string} canonical textual IPv6 address
 */
function nodeAddress(appUuid, outpoint) {
  return memberAddress(appUuid, outpoint, 0);
}

/**
 * The translator's own overlay address inside an app on this node — the source
 * of the ICMPv6 errors tayga originates. It sits at the base of its own
 * derived block rather than inside the node's, so it can never land on a
 * member address.
 *
 * @param {string} appUuid the app row's registration uuid
 * @param {string} outpoint the node's canonical outpoint
 * @returns {string} canonical textual IPv6 address
 */
function translatorAddress(appUuid, outpoint) {
  assertAppUuid(appUuid);
  assertOutpoint(outpoint);
  const bytes = Buffer.concat([
    appPrefixBytes(appUuid),
    sha256(TRANSLATOR_DOMAIN, appUuid, outpoint).subarray(0, 6),
    Buffer.alloc(4),
  ]);
  return formatIpv6(bytes);
}

/**
 * A node's stable short id within mesh names and the resolver snapshot:
 * the first 4 bytes of sha256 over the canonical outpoint, in hex.
 *
 * @param {string} outpoint the node's canonical outpoint
 * @returns {string} 8 lowercase hex chars
 */
function nodeId(outpoint) {
  assertOutpoint(outpoint);
  return sha256(outpoint).subarray(0, 4).toString('hex');
}

/**
 * The stable DNS label of one member: `<component>-<nodeid>`, also the
 * container's `FLUX_MESH_SELF`.
 *
 * @param {string} componentName the component's spec name
 * @param {string} outpoint the hosting node's canonical outpoint
 * @returns {string} the member name
 */
function memberName(componentName, outpoint) {
  if (typeof componentName !== 'string' || componentName === '') {
    throw new TypeError('componentName must be a non-empty string');
  }
  return `${componentName}-${nodeId(outpoint)}`;
}

module.exports = {
  canonicalOutpoint,
  formatIpv6,
  appPrefix,
  nodeBlock,
  memberAddress,
  nodeAddress,
  translatorAddress,
  nodeId,
  memberName,
};
