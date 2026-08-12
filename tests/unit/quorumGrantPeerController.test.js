'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const generalService = require('../../ZelBack/src/services/generalService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const grantClient = require('../../ZelBack/src/services/quorumGrant/grantClient');
const grantPeerController = require('../../ZelBack/src/services/quorumGrant/grantPeerController');

// The witness and relay gauntlets. What they answer is grantClient's and has
// its own suite; what gets THROUGH to them is this one's.

const CALLER_HOST = '10.2.0.1';
const SELF_TXHASH = 'a'.repeat(64);
const SELF_HOST = '203.0.113.5';

function fixtureFleet() {
  return [
    {
      txhash: '1'.repeat(64), outidx: 0, pubkey: 'owner-1', ip: `${CALLER_HOST}:16127`,
    },
    {
      txhash: SELF_TXHASH, outidx: 0, pubkey: 'owner-self', ip: `${SELF_HOST}:16127`,
    },
  ];
}

function fakeReq(body, host = CALLER_HOST) {
  return { body, socket: { remoteAddress: `::ffff:${host}` } };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

describe('quorumGrant grantPeerController', () => {
  beforeEach(() => {
    grantPeerController.reset();
    sinon.stub(fluxCommunicationUtils, 'deterministicFluxList').resolves(fixtureFleet());
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
      txhash: SELF_TXHASH, txindex: 0,
    });
    sinon.stub(registryManager, 'appLocation').resolves([{ ip: `${SELF_HOST}:16127` }]);
    sinon.stub(grantClient, 'witnessAnswer').resolves({
      holding: false, acquiring: false, quorumReachable: true,
    });
    sinon.stub(grantClient, 'carryAsk').resolves({ replies: [{ member: 'x:0', reply: { ok: true } }] });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('witness', () => {
    it('answers a listed caller from the live client state', async () => {
      const res = fakeRes();
      await grantPeerController.witness(fakeReq({ key: 'myapp/master' }), res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.quorumReachable).to.equal(true);
      expect(grantClient.witnessAnswer.calledOnceWith('myapp/master')).to.equal(true);
    });

    it('refuses malformed keys and unlisted callers', async () => {
      const badKey = fakeRes();
      await grantPeerController.witness(fakeReq({ key: 'nope' }), badKey);
      expect(badKey.statusCode).to.equal(400);

      const stranger = fakeRes();
      await grantPeerController.witness(fakeReq({ key: 'myapp/master' }, '198.51.100.9'), stranger);
      expect(stranger.statusCode).to.equal(403);
      expect(grantClient.witnessAnswer.called).to.equal(false);
    });
  });

  describe('relay', () => {
    function relayBody(overrides = {}) {
      return {
        type: 'renew',
        ask: { key: 'myapp/master', mode: 'held', epoch: 2 },
        signature: 'c2ln',
        ...overrides,
      };
    }

    it('carries a well-formed ask for an app this node holds', async () => {
      const res = fakeRes();
      await grantPeerController.relay(fakeReq(relayBody()), res);
      expect(res.statusCode).to.equal(200);
      expect(res.body.data.replies).to.have.length(1);
      expect(grantClient.carryAsk.calledOnce).to.equal(true);
      const [type, ask, signature] = grantClient.carryAsk.firstCall.args;
      expect(type).to.equal('renew');
      expect(ask.key).to.equal('myapp/master');
      expect(signature).to.equal('c2ln');
    });

    it('refuses unknown types, malformed keys, and missing signatures', async () => {
      const cases = [
        relayBody({ type: 'forward' }),
        relayBody({ ask: { key: 'no-role' } }),
        relayBody({ signature: undefined }),
      ];
      const codes = await Promise.all(cases.map(async (body) => {
        const res = fakeRes();
        await grantPeerController.relay(fakeReq(body), res);
        return res.statusCode;
      }));
      expect(codes).to.deep.equal([400, 400, 400]);
      expect(grantClient.carryAsk.called).to.equal(false);
    });

    it('refuses to carry for an app this node does not hold — no open proxy', async () => {
      registryManager.appLocation.resolves([{ ip: '10.50.0.1:16127' }]);
      const res = fakeRes();
      await grantPeerController.relay(fakeReq(relayBody()), res);
      expect(res.statusCode).to.equal(403);
      expect(res.body.data.message).to.contain('holder');
      expect(grantClient.carryAsk.called).to.equal(false);
    });

    it('refuses unlisted callers before touching anything', async () => {
      const res = fakeRes();
      await grantPeerController.relay(fakeReq(relayBody(), '198.51.100.9'), res);
      expect(res.statusCode).to.equal(403);
    });
  });

  describe('the peer ceiling', () => {
    it('cuts a flooding peer off within the window', async () => {
      const malformed = { key: 'nope' };
      const burst = Array.from({ length: 600 }, () => grantPeerController.witness(fakeReq(malformed), fakeRes()));
      await Promise.all(burst);
      const overflow = fakeRes();
      await grantPeerController.witness(fakeReq(malformed), overflow);
      expect(overflow.statusCode).to.equal(429);
    });
  });
});
