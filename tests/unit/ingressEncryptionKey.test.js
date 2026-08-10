'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

// A valid 32-byte x25519 public key (base64), distinct from the source default.
const OVERRIDE_PUBKEY_B64 = Buffer.alloc(32, 7).toString('base64');

function load(configStub) {
  return proxyquire('../../ZelBack/src/services/utils/ingressEncryptionKey', {
    config: configStub,
  });
}

describe('ingressEncryptionKey tests', () => {
  it('falls back to the baked-in default key and kid when config is absent', () => {
    const mod = load({});
    const { kid, publicKey } = mod.current();
    expect(kid).to.equal(mod.DEFAULT_INGRESS_ENCRYPTION_KID);
    expect(publicKey).to.be.instanceOf(Uint8Array).with.length(32);
    expect(Buffer.from(publicKey).toString('base64')).to.equal(mod.DEFAULT_INGRESS_ENCRYPTION_PUBKEY);
  });

  it('honours a config override for the key and kid', () => {
    const mod = load({ ingress: { encryptionKid: 'ft-override', encryptionPubkey: OVERRIDE_PUBKEY_B64 } });
    const { kid, publicKey } = mod.current();
    expect(kid).to.equal('ft-override');
    expect(Buffer.from(publicKey).toString('base64')).to.equal(OVERRIDE_PUBKEY_B64);
  });

  it('rejects a public key that is not 32 bytes', () => {
    const mod = load({ ingress: { encryptionPubkey: Buffer.alloc(16).toString('base64') } });
    expect(() => mod.current()).to.throw(/32 bytes/);
  });

  it('exposes a 32-byte default public key', () => {
    const mod = load({});
    expect(Buffer.from(mod.DEFAULT_INGRESS_ENCRYPTION_PUBKEY, 'base64')).to.have.length(32);
  });
});
