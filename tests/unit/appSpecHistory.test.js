'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('appSpecHistory tests', () => {
  let appSpecHistory;
  let appHistoryStub;
  let resolveSpecStub;

  function applied(hash, fields = {}) {
    return {
      message: { hash, contentHash: null, appSpecifications: { name: 'myapp', owner: fields.owner ?? 'ownerA' } },
      decision: {
        hash, height: fields.height ?? 150, termStart: 1_700_000_000, uuid: `uuid-${hash}`, identity: 'myapp',
      },
    };
  }

  beforeEach(() => {
    appHistoryStub = { latestApplied: sinon.stub().resolves(null) };
    resolveSpecStub = sinon.stub().callsFake((spec) => Promise.resolve(spec));

    appSpecHistory = proxyquire('../../ZelBack/src/services/appDatabase/appSpecHistory', {
      '../appDecisions/appHistory': appHistoryStub,
      '../utils/specCutover': { resolveSpec: resolveSpecStub },
      '../utils/specLibs': {
        getSpecBackend: sinon.stub().resolves({
          InstantiatedSpec: { fromEvent: (event) => ({ ...event, owner: event.spec.owner }) },
        }),
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getStateBeforeHeight', () => {
    it('returns null when nothing was applied below the height', async () => {
      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);
      expect(result).to.be.null;
      sinon.assert.calledOnceWithExactly(appHistoryStub.latestApplied, 'myapp', { before: 200 });
    });

    it('answers the latest applied message below the height, with its decision\'s term start, uuid and identity', async () => {
      appHistoryStub.latestApplied.resolves(applied('newest-below', { owner: 'ownerB' }));

      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);

      expect(result).to.include({
        hash: 'newest-below', height: 150, registeredAt: 1_700_000_000, uuid: 'uuid-newest-below', identity: 'myapp', owner: 'ownerB',
      });
    });

    it('returns null when the spec cannot be resolved on this node', async () => {
      appHistoryStub.latestApplied.resolves(applied('x'));
      resolveSpecStub.resolves(null);

      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);
      expect(result).to.be.null;
    });
  });
});
