/**
 * Binary encoders for the fluxd ZMQ topics — the write side of
 * ZelBack/src/services/utils/fluxdZmqDecoders.js.
 *
 * Hashes go on the wire in display order, exactly as they are written in an RPC
 * response or a log line: fluxd reverses before publishing, and the decoder does not
 * reverse on read. A stub that reversed here would produce payloads no client can
 * chain onto, so a hash is a plain hex-to-bytes conversion and nothing else.
 *
 * All integers are little-endian uint32 unless stated.
 */

const TIER_BYTES = {
  CUMULUS: 1,
  NIMBUS: 2,
  STRATUS: 3,
};

const STATUS_BYTES = {
  ERROR: 0,
  STARTED: 1,
  DOS_PROTECTION: 2,
  CONFIRMED: 3,
  MISS_CONFIRMED: 4,
  EXPIRED: 5,
};

const TOPICS = ['hashblockheight', 'chainreorg', 'fluxnodelistdelta', 'fluxnodestatus'];

/**
 * Encodes a little-endian uint32.
 * @param {number} value Value.
 * @param {string} what Field name, for the error message.
 * @returns {Buffer} Four bytes.
 */
function uint32(value, what) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xffffffff) {
    throw new Error(`${what} must be a uint32, got ${value}`);
  }
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(number, 0);
  return buf;
}

/**
 * Encodes a byte in the range 0-255.
 * @param {number} value Value.
 * @param {string} what Field name, for the error message.
 * @returns {Buffer} One byte.
 */
function uint8(value, what) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 0xff) {
    throw new Error(`${what} must be a byte, got ${value}`);
  }
  return Buffer.from([number]);
}

/**
 * Encodes a Bitcoin CompactSize varint.
 * @param {number} value Count.
 * @returns {Buffer} One, three, five or nine bytes.
 */
function compactSize(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`compactSize needs a non-negative integer, got ${value}`);
  }
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf.writeUInt8(0xfd, 0);
    buf.writeUInt16LE(value, 1);
    return buf;
  }
  if (value <= 0xffffffff) {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(0xfe, 0);
    buf.writeUInt32LE(value, 1);
    return buf;
  }
  const buf = Buffer.alloc(9);
  buf.writeUInt8(0xff, 0);
  buf.writeBigUInt64LE(BigInt(value), 1);
  return buf;
}

/**
 * Encodes a CompactSize-prefixed byte string.
 * @param {Buffer} buf Bytes.
 * @returns {Buffer} Length prefix followed by the bytes.
 */
function varBytes(buf) {
  return Buffer.concat([compactSize(buf.length), buf]);
}

/**
 * Converts a 32-byte hash from its display hex to wire bytes. No reversal — see the
 * file header.
 * @param {string} hex 64 hex characters.
 * @param {string} what Field name, for the error message.
 * @returns {Buffer} 32 bytes.
 */
