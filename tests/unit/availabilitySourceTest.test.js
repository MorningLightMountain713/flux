const { expect } = require('chai');

const availabilitySourceTest = require('../../ZelBack/src/services/utils/availabilitySourceTest');

describe('availabilitySourceTest', () => {
  it('matches a call that came from the observer\'s address', () => {
    const nonce = availabilitySourceTest.open('1.2.3.4');
    availabilitySourceTest.record(nonce, '1.2.3.4');
    expect(availabilitySourceTest.close(nonce)).to.deep.equal({ verdict: 'match', seenFrom: '1.2.3.4' });
  });

  it('reads an IPv4 caller on a dual-stack listener as its IPv4 address', () => {
    const nonce = availabilitySourceTest.open('1.2.3.4');
    availabilitySourceTest.record(nonce, '::ffff:1.2.3.4');
    expect(availabilitySourceTest.close(nonce).verdict).to.equal('match');
  });

  it('says mismatch for a call from another address, and names it', () => {
    const nonce = availabilitySourceTest.open('1.2.3.4');
    availabilitySourceTest.record(nonce, '10.0.0.1');
    expect(availabilitySourceTest.close(nonce)).to.deep.equal({ verdict: 'mismatch', seenFrom: '10.0.0.1' });
  });

  it('keeps the first call\'s address', () => {
    const nonce = availabilitySourceTest.open('1.2.3.4');
    availabilitySourceTest.record(nonce, '10.0.0.1');
    availabilitySourceTest.record(nonce, '1.2.3.4');
    expect(availabilitySourceTest.close(nonce).verdict).to.equal('mismatch');
  });

  it('says unseen when no call carried the nonce, and for a nonce it never handed out or already closed', () => {
    const nonce = availabilitySourceTest.open('1.2.3.4');
    expect(availabilitySourceTest.close(nonce)).to.deep.equal({ verdict: 'unseen', seenFrom: null });
    availabilitySourceTest.record(nonce, '1.2.3.4');
    expect(availabilitySourceTest.close(nonce).verdict).to.equal('unseen');
    availabilitySourceTest.record('0'.repeat(32), '1.2.3.4');
    expect(availabilitySourceTest.close('0'.repeat(32)).verdict).to.equal('unseen');
  });

  it('hands out nonces it recognises, and recognises no other value', () => {
    expect(availabilitySourceTest.isNonce(availabilitySourceTest.open('1.2.3.4'))).to.equal(true);
    for (const value of [undefined, null, 7, '', 'abc', 'g'.repeat(32), `${'a'.repeat(32)}x`, ['a'.repeat(32)]]) {
      expect(availabilitySourceTest.isNonce(value), String(value)).to.equal(false);
    }
  });

  it('forgets the oldest asks once more are open than any check makes', () => {
    const first = availabilitySourceTest.open('1.2.3.4');
    const later = Array.from({ length: 40 }, () => availabilitySourceTest.open('1.2.3.4'));
    availabilitySourceTest.record(first, '1.2.3.4');
    expect(availabilitySourceTest.close(first).verdict).to.equal('unseen');
    availabilitySourceTest.record(later.at(-1), '1.2.3.4');
    expect(availabilitySourceTest.close(later.at(-1)).verdict).to.equal('match');
    later.forEach((nonce) => availabilitySourceTest.close(nonce));
  });
});
