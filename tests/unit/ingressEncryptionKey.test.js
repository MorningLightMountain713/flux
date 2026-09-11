'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const { asConfig } = require('./fixtures/config');

const production = require('../../ZelBack/config/default');

// A valid 32-byte x25519 public key (base64), distinct from the shipped one.
const OVERRIDE_PUBKEY_B64 = Buffer.alloc(32, 7).toString('base64');

function load(configStub) {
  return proxyquire('../../ZelBack/src/services/utils/ingressEncryptionKey', {
    config: asConfig(configStub),
  });
}

describe('ingressEncryptionKey tests', () => {
  // There is no baked-in default any more. The key is a verification identity
  // and it lives in config/default.js, where it can be read and rotated; a copy
  // in the reader was a value nobody could see and nobody could change.
  it('uses the key and kid config ships', () => {
    const mod = load({});
    const { kid, publicKey } = mod.current();
    expect(kid).to.equal(production.ingress.encryptionKid);
    expect(publicKey).to.be.instanceOf(Uint8Array).with.length(32);
    expect(Buffer.from(publicKey).toString('base64')).to.equal(production.ingress.encryptionPubkey);
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

  it('ships a 32-byte public key', () => {
    expect(Buffer.from(production.ingress.encryptionPubkey, 'base64')).to.have.length(32);
  });
});
