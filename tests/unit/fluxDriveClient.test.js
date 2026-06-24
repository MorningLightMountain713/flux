const { expect } = require('chai');
const { uploadBlob, fetchBlobByLocator } = require('../../ZelBack/src/services/utils/fluxDriveClient');

const BASE = 'https://drive.example';

describe('fluxDriveClient', () => {
  describe('uploadBlob', () => {
    it('POSTs framed ciphertext with the dual-signature headers', async () => {
      const calls = [];
      const http = { post: async (url, body, opts) => { calls.push({ url, body, opts }); return { status: 200 }; } };
      const framed = Buffer.from('cipher');

      await uploadBlob(framed, {
        locator: 'loc', appName: 'app', timestamp: 123, arcaneSig: 'asig', ownerSig: 'osig', source: 'blob',
      }, { http, baseUrl: BASE });

      expect(calls.length).to.equal(1);
      expect(calls[0].url).to.equal(`${BASE}/api/v1/blob`);
      expect(calls[0].body).to.equal(framed);
      expect(calls[0].opts.headers).to.include({
        'Content-Type': 'application/octet-stream',
        'X-Flux-Locator': 'loc',
        'X-Flux-AppName': 'app',
        'X-Flux-Timestamp': '123',
        'X-Flux-Arcane-Sig': 'asig',
        'X-Flux-Owner-Sig': 'osig',
        'X-Flux-Source': 'blob',
      });
    });

    it('throws when the base URL is not configured', async () => {
      let threw = false;
      try {
        await uploadBlob(Buffer.from('x'), { locator: 'l' }, { http: { post: async () => {} } });
      } catch (e) {
        threw = /not configured/.test(e.message);
      }
      expect(threw).to.equal(true);
    });
  });

  describe('fetchBlobByLocator', () => {
    it('returns a Buffer of the fetched ciphertext', async () => {
      const http = { get: async () => ({ data: Buffer.from('opaque') }) };
      const out = await fetchBlobByLocator('loc', { http, baseUrl: BASE });
      expect(Buffer.isBuffer(out)).to.equal(true);
      expect(out.toString()).to.equal('opaque');
    });

    it('returns null on 404', async () => {
      const http = { get: async () => { const e = new Error('nf'); e.response = { status: 404 }; throw e; } };
      expect(await fetchBlobByLocator('loc', { http, baseUrl: BASE })).to.equal(null);
    });

    it('rethrows non-404 errors', async () => {
      const http = { get: async () => { const e = new Error('boom'); e.response = { status: 500 }; throw e; } };
      let threw = false;
      try {
        await fetchBlobByLocator('loc', { http, baseUrl: BASE });
      } catch (e) {
        threw = e.message === 'boom';
      }
      expect(threw).to.equal(true);
    });
  });
});
