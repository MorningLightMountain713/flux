'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { load } = require('@runonflux/flux-spec-cjs');

let PricingModel;
before(async () => {
  ({ PricingModel } = await load());
});

describe('pricingRegime', () => {
  afterEach(() => {
    sinon.restore();
  });

  // Where a declared pricing model meets its implementation. Nothing in the
  // pricing path reads a spec version; a spec states its model and this
  // resolves it.
  describe('regimeFor — a declared pricing model resolves to its implementation', () => {
    const { regimeFor } = require('../../ZelBack/src/services/pricing/pricingRegime');
    const legacyPricingRegime = require('../../ZelBack/src/services/pricing/legacyPricingRegime');
    const v9PricingRegime = require('../../ZelBack/src/services/pricing/v9PricingRegime');

    it('resolves the chain-floor model to the legacy regime', async () => {
      const regime = await regimeFor({ pricingModel: PricingModel.CHAIN_FLOOR });
      expect(regime).to.equal(legacyPricingRegime);
    });

    it('resolves the unified model to the v9 regime', async () => {
      const regime = await regimeFor({ pricingModel: PricingModel.UNIFIED });
      expect(regime).to.equal(v9PricingRegime);
    });

    // A generation whose economics nobody has implemented must stop, not be
    // priced under whichever model happens to be first or default. Falling back
    // would charge an app under rules it was never issued under.
    it('refuses a model no regime implements rather than falling back', async () => {
      let error;
      await regimeFor({ pricingModel: 'someFutureModel' }).catch((err) => { error = err; });
      expect(error).to.be.an('error');
      expect(error.message).to.include('someFutureModel');
    });

    it('refuses a spec that declares no model at all', async () => {
      let error;
      await regimeFor({ version: 9 }).catch((err) => { error = err; });
      expect(error).to.be.an('error');
    });

    it('implements every model flux-spec declares', async () => {
      for (const model of Object.values(PricingModel)) {
        // eslint-disable-next-line no-await-in-loop
        expect(await regimeFor({ pricingModel: model })).to.be.an('object');
      }
    });

    it('exposes the same five operations on both regimes', () => {
      const ops = ['onChainDisplayPrice', 'fiatAndFluxDisplayPrice', 'registrationFee', 'supersededMessage', 'updateFee'];
      for (const op of ops) {
        expect(legacyPricingRegime[op], `legacy.${op}`).to.be.a('function');
        expect(v9PricingRegime[op], `v9.${op}`).to.be.a('function');
      }
    });
  });

  // What an update is priced against. Each regime answers for its own
  // economics; the promotion path asks and never chooses.
  describe('supersededMessage', () => {
    const CONFIRMING = { height: 2000000, timestamp: 1750000000000 };

    function loadRegimes() {
      const appsRepositoryStub = {
        getPreviousPermanentMessage: sinon.stub().resolves({ hash: 'byTimestamp' }),
        getPermanentMessageBeforeHeight: sinon.stub().resolves({ hash: 'byHeight' }),
        listAppMessagesByName: sinon.stub().resolves([]),
      };
      const P = '../../ZelBack/src/services/pricing';
      return {
        appsRepositoryStub,
        legacy: proxyquire(`${P}/legacyPricingRegime`, {
          '../appDatabase/appsRepository': appsRepositoryStub,
        }),
        v9: proxyquire(`${P}/v9PricingRegime`, {
          '../appDatabase/appsRepository': appsRepositoryStub,
        }),
      };
    }

    // The update is already stored as a permanent message by the time this is
    // asked. A height cutoff is the only one that excludes it: the message
    // cannot precede its own height, however its timestamp is written.
    it('v9 resolves by confirming height, which cannot select the update itself', async () => {
      const { v9, appsRepositoryStub } = loadRegimes();

      const result = await v9.supersededMessage('myapp', CONFIRMING);

      expect(result.hash).to.equal('byHeight');
      sinon.assert.calledOnceWithExactly(
        appsRepositoryStub.getPermanentMessageBeforeHeight, 'myapp', CONFIRMING.height,
      );
      sinon.assert.notCalled(appsRepositoryStub.getPreviousPermanentMessage);
    });

    it('v9 never uses the message timestamp, which its sender writes', async () => {
      const { v9, appsRepositoryStub } = loadRegimes();

      await v9.supersededMessage('myapp', { height: 2000000, timestamp: 1 });

      const [, cutoff] = appsRepositoryStub.getPermanentMessageBeforeHeight.firstCall.args;
      expect(cutoff).to.equal(2000000);
    });

    // Legacy is bug-compatible on purpose: its resolution selects the update
    // itself, which floors every legacy update at minPrice. That is what the
    // network has enforced since height 1004000, and a node resolving it any
    // other way would reject updates every other node accepts.
    it('legacy keeps the timestamp resolution the network has always used', async () => {
      const { legacy, appsRepositoryStub } = loadRegimes();

      const result = await legacy.supersededMessage('myapp', CONFIRMING);

      expect(result.hash).to.equal('byTimestamp');
      sinon.assert.calledOnceWithExactly(
        appsRepositoryStub.getPreviousPermanentMessage, 'myapp', CONFIRMING.timestamp,
      );
      sinon.assert.notCalled(appsRepositoryStub.getPermanentMessageBeforeHeight);
    });

    it('reports nothing to supersede rather than inventing a predecessor', async () => {
      const { v9, appsRepositoryStub } = loadRegimes();
      appsRepositoryStub.getPermanentMessageBeforeHeight.resolves(null);

      expect(await v9.supersededMessage('myapp', CONFIRMING)).to.be.null;
    });
  });
});
