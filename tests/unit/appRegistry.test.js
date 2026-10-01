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
  // What chainState.getScannedHeight() reports, and its block's time: every
  // term is measured against them, never against this node's clock.
  const SCANNED_HEIGHT = 1_000_000;
  const NOW = Math.floor(Date.now() / 1000);
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
        onBlockScanned: sinon.stub(),
        onRewind: sinon.stub(),
      },
      '../appMessaging/confirmedMessageStore': { lookupBlockTime: sinon.stub().resolves(NOW) },
      './appsRepository': {
        replaceGlobalAppRow: sinon.stub().resolves(),
        removeGlobalAppInfo: sinon.stub().resolves(),
        removeAppInstallingErrorRecords: sinon.stub().resolves(),
        removeContentManifests: sinon.stub().resolves(),
      },
      './registryManager': { storeGlobalSpec: sinon.stub().resolves() },
      '../appLifecycle/contentSlotService': { promoteQuarantinedManifest: sinon.stub().resolves() },
      '../appMesh/foundingCommittee': { forget: sinon.stub().resolves(), retract: sinon.stub().resolves() },
      '../utils/fluxEventBus': { publish: sinon.stub() },
      '../appDecisions/decider': { onDecided: sinon.stub(), onFullPass: sinon.stub() },
      '../appDecisions/decisionStore': {
        appliedFor: sinon.stub().resolves([]),
        latestApplied: sinon.stub().resolves(new Map()),
      },
      '../appMessaging/messageStore': { processPendingUpdates: sinon.stub().resolves(), rejudgeGenerationRecords: sinon.stub().resolves() },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    };
    registry = proxyquire('../../ZelBack/src/services/appDatabase/appRegistry', stubs);
  });

  afterEach(() => {
    sinon.restore();
    capabilities.resetForTests();
  });

  /**
   * Lists apps through a reconcile, each from its own applied decision, and
   * raises the capability.
   * @param {Array<{name: string, spec: object, fields?: object}>} apps
   */
  async function listed(apps) {
    const applied = new Map();
    for (const { name, spec, fields } of apps) {
      messages.push(message(name, spec));
      applied.set(name, decision(name, { name, ...fields }));
    }
    stubs['../appDecisions/decisionStore'].latestApplied.resolves(applied);
    capabilities.setForTests(['explorerSynced', 'appMessagesSynced'], true);
    await registry.reconcile();
    stubs['./appsRepository'].removeGlobalAppInfo.resetHistory();
    stubs['./appsRepository'].removeAppInstallingErrorRecords.resetHistory();
  }

  describe('a scanned block', () => {
    it('drops a row once, at the block its term ends, with its error records, tells the listeners, and keeps a live one', async () => {
      await listed([
        { name: 'deadapp', spec: await v9Spec({ name: 'deadapp' }), fields: { termStart: NOW - 30 * 86_400 + 60 } },
        { name: 'liveapp', spec: await v9Spec({ name: 'liveapp' }) },
      ]);
      const removed = sinon.stub();
      registry.onRemoved(removed);

      await registry.blockScanned({ height: SCANNED_HEIGHT + 2, time: NOW + 61 });
      await registry.blockScanned({ height: SCANNED_HEIGHT + 3, time: NOW + 91 });
      await new Promise((resolve) => { setImmediate(resolve); });

      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'deadapp');
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeAppInstallingErrorRecords, 'deadapp');
      sinon.assert.calledOnceWithExactly(removed, 'deadapp');
    });

    it('keeps a v9 row until the first block whose time is past its term end', async () => {
      await listed([{ name: 'deadapp', spec: await v9Spec({ name: 'deadapp' }), fields: { termStart: NOW - 30 * 86_400 + 60 } }]);

      await registry.blockScanned({ height: SCANNED_HEIGHT + 1_000_000, time: NOW + 60 });
      sinon.assert.notCalled(stubs['./appsRepository'].removeGlobalAppInfo);

      await registry.blockScanned({ height: SCANNED_HEIGHT + 1_000_001, time: NOW + 61 });
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'deadapp');
    });

    it('ends a v1-v8 term at the block height it runs to, whatever the block time', async () => {
      // The fixture's expire is 88,000 blocks, measured from the row's height.
      await listed([{ name: 'deadapp', spec: await v8Spec({ name: 'deadapp' }), fields: { height: SCANNED_HEIGHT - 87_999 } }]);

      await registry.blockScanned({ height: SCANNED_HEIGHT, time: NOW + 10 ** 9 });
      sinon.assert.notCalled(stubs['./appsRepository'].removeGlobalAppInfo);

      await registry.blockScanned({ height: SCANNED_HEIGHT + 1, time: NOW });
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'deadapp');
    });

    it('stretches a pre-fork term that crosses the PON fork: its blocks after the fork are 30 s, not 2 min', async () => {
      // Bought 10,000 blocks before the fork with 88,000 blocks of expire: 10,000
      // two-minute blocks, then the remaining 78,000 blocks' worth of time as
      // 312,000 thirty-second blocks. Its end is PON + 312,000, not PON + 78,000.
      const PON = 2_020_000;
      stubs['../chainState'].getScannedHeight.resolves(PON);
      await listed([{ name: 'crossing', spec: await v8Spec({ name: 'crossing' }), fields: { height: PON - 10_000 } }]);

      await registry.blockScanned({ height: PON + 78_000, time: NOW });
      sinon.assert.notCalled(stubs['./appsRepository'].removeGlobalAppInfo);

      await registry.blockScanned({ height: PON + 312_000, time: NOW });
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'crossing');
    });

    it('keeps a row it cannot judge and drops every other ended row', async () => {
      const bad = await v9Spec({ name: 'unjudgeable' });
      await listed([
        { name: 'unjudgeable', spec: bad, fields: { termStart: null } },
        { name: 'deadapp', spec: await v9Spec({ name: 'deadapp' }), fields: { termStart: NOW - 30 * 86_400 } },
      ]);
      sinon.assert.calledWithMatch(stubs['./registryManager'].storeGlobalSpec, { name: 'unjudgeable' });

      await registry.blockScanned({ height: SCANNED_HEIGHT + 1, time: NOW + 1 });

      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'deadapp');
    });

    it('drops nothing while the list is not consistent', async () => {
      await listed([{ name: 'deadapp', spec: await v9Spec({ name: 'deadapp' }), fields: { termStart: NOW - 30 * 86_400 + 60 } }]);
      capabilities.setForTests('chainStateConsistent', false);

      await registry.blockScanned({ height: SCANNED_HEIGHT + 1, time: NOW + 61 });

      sinon.assert.notCalled(stubs['./appsRepository'].removeGlobalAppInfo);
    });
  });

  describe('the clock a row is judged by', () => {
    it('is the scanned block\'s time, not this node\'s clock', async () => {
      // Past its term by this node's clock, inside it at the scanned block.
      const blockTime = LONG_EXPIRED_AT + 86_400;
      stubs['../appMessaging/confirmedMessageStore'].lookupBlockTime.resolves(blockTime);
      const spec = await v9Spec({ name: 'myapp' });
      messages = [message('r', spec)];

      await registry.applyDecided('myapp', [decision('r', { termStart: LONG_EXPIRED_AT })]);

      sinon.assert.calledOnceWithExactly(stubs['../appMessaging/confirmedMessageStore'].lookupBlockTime, SCANNED_HEIGHT);
      sinon.assert.calledOnce(stubs['./registryManager'].storeGlobalSpec);
    });

    it('is the last block the scan reported, and is read from the cursor again after a rewind', async () => {
      registry.start();
      const [[onRewind]] = stubs['../chainState'].onRewind.args;
      const spec = await v9Spec({ name: 'myapp' });
      messages = [message('r', spec)];

      await registry.blockScanned({ height: SCANNED_HEIGHT + 1, time: NOW });
      await registry.applyDecided('myapp', [decision('r')]);
      sinon.assert.notCalled(stubs['../appMessaging/confirmedMessageStore'].lookupBlockTime);

      onRewind(SCANNED_HEIGHT - 10);
      await registry.applyDecided('myapp', [decision('r')]);
      sinon.assert.calledOnce(stubs['../appMessaging/confirmedMessageStore'].lookupBlockTime);
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
      // A content manifest held for this app's identity is promoted now that its row exists.
      await new Promise((resolve) => { setImmediate(resolve); });
      sinon.assert.calledOnceWithExactly(stubs['../appLifecycle/contentSlotService'].promoteQuarantinedManifest, 'MyApp');
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

    it('a row written with a new owner has its generation records judged again and asked for; the same owner does not', async () => {
      const seller = await v8Spec({ name: 'MyApp' });
      const buyer = await v8Spec({ name: 'MyApp', owner: '1F1tAaz5x1HUXrCNLbtMDqcw6o5GNn4xqX' });
      messages = [message('t', buyer), message('u', seller)];
      rows = [{ ...(await instantiatedSpec(seller, { hash: 'r', height: 980_000 })).serialize(), uuid: 'uuid-r', identity: 'MyApp' }];

      await registry.applyDecided('myapp', [decision('u', { uuid: 'uuid-r' })]);
      await new Promise((resolve) => { setImmediate(resolve); });
      sinon.assert.notCalled(stubs['../appMessaging/messageStore'].rejudgeGenerationRecords);

      await registry.applyDecided('myapp', [decision('t', { uuid: 'uuid-r' })]);
      await new Promise((resolve) => { setImmediate(resolve); });
      sinon.assert.calledOnceWithExactly(stubs['../appMessaging/messageStore'].rejudgeGenerationRecords, 'MyApp');
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

      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeGlobalAppInfo, 'MyApp');
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

  describe('the founding record and content manifests follow the row', () => {
    it('is forgotten when the app leaves the list', async () => {
      await listed([{ name: 'deadapp', spec: await v9Spec({ name: 'deadapp' }), fields: { termStart: NOW - 30 * 86_400, identity: 'aaaaaaaaaaaa' } }]);
      stubs['../appMesh/foundingCommittee'].forget.resetHistory();

      await registry.blockScanned({ height: SCANNED_HEIGHT + 1, time: NOW + 1 });

      sinon.assert.calledOnceWithExactly(stubs['../appMesh/foundingCommittee'].forget, 'aaaaaaaaaaaa');
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeContentManifests, 'aaaaaaaaaaaa');
    });

    it('is forgotten when another app takes the name', async () => {
      const spec = await v9Spec({ name: 'myapp' });
      messages = [message('new', spec)];
      rows = [{ ...(await instantiatedSpec(spec, { hash: 'old', height: 980_000 })).serialize(), identity: 'aaaaaaaaaaaa' }];

      await registry.applyDecided('myapp', [decision('new', { identity: 'bbbbbbbbbbbb', height: 990_000 })]);

      sinon.assert.calledOnceWithExactly(stubs['../appMesh/foundingCommittee'].forget, 'aaaaaaaaaaaa');
      sinon.assert.calledOnceWithExactly(stubs['./appsRepository'].removeContentManifests, 'aaaaaaaaaaaa');
      sinon.assert.notCalled(stubs['../appMesh/foundingCommittee'].retract);
    });

    it('promotes a content manifest held for the app by its identity, not its name', async () => {
      const spec = await v9Spec({ name: 'myapp' });
      messages = [message('r', spec)];
      const identity = `b${'d'.repeat(52)}`;

      await registry.applyDecided('myapp', [decision('r', { identity })]);
      await new Promise((resolve) => { setImmediate(resolve); });

      sinon.assert.calledOnceWithExactly(stubs['../appLifecycle/contentSlotService'].promoteQuarantinedManifest, identity);
    });

    it('is wound back when the app goes back to an earlier spec, and left alone when it moves forward', async () => {
      const spec = await v9Spec({ name: 'myapp' });
      messages = [message('earlier', spec), message('later', spec)];
      rows = [{ ...(await instantiatedSpec(spec, { hash: 'refused-later', height: 995_000 })).serialize(), identity: 'aaaaaaaaaaaa' }];

      await registry.applyDecided('myapp', [decision('earlier', { identity: 'aaaaaaaaaaaa', height: 990_000 })]);
      sinon.assert.calledOnceWithExactly(stubs['../appMesh/foundingCommittee'].retract, 'aaaaaaaaaaaa', 990_000);

      rows = [{ ...(await instantiatedSpec(spec, { hash: 'earlier', height: 990_000 })).serialize(), identity: 'aaaaaaaaaaaa' }];
      await registry.applyDecided('myapp', [decision('later', { identity: 'aaaaaaaaaaaa', height: 999_000 })]);
      sinon.assert.calledOnce(stubs['../appMesh/foundingCommittee'].retract);
      sinon.assert.notCalled(stubs['../appMesh/foundingCommittee'].forget);
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
      sinon.assert.calledOnceWithExactly(stubs['../chainState'].onBlockScanned, registry.blockScanned);
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(false);

      await registry.reconcile();
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(true);

      capabilities.setForTests('chainStateConsistent', false);
      capabilities.setForTests('chainStateConsistent', true);
      expect(capabilities.isUp('appRegistryConsistent'), 'down until the next reconcile').to.equal(false);
    });
  });
});
