const { expect } = require('chai');

const meshDerivation = require('../../ZelBack/src/services/appMesh/meshDerivation');

// The golden vectors pin the derivation forever: every node computes every
// member's address from these functions, and the impersonation detector treats
// a derivation mismatch as a cheat, so a behaviour change here renumbers live
// overlays and turns honest members into apparent impostors. The expected
// values were computed by an independent implementation (python hashlib), not
// by the module under test. If one of these assertions fails, the code is
// wrong — do not update the vector.
const TX1 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const TX2 = '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8';

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
      expect(meshDerivation.appPrefix('myblog')).to.equal('fd55:1618:a920::/48');
    });

    it('is case-sensitive over the spec name bytes', () => {
      expect(meshDerivation.appPrefix('MyBlog')).to.equal('fde2:d65a:dce9::/48');
    });

    it('rejects an empty or non-string name', () => {
      expect(() => meshDerivation.appPrefix('')).to.throw(TypeError);
      expect(() => meshDerivation.appPrefix(undefined)).to.throw(TypeError);
    });
  });

  describe('nodeBlock', () => {
    it('matches the golden vectors', () => {
      expect(meshDerivation.nodeBlock('myblog', `${TX1}:0`)).to.equal('fd55:1618:a920:bae8:775c:9ea9:de69:0/112');
      expect(meshDerivation.nodeBlock('myblog', `${TX1}:1`)).to.equal('fd55:1618:a920:e5fe:6325:565f:28:0/112');
      expect(meshDerivation.nodeBlock('myblog', `${TX2}:0`)).to.equal('fd55:1618:a920:6c3a:abbf:632a:3a69:0/112');
      expect(meshDerivation.nodeBlock('MyBlog', `${TX1}:0`)).to.equal('fde2:d65a:dce9:abfc:fe13:312e:9d6c:0/112');
    });

    it('rejects a non-canonical outpoint', () => {
      expect(() => meshDerivation.nodeBlock('myblog', `${TX1.toUpperCase()}:0`)).to.throw(TypeError);
      expect(() => meshDerivation.nodeBlock('myblog', TX1)).to.throw(TypeError);
    });
  });

  describe('memberAddress', () => {
    it('matches the golden vectors', () => {
      expect(meshDerivation.memberAddress('myblog', `${TX1}:0`, 0)).to.equal('fd55:1618:a920:bae8:775c:9ea9:de69:0');
      expect(meshDerivation.memberAddress('myblog', `${TX1}:0`, 1)).to.equal('fd55:1618:a920:bae8:775c:9ea9:de69:1');
      expect(meshDerivation.memberAddress('myblog', `${TX1}:0`, 9)).to.equal('fd55:1618:a920:bae8:775c:9ea9:de69:9');
      expect(meshDerivation.memberAddress('myblog', `${TX1}:1`, 0)).to.equal('fd55:1618:a920:e5fe:6325:565f:28:0');
      expect(meshDerivation.memberAddress('myblog', `${TX2}:0`, 0)).to.equal('fd55:1618:a920:6c3a:abbf:632a:3a69:0');
      expect(meshDerivation.memberAddress('MyBlog', `${TX1}:0`, 0)).to.equal('fde2:d65a:dce9:abfc:fe13:312e:9d6c:0');
    });

    it('lives inside its own node block and app prefix', () => {
      const address = meshDerivation.memberAddress('myblog', `${TX1}:0`, 5);
      const block = meshDerivation.nodeBlock('myblog', `${TX1}:0`);
      const prefix = meshDerivation.appPrefix('myblog');
      expect(block.startsWith(prefix.replace('::/48', ':'))).to.equal(true);
      expect(address.startsWith(block.replace(':0/112', ':'))).to.equal(true);
    });

    it('rejects a component index outside 0..65535', () => {
      expect(() => meshDerivation.memberAddress('myblog', `${TX1}:0`, -1)).to.throw(TypeError);
      expect(() => meshDerivation.memberAddress('myblog', `${TX1}:0`, 0x10000)).to.throw(TypeError);
      expect(() => meshDerivation.memberAddress('myblog', `${TX1}:0`, 1.5)).to.throw(TypeError);
    });
  });

  describe('nodeId', () => {
    it('matches the golden vectors', () => {
      expect(meshDerivation.nodeId(`${TX1}:0`)).to.equal('6f6437c5');
      expect(meshDerivation.nodeId(`${TX1}:1`)).to.equal('57eac747');
      expect(meshDerivation.nodeId(`${TX2}:0`)).to.equal('79d325b0');
    });

    it('is independent of the app', () => {
      // The id names the node, so it must be the same in every app's overlay.
      expect(meshDerivation.nodeId(`${TX1}:0`)).to.have.lengthOf(8);
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

  describe('componentIndexOf', () => {
    it('returns the position in spec order', () => {
      expect(meshDerivation.componentIndexOf(['web', 'mysql', 'cache'], 'mysql')).to.equal(1);
      expect(meshDerivation.componentIndexOf(['web'], 'web')).to.equal(0);
    });

    it('throws on a component the spec does not contain', () => {
      expect(() => meshDerivation.componentIndexOf(['web'], 'mysql')).to.throw(RangeError);
    });

    it('throws on a duplicated component name rather than picking one', () => {
      expect(() => meshDerivation.componentIndexOf(['web', 'web'], 'web')).to.throw(RangeError);
    });

    it('matches by exact name, never case-folded', () => {
      expect(() => meshDerivation.componentIndexOf(['Web'], 'web')).to.throw(RangeError);
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
