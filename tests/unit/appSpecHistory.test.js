const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('appSpecHistory tests', () => {
  let appSpecHistory;
  let appsRepositoryStub;
  let resolveSpecStub;

  function message(overrides = {}) {
    return {
      type: 'fluxappupdate',
      hash: 'hash1',
      height: 100,
      timestamp: 1000,
      appSpecifications: { name: 'myapp', owner: 'ownerA' },
      ...overrides,
    };
  }

  beforeEach(() => {
    appsRepositoryStub = { listAppMessagesByName: sinon.stub().resolves([]) };
    resolveSpecStub = sinon.stub().callsFake((spec) => Promise.resolve(spec));

    appSpecHistory = proxyquire('../../ZelBack/src/services/appDatabase/appSpecHistory', {
      './appsRepository': appsRepositoryStub,
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
    it('returns null when the name has no messages', async () => {
      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);
      expect(result).to.be.null;
    });

    it('returns the newest message below the height', async () => {
      appsRepositoryStub.listAppMessagesByName.resolves([
        message({ hash: 'old', height: 100 }),
        message({ hash: 'newest-below', height: 150 }),
        message({ hash: 'above', height: 250 }),
      ]);

      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);
      expect(result.hash).to.equal('newest-below');
    });

    it('ignores a message at or above the height', async () => {
      appsRepositoryStub.listAppMessagesByName.resolves([
        message({ hash: 'same-height', height: 200 }),
      ]);

      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);
      expect(result).to.be.null;
    });

    it('ignores message types that are not registrations or updates', async () => {
      appsRepositoryStub.listAppMessagesByName.resolves([
        message({ hash: 'other', height: 150, type: 'fluxappnotanupdate' }),
      ]);

      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);
      expect(result).to.be.null;
    });

    // The cutoff is the block height, which the chain fixes — never the message's
    // own timestamp, which its sender writes. A backdated message must not reach
    // back past a later owner of the same name.
    it('does not let a backdated timestamp reach behind a newer message', async () => {
      appsRepositoryStub.listAppMessagesByName.resolves([
        message({
          hash: 'ownerA-registration',
          height: 100,
          timestamp: 1000,
          type: 'fluxappregister',
          appSpecifications: { name: 'myapp', owner: 'ownerA' },
        }),
        message({
          hash: 'ownerB-registration',
          height: 300,
          timestamp: 3000,
          type: 'fluxappregister',
          appSpecifications: { name: 'myapp', owner: 'ownerB' },
        }),
      ]);

      // ownerA's message claims a timestamp from before ownerB ever held the
      // name, but it is mined at height 400.
      const result = await appSpecHistory.getStateBeforeHeight('myapp', 400);
      expect(result.owner).to.equal('ownerB');
    });

    it('breaks a tie within one height on the later timestamp', async () => {
      appsRepositoryStub.listAppMessagesByName.resolves([
        message({ hash: 'earlier', height: 150, timestamp: 1000 }),
        message({ hash: 'later', height: 150, timestamp: 2000 }),
      ]);

      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);
      expect(result.hash).to.equal('later');
    });

    it('returns null when the spec cannot be resolved on this node', async () => {
      appsRepositoryStub.listAppMessagesByName.resolves([message({ height: 150 })]);
      resolveSpecStub.resolves(null);

      const result = await appSpecHistory.getStateBeforeHeight('myapp', 200);
      expect(result).to.be.null;
    });
  });
});
