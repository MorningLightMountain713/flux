'use strict';

const { expect } = require('chai');

const decoders = require('../../ZelBack/src/services/utils/fluxdZmqDecoders');

/**
 * Mirrors fluxd's CDataStream serialisation so fixtures are built the way the daemon
 * builds them (`src/zmq/zmqpublishnotifier.cpp`). Kept deliberately independent of the
 * decoder so a shared misreading cannot pass unnoticed.
 */
function compactSize(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b.writeUInt8(0xfd, 0);
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b.writeUInt8(0xfe, 0);
  b.writeUInt32LE(n, 1);
  return b;
}

function varBytes(buf) {
  return Buffer.concat([compactSize(buf.length), buf]);
}

function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/** A 32-byte hash as it appears on the wire: display order, no reversal. */
function hashBytes(seed) {
  return Buffer.alloc(32, seed);
}

function outpointBytes(seed, index) {
  return Buffer.concat([hashBytes(seed), uint32(index)]);
}

function nodeRecordBytes(overrides = {}) {
  const o = {
    seed: 0x11,
    index: 1,
    collateralPubkey: Buffer.alloc(33, 0xaa),
    pubkey: Buffer.alloc(33, 0xbb),
    confirmedHeight: 100,
    lastPaidHeight: 200,
    tier: 1,
    status: 3,
    ip: '10.0.0.1:16127',
    ...overrides,
  };

  return Buffer.concat([
    outpointBytes(o.seed, o.index),
    varBytes(o.collateralPubkey),
    varBytes(o.pubkey),
    uint32(o.confirmedHeight),
    uint32(o.lastPaidHeight),
    Buffer.from([o.tier, o.status]),
    varBytes(Buffer.from(o.ip, 'utf8')),
  ]);
}

function deltaBytes({
  fromHeight = 1000,
  toHeight = 1001,
  fromSeed = 0x01,
  toSeed = 0x02,
  flags = 0x00,
  added = [],
  removed = [],
  updated = [],
} = {}) {
  return Buffer.concat([
    uint32(fromHeight),
    uint32(toHeight),
    hashBytes(fromSeed),
    hashBytes(toSeed),
    Buffer.from([flags]),
    compactSize(added.length),
    ...added,
    compactSize(removed.length),
    ...removed,
    compactSize(updated.length),
    ...updated,
  ]);
}

