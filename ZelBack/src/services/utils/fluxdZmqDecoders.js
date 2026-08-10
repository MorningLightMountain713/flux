'use strict';

/**
 * Binary decoders for the fluxd ZMQ topics.
 *
 * Every 32-byte hash on the wire is already in display byte order — fluxd reverses
 * before publishing (`zmqpublishnotifier.cpp:223`, `:249-263`, `:373-382`). Reading a
 * hash is therefore a plain hex conversion. Reversing here is the single most common
 * mistake in clients written against these topics; do not add one.
 *
 * All integers are little-endian uint32 unless stated.
 */

const TIERS = {
  1: 'CUMULUS',
  2: 'NIMBUS',
  3: 'STRATUS',
};

const NODE_STATUSES = {
  0: 'ERROR',
  1: 'STARTED',
  2: 'DOS_PROTECTION',
  3: 'CONFIRMED',
  4: 'MISS_CONFIRMED',
  5: 'EXPIRED',
};

const HASH_BLOCK_HEIGHT_BYTES = 36;
const CHAIN_REORG_BYTES = 108;
const DELTA_HEADER_BYTES = 73;
const FLUXNODE_STATUS_MIN_BYTES = 54;
const OUTPOINT_BYTES = 36;

/**
 * Asserts a buffer holds at least `needed` more bytes from `offset`.
 * @param {Buffer} buf Payload.
 * @param {number} offset Read position.
 * @param {number} needed Bytes required.
 * @param {string} what Field name, for the error message.
 */
function requireBytes(buf, offset, needed, what) {
  if (offset + needed > buf.length) {
    throw new Error(`Truncated payload reading ${what}: need ${needed} bytes at ${offset}, have ${buf.length - offset}`);
  }
}

/**
 * Reads a Bitcoin CompactSize varint.
 * @param {Buffer} buf Payload.
 * @param {number} offset Read position.
 * @returns {{value: number, offset: number}} Value and the position after it.
 */
function readCompactSize(buf, offset) {
  requireBytes(buf, offset, 1, 'compactSize prefix');
  const prefix = buf.readUInt8(offset);

  if (prefix < 0xfd) return { value: prefix, offset: offset + 1 };

  if (prefix === 0xfd) {
    requireBytes(buf, offset + 1, 2, 'compactSize uint16');
    return { value: buf.readUInt16LE(offset + 1), offset: offset + 3 };
  }

  if (prefix === 0xfe) {
    requireBytes(buf, offset + 1, 4, 'compactSize uint32');
    return { value: buf.readUInt32LE(offset + 1), offset: offset + 5 };
  }

  requireBytes(buf, offset + 1, 8, 'compactSize uint64');
  const value = buf.readBigUInt64LE(offset + 1);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`compactSize ${value} exceeds safe integer range`);
  }
  return { value: Number(value), offset: offset + 9 };
}

/**
 * Reads a CompactSize-prefixed byte string.
 * @param {Buffer} buf Payload.
 * @param {number} offset Read position.
 * @param {string} what Field name, for the error message.
 * @returns {{value: Buffer, offset: number}} Bytes and the position after them.
 */
function readVarBytes(buf, offset, what) {
  const { value: length, offset: dataStart } = readCompactSize(buf, offset);
  requireBytes(buf, dataStart, length, what);
  return {
    value: buf.subarray(dataStart, dataStart + length),
    offset: dataStart + length,
  };
}

/**
 * Reads a collateral outpoint. The txid is on the wire in display order already.
 * @param {Buffer} buf Payload.
 * @param {number} offset Read position.
 * @returns {{value: {txid: string, index: number}, offset: number}} Outpoint and position after it.
 */
function readOutpoint(buf, offset) {
  requireBytes(buf, offset, OUTPOINT_BYTES, 'outpoint');
  return {
    value: {
      txid: buf.subarray(offset, offset + 32).toString('hex'),
      index: buf.readUInt32LE(offset + 32),
    },
    offset: offset + OUTPOINT_BYTES,
  };
}

/**
 * Reads one full node record from a delta's added or updated section.
 * @param {Buffer} buf Payload.
 * @param {number} offset Read position.
 * @returns {{value: object, offset: number}} Node and the position after it.
 */
function readNodeRecord(buf, offset) {
  const outpoint = readOutpoint(buf, offset);
  const collateralPubkey = readVarBytes(buf, outpoint.offset, 'collateralPubkey');
  const pubkey = readVarBytes(buf, collateralPubkey.offset, 'pubkey');

  let cursor = pubkey.offset;
  requireBytes(buf, cursor, 10, 'node record body');

  const confirmedHeight = buf.readUInt32LE(cursor);
  const lastPaidHeight = buf.readUInt32LE(cursor + 4);
  const tierByte = buf.readUInt8(cursor + 8);
  const statusByte = buf.readUInt8(cursor + 9);
  cursor += 10;

  const ip = readVarBytes(buf, cursor, 'node ip');

  return {
    value: {
      txhash: outpoint.value.txid,
      outidx: outpoint.value.index,
      collateralPubkey: collateralPubkey.value.toString('hex'),
      pubkey: pubkey.value.toString('hex'),
      confirmedHeight,
      lastPaidHeight,
      tier: TIERS[tierByte] || String(tierByte),
      status: NODE_STATUSES[statusByte] || String(statusByte),
      ip: ip.value.toString('utf8'),
    },
    offset: ip.offset,
  };
}

