import { expect } from 'chai';
import {
  CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm,
} from '@hpke/core';
import transportProvider from '../../ZelBack/src/services/providers/FluxOSTransportProvider.js';
import specLibs from '../../ZelBack/src/services/utils/specLibs.js';

/**
 * A viewer recipient for the HPKE seal under test. Its owner signature is not
 * what this file tests (registryManager's tests do that), so it is authorized
 * through a verifier that accepts.
 */
async function viewer(publicKey) {
  const { authorizeViewerKey } = await specLibs.getSpec();
  return authorizeViewerKey({
    appName: 'seal-app', owner: 'owner1', publicKey, timestamp: 1, signature: 'sig', maxAgeMs: null,
  }, () => true);
}

describe('FluxOSTransportProvider', () => {
  describe('seal (view direction)', () => {
    it('refuses key bytes in place of an authorized recipient', async () => {
      const provider = await transportProvider.create('seal-app', 'owner1');
      let threw;
      try {
        await provider.seal({ plaintext: Buffer.from('x'), aad: Buffer.from('a'), recipient: new Uint8Array(32), info: 'i' });
      } catch (e) { threw = e; }
      expect(threw?.message).to.match(/not key bytes/);
    });

    it('returns a TransportEnvelope a real HPKE recipient can open', async () => {
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
        plaintext, aad, recipient: await viewer(peerPublicKey), info,
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
      const kem = new DhkemX25519HkdfSha256();
      const suite = new CipherSuite({ kem, kdf: new HkdfSha256(), aead: new Aes256Gcm() });
      const recipientKeyPair = await kem.generateKeyPair();
      const peerPublicKey = new Uint8Array(await kem.serializePublicKey(recipientKeyPair.publicKey));

      const provider = await transportProvider.create('seal-app', 'owner1');
      const info = 'FLUX_APP_SPEC_VIEW_v1';
      const envelope = await provider.seal({
        plaintext: Buffer.from('secret'), aad: Buffer.from('right-aad'), recipient: await viewer(peerPublicKey), info,
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
