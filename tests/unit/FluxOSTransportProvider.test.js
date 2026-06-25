const { expect } = require('chai');
const transportProvider = require('../../ZelBack/src/services/providers/FluxOSTransportProvider');

describe('FluxOSTransportProvider', () => {
  describe('seal (view direction)', () => {
    it('returns a TransportEnvelope a real HPKE recipient can open', async () => {
      const {
        CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm,
      } = await import('@hpke/core');
      const kem = new DhkemX25519HkdfSha256();
      const suite = new CipherSuite({ kem, kdf: new HkdfSha256(), aead: new Aes256Gcm() });

      const recipientKeyPair = await kem.generateKeyPair();
      const peerPublicKey = new Uint8Array(await kem.serializePublicKey(recipientKeyPair.publicKey));

      const provider = await transportProvider.create('seal-app', 'owner1');
      const message = JSON.stringify({ hello: 'world' });
      const plaintext = Buffer.from(message, 'utf8');
      const aad = Buffer.from('view-aad');
      const info = 'FLUX_APP_SPEC_VIEW_v1';

      const envelope = await provider.seal({
        plaintext, aad, peerPublicKey, info,
      });

      // view leg: no nonce (HPKE owns it), 32-byte encapsulated key, ciphertext
      // carries the 16-byte GCM tag
      expect(envelope.nonce).to.equal(null);
      expect(envelope.encapsulatedKey).to.be.instanceOf(Uint8Array);
      expect(envelope.encapsulatedKey.length).to.equal(32);
      expect(envelope.ciphertext.length).to.be.greaterThan(16);

      const wire = envelope.toJSON();
      expect(wire).to.not.have.property('nonce');
      expect(wire.encapsulatedKey).to.be.a('string');
      expect(wire.ciphertext).to.be.a('string');

      // the frontend's counterpart — a genuine HPKE recipient — opens it back
      const recipient = await suite.createRecipientContext({
        recipientKey: recipientKeyPair,
        enc: envelope.encapsulatedKey,
        info: new TextEncoder().encode(info),
      });
      const opened = await recipient.open(envelope.ciphertext, aad);
      expect(Buffer.from(opened).toString('utf8')).to.equal(message);
    });

    it('binds the AAD — a recipient opening with the wrong AAD fails', async () => {
      const {
        CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm,
      } = await import('@hpke/core');
      const kem = new DhkemX25519HkdfSha256();
      const suite = new CipherSuite({ kem, kdf: new HkdfSha256(), aead: new Aes256Gcm() });
      const recipientKeyPair = await kem.generateKeyPair();
      const peerPublicKey = new Uint8Array(await kem.serializePublicKey(recipientKeyPair.publicKey));

      const provider = await transportProvider.create('seal-app', 'owner1');
      const info = 'FLUX_APP_SPEC_VIEW_v1';
      const envelope = await provider.seal({
        plaintext: Buffer.from('secret'), aad: Buffer.from('right-aad'), peerPublicKey, info,
      });

      const recipient = await suite.createRecipientContext({
        recipientKey: recipientKeyPair,
        enc: envelope.encapsulatedKey,
        info: new TextEncoder().encode(info),
      });

      let threw = null;
      try {
        await recipient.open(envelope.ciphertext, Buffer.from('wrong-aad'));
      } catch (e) { threw = e; }
      expect(threw).to.not.be.null;
    });
  });
});
