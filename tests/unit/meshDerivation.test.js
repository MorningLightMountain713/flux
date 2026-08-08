const { expect } = require('chai');

const meshDerivation = require('../../ZelBack/src/services/appMesh/meshDerivation');

// The golden vectors pin the derivation forever: every node computes every
// member's address from these functions, and the impersonation detector treats
// a derivation mismatch as a cheat, so a behaviour change here renumbers live
// overlays and turns honest members into apparent impostors. The expected
// values were computed by an independent implementation (python hashlib), not
// by the module under test. If one of these assertions fails, the code is
// wrong — do not update the vector.
//
// The component slot is flux-spec's derivation (meshComponentSlot) — its
// vectors live in flux-spec's own suite; here it is only an input.
const TX1 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const TX2 = '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8';
// mintAppUuid('myblog', TX1) and mintAppUuid('myblog', TX2): the same name
// under two registrations — the pair the uuid keying exists to keep apart.
const UUID1 = '5db6f53acbbd9b38e949307e96601e573bd6437ddec08707e76a33f771b358ea';
const UUID2 = '644922a758ce6edd65e15117b1e4dd3514182d2f852fdcb205ddb3254fad056e';

describe('meshDerivation', () => {
  describe('canonicalOutpoint', () => {
    it('joins txhash and index with a colon', () => {
      expect(meshDerivation.canonicalOutpoint(TX1, 0)).to.equal(`${TX1}:0`);
    });

    it('lowercases the txhash', () => {
      expect(meshDerivation.canonicalOutpoint(TX1.toUpperCase(), 3)).to.equal(`${TX1}:3`);
    });

    it('accepts the daemon string form of outidx and normalises it', () => {
      expect(meshDerivation.canonicalOutpoint(TX1, '07')).to.equal(`${TX1}:7`);
    });

    it('rejects a txhash that is not 64 hex chars', () => {
      expect(() => meshDerivation.canonicalOutpoint('abc123', 0)).to.throw(TypeError);
      expect(() => meshDerivation.canonicalOutpoint(`${TX1}00`, 0)).to.throw(TypeError);
    });

    it('rejects a negative, fractional or non-numeric outidx', () => {
      expect(() => meshDerivation.canonicalOutpoint(TX1, -1)).to.throw(TypeError);
      expect(() => meshDerivation.canonicalOutpoint(TX1, 0.5)).to.throw(TypeError);
      expect(() => meshDerivation.canonicalOutpoint(TX1, '1e3')).to.throw(TypeError);
    });
  });

  describe('appPrefix', () => {
    it('matches the golden vector', () => {
      expect(meshDerivation.appPrefix(UUID1)).to.equal('fdb2:8fa9:3450::/48');
    });

    it('separates two registrations of the same name', () => {
      expect(meshDerivation.appPrefix(UUID2)).to.equal('fd82:31ca:2eb1::/48');
    });

    it('rejects anything but a 64-hex uuid', () => {
      expect(() => meshDerivation.appPrefix('myblog')).to.throw(TypeError);
      expect(() => meshDerivation.appPrefix(UUID1.toUpperCase())).to.throw(TypeError);
      expect(() => meshDerivation.appPrefix(undefined)).to.throw(TypeError);
    });
  });

  describe('nodeBlock', () => {
    it('matches the golden vectors', () => {
      expect(meshDerivation.nodeBlock(UUID1, `${TX1}:0`)).to.equal('fdb2:8fa9:3450:76a8:bd32:a312::/96');
      expect(meshDerivation.nodeBlock(UUID1, `${TX1}:1`)).to.equal('fdb2:8fa9:3450:98e6:a9ff:3df9::/96');
      expect(meshDerivation.nodeBlock(UUID1, `${TX2}:0`)).to.equal('fdb2:8fa9:3450:9d94:6853:4b74::/96');
      expect(meshDerivation.nodeBlock(UUID2, `${TX1}:0`)).to.equal('fd82:31ca:2eb1:da6d:6f91:e55a::/96');
    });

    it('rejects a non-canonical outpoint', () => {
      expect(() => meshDerivation.nodeBlock(UUID1, `${TX1.toUpperCase()}:0`)).to.throw(TypeError);
      expect(() => meshDerivation.nodeBlock(UUID1, TX1)).to.throw(TypeError);
    });
  });

  describe('memberAddress', () => {
    it('matches the golden vectors', () => {
      expect(meshDerivation.memberAddress(UUID1, `${TX1}:0`, 0)).to.equal('fdb2:8fa9:3450:76a8:bd32:a312::');
      expect(meshDerivation.memberAddress(UUID1, `${TX1}:0`, 43)).to.equal('fdb2:8fa9:3450:76a8:bd32:a312:0:2b');
      expect(meshDerivation.memberAddress(UUID1, `${TX1}:0`, 4294967295)).to.equal('fdb2:8fa9:3450:76a8:bd32:a312:ffff:ffff');
      expect(meshDerivation.memberAddress(UUID1, `${TX1}:0`, 191014375)).to.equal('fdb2:8fa9:3450:76a8:bd32:a312:b62:a5e7');
      expect(meshDerivation.memberAddress(UUID1, `${TX2}:0`, 0)).to.equal('fdb2:8fa9:3450:9d94:6853:4b74::');
      expect(meshDerivation.memberAddress(UUID2, `${TX1}:0`, 0)).to.equal('fd82:31ca:2eb1:da6d:6f91:e55a::');
    });

    it('lives inside its own node block and app prefix', () => {
      const address = meshDerivation.memberAddress(UUID1, `${TX1}:0`, 5);
      const block = meshDerivation.nodeBlock(UUID1, `${TX1}:0`);
      const prefix = meshDerivation.appPrefix(UUID1);
      expect(block.startsWith(prefix.replace('::/48', ':'))).to.equal(true);
      expect(address.startsWith(block.replace('::/96', ':'))).to.equal(true);
    });

    it('rejects a slot outside 0..4294967295', () => {
      expect(() => meshDerivation.memberAddress(UUID1, `${TX1}:0`, -1)).to.throw(TypeError);
      expect(() => meshDerivation.memberAddress(UUID1, `${TX1}:0`, 0x100000000)).to.throw(TypeError);
      expect(() => meshDerivation.memberAddress(UUID1, `${TX1}:0`, 1.5)).to.throw(TypeError);
    });
  });

  describe('nodeId', () => {
    it('matches the golden vectors', () => {
      expect(meshDerivation.nodeId(`${TX1}:0`)).to.equal('6f6437c5');
      expect(meshDerivation.nodeId(`${TX1}:1`)).to.equal('57eac747');
      expect(meshDerivation.nodeId(`${TX2}:0`)).to.equal('79d325b0');
    });
  });

  describe('memberName', () => {
    it('joins the component name and node id', () => {
      expect(meshDerivation.memberName('mysql', `${TX1}:0`)).to.equal('mysql-6f6437c5');
    });

    it('rejects an empty component name', () => {
      expect(() => meshDerivation.memberName('', `${TX1}:0`)).to.throw(TypeError);
    });
  });

  describe('formatIpv6', () => {
    const addr = (hex) => meshDerivation.formatIpv6(Buffer.from(hex, 'hex'));

    it('compresses the longest zero run', () => {
      expect(addr('fd000000000000000000000000000001')).to.equal('fd00::1');
    });

    it('compresses the longer run when runs differ', () => {
      expect(addr('fd0000000000000100000000000000ff')).to.equal('fd00:0:0:1::ff');
    });

    it('prefers the leftmost run on a tie', () => {
      expect(addr('fd0000000000000100000000000100ff')).to.equal('fd00::1:0:0:1:ff');
    });

    it('never compresses a single zero hextet', () => {
      expect(addr('fd00000011110000222200003333ffff')).to.equal('fd00:0:1111:0:2222:0:3333:ffff');
    });

    it('compresses a trailing run and strips leading zeros', () => {
      expect(addr('fd5516180a2000000000000000000000')).to.equal('fd55:1618:a20::');
    });

    it('handles the all-zero address', () => {
      expect(addr('00000000000000000000000000000000')).to.equal('::');
    });

    it('rejects anything but a 16-byte Buffer', () => {
      expect(() => meshDerivation.formatIpv6('fd00')).to.throw(TypeError);
      expect(() => meshDerivation.formatIpv6(Buffer.alloc(4))).to.throw(TypeError);
    });
  });
});