describe('fluxdZmqDecoders tests', () => {
  describe('readCompactSize tests', () => {
    it('should read a single byte value', () => {
      expect(decoders.readCompactSize(Buffer.from([0x42]), 0)).to.eql({ value: 0x42, offset: 1 });
    });

    it('should read a 0xfd prefixed uint16', () => {
      const buf = Buffer.from([0xfd, 0x34, 0x12]);
      expect(decoders.readCompactSize(buf, 0)).to.eql({ value: 0x1234, offset: 3 });
    });

    it('should read a 0xfe prefixed uint32', () => {
      const buf = Buffer.from([0xfe, 0x78, 0x56, 0x34, 0x12]);
      expect(decoders.readCompactSize(buf, 0)).to.eql({ value: 0x12345678, offset: 5 });
    });

    it('should throw rather than lose precision above the safe integer range', () => {
      const buf = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(8, 0xff)]);
      expect(() => decoders.readCompactSize(buf, 0)).to.throw('exceeds safe integer range');
    });

    it('should throw on a truncated prefix', () => {
      expect(() => decoders.readCompactSize(Buffer.from([0xfd]), 0)).to.throw('Truncated payload');
    });
  });

  describe('decodeHashBlockHeight tests', () => {
    it('should decode hash and height without reversing the hash', () => {
      const hash = Buffer.from('ab'.repeat(32), 'hex');
      const payload = Buffer.concat([hash, uint32(2837899)]);

      const result = decoders.decodeHashBlockHeight(payload);

      expect(result.height).to.equal(2837899);
      expect(result.hash).to.equal('ab'.repeat(32));
    });

    it('should preserve wire byte order for an asymmetric hash', () => {
      const hex = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
      const payload = Buffer.concat([Buffer.from(hex, 'hex'), uint32(1)]);

      expect(decoders.decodeHashBlockHeight(payload).hash).to.equal(hex);
    });

    it('should reject a payload that is not 36 bytes', () => {
      expect(() => decoders.decodeHashBlockHeight(Buffer.alloc(35))).to.throw('must be 36 bytes');
    });
  });

  describe('decodeChainReorg tests', () => {
    it('should decode all three tips and derive depth', () => {
      const payload = Buffer.concat([
        hashBytes(0x0a), uint32(2000),
        hashBytes(0x0b), uint32(2001),
        hashBytes(0x0c), uint32(1997),
      ]);

      const result = decoders.decodeChainReorg(payload);

      expect(result.oldTip).to.eql({ hash: '0a'.repeat(32), height: 2000 });
      expect(result.newTip).to.eql({ hash: '0b'.repeat(32), height: 2001 });
      expect(result.fork).to.eql({ hash: '0c'.repeat(32), height: 1997 });
      expect(result.depth).to.equal(3);
    });

    it('should reject a payload that is not 108 bytes', () => {
      expect(() => decoders.decodeChainReorg(Buffer.alloc(76))).to.throw('must be 108 bytes');
    });
  });

  describe('decodeFluxnodeListDelta tests', () => {
    it('should decode an empty delta', () => {
      const result = decoders.decodeFluxnodeListDelta(deltaBytes());

      expect(result.fromHeight).to.equal(1000);
      expect(result.toHeight).to.equal(1001);
      expect(result.fromHash).to.equal('01'.repeat(32));
      expect(result.toHash).to.equal('02'.repeat(32));
      expect(result.isReorg).to.equal(false);
      expect(result.added).to.eql([]);
      expect(result.removed).to.eql([]);
      expect(result.updated).to.eql([]);
    });

    it('should decode added, removed and updated sections in wire order', () => {
      const payload = deltaBytes({
        added: [nodeRecordBytes({ seed: 0x11, index: 0, ip: '1.1.1.1:16127' })],
        removed: [outpointBytes(0x22, 7)],
        updated: [
          nodeRecordBytes({ seed: 0x33, index: 2, tier: 3, status: 5, ip: '3.3.3.3:16127' }),
          nodeRecordBytes({ seed: 0x44, index: 3, tier: 2, ip: '4.4.4.4:16127' }),
        ],
      });

      const result = decoders.decodeFluxnodeListDelta(payload);

      expect(result.added).to.have.length(1);
      expect(result.added[0].txhash).to.equal('11'.repeat(32));
      expect(result.added[0].outidx).to.equal(0);
      expect(result.added[0].tier).to.equal('CUMULUS');
      expect(result.added[0].status).to.equal('CONFIRMED');
      expect(result.added[0].ip).to.equal('1.1.1.1:16127');

      expect(result.removed).to.eql([{ txid: '22'.repeat(32), index: 7 }]);

      expect(result.updated).to.have.length(2);
      expect(result.updated[0].tier).to.equal('STRATUS');
      expect(result.updated[0].status).to.equal('EXPIRED');
      expect(result.updated[1].tier).to.equal('NIMBUS');
      expect(result.updated[1].ip).to.equal('4.4.4.4:16127');
    });

    it('should carry an outidx of zero rather than dropping the node', () => {
      const payload = deltaBytes({ added: [nodeRecordBytes({ index: 0 })] });

      expect(decoders.decodeFluxnodeListDelta(payload).added[0].outidx).to.equal(0);
    });

    it('should set isReorg from bit 0 of the flags byte', () => {
      expect(decoders.decodeFluxnodeListDelta(deltaBytes({ flags: 0x01 })).isReorg).to.equal(true);
    });

    it('should accept a transition where the height goes backwards', () => {
      const result = decoders.decodeFluxnodeListDelta(
        deltaBytes({ fromHeight: 2000, toHeight: 1998, flags: 0x01 }),
      );

      expect(result.fromHeight).to.equal(2000);
      expect(result.toHeight).to.equal(1998);
    });

    it('should accept the same height with a different hash', () => {
      const result = decoders.decodeFluxnodeListDelta(
        deltaBytes({
          fromHeight: 2000, toHeight: 2000, fromSeed: 0xaa, toSeed: 0xbb, flags: 0x01,
        }),
      );

      expect(result.toHeight).to.equal(result.fromHeight);
      expect(result.toHash).to.not.equal(result.fromHash);
    });

    it('should decode a section count that needs a 0xfd prefix', () => {
      const added = Array.from({ length: 300 }, (unused, i) => nodeRecordBytes({ index: i }));

      const result = decoders.decodeFluxnodeListDelta(deltaBytes({ added }));

      expect(result.added).to.have.length(300);
      expect(result.added[299].outidx).to.equal(299);
    });

    it('should reject a header shorter than 73 bytes', () => {
      expect(() => decoders.decodeFluxnodeListDelta(Buffer.alloc(72))).to.throw('at least 73 header bytes');
    });

    it('should throw rather than return partial data when a section is truncated', () => {
      const full = deltaBytes({ added: [nodeRecordBytes()] });

      expect(() => decoders.decodeFluxnodeListDelta(full.subarray(0, full.length - 4))).to.throw('Truncated payload');
    });
  });

  describe('decodeFluxnodeStatus tests', () => {
    function statusBytes({
      blockHeight = 2837899,
      status = 3,
      tier = 2,
      confirmedHeight = 100,
      lastConfirmedHeight = 150,
      lastPaidHeight = 200,
      seed = 0x55,
      outidx = 4,
      ip = '5.5.5.5:16127',
    } = {}) {
      return Buffer.concat([
        uint32(blockHeight),
        Buffer.from([status, tier]),
        uint32(confirmedHeight),
        uint32(lastConfirmedHeight),
        uint32(lastPaidHeight),
        hashBytes(seed),
        uint32(outidx),
        varBytes(Buffer.from(ip, 'utf8')),
      ]);
    }

    it('should decode every field at its wire offset', () => {
      const result = decoders.decodeFluxnodeStatus(statusBytes());

      expect(result).to.eql({
        blockHeight: 2837899,
        status: 'CONFIRMED',
        tier: 'NIMBUS',
        confirmedHeight: 100,
        lastConfirmedHeight: 150,
        lastPaidHeight: 200,
        txhash: '55'.repeat(32),
        outidx: 4,
        ip: '5.5.5.5:16127',
      });
    });

    it('should decode an outidx of zero', () => {
      expect(decoders.decodeFluxnodeStatus(statusBytes({ outidx: 0 })).outidx).to.equal(0);
    });

    it('should decode each status in the enum', () => {
      const seen = [0, 1, 2, 3, 4, 5].map(
        (s) => decoders.decodeFluxnodeStatus(statusBytes({ status: s })).status,
      );

      expect(seen).to.eql(['ERROR', 'STARTED', 'DOS_PROTECTION', 'CONFIRMED', 'MISS_CONFIRMED', 'EXPIRED']);
    });

    it('should surface an unknown status as its numeric value', () => {
      expect(decoders.decodeFluxnodeStatus(statusBytes({ status: 9 })).status).to.equal('9');
    });

    it('should reject a payload shorter than the fixed prefix', () => {
      expect(() => decoders.decodeFluxnodeStatus(Buffer.alloc(53))).to.throw('at least 54 bytes');
    });
  });

  describe('decode dispatch tests', () => {
    it('should dispatch on topic name', () => {
      const payload = Buffer.concat([hashBytes(0x07), uint32(42)]);

      expect(decoders.decode('hashblockheight', payload)).to.eql({ hash: '07'.repeat(32), height: 42 });
    });

    it('should throw for an unknown topic', () => {
      expect(() => decoders.decode('rawblock', Buffer.alloc(0))).to.throw('No decoder for topic rawblock');
    });
  });
});
