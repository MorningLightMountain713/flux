const { expect } = require('chai');
const express = require('express');
const request = require('supertest');
const { bodyParser, MIGRATED_ROUTES } = require('../../ZelBack/src/lib/bodyParser');

// The gated body-parser is the foundation for migrating POST handlers off the
// raw req.on('data') listener onto middleware-parsed req.body. Migrated routes
// get json + urlencoded (json for any content-type that is not urlencoded or
// multipart); every other route keeps the legacy json-only behaviour.

function buildApp() {
  const app = express();
  app.use(bodyParser);
  // A migrated route and a legacy route, each echoing what the middleware parsed.
  app.post('/apps/appregister', (req, res) => res.json({ hello: req.body && req.body.hello }));
  app.post('/legacy/route', (req, res) => res.json({ hello: req.body && req.body.hello }));
  return app;
}

describe('bodyParser middleware', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it('exposes the appregister/appupdate submission routes as migrated', () => {
    expect(MIGRATED_ROUTES.has('/apps/appregister')).to.equal(true);
    expect(MIGRATED_ROUTES.has('/apps/appupdate')).to.equal(true);
    expect(MIGRATED_ROUTES.has('/apps/verifyappregistrationspecifications')).to.equal(true);
    expect(MIGRATED_ROUTES.has('/apps/verifyappupdatespecifications')).to.equal(true);
  });

  describe('migrated route', () => {
    it('parses an application/json body into req.body', async () => {
      const res = await request(app).post('/apps/appregister').send({ hello: 'world' });
      expect(res.body.hello).to.equal('world');
    });

    it('parses a urlencoded body into req.body', async () => {
      const res = await request(app)
        .post('/apps/appregister')
        .type('form')
        .send({ hello: 'world' });
      expect(res.body.hello).to.equal('world');
    });

    it('parses a JSON string mislabelled as urlencoded (the real frontend pattern)', async () => {
      // The frontend posts JSON.stringify(spec) which axios labels
      // application/x-www-form-urlencoded. Trusting that header and running
      // express.urlencoded would qs-parse the JSON string into garbage; the
      // JSON-first/qs-fallback parse recovers the real object.
      const res = await request(app)
        .post('/apps/appregister')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(JSON.stringify({ hello: 'world' }));
      expect(res.body.hello).to.equal('world');
    });

    it('parses a JSON body sent with a non-json content-type (e.g. text/plain)', async () => {
      // The legacy clients often send the JSON spec without an application/json
      // content-type; the migrated parser treats any non-urlencoded,
      // non-multipart body as JSON so those requests stay transparent.
      const res = await request(app)
        .post('/apps/appregister')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ hello: 'world' }));
      expect(res.body.hello).to.equal('world');
    });

    it('does not consume a multipart body as json/urlencoded (left for the file parser)', async () => {
      const res = await request(app)
        .post('/apps/appregister')
        .field('hello', 'world');
      // multipart is not parsed here, so req.body carries no `hello`
      expect(res.body.hello).to.be.undefined;
    });
  });

  describe('legacy (non-migrated) route', () => {
    it('still parses application/json (unchanged behaviour)', async () => {
      const res = await request(app).post('/legacy/route').send({ hello: 'world' });
      expect(res.body.hello).to.equal('world');
    });

    it('does not parse a non-json content-type (legacy json-only)', async () => {
      // The legacy global parser only handles application/json; other
      // content-types fall through untouched (as today), so the real legacy
      // handlers' own raw-stream reading keeps working until they are migrated.
      const res = await request(app)
        .post('/legacy/route')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ hello: 'world' }));
      expect(res.body.hello).to.be.undefined;
    });
  });
});