function hashBytes(hex, what) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${what} must be a 64-character hex hash, got ${hex}`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Converts a hex string of any length to bytes.
 * @param {string} hex Hex, or an empty string.
 * @param {string} what Field name, for the error message.
 * @returns {Buffer} The bytes.
 */
function hexBytes(hex, what) {
  const value = hex ?? '';
  if (typeof value !== 'string' || (value.length % 2) !== 0 || (value.length && !/^[0-9a-fA-F]+$/.test(value))) {
    throw new Error(`${what} must be an even-length hex string, got ${hex}`);
  }
  return Buffer.from(value, 'hex');
}

/**
 * Resolves a tier given either as a name or as its wire byte.
 * @param {string|number} tier Tier.
 * @returns {number} Wire byte.
 */
function tierByte(tier) {
  if (typeof tier === 'number') return tier;
  const byte = TIER_BYTES[String(tier).toUpperCase()];
  if (byte === undefined) throw new Error(`Unknown tier ${tier}`);
  return byte;
}

/**
 * Resolves a status given either as a name or as its wire byte.
 * @param {string|number} status Status.
 * @returns {number} Wire byte.
 */
function statusByte(status) {
  if (typeof status === 'number') return status;
  const byte = STATUS_BYTES[String(status).toUpperCase()];
  if (byte === undefined) throw new Error(`Unknown status ${status}`);
  return byte;
}

/**
 * Encodes a collateral outpoint.
 * @param {{txhash: string, outidx: number|string}} outpoint Outpoint. `txid`/`index`
 *   are accepted as aliases, so a decoded outpoint can be re-encoded unchanged.
 * @returns {Buffer} 36 bytes.
 */
function encodeOutpoint(outpoint) {
  const txhash = outpoint.txhash ?? outpoint.txid;
  const index = outpoint.outidx ?? outpoint.index;
  return Buffer.concat([
    hashBytes(txhash, 'outpoint txhash'),
    uint32(index, 'outpoint index'),
  ]);
}

/**
 * Encodes one node record, as carried in a delta's added and updated sections.
 * @param {object} node Node fields; tier and status take a name or a byte.
 * @returns {Buffer} The record.
 */
function encodeNodeRecord(node) {
  return Buffer.concat([
    encodeOutpoint(node),
    varBytes(hexBytes(node.collateralPubkey, 'collateralPubkey')),
    varBytes(hexBytes(node.pubkey, 'pubkey')),
    uint32(node.confirmedHeight, 'confirmedHeight'),
    uint32(node.lastPaidHeight, 'lastPaidHeight'),
    uint8(tierByte(node.tier), 'tier'),
    uint8(statusByte(node.status), 'status'),
    varBytes(Buffer.from(node.ip ?? '', 'utf8')),
  ]);
}

/**
 * Encodes a CompactSize-counted section.
 * @param {Array<object>} items Elements.
 * @param {(item: object) => Buffer} encodeElement Element encoder.
 * @returns {Buffer} Count followed by the elements.
 */
function encodeSection(items, encodeElement) {
  const list = items ?? [];
  return Buffer.concat([compactSize(list.length), ...list.map(encodeElement)]);
}

/**
 * Encodes a `hashblockheight` payload.
 * @param {{hash: string, height: number}} fields Tip hash in display order and height.
 * @returns {Buffer} 36 bytes.
 */
function encodeHashBlockHeight(fields) {
  return Buffer.concat([
    hashBytes(fields.hash, 'block hash'),
    uint32(fields.height, 'block height'),
  ]);
}

/**
 * Encodes a `chainreorg` payload. Depth is the decoder's arithmetic, not a field.
 * @param {{oldTip: object, newTip: object, fork: object}} fields Each {hash, height}.
 * @returns {Buffer} 108 bytes.
 */
function encodeChainReorg(fields) {
  return Buffer.concat([
    hashBytes(fields.oldTip.hash, 'oldTip hash'),
    uint32(fields.oldTip.height, 'oldTip height'),
    hashBytes(fields.newTip.hash, 'newTip hash'),
    uint32(fields.newTip.height, 'newTip height'),
    hashBytes(fields.fork.hash, 'fork hash'),
    uint32(fields.fork.height, 'fork height'),
  ]);
}

/**
 * Encodes a `fluxnodelistdelta` payload.
 * @param {object} fields Transition endpoints, the reorg flag and the three sections.
 * @returns {Buffer} 73 header bytes followed by added, removed and updated.
 */
function encodeFluxnodeListDelta(fields) {
  return Buffer.concat([
    uint32(fields.fromHeight, 'fromHeight'),
    uint32(fields.toHeight, 'toHeight'),
    hashBytes(fields.fromHash, 'fromHash'),
    hashBytes(fields.toHash, 'toHash'),
    uint8(fields.isReorg ? 0x01 : 0x00, 'flags'),
    encodeSection(fields.added, encodeNodeRecord),
    encodeSection(fields.removed, encodeOutpoint),
    encodeSection(fields.updated, encodeNodeRecord),
  ]);
}

/**
 * Encodes a `fluxnodestatus` payload — one node's own deterministic-list state.
 * @param {object} fields Status fields; tier and status take a name or a byte.
 * @returns {Buffer} 54 bytes plus the ip.
 */
function encodeFluxnodeStatus(fields) {
  return Buffer.concat([
    uint32(fields.blockHeight, 'blockHeight'),
    uint8(statusByte(fields.status), 'status'),
    uint8(tierByte(fields.tier), 'tier'),
    uint32(fields.confirmedHeight, 'confirmedHeight'),
    uint32(fields.lastConfirmedHeight, 'lastConfirmedHeight'),
    uint32(fields.lastPaidHeight, 'lastPaidHeight'),
    hashBytes(fields.txhash, 'txhash'),
    uint32(fields.outidx, 'outidx'),
    varBytes(Buffer.from(fields.ip ?? '', 'utf8')),
  ]);
}

const ENCODERS = {
  hashblockheight: encodeHashBlockHeight,
  chainreorg: encodeChainReorg,
  fluxnodelistdelta: encodeFluxnodeListDelta,
  fluxnodestatus: encodeFluxnodeStatus,
};

/**
 * Encodes a payload for the named topic.
 * @param {string} topic Topic name.
 * @param {object} fields Topic fields.
 * @returns {Buffer} The payload frame.
 */
function encode(topic, fields) {
  const encoder = ENCODERS[topic];
  if (!encoder) throw new Error(`No encoder for topic ${topic}`);
  return encoder(fields);
}

module.exports = {
  STATUS_BYTES,
  TIER_BYTES,
  TOPICS,
  compactSize,
  encode,
  encodeChainReorg,
  encodeFluxnodeListDelta,
  encodeFluxnodeStatus,
  encodeHashBlockHeight,
  encodeNodeRecord,
  encodeOutpoint,
};
