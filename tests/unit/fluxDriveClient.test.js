const { expect } = require('chai');
const {
  uploadBlob, fetchBlobByLocator, putManifest, reconcile, fetchManifest,
} = require('../../ZelBack/src/services/utils/fluxDriveClient');

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

  describe('putManifest', () => {
    it('PUTs the JSON manifest body to /api/v1/manifest/:appName', async () => {
      const calls = [];
      const http = { put: async (url, body, opts) => { calls.push({ url, body, opts }); return { status: 200 }; } };
      await putManifest('my-app', {
        version: 3, timestamp: 123, arcaneSig: 'asig', ownerSig: 'osig', manifest: { version: 3, slots: { sealed: {} } },
      }, { http, baseUrl: BASE });
      expect(calls.length).to.equal(1);
      expect(calls[0].url).to.equal(`${BASE}/api/v1/manifest/my-app`);
      expect(calls[0].body).to.deep.include({ version: 3, timestamp: 123, arcaneSig: 'asig', ownerSig: 'osig' });
      expect(calls[0].body.manifest).to.deep.equal({ version: 3, slots: { sealed: {} } });
    });

    it('url-encodes the appName', async () => {
      const calls = [];
      const http = { put: async (url) => { calls.push(url); return {}; } };
      await putManifest('a b/c', { version: 1 }, { http, baseUrl: BASE });
      expect(calls[0]).to.equal(`${BASE}/api/v1/manifest/a%20b%2Fc`);
    });
  });

  describe('reconcile', () => {
    it('POSTs the reconcile body to /api/v1/blob/reconcile', async () => {
      const calls = [];
      const http = { post: async (url, body, opts) => { calls.push({ url, body, opts }); return { status: 200 }; } };
      await reconcile('my-app', {
        source: 'slot', version: 4, arcaneSig: 'asig', ownerSig: 'osig', liveLocators: ['l1', 'l2'],
      }, { http, baseUrl: BASE });
      expect(calls.length).to.equal(1);
      expect(calls[0].url).to.equal(`${BASE}/api/v1/blob/reconcile`);
      expect(calls[0].body).to.deep.equal({
        appName: 'my-app', source: 'slot', version: 4, arcaneSig: 'asig', ownerSig: 'osig', liveLocators: ['l1', 'l2'],
      });
    });

    it('throws when the base URL is not configured', async () => {
      let threw = false;
      try {
        await reconcile('app', { source: 'slot', version: 1 }, { http: { post: async () => {} } });
      } catch (e) {
        threw = /not configured/.test(e.message);
      }
      expect(threw).to.equal(true);
    });
  });

  describe('fetchManifest', () => {
    it('returns the { version, manifest } body', async () => {
      const http = { get: async () => ({ data: { version: 5, manifest: { slots: {} } } }) };
      const out = await fetchManifest('app', { http, baseUrl: BASE });
      expect(out).to.deep.equal({ version: 5, manifest: { slots: {} } });
    });

    it('returns null on 404', async () => {
      const http = { get: async () => { const e = new Error('nf'); e.response = { status: 404 }; throw e; } };
      expect(await fetchManifest('app', { http, baseUrl: BASE })).to.equal(null);
    });

    it('rethrows non-404 errors', async () => {
      const http = { get: async () => { const e = new Error('boom'); e.response = { status: 502 }; throw e; } };
      let threw = false;
      try {
        await fetchManifest('app', { http, baseUrl: BASE });
      } catch (e) {
        threw = e.message === 'boom';
      }
      expect(threw).to.equal(true);
    });
  });
});
