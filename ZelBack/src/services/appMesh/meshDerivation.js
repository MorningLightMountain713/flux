const crypto = require('crypto');

// Every value here is derived, never allocated: all nodes hosting an app
// compute identical prefixes, addresses and names from inputs they already
// share (the spec's app name, the hosting set's outpoints, the compose
// ordering), so nothing needs to be agreed, published or stored. Addresses are
// permanent for the life of a (node, app) pairing — the impersonation detector
// treats any disagreement between a claimed address and this derivation as a
// cheat, so these functions must never change behaviour for existing inputs.
// The golden vectors in tests/unit/meshDerivation.test.js pin them.
//
// Address layout (DESIGN §5.2), 128 bits:
//   fd (8) | sha256("flux-mesh-app" ‖ appHash)[0..5] (40)   → the /48 app prefix
//          | sha256("flux-mesh-node" ‖ appHash ‖ outpoint)[0..8] (64)  → node block
//          | componentIndex, big-endian (16)
//
// appHash is sha256 over the spec's name bytes, verbatim. The name is the one
// identifier every node already holds for a mesh app — the voucher, broadcast
// and accept path are all name-keyed — and a same-name re-registration
// inheriting a dead app's prefix is harmless because apps never share an
// overlay: two apps using the same addresses is explicitly tolerated
// (DESIGN §5.1), so the prefix carries no authority. Identity lives in the
// certificates and vouchers, never in the address.
const APP_PREFIX_DOMAIN = 'flux-mesh-app';
const NODE_BLOCK_DOMAIN = 'flux-mesh-node';

const OUTPOINT_RE = /^[0-9a-f]{64}:\d+$/;

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  parts.forEach((part) => hash.update(part));
  return hash.digest();
}

function assertAppName(appName) {
  if (typeof appName !== 'string' || appName === '') {
    throw new TypeError('appName must be a non-empty string');
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

function appPrefixBytes(appName) {
  const appHash = sha256(Buffer.from(appName, 'utf8'));
  return Buffer.concat([Buffer.from([0xfd]), sha256(APP_PREFIX_DOMAIN, appHash).subarray(0, 5)]);
}

function nodeBlockBytes(appName, outpoint) {
  const appHash = sha256(Buffer.from(appName, 'utf8'));
  return sha256(NODE_BLOCK_DOMAIN, appHash, outpoint).subarray(0, 8);
}

/**
 * The app's overlay prefix, identical on every node hosting it.
 *
 * @param {string} appName the spec's app name, verbatim
 * @returns {string} `<prefix>/48` in canonical form
 */
function appPrefix(appName) {
  assertAppName(appName);
  return `${formatIpv6(Buffer.concat([appPrefixBytes(appName), Buffer.alloc(10)]))}/48`;
}

/**
 * One node's address block within an app's overlay — what the node's host
 * certificate carries as `unsafeNetworks`.
 *
 * @param {string} appName the spec's app name, verbatim
 * @param {string} outpoint the node's canonical outpoint
 * @returns {string} `<block>/112` in canonical form
 */
function nodeBlock(appName, outpoint) {
  assertAppName(appName);
  assertOutpoint(outpoint);
  const bytes = Buffer.concat([appPrefixBytes(appName), nodeBlockBytes(appName, outpoint), Buffer.alloc(2)]);
  return `${formatIpv6(bytes)}/112`;
}

/**
 * The overlay address of one component instance on one node.
 *
 * @param {string} appName the spec's app name, verbatim
 * @param {string} outpoint the hosting node's canonical outpoint
 * @param {number} componentIndex the component's position in the spec's compose ordering
 * @returns {string} canonical textual IPv6 address
 */
function memberAddress(appName, outpoint, componentIndex) {
  assertAppName(appName);
  assertOutpoint(outpoint);
  if (!Number.isInteger(componentIndex) || componentIndex < 0 || componentIndex > 0xffff) {
    throw new TypeError('componentIndex must be an integer in 0..65535');
  }
  const index = Buffer.alloc(2);
  index.writeUInt16BE(componentIndex);
  return formatIpv6(Buffer.concat([appPrefixBytes(appName), nodeBlockBytes(appName, outpoint), index]));
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
 * The stable DNS label of one member: `<component>-<nodeid>` (DESIGN §8.2),
 * also the container's `FLUX_MESH_SELF`.
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

/**
 * A component's position in the canonical spec ordering — the compose array
 * as registered. The position is derived by every node from the same spec,
 * which is why it needs no publishing.
 *
 * @param {string[]} componentNames the spec's compose component names, in spec order
 * @param {string} componentName the component to locate
 * @returns {number} the component's index
 */
function componentIndexOf(componentNames, componentName) {
  if (!Array.isArray(componentNames)) {
    throw new TypeError('componentNames must be an array');
  }
  const matches = componentNames.reduce((found, name, index) => {
    if (name === componentName) found.push(index);
    return found;
  }, []);
  if (matches.length === 0) {
    throw new RangeError(`component "${componentName}" is not in the spec`);
  }
  if (matches.length > 1) {
    throw new RangeError(`component "${componentName}" appears ${matches.length} times in the spec`);
  }
  return matches[0];
}

module.exports = {
  canonicalOutpoint,
  formatIpv6,
  appPrefix,
  nodeBlock,
  memberAddress,
  nodeId,
  memberName,
  componentIndexOf,
};
