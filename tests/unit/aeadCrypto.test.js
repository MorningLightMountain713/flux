const { expect } = require('chai');
const crypto = require('node:crypto');
const { aeadEncrypt, aeadDecrypt, NONCE_BYTES, TAG_BYTES, KEY_BYTES } = require('../../ZelBack/src/services/utils/aeadCrypto');

const key = () => crypto.randomBytes(KEY_BYTES);

describe('aeadCrypto', () => {
  describe('round-trip', () => {
    it('decrypts what it encrypts', () => {
      const k = key();
      const pt = Buffer.from('the quick brown fox');
      expect(aeadDecrypt(k, aeadEncrypt(k, pt)).equals(pt)).to.equal(true);
    });

    it('round-trips with additional authenticated data', () => {
      const k = key();
      const pt = Buffer.from('payload');
      const aad = Buffer.from('sha256:deadbeef');
      expect(aeadDecrypt(k, aeadEncrypt(k, pt, aad), aad).equals(pt)).to.equal(true);
    });

    it('round-trips empty plaintext', () => {
      const k = key();
      expect(aeadDecrypt(k, aeadEncrypt(k, Buffer.alloc(0))).length).to.equal(0);
    });
  });

  describe('framing', () => {
    it('frames as nonce, tag, ciphertext (length is plaintext + 28)', () => {
      const pt = Buffer.from('a'.repeat(100));
      expect(aeadEncrypt(key(), pt).length).to.equal(NONCE_BYTES + TAG_BYTES + pt.length);
    });

    it('uses a fresh nonce per call so the same input yields different output', () => {
      const k = key();
      const pt = Buffer.from('same');
      expect(aeadEncrypt(k, pt).equals(aeadEncrypt(k, pt))).to.equal(false);
    });
  });

  describe('authentication', () => {
    it('rejects a tampered ciphertext', () => {
      const k = key();
      const framed = aeadEncrypt(k, Buffer.from('secret'));
      framed[framed.length - 1] ^= 0x01;
      expect(() => aeadDecrypt(k, framed)).to.throw();
    });

    it('rejects a tampered tag', () => {
      const k = key();
      const framed = aeadEncrypt(k, Buffer.from('secret'));
      framed[NONCE_BYTES] ^= 0x01;
      expect(() => aeadDecrypt(k, framed)).to.throw();
    });

    it('rejects the wrong key', () => {
      const framed = aeadEncrypt(key(), Buffer.from('secret'));
      expect(() => aeadDecrypt(key(), framed)).to.throw();
    });

    it('binds the aad so decrypting with a different aad fails', () => {
      const k = key();
      const framed = aeadEncrypt(k, Buffer.from('secret'), Buffer.from('aad-1'));
      expect(() => aeadDecrypt(k, framed, Buffer.from('aad-2'))).to.throw();
    });

    it('binds the aad so omitting it on decrypt fails', () => {
      const k = key();
      const framed = aeadEncrypt(k, Buffer.from('secret'), Buffer.from('aad'));
      expect(() => aeadDecrypt(k, framed)).to.throw();
    });
  });

  describe('input validation', () => {
    it('rejects a non-32-byte key on encrypt', () => {
      expect(() => aeadEncrypt(crypto.randomBytes(16), Buffer.from('x'))).to.throw(/32-byte/);
    });

    it('rejects a non-32-byte key on decrypt', () => {
      expect(() => aeadDecrypt(crypto.randomBytes(16), Buffer.alloc(40))).to.throw(/32-byte/);
    });

    it('rejects a frame shorter than nonce plus tag', () => {
      expect(() => aeadDecrypt(key(), Buffer.alloc(NONCE_BYTES + TAG_BYTES - 1))).to.throw(/too short/);
    });
  });
});
