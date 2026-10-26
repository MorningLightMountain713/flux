'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const specLibs = require('../../ZelBack/src/services/utils/specLibs');

chai.use(chaiAsPromised);
const { expect } = chai;

// POST /v2/apps/quotes: the handler's own decisions, with the pricing, the spec
// reader and the pool at their seams.
describe('POST /v2/apps/quotes', () => {
  const NOW = 1_760_000_000_000;
  const CONTENT_HASH = 'c'.repeat(64);
  const SPEC = { name: 'myapp', version: 9, contentHash: () => CONTENT_HASH };
  const PRIVATE_SPEC = { name: 'myapp', version: 9, contentHash: () => CONTENT_HASH, isEncrypted: true };
  let apps;
  let messageQuote;
  let resolveSpec;
  let openTransportEnvelope;
  let validatePrivateSubmission;
  let getTempMessageByName;

  const respond = () => ({
    ok: sinon.stub().returnsArg(0),
    fail: sinon.stub().callsFake((code, message, extra) => ({ code, message, ...extra })),
  });
  const body = (over = {}) => ({ appSpecification: { name: 'myapp' }, timestamp: NOW - 1000, ...over });

  beforeEach(() => {
    sinon.useFakeTimers({ now: NOW, toFake: ['Date'] });
    messageQuote = sinon.stub().resolves({
      fee: 123_456_789n, usd: 4.99, fiatMarkupBp: 500, at: { time: (NOW - 1000) / 1000, height: 201 },
    });
    resolveSpec = sinon.stub().resolves(SPEC);
    openTransportEnvelope = sinon.stub();
    validatePrivateSubmission = sinon.stub().resolves(PRIVATE_SPEC);
    getTempMessageByName = sinon.stub().resolves(null);
    apps = proxyquire('../../ZelBack/src/services/apiV2/apps', {
      '../pricing/pricingRegime': { messageQuote },
      '../utils/specCutover': { resolveSpec },
      '../utils/transportHelper': { openTransportEnvelope },
      '../utils/specLibs': { getSpecBackend: specLibs.getSpecBackend, validatePrivateSubmission },
      '../appDatabase/appsRepository': { getTempMessageByName },
    });
  });

  afterEach(() => sinon.restore());

  it('answers the fee in satoshis, the moment it was priced at, and the time it must be paid by', async () => {
    const res = respond();
    await apps.quote({ body: body({ extend: true }) }, res);

    const { PAYMENT_WINDOW_MS } = await specLibs.getSpecBackend();
    sinon.assert.calledOnceWithExactly(messageQuote, SPEC, { timestamp: NOW - 1000, extend: true });
    sinon.assert.calledOnceWithExactly(res.ok, {
      fee: '123456789', usd: 4.99, fiatMarkupBp: 500, payBy: NOW - 1000 + PAYMENT_WINDOW_MS, pricedAt: { time: (NOW - 1000) / 1000, height: 201 },
    });
  });

  it('quotes a message that does not set extend as one that does not renew', async () => {
    await apps.quote({ body: body() }, respond());
    expect(messageQuote.firstCall.args[1].extend).to.equal(false);
  });

  for (const [what, bad] of [
    ['no specification', { appSpecification: undefined }],
    ['a timestamp that is not whole ms', { timestamp: '1760000000000' }],
    ['an extend that is not a boolean', { extend: 'true' }],
  ]) {
    it(`refuses ${what} as a bad request`, async () => {
      const res = respond();
      await apps.quote({ body: body(bad) }, res);
      expect(res.fail.firstCall.args[0]).to.equal('BAD_REQUEST');
      sinon.assert.notCalled(messageQuote);
    });
  }

  it('refuses a timestamp a submission would refuse', async () => {
    const res = respond();
    await apps.quote({ body: body({ timestamp: NOW - 61 * 60 * 1000 }) }, res);
    expect(res.fail.firstCall.args.slice(0, 1)).to.deep.equal(['UNPROCESSABLE']);
    expect(res.fail.firstCall.args[1]).to.match(/over 1 hour old/);
    sinon.assert.notCalled(messageQuote);
  });

  it('refuses while another message for the app waits for its payment', async () => {
    getTempMessageByName.resolves({ hash: 'waiting' });
    const res = respond();
    await apps.quote({ body: body() }, res);
    expect(res.fail.firstCall.args[0]).to.equal('CONFLICT');
    sinon.assert.calledOnceWithExactly(getTempMessageByName, 'myapp');
    sinon.assert.notCalled(messageQuote);
  });

  it('refuses a specification this node cannot read', async () => {
    resolveSpec.rejects(new Error('ttl: must be 0 or an integer in [86400, 31536000]'));
    const res = respond();
    await apps.quote({ body: body() }, res);
    expect(res.fail.firstCall.args).to.deep.equal(['UNPROCESSABLE', 'ttl: must be 0 or an integer in [86400, 31536000]']);
  });

  for (const reason of ['NotQuotable', 'StampedEarly', 'UpdateRefused']) {
    it(`reports a ${reason} refusal by name`, async () => {
      const refusal = new Error('refused');
      refusal.name = reason;
      messageQuote.rejects(refusal);
      const res = respond();
      await apps.quote({ body: body() }, res);
      expect(res.fail.firstCall.args).to.deep.equal(['UNPROCESSABLE', 'refused', { reason }]);
    });
  }

  describe('a private specification, sealed as it is submitted', () => {
    const SEALED = {
      name: 'myapp',
      owner: '1owner',
      transportEncrypted: {
        algorithm: 'HPKE-X25519-HKDF-SHA256-AES256GCM',
        encapsulatedKey: Buffer.alloc(32).toString('base64'),
        ciphertext: Buffer.alloc(32).toString('base64'),
        nonce: Buffer.alloc(12).toString('base64'),
      },
    };
    const OPENED = { version: 9, name: 'myapp', owner: '1owner' };
    const sealedBody = (over = {}) => body({
      type: 'fluxappregister', appSpecification: SEALED, contentHash: CONTENT_HASH, extend: true, ...over,
    });

    it('is opened with the type, content hash and time its seal is bound to, and priced as the private spec it opens to', async () => {
      openTransportEnvelope.withArgs(SEALED).resolves(OPENED);
      const res = respond();
      await apps.quote({ body: sealedBody() }, res);
      sinon.assert.calledOnceWithExactly(openTransportEnvelope, SEALED, {
        contentHash: CONTENT_HASH, timestamp: NOW - 1000, type: 'fluxappregister',
      });
      sinon.assert.calledOnceWithExactly(validatePrivateSubmission, OPENED);
      sinon.assert.notCalled(resolveSpec);
      sinon.assert.calledOnceWithExactly(messageQuote, PRIVATE_SPEC, { timestamp: NOW - 1000, extend: true });
      sinon.assert.calledOnce(res.ok);
    });

    it('is refused by the seal\'s own rule when the type it is bound to is missing', async () => {
      const real = proxyquire('../../ZelBack/src/services/apiV2/apps', {
        '../pricing/pricingRegime': { messageQuote },
        '../appDatabase/appsRepository': { getTempMessageByName },
      });
      const res = respond();
      await real.quote({ body: sealedBody({ type: undefined }) }, res);
      expect(res.fail.firstCall.args[0]).to.equal('UNPROCESSABLE');
      expect(res.fail.firstCall.args[1]).to.match(/type must be one of TRANSPORT_PURPOSE/);
      sinon.assert.notCalled(messageQuote);
    });

    it('is refused when it does not open on this node', async () => {
      openTransportEnvelope.rejects(new Error('Transport-encrypted submission could not be opened'));
      const res = respond();
      await apps.quote({ body: sealedBody() }, res);
      expect(res.fail.firstCall.args).to.deep.equal(['UNPROCESSABLE', 'Transport-encrypted submission could not be opened']);
      sinon.assert.notCalled(messageQuote);
    });
  });

  it('refuses a specification that does not hash to the content hash given', async () => {
    const res = respond();
    await apps.quote({ body: body({ contentHash: 'd'.repeat(64) }) }, res);
    expect(res.fail.firstCall.args).to.deep.equal(['UNPROCESSABLE', 'contentHash does not match appSpecification']);
    sinon.assert.notCalled(messageQuote);
  });

  it('prices a specification that hashes to the content hash given', async () => {
    const res = respond();
    await apps.quote({ body: body({ contentHash: CONTENT_HASH }) }, res);
    sinon.assert.calledOnce(res.ok);
  });

  it('lets any other failure out to the surface\'s error handler', async () => {
    messageQuote.rejects(new TypeError('a fault of ours'));
    await expect(apps.quote({ body: body() }, respond())).to.be.rejectedWith(TypeError, 'a fault of ours');
  });
});
