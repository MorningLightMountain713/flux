'use strict';

const { expect } = require('chai');

// Every module that requires globalState binds the instance it was handed at
// load, and mocha loads every test file before it runs any test. So swapping the
// cache entry for a fresh instance leaves this file talking to an object nothing
// else in the process holds - and a later file that requires globalState reads
// THAT one while the code it is testing still writes to the original. The entry
// is therefore put back after every test.
const globalStatePath = require.resolve('../../ZelBack/src/services/utils/globalState');
require('../../ZelBack/src/services/utils/globalState');
const liveGlobalStateEntry = require.cache[globalStatePath];

describe('globalState tests', () => {
  let globalState;

  beforeEach(() => {
    // Clear the module cache to get a fresh instance for each test
    delete require.cache[globalStatePath];
    globalState = require('../../ZelBack/src/services/utils/globalState');
  });

  afterEach(() => {
    require.cache[globalStatePath] = liveGlobalStateEntry;
  });

  // A forced removal skips the single-removal guard, so two broadcast removals of one
  // identity can overlap; the first to finish must not hand the claim back to the one
  // still running.
  describe('departingApps', () => {
    afterEach(() => globalState.departingApps.clear());

    it('holds an identity until every removal of it has finished', () => {
      const { departingApps } = globalState;
      departingApps.enter('app');
      departingApps.enter('app');
      departingApps.leave('app');
      expect(departingApps.has('app'), 'the first removal to finish released the second one\'s mark').to.equal(true);
      departingApps.leave('app');
      expect(departingApps.has('app')).to.equal(false);
    });

    it('holds a replica without holding its siblings, and the whole app holds every replica', () => {
      const { departingApps } = globalState;
      departingApps.enter('app', 's1');
      expect(departingApps.has('app', 's1')).to.equal(true);
      expect(departingApps.has('app', 's2')).to.equal(false);
      expect(departingApps.has('app'), 'one replica leaving is not the app leaving').to.equal(false);
      departingApps.enter('app');
      expect(departingApps.has('app', 's2')).to.equal(true);
    });

    it('ignores a leave with nothing entered', () => {
      globalState.departingApps.leave('never');
      expect(globalState.departingApps.size).to.equal(0);
    });
  });

  describe('waitForPolicyReady tests', () => {
    afterEach(() => { globalState.policyReady = false; });

    it('waits while the policy is unobtained', async () => {
      let resolved = false;
      globalState.waitForPolicyReady().then(() => { resolved = true; });

      await new Promise((r) => setImmediate(r));

      expect(globalState.policyReady).to.equal(false);
      expect(resolved, 'a node without policy must not be released').to.equal(false);
    });

    it('releases a caller already waiting when the policy arrives', async () => {
      let resolved = false;
      const waiting = globalState.waitForPolicyReady().then(() => { resolved = true; });

      globalState.policyReady = true;
      await waiting;

      expect(resolved).to.equal(true);
    });

    it('releases a caller that arrives after the policy did', async () => {
      globalState.policyReady = true;

      await globalState.waitForPolicyReady();

      expect(globalState.policyReady).to.equal(true);
    });
  });

  describe('runningAppsCache tests', () => {
    it('should be a Set', () => {
      expect(globalState.runningAppsCache).to.be.instanceOf(Set);
    });

    it('should be empty by default', () => {
      expect(globalState.runningAppsCache.size).to.equal(0);
    });

    it('should allow adding app names', () => {
      globalState.runningAppsCache.add('app1');
      globalState.runningAppsCache.add('app2');

      expect(globalState.runningAppsCache.size).to.equal(2);
      expect(globalState.runningAppsCache.has('app1')).to.equal(true);
      expect(globalState.runningAppsCache.has('app2')).to.equal(true);
    });

    it('should not duplicate app names', () => {
      globalState.runningAppsCache.add('app1');
      globalState.runningAppsCache.add('app1');
      globalState.runningAppsCache.add('app1');

      expect(globalState.runningAppsCache.size).to.equal(1);
    });

    it('should allow removing app names', () => {
      globalState.runningAppsCache.add('app1');
      globalState.runningAppsCache.add('app2');

      globalState.runningAppsCache.delete('app1');

      expect(globalState.runningAppsCache.size).to.equal(1);
      expect(globalState.runningAppsCache.has('app1')).to.equal(false);
      expect(globalState.runningAppsCache.has('app2')).to.equal(true);
    });

    it('should allow clearing all app names', () => {
      globalState.runningAppsCache.add('app1');
      globalState.runningAppsCache.add('app2');
      globalState.runningAppsCache.add('app3');

      globalState.runningAppsCache.clear();

      expect(globalState.runningAppsCache.size).to.equal(0);
    });

    it('should be iterable', () => {
      globalState.runningAppsCache.add('app1');
      globalState.runningAppsCache.add('app2');
      globalState.runningAppsCache.add('app3');

      const apps = [];
      globalState.runningAppsCache.forEach((app) => {
        apps.push(app);
      });

      expect(apps).to.have.members(['app1', 'app2', 'app3']);
    });

    it('should check if app exists with has()', () => {
      globalState.runningAppsCache.add('existingApp');

      expect(globalState.runningAppsCache.has('existingApp')).to.equal(true);
      expect(globalState.runningAppsCache.has('nonExistingApp')).to.equal(false);
    });
  });

  describe('cache collections tests', () => {
    it('should have empty collections by default', () => {
      expect(globalState.appsToBeCheckedLater).to.be.an('array').that.is.empty;
      expect(globalState.appsSyncthingToBeCheckedLater).to.be.an('array').that.is.empty;
      expect(globalState.receiveOnlySyncthingAppsCache).to.be.instanceOf(Map);
      expect(globalState.syncthingDevicesIDCache).to.be.instanceOf(Map);
      expect(globalState.folderHealthCache).to.be.instanceOf(Map);
    });

    it('should allow modifying appsToBeCheckedLater', () => {
      globalState.appsToBeCheckedLater.push('app1');
      globalState.appsToBeCheckedLater.push('app2');

      expect(globalState.appsToBeCheckedLater).to.have.lengthOf(2);
      expect(globalState.appsToBeCheckedLater).to.include('app1');
    });
  });

  describe('waitForDbReady', () => {
    it('should resolve immediately when dbReady is already true', async () => {
      globalState.dbReady = true;
      await globalState.waitForDbReady();
    });

    it('should wait until dbReady is set to true', async () => {
      globalState.dbReady = false;
      let resolved = false;
      const promise = globalState.waitForDbReady().then(() => { resolved = true; });
      await new Promise((r) => setImmediate(r));
      expect(resolved).to.equal(false);
      globalState.dbReady = true;
      await promise;
      expect(resolved).to.equal(true);
    });

    it('should resolve again after a reset cycle', async () => {
      globalState.dbReady = true;
      await globalState.waitForDbReady();

      globalState.dbReady = false;
      let resolved = false;
      const promise = globalState.waitForDbReady().then(() => { resolved = true; });
      await new Promise((r) => setImmediate(r));
      expect(resolved).to.equal(false);
      globalState.dbReady = true;
      await promise;
      expect(resolved).to.equal(true);
    });
  });

  describe('waitForDaemonReady', () => {
    it('should resolve immediately when daemonReady is already true', async () => {
      globalState.daemonReady = true;
      await globalState.waitForDaemonReady();
    });

    it('should wait until daemonReady is set to true', async () => {
      let resolved = false;
      const promise = globalState.waitForDaemonReady().then(() => { resolved = true; });
      await new Promise((r) => setImmediate(r));
      expect(resolved).to.equal(false);
      globalState.daemonReady = true;
      await promise;
      expect(resolved).to.equal(true);
    });
  });

  describe('waitForBootContainerStateSettled', () => {
    it('should resolve immediately when bootContainerStateSettled is already true', async () => {
      globalState.bootContainerStateSettled = true;
      await globalState.waitForBootContainerStateSettled();
    });

    it('should wait until bootContainerStateSettled is set to true', async () => {
      let resolved = false;
      const promise = globalState.waitForBootContainerStateSettled().then(() => { resolved = true; });
      await new Promise((r) => setImmediate(r));
      expect(resolved).to.equal(false);
      globalState.bootContainerStateSettled = true;
      await promise;
      expect(resolved).to.equal(true);
    });
  });

  describe('in-flight install abort registry (cancel-vs-install)', () => {
    it('installingApps is a Map', () => {
      expect(globalState.installingApps).to.be.instanceOf(Map);
    });

    it('installAborted is false when no install is registered', () => {
      expect(globalState.installAborted('app')).to.equal(false);
    });

    it('installAborted is false for a registered-but-not-aborted install', () => {
      globalState.installingApps.set('app', new AbortController());
      expect(globalState.installAborted('app')).to.equal(false);
    });

    it('abortInstall latches the signal so installAborted then reports true', () => {
      const controller = new AbortController();
      globalState.installingApps.set('app', controller);
      expect(globalState.abortInstall('app'), 'aborted an in-flight install').to.equal(true);
      expect(controller.signal.aborted, 'the signal latched').to.equal(true);
      expect(globalState.installAborted('app'), 'observable from the install catch').to.equal(true);
    });

    it('abortInstall is a no-op (returns false) when nothing is in flight', () => {
      expect(globalState.abortInstall('ghost')).to.equal(false);
    });
  });
});