/**
 * Reads a CompactSize-counted section using the supplied element reader.
 * @param {Buffer} buf Payload.
 * @param {number} offset Read position.
 * @param {(b: Buffer, o: number) => {value: any, offset: number}} readElement Element reader.
 * @returns {{value: Array, offset: number}} Elements and the position after them.
 */
function readSection(buf, offset, readElement) {
  const { value: count, offset: start } = readCompactSize(buf, offset);
  const items = [];
  let cursor = start;

  for (let i = 0; i < count; i += 1) {
    const element = readElement(buf, cursor);
    items.push(element.value);
    cursor = element.offset;
  }

  return { value: items, offset: cursor };
}

/**
 * Decodes a `hashblockheight` payload.
 * @param {Buffer} payload 36 bytes.
 * @returns {{hash: string, height: number}} Block hash in display order and its height.
 */
function decodeHashBlockHeight(payload) {
  if (payload.length !== HASH_BLOCK_HEIGHT_BYTES) {
    throw new Error(`hashblockheight must be ${HASH_BLOCK_HEIGHT_BYTES} bytes, got ${payload.length}`);
  }

  return {
    hash: payload.subarray(0, 32).toString('hex'),
    height: payload.readUInt32LE(32),
  };
}

/**
 * Decodes a `chainreorg` payload.
 * @param {Buffer} payload 108 bytes.
 * @returns {object} Old tip, new tip, fork point and the reorg depth.
 */
function decodeChainReorg(payload) {
  if (payload.length !== CHAIN_REORG_BYTES) {
    throw new Error(`chainreorg must be ${CHAIN_REORG_BYTES} bytes, got ${payload.length}`);
  }

  const oldTip = {
    hash: payload.subarray(0, 32).toString('hex'),
    height: payload.readUInt32LE(32),
  };
  const newTip = {
    hash: payload.subarray(36, 68).toString('hex'),
    height: payload.readUInt32LE(68),
  };
  const fork = {
    hash: payload.subarray(72, 104).toString('hex'),
    height: payload.readUInt32LE(104),
  };

  return { oldTip, newTip, fork, depth: oldTip.height - fork.height };
}

/**
 * Decodes a `fluxnodelistdelta` payload.
 *
 * The transition is identified by both endpoints. `toHeight` may be lower than or equal
 * to `fromHeight` after a reorg, and the same height may recur with a different hash —
 * consumers must key on hash, not height.
 * @param {Buffer} payload 73 bytes of header plus three counted sections.
 * @returns {object} Transition endpoints, the reorg flag, and added/removed/updated.
 */
function decodeFluxnodeListDelta(payload) {
  if (payload.length < DELTA_HEADER_BYTES) {
    throw new Error(`fluxnodelistdelta needs at least ${DELTA_HEADER_BYTES} header bytes, got ${payload.length}`);
  }

  const fromHeight = payload.readUInt32LE(0);
  const toHeight = payload.readUInt32LE(4);
  const fromHash = payload.subarray(8, 40).toString('hex');
  const toHash = payload.subarray(40, 72).toString('hex');
  const flags = payload.readUInt8(72);

  const added = readSection(payload, DELTA_HEADER_BYTES, readNodeRecord);
  const removed = readSection(payload, added.offset, readOutpoint);
  const updated = readSection(payload, removed.offset, readNodeRecord);

  return {
    fromHeight,
    toHeight,
    fromHash,
    toHash,
    isReorg: Boolean(flags & 0x01),
    added: added.value,
    removed: removed.value,
    updated: updated.value,
  };
}

/**
 * Decodes a `fluxnodestatus` payload — this node's own deterministic-list state.
 * @param {Buffer} payload 54 bytes or more.
 * @returns {object} Block height, status, tier, confirmation heights, collateral and ip.
 */
function decodeFluxnodeStatus(payload) {
  if (payload.length < FLUXNODE_STATUS_MIN_BYTES) {
    throw new Error(`fluxnodestatus needs at least ${FLUXNODE_STATUS_MIN_BYTES} bytes, got ${payload.length}`);
  }

  const statusByte = payload.readUInt8(4);
  const tierByte = payload.readUInt8(5);
  const ip = readVarBytes(payload, FLUXNODE_STATUS_MIN_BYTES, 'status ip');

  return {
    blockHeight: payload.readUInt32LE(0),
    status: NODE_STATUSES[statusByte] || String(statusByte),
    tier: TIERS[tierByte] || String(tierByte),
    confirmedHeight: payload.readUInt32LE(6),
    lastConfirmedHeight: payload.readUInt32LE(10),
    lastPaidHeight: payload.readUInt32LE(14),
    txhash: payload.subarray(18, 50).toString('hex'),
    outidx: payload.readUInt32LE(50),
    ip: ip.value.toString('utf8'),
  };
}

const DECODERS = {
  hashblockheight: decodeHashBlockHeight,
  chainreorg: decodeChainReorg,
  fluxnodelistdelta: decodeFluxnodeListDelta,
  fluxnodestatus: decodeFluxnodeStatus,
};

/**
 * Decodes a payload for the named topic.
 * @param {string} topic Topic name.
 * @param {Buffer} payload Raw payload frame.
 * @returns {object} The decoded message.
 */
function decode(topic, payload) {
  const decoder = DECODERS[topic];
  if (!decoder) throw new Error(`No decoder for topic ${topic}`);
  return decoder(payload);
}

module.exports = {
  decode,
  decodeChainReorg,
  decodeFluxnodeListDelta,
  decodeFluxnodeStatus,
  decodeHashBlockHeight,
  readCompactSize,
  NODE_STATUSES,
  TIERS,
};
