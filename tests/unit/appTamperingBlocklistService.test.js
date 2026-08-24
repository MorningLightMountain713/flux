'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { EventEmitter } = require('events');
const proxyquire = require('proxyquire').noCallThru();

describe('appTamperingBlocklistService tests', () => {
  let service;
  let policyStoreStub;
  let tamperingRepositoryStub;
  let nodeDosStateStub;
  let generalServiceStub;
  let daemonMiscStub;

  const MOCK_TXHASH = 'abc123deadbeef';

  function loadService(arcane = false) {
    return proxyquire('../../ZelBack/src/services/appTamperingBlocklistService', {
      '../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
      },
      './appDatabase/appTamperingRepository': tamperingRepositoryStub,
      './nodeDosState': nodeDosStateStub,
      './generalService': generalServiceStub,
      './daemonService/daemonServiceMiscRpcs': daemonMiscStub,
      './utils/globalState': { isArcane: () => arcane },
      './policy/policyStore': policyStoreStub,
    });
  }

  // policyStore holds the document; null is its "no copy from any layer" answer, which is
  // deliberately not the same as an empty list.
  function setBlocklist(value) {
    policyStoreStub.get.withArgs('tamperingBlocklist').returns(value);
  }

  beforeEach(() => {
    policyStoreStub = {
      get: sinon.stub().returns(null),
    };

    tamperingRepositoryStub = {
      sumIncidentSeverities: sinon.stub().resolves(0),
    };

    nodeDosStateStub = {
      setStickyDosMessage: sinon.stub(),
      setStickyDosStateValue: sinon.stub(),
      clearStickyDosMessage: sinon.stub(),
      getStickyDosMessage: sinon.stub().returns(null),
    };

    generalServiceStub = {
      obtainNodeCollateralInformation: sinon.stub().resolves({ txhash: MOCK_TXHASH, txindex: 0 }),
    };

    daemonMiscStub = {
      isDaemonSynced: sinon.stub().returns({ data: { synced: true } }),
    };

    service = loadService();
  });

  afterEach(() => {
    sinon.restore();
  });

  // Helper: the repository owns the aggregation; the service only weighs its score.
  function setTamperScore(n) {
    tamperingRepositoryStub.sumIncidentSeverities = sinon.stub().resolves(n);
  }

  describe('fetchBlocklist', () => {
    // Fetching, validating and caching belong to policyStore and are covered in
    // policyStore.test.js. Here the service is only responsible for reading the right
    // document and passing its two distinct answers through unchanged.
    it('reads the tamperingBlocklist document', () => {
      setBlocklist(['tx1', 'tx2']);

      expect(service.fetchBlocklist()).to.deep.equal(['tx1', 'tx2']);
      sinon.assert.calledWith(policyStoreStub.get, 'tamperingBlocklist');
    });

    it('passes an empty list through as an empty list', () => {
      setBlocklist([]);

      expect(service.fetchBlocklist()).to.deep.equal([]);
    });

    it('passes "no copy available" through as null, not an empty list', () => {
      setBlocklist(null);

      expect(service.fetchBlocklist()).to.equal(null);
    });
  });

  // The aggregation itself (schema filter, severity summing) belongs to the
  // repository and is covered in appTamperingRepository.test.js. Here the
  // service is only responsible for weighing the score it is handed.
  describe('computeTamperScore', () => {
    it('returns the score the repository reports', async () => {
      setTamperScore(42);

      const result = await service.computeTamperScore();

      expect(result).to.equal(42);
    });

    it('returns 0 when the DB is unavailable (repository reports null)', async () => {
      tamperingRepositoryStub.sumIncidentSeverities = sinon.stub().resolves(null);

      const result = await service.computeTamperScore();

      expect(result).to.equal(0);
    });

    it('returns 0 when the repository throws', async () => {
      tamperingRepositoryStub.sumIncidentSeverities = sinon.stub().rejects(new Error('mongo boom'));

      const result = await service.computeTamperScore();

      expect(result).to.equal(0);
    });
  });

  describe('getMyTxhash', () => {
    it('returns txhash from collateral info', async () => {
      const result = await service.getMyTxhash();

      expect(result).to.equal(MOCK_TXHASH);
    });

    it('returns null if collateral lookup throws', async () => {
      generalServiceStub.obtainNodeCollateralInformation = sinon.stub().rejects(new Error('no daemon'));

      const result = await service.getMyTxhash();

      expect(result).to.be.null;
    });

    it('returns null if collateral info lacks txhash', async () => {
      generalServiceStub.obtainNodeCollateralInformation = sinon.stub().resolves({});

      const result = await service.getMyTxhash();

      expect(result).to.be.null;
    });
  });

  describe('enforceBlocklist', () => {
    it('skips the tick when daemon is not synced', async () => {
      daemonMiscStub.isDaemonSynced = sinon.stub().returns({ data: { synced: false } });

      await service.enforceBlocklist();

      expect(nodeDosStateStub.setStickyDosMessage.called).to.be.false;
      expect(nodeDosStateStub.clearStickyDosMessage.called).to.be.false;
    });

    it('skips when own txhash cannot be determined', async () => {
      generalServiceStub.obtainNodeCollateralInformation = sinon.stub().resolves({});

      await service.enforceBlocklist();

      expect(nodeDosStateStub.setStickyDosMessage.called).to.be.false;
      expect(nodeDosStateStub.clearStickyDosMessage.called).to.be.false;
    });

    it('does nothing when txhash is not on the blocklist', async () => {
      setBlocklist(['otherhash']);
      setTamperScore(100);

      await service.enforceBlocklist();

      expect(nodeDosStateStub.setStickyDosMessage.called).to.be.false;
    });

    it('does nothing when listed but score <= threshold', async () => {
      setBlocklist([MOCK_TXHASH]);
      setTamperScore(10); // threshold is >10, so exactly 10 should NOT trigger

      await service.enforceBlocklist();

      expect(nodeDosStateStub.setStickyDosMessage.called).to.be.false;
    });

    it('sets sticky DOS when listed AND score > threshold', async () => {
      setBlocklist([MOCK_TXHASH]);
      setTamperScore(11);

      await service.enforceBlocklist();

      sinon.assert.calledOnce(nodeDosStateStub.setStickyDosMessage);
      const msg = nodeDosStateStub.setStickyDosMessage.firstCall.args[0];
      expect(msg).to.include(service.DOS_MESSAGE_PREFIX);
      expect(msg).to.include(MOCK_TXHASH);
      expect(msg).to.include('11');
      sinon.assert.calledWith(nodeDosStateStub.setStickyDosStateValue, 100);
      expect(service.isDosActive()).to.be.true;
    });

    it('clears sticky DOS on next tick when condition no longer holds', async () => {
      // First tick: set DOS
      setBlocklist([MOCK_TXHASH]);
      setTamperScore(15);
      await service.enforceBlocklist();
      expect(service.isDosActive()).to.be.true;

      // Second tick: txhash removed from list
      setBlocklist([]);
      await service.enforceBlocklist();

      sinon.assert.called(nodeDosStateStub.clearStickyDosMessage);
      expect(service.isDosActive()).to.be.false;
    });

    it('does NOT clear a sticky DOS when the blocklist cannot be fetched', async () => {
      setBlocklist([MOCK_TXHASH]);
      setTamperScore(15);
      await service.enforceBlocklist();
      expect(service.isDosActive()).to.be.true;

      // An unreadable list must not read as "nobody is listed" — that would release a
      // node the network had deliberately blocked, on nothing worse than a github blip.
      setBlocklist(null);
      await service.enforceBlocklist();

      expect(nodeDosStateStub.clearStickyDosMessage.called).to.be.false;
      expect(service.isDosActive()).to.be.true;
    });

    it('does NOT set a DOS when the blocklist cannot be fetched', async () => {
      setBlocklist(null);
      setTamperScore(100);

      await service.enforceBlocklist();

      expect(nodeDosStateStub.setStickyDosMessage.called).to.be.false;
    });

    it('clears sticky DOS when the score drops to <= threshold', async () => {
      setBlocklist([MOCK_TXHASH]);
      setTamperScore(15);
      await service.enforceBlocklist();
      expect(service.isDosActive()).to.be.true;

      setTamperScore(5);
      await service.enforceBlocklist();

      sinon.assert.called(nodeDosStateStub.clearStickyDosMessage);
      expect(service.isDosActive()).to.be.false;
    });

    it('clears an orphaned sticky DOS message owned by this service', async () => {
      // ourDosActive is false, but sticky owned by us (prefix match) from prior run
      const ours = `${service.DOS_MESSAGE_PREFIX}: 42 events, txhash xyz`;
      nodeDosStateStub.getStickyDosMessage = sinon.stub().returns(ours);
      setBlocklist([]);
      setTamperScore(0);

      await service.enforceBlocklist();

      sinon.assert.called(nodeDosStateStub.clearStickyDosMessage);
    });

    it('does NOT clear a sticky DOS set by a different module', async () => {
      // Some other module set sticky for an unrelated reason
      nodeDosStateStub.getStickyDosMessage = sinon.stub().returns('some other module sticky reason');
      setBlocklist([]);
      setTamperScore(0);

      await service.enforceBlocklist();

      expect(nodeDosStateStub.clearStickyDosMessage.called).to.be.false;
    });
  });

  describe('start/stop cancellation', () => {
    it('an unsynced boot enforces on the first processed block, not a timer', async () => {
      daemonMiscStub.isDaemonSynced = sinon.stub().returns({ data: { synced: false } });
      setBlocklist([MOCK_TXHASH]);
      setTamperScore(100);
      const blockEmitter = new EventEmitter();
      const startPromise = service.start({ blockEmitter });
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(nodeDosStateStub.setStickyDosMessage.called).to.be.false;

      // The chain updates: the poller stamps the level, the block event
      // announces it - and the first tick follows immediately.
      daemonMiscStub.isDaemonSynced = sinon.stub().returns({ data: { synced: true } });
      blockEmitter.emit('blocksProcessed', 100);
      await startPromise;
      expect(nodeDosStateStub.setStickyDosMessage.called).to.be.true;
    });

    it('start() aborts without scheduling an interval if stop() is called during daemon-sync wait', async () => {
      // Daemon never reports synced
      daemonMiscStub.isDaemonSynced = sinon.stub().returns({ data: { synced: false } });
      const setIntervalSpy = sinon.spy(global, 'setInterval');

      // Kick off start() — it will enter waitForDaemonSynced and poll
      const startPromise = service.start();

      // Give the loop a tick to enter the polling wait, then stop
      await new Promise((resolve) => setImmediate(resolve));
      service.stop();

      // Now make daemon report synced so a buggy implementation would proceed
      daemonMiscStub.isDaemonSynced = sinon.stub().returns({ data: { synced: true } });
      await startPromise;

      const twelveH = 12 * 60 * 60 * 1000;
      const scheduled12h = setIntervalSpy.getCalls().some((c) => c.args[1] === twelveH);
      expect(scheduled12h).to.be.false;
    });

    it('stop() clears the interval after it has been installed', async () => {
      // Daemon synced immediately so start() completes quickly
      await service.start();
      // Now interval should be set — stop and assert clearInterval ran
      const clearSpy = sinon.spy(global, 'clearInterval');

      service.stop();

      sinon.assert.called(clearSpy);
    });
  });

  describe('ArcaneOS gating (via fluxbenchd)', () => {
    function makeArcaneService() {
      return loadService(true);
    }

    it('enforceBlocklist is a no-op when bench reports systemsecure=true', async () => {
      const arcaneService = makeArcaneService();
      setBlocklist([MOCK_TXHASH]);
      setTamperScore(100);

      await arcaneService.enforceBlocklist();

      expect(nodeDosStateStub.setStickyDosMessage.called).to.be.false;
      expect(nodeDosStateStub.setStickyDosStateValue.called).to.be.false;
      expect(arcaneService.isDosActive()).to.be.false;
    });

    it('enforceBlocklist does not read blocklist or compute a score when ArcaneOS', async () => {
      const arcaneService = makeArcaneService();

      await arcaneService.enforceBlocklist();

      expect(policyStoreStub.get.called).to.be.false;
      expect(generalServiceStub.obtainNodeCollateralInformation.called).to.be.false;
    });

    it('start() does not install the interval when ArcaneOS', async () => {
      const arcaneService = makeArcaneService();
      const setIntervalSpy = sinon.spy(global, 'setInterval');

      await arcaneService.start();

      const twelveH = 12 * 60 * 60 * 1000;
      const calledWith12h = setIntervalSpy.getCalls().some((c) => c.args[1] === twelveH);
      expect(calledWith12h).to.be.false;
    });

    it('FLUXOS_PATH env var alone does not skip enforcement (spoof guard)', async () => {
      // Simulate a legacy operator trying to bypass by setting FLUXOS_PATH.
      // Benchmark must be the source of truth.
      const originalFluxOSPath = process.env.FLUXOS_PATH;
      process.env.FLUXOS_PATH = '/fake/arcane/path';
      try {
        setBlocklist([MOCK_TXHASH]);
        setTamperScore(100);
        const svc = loadService();

        await svc.enforceBlocklist();

        sinon.assert.calledOnce(nodeDosStateStub.setStickyDosMessage);
      } finally {
        if (originalFluxOSPath !== undefined) process.env.FLUXOS_PATH = originalFluxOSPath;
        else delete process.env.FLUXOS_PATH;
      }
    });
  });
});
