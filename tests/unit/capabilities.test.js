'use strict';

const { expect } = require('chai');

const capabilities = require('../../ZelBack/src/services/utils/capabilities');

const { STATE } = capabilities;

describe('capabilities tests', () => {
  beforeEach(() => capabilities.resetForTests());
  after(() => capabilities.resetForTests());

  describe('the table', () => {
    it('names every prerequisite as a capability and has no cycle', () => {
      const names = new Set(capabilities.DEFINITIONS.map((d) => d.name));
      const visiting = new Set();
      const done = new Set();
      const visit = (name) => {
        expect(names.has(name), `unknown prerequisite ${name}`).to.equal(true);
        if (done.has(name)) return;
        expect(visiting.has(name), `cycle through ${name}`).to.equal(false);
        visiting.add(name);
        capabilities.DEFINITIONS.find((d) => d.name === name).needs.forEach(visit);
        visiting.delete(name);
        done.add(name);
      };
      names.forEach(visit);
    });

    it('lists each capability once', () => {
      const names = capabilities.DEFINITIONS.map((d) => d.name);
      expect(new Set(names).size).to.equal(names.length);
    });
  });

  describe('claim', () => {
    it('gives the same owner the same handle on a repeat claim', () => {
      const first = capabilities.claim('mongoReachable', 'serviceManager');
      const second = capabilities.claim('mongoReachable', 'serviceManager');
      expect(second).to.equal(first);
    });

    it('refuses a claim by anyone but the owner', () => {
      expect(() => capabilities.claim('mongoReachable', 'explorerService')).to.throw(/owned by serviceManager/);
    });

    it('refuses an unknown capability', () => {
      expect(() => capabilities.claim('nothing', 'serviceManager')).to.throw(/no capability/);
    });
  });

  describe('states', () => {
    it('is down until raised, coming-up while starting, up once raised', () => {
      const handle = capabilities.claim('mongoReachable', 'serviceManager');
      expect(capabilities.stateOf('mongoReachable')).to.equal(STATE.DOWN);
      handle.starting('probing');
      expect(capabilities.stateOf('mongoReachable')).to.equal(STATE.COMING_UP);
      expect(capabilities.isUp('mongoReachable')).to.equal(false);
      handle.raise('answered');
      expect(capabilities.isUp('mongoReachable')).to.equal(true);
      handle.lower('probe failed');
      expect(capabilities.stateOf('mongoReachable')).to.equal(STATE.DOWN);
    });

    it('holds a raised capability coming-up while a prerequisite is down, and brings it up with it', () => {
      const mongo = capabilities.claim('mongoReachable', 'serviceManager');
      const localDb = capabilities.claim('localDbPrepared', 'serviceManager');
      localDb.raise('indexes prepared');
      expect(capabilities.stateOf('localDbPrepared')).to.equal(STATE.COMING_UP);
      mongo.raise('answered');
      expect(capabilities.isUp('localDbPrepared')).to.equal(true);
    });

    it('takes every dependent down with a prerequisite, through the chain', () => {
      capabilities.claim('mongoReachable', 'serviceManager').raise('up');
      const chain = capabilities.claim('chainStateConsistent', 'chainState');
      const synced = capabilities.claim('explorerSynced', 'explorerService');
      const messages = capabilities.claim('appMessagesSynced', 'appSyncOrchestrator');
      const registry = capabilities.claim('appRegistryConsistent', 'appRegistry');
      [chain, synced, messages, registry].forEach((h) => h.raise('up'));
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(true);

      chain.lower('rewind');
      expect(capabilities.isUp('explorerSynced')).to.equal(false);
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(false);
      expect(capabilities.isUp('appMessagesSynced'), 'a rewind loses no messages').to.equal(true);

      chain.raise('rebuilt');
      expect(capabilities.isUp('appRegistryConsistent')).to.equal(true);
    });

    // Nothing is installed while the boot is still deciding what this node keeps.
    it('holds the spawner coming-up until the boot has decided, and brings it up then', () => {
      capabilities.claim('mongoReachable', 'serviceManager').raise('up');
      capabilities.claim('dockerReachable', 'serviceManager').raise('up');
      const spawner = capabilities.claim('spawnerReady', 'appSyncOrchestrator');
      const boot = capabilities.claim('bootReconcileDecided', 'appStartupManager');
      const ups = [];
      capabilities.onUp('spawnerReady', () => ups.push('up'));

      spawner.raise('orchestrator READY');
      expect(capabilities.stateOf('spawnerReady')).to.equal(STATE.COMING_UP);
      expect(ups).to.deep.equal([]);

      boot.raise('decided');
      expect(capabilities.isUp('spawnerReady')).to.equal(true);
      expect(ups).to.deep.equal(['up']);
    });

    it('does not bring back a dependent its owner lowered', () => {
      const mongo = capabilities.claim('mongoReachable', 'serviceManager');
      const localDb = capabilities.claim('localDbPrepared', 'serviceManager');
      mongo.raise('up');
      localDb.raise('up');
      mongo.lower('down');
      localDb.lower('owner lowered');
      mongo.raise('up again');
      expect(capabilities.isUp('localDbPrepared')).to.equal(false);
    });
  });

  describe('conditional capabilities', () => {
    it('is absent, and missing from the snapshot, until its owner claims it', () => {
      expect(capabilities.isPresent('upnpMapped')).to.equal(false);
      expect(capabilities.snapshot().map((s) => s.name)).not.to.include('upnpMapped');
      capabilities.claim('upnpMapped', 'upnpService');
      expect(capabilities.isPresent('upnpMapped')).to.equal(true);
      expect(capabilities.snapshot().map((s) => s.name)).to.include('upnpMapped');
    });
  });

  describe('readers', () => {
    it('resolves whenUp for a set only once every member is up together', async () => {
      const mongo = capabilities.claim('mongoReachable', 'serviceManager');
      const docker = capabilities.claim('dockerReachable', 'serviceManager');
      let resolved = false;
      const waiting = capabilities.whenUp(['mongoReachable', 'dockerReachable']).then(() => { resolved = true; });
      mongo.raise('up');
      await Promise.resolve();
      expect(resolved).to.equal(false);
      docker.raise('up');
      await waiting;
      expect(resolved).to.equal(true);
    });

    it('resolves whenUp at once when already up', async () => {
      capabilities.claim('mongoReachable', 'serviceManager').raise('up');
      await capabilities.whenUp('mongoReachable');
    });

    it('names the first member of a set that is not up', () => {
      capabilities.claim('mongoReachable', 'serviceManager').raise('up');
      expect(capabilities.firstNotUp(['mongoReachable', 'dockerReachable'])).to.equal('dockerReachable');
      expect(capabilities.firstNotUp(['mongoReachable'])).to.equal(null);
    });

    it('runs onFirstUp once per process, at once if already up', () => {
      const mongo = capabilities.claim('mongoReachable', 'serviceManager');
      let calls = 0;
      capabilities.onFirstUp('mongoReachable', () => { calls += 1; });
      mongo.raise('up');
      mongo.lower('down');
      mongo.raise('up again');
      expect(calls).to.equal(1);
      capabilities.onFirstUp('mongoReachable', () => { calls += 1; });
      expect(calls).to.equal(2);
    });

    it('reports each transition to onTransition until unsubscribed', () => {
      const mongo = capabilities.claim('mongoReachable', 'serviceManager');
      const seen = [];
      const off = capabilities.onTransition('mongoReachable', (r) => seen.push(r.to));
      mongo.starting('probing');
      mongo.raise('up');
      off();
      mongo.lower('down');
      expect(seen).to.deep.equal([STATE.COMING_UP, STATE.UP]);
    });

    it('reports only the up and down edges to onUp and onDown', () => {
      const mongo = capabilities.claim('mongoReachable', 'serviceManager');
      const localDb = capabilities.claim('localDbPrepared', 'serviceManager');
      const seen = [];
      capabilities.onUp('localDbPrepared', () => seen.push(true));
      capabilities.onDown('localDbPrepared', () => seen.push(false));
      localDb.starting('preparing');
      localDb.raise('prepared');
      mongo.raise('up');
      mongo.lower('down');
      localDb.lower('owner lowered');
      expect(seen).to.deep.equal([true, false]);
    });

    it('records a transition with what it waited on', () => {
      capabilities.claim('localDbPrepared', 'serviceManager').raise('prepared');
      const record = capabilities.transitions().find((t) => t.name === 'localDbPrepared');
      expect(record.to).to.equal(STATE.COMING_UP);
      expect(record.waitingOn).to.equal('mongoReachable');
      const snap = capabilities.snapshot().find((s) => s.name === 'localDbPrepared');
      expect(snap.waitingOn).to.equal('mongoReachable');
    });
  });
});
