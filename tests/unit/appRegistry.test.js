'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const capabilities = require('../../ZelBack/src/services/utils/capabilities');
const {
  loadSpecLibrary, v8Spec, v9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');

// The spec library is real: every row and message below is one the library
// builds, so expiry is the library's rule and not a stub that agrees with
// itself. What is stubbed is I/O.
describe('appRegistry', () => {
  // What chainState.getScannedHeight() reports: v1-v8 expiry is measured
  // against it, never against wall-clock time.
  const SCANNED_HEIGHT = 1_000_000;
  // The fixture v9 ttl is 30 days, so a term started at this timestamp
  // (2025-07-04) is long past it.
  const LONG_EXPIRED_AT = 1_751_628_800;

  let registry;
  let rows;
  let messages;
  let stubs;

  before(async function loadLibrary() {
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  // A stored legacy message whose spec is `spec`.
  function message(hash, spec) {
    return {
      type: 'fluxappupdate', version: 1, appSpecifications: spec.serialize(), hash, timestamp: 1, signature: 's', txid: `tx-${hash}`, height: 1, valueSat: 1,
    };
  }

  function decision(hash, fields = {}) {
    return {
      hash,
      name: 'myapp',
      decision: 'applied',
      height: 990_000,
      txIndex: 0,
      termStart: Math.floor(Date.now() / 1000),
      uuid: `uuid-${hash}`,
      identity: 'MyApp',
      ...fields,
    };
  }

  beforeEach(() => {
    rows = [];
    messages = [];
    capabilities.resetForTests();
    stubs = {
      '../dbHelper': {
        databaseConnection: () => ({ db: () => ({}) }),
        findInDatabase: sinon.stub().callsFake(async (_db, collection, query) => {
          if (collection === 'zelappsmessages') return messages.filter((m) => query.hash.$in.includes(m.hash));
          return rows;
        }),
        findOneInDatabase: sinon.stub().callsFake(async (_db, _collection, query) => rows.find((row) => query.name.test(row.name)) ?? null),
      },
      '../chainState': {
        getScannedHeight: sinon.stub().resolves(SCANNED_HEIGHT),
        exclusive: sinon.stub().callsFake((fn) => fn()),
      },
      './appsRepository': {
        replaceGlobalAppRow: sinon.stub().resolves(),
        removeGlobalAppInfo: sinon.stub().resolves(),
        removeAppInstallingErrorRecords: sinon.stub().resolves(),
      },
      './registryManager': { storeGlobalSpec: sinon.stub().resolves() },
      '../appLifecycle/contentSlotService': { promoteQuarantinedManifest: sinon.stub().resolves() },
      '../utils/fluxEventBus': { publish: sinon.stub() },
      '../appDecisions/decider': { onDecided: sinon.stub(), onFullPass: sinon.stub() },
      '../appDecisions/decisionStore': {
        appliedFor: sinon.stub().resolves([]),
        latestApplied: sinon.stub().resolves(new Map()),
      },
      '../appMessaging/messageStore': { processPendingUpdates: sinon.stub().resolves() },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    };
    registry = proxyquire('../../ZelBack/src/services/appDatabase/appRegistry', stubs);
  });

  afterEach(() => {
    sinon.restore();
    capabilities.resetForTests();
  });

  describe('sweepExpired', () => {
    it('drops an expired row with its error records, and keeps a live one', async () => {
      rows = [
        (await instantiatedSpec(await v9Spec({ name: 'deadapp' }), { registeredAt: LONG_EXPIRED_AT })).serialize(),
        (await instantiatedSpec(await v9Spec({ name: 'liveapp' }), { registeredAt: Math.floor(Date.now() / 1000) })).serialize(),
      ];

      const result = await registry.sweepExpired();

      expect(result).to.deep.equal({ expired: ['deadapp'], unjudgeable: [] });
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'deadapp');
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeAppInstallingErrorRecords, 'deadapp');
    });

    it('expires a v1-v8 row by the scanned height, not by wall-clock time', async () => {
      // The fixture's expire is 88,000 blocks, measured from each row's height.
      rows = [
        (await instantiatedSpec(await v8Spec({ name: 'deadapp' }), { height: SCANNED_HEIGHT - 88_000 })).serialize(),
        (await instantiatedSpec(await v8Spec({ name: 'liveapp' }), { height: SCANNED_HEIGHT - 87_999 })).serialize(),
      ];

      expect((await registry.sweepExpired()).expired).to.deep.equal(['deadapp']);
    });

    it('stretches a pre-fork term that crosses the PON fork: its blocks after the fork are 30 s, not 2 min', async () => {
      // Bought 10,000 blocks before the fork with 88,000 blocks of expire: 10,000
      // two-minute blocks, then the remaining 78,000 blocks' worth of time as
      // 312,000 thirty-second blocks. Its end is PON + 312,000, not PON + 78,000.
      const PON = 2_020_000;
      rows = [(await instantiatedSpec(await v8Spec({ name: 'crossing' }), { height: PON - 10_000 })).serialize()];

      stubs['../chainState'].getScannedHeight.resolves(PON + 78_000);
      expect((await registry.sweepExpired()).expired, 'alive past the unstretched end').to.deep.equal([]);

      stubs['../chainState'].getScannedHeight.resolves(PON + 312_000);
      expect((await registry.sweepExpired()).expired, 'expired at the stretched end').to.deep.equal(['crossing']);
    });

    it('does not expire a v9 row on height: its clock is time', async () => {
      rows = [(await instantiatedSpec(await v9Spec({ name: 'liveapp' }), { registeredAt: Math.floor(Date.now() / 1000), height: 100_000 })).serialize()];

      expect((await registry.sweepExpired()).expired).to.deep.equal([]);
    });

    it('keeps a row it cannot judge, reports it, and expires every other row in the pass', async () => {
      const bad = (await instantiatedSpec(await v8Spec({ name: 'unjudgeable' }), { height: 1 })).serialize();
      bad.height = 'notaheight';
      rows = [bad, (await instantiatedSpec(await v9Spec({ name: 'deadapp' }), { registeredAt: LONG_EXPIRED_AT })).serialize()];

      const result = await registry.sweepExpired();

      expect(result).to.deep.equal({ expired: ['deadapp'], unjudgeable: ['unjudgeable'] });
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'deadapp');
    });

    it('holds the chain-state lock', async () => {
      await registry.sweepExpired();
      sinon.assert.calledOnce(stubs['../chainState'].exclusive);
    });
  });

  describe('a decided name', () => {
    it('gains a row from its applied registration, with the decision\'s uuid, identity and term start, and its effects run', async () => {
      const spec = await v8Spec({ name: 'MyApp' });
      messages = [message('r', spec)];

      await registry.applyDecided('myapp', [decision('r')]);

      const store = stubs['./registryManager'].storeGlobalSpec;
      sinon.assert.calledOnce(store);
      const [row] = store.firstCall.args;
      expect(row).to.include({
        name: 'MyApp', hash: 'r', height: 990_000, uuid: 'uuid-r', identity: 'MyApp',
      });
      sinon.assert.calledWithMatch(stubs['../utils/fluxEventBus'].publish, 'app:specStored', { name: 'MyApp', hash: 'r' });
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeAppInstallingErrorRecords, 'MyApp');
      // Updates held ahead of the registration are judged now that it exists.
      sinon.assert.calledOnceWithExactly(stubs['../appMessaging/messageStore'].processPendingUpdates, 'MyApp');
    });

    it('moves its row to a later applied message, and replays nothing', async () => {
      const spec = await v8Spec({ name: 'MyApp' });
      messages = [message('u', spec)];
      rows = [{ ...(await instantiatedSpec(spec, { hash: 'r', height: 980_000 })).serialize(), uuid: 'uuid-r', identity: 'MyApp' }];

      await registry.applyDecided('myapp', [decision('u', { uuid: 'uuid-r' })]);

      sinon.assert.calledOnce(stubs['./registryManager'].storeGlobalSpec);
      expect(stubs['./registryManager'].storeGlobalSpec.firstCall.args[0].hash).to.equal('u');
      sinon.assert.notCalled(stubs['../appMessaging/messageStore'].processPendingUpdates);
    });

    it('restamps a row whose message is unchanged without running any effect', async () => {
      const spec = await v8Spec({ name: 'MyApp' });
      messages = [message('r', spec)];
      rows = [(await instantiatedSpec(spec, { hash: 'r', height: 990_000 })).serialize()];

      await registry.applyDecided('myapp', [decision('r')]);

      sinon.assert.calledOnce(stubs['./appsRepository'].replaceGlobalAppRow);
      expect(stubs['./appsRepository'].replaceGlobalAppRow.firstCall.args[0]).to.include({ uuid: 'uuid-r', identity: 'MyApp' });
      sinon.assert.notCalled(stubs['./registryManager'].storeGlobalSpec);
      sinon.assert.notCalled(stubs['../utils/fluxEventBus'].publish);
    });

    it('stands on the latest applied decision in chain order, stored or made in this run', async () => {
      const spec = await v8Spec({ name: 'MyApp' });
      messages = [message('stored-later', spec), message('run-earlier', spec)];
      stubs['../appDecisions/decisionStore'].appliedFor.resolves([decision('stored-later', { height: 990_100 })]);

      await registry.applyDecided('myapp', [decision('run-earlier', { height: 990_000 })]);

      expect(stubs['./registryManager'].storeGlobalSpec.firstCall.args[0].hash).to.equal('stored-later');
    });

    it('reads this run\'s decision over a stored one for the same message', async () => {
      const spec = await v8Spec({ name: 'MyApp' });
      messages = [message('r', spec)];
      rows = [(await instantiatedSpec(spec, { hash: 'r', height: 990_000 })).serialize()];
      stubs['../appDecisions/decisionStore'].appliedFor.resolves([decision('r')]);

      // The message is refused on this run: the name has no applied message.
      await registry.applyDecided('myapp', [decision('r', { decision: 'refused', reason: 'unauthorized' })]);

      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'myapp');
    });

    it('loses its row when its latest applied app has expired', async () => {
      const spec = await v9Spec({ name: 'myapp' });
      messages = [message('r', spec)];
      rows = [(await instantiatedSpec(spec, { hash: 'r', registeredAt: LONG_EXPIRED_AT })).serialize()];

      await registry.applyDecided('myapp', [decision('r', { termStart: LONG_EXPIRED_AT })]);

      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'myapp');
      sinon.assert.notCalled(stubs['./registryManager'].storeGlobalSpec);
    });
  });

  describe('reconcile', () => {
    it('writes every row the decisions stand for, removes every row they do not, and raises the capability', async () => {
      const spec = await v8Spec({ name: 'MyApp' });
      messages = [message('r', spec)];
      rows = [(await instantiatedSpec(await v8Spec({ name: 'claimcalc' }), { hash: 'old' })).serialize()];
      stubs['../appDecisions/decisionStore'].latestApplied.resolves(new Map([['myapp', decision('r')]]));
      capabilities.setForTests(['explorerSynced', 'appMessagesSynced'], true);

      await registry.reconcile();

      expect(stubs['./registryManager'].storeGlobalSpec.firstCall.args[0].name).to.equal('MyApp');
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'claimcalc');
      sinon.assert.calledOnce(stubs['../chainState'].exclusive);
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(true);
    });
  });

  describe('reconcile before the scan has caught up', () => {
    it('writes and removes nothing, and leaves the capability down', async () => {
      rows = [(await instantiatedSpec(await v8Spec({ name: 'recent' }), { hash: 'r' })).serialize()];
      capabilities.setForTests('appMessagesSynced', true);

      await registry.reconcile();

      sinon.assert.notCalled(stubs['../appDecisions/decisionStore'].latestApplied);
      sinon.assert.notCalled(stubs['./appsRepository'].removeGlobalAppInfo);
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(false);
    });
  });

  describe('start', () => {
    it('follows the decider, and goes down while chain state rewinds', async () => {
      capabilities.setForTests(['explorerSynced', 'appMessagesSynced'], true);
      registry.start();
      sinon.assert.calledOnceWithExactly(stubs['../appDecisions/decider'].onDecided, registry.applyDecided);
      sinon.assert.calledOnceWithExactly(stubs['../appDecisions/decider'].onFullPass, registry.reconcile);
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(false);

      await registry.reconcile();
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(true);

      capabilities.setForTests('chainStateConsistent', false);
      capabilities.setForTests('chainStateConsistent', true);
      expect(capabilities.isUp('appRegistryConsistent'), 'down until the next reconcile').to.equal(false);
    });
  });
});
