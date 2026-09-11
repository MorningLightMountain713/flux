'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const residentialNodeDosService = require('../../ZelBack/src/services/residentialNodeDosService');
const appEvacuationSafety = require('../../ZelBack/src/services/appLifecycle/appEvacuationSafety');
const appUninstaller = require('../../ZelBack/src/services/appLifecycle/appUninstaller');
const appReconciler = require('../../ZelBack/src/services/appMonitoring/appReconciler');
const appGiveUp = require('../../ZelBack/src/services/appLifecycle/appGiveUp');

chai.use(chaiAsPromised);
const { expect } = chai;

describe('appGiveUp - handing an app back', () => {
  const LOCAL = '1.2.3.4:16127';
  let publish;
  let uninstall;
  let noteEvacuated;
  let mayEvacuate;
  let safety;

  const deps = () => ({
    installedAppsFn: async () => ({ status: 'success', data: [{ name: 'appone' }, { name: 'apptwo' }] }),
    isElectedPrimary: async () => false,
    runningLocally: async () => false,
  });

  const ok = { ok: true, code: 'READY', reason: 'its turn' };
  const notYet = { ok: false, code: 'DEPARTURE_INTERVAL', reason: 'next departure in 12m' };
  const safe = { safe: true, code: 'SYNCED_ELSEWHERE', reason: '1 synced component held by a peer' };

  const eventsOf = (name) => publish.getCalls()
    .filter((c) => c.args[0] === name).map((c) => c.args[1]);

  beforeEach(() => {
    operationRegistry.clear();
    publish = sinon.stub(fluxEventBus, 'publish');
    sinon.stub(residentialNodeDosService, 'isEvacuating').returns(true);
    sinon.stub(residentialNodeDosService, 'listInstalledApps').resolves(['appone', 'apptwo']);
    mayEvacuate = sinon.stub(residentialNodeDosService, 'mayEvacuateApp').returns(ok);
    noteEvacuated = sinon.stub(residentialNodeDosService, 'noteEvacuated');
    sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(LOCAL);
    sinon.stub(registryManager, 'appLocation').resolves([{ ip: LOCAL }, { ip: '5.6.7.8:16127' }]);
    sinon.stub(appsRepository, 'getInstalledApp').resolves({ name: 'appone', instances: 3 });
    safety = sinon.stub(appEvacuationSafety, 'canSafelyRemoveApp').resolves(safe);
    uninstall = sinon.stub(appUninstaller, 'uninstallApplication')
      .resolves({ status: appUninstaller.UninstallStatus.REMOVED, reason: null });
  });

  afterEach(() => {
    sinon.restore();
    operationRegistry.clear();
  });

  it('hands one app back and stops there', async () => {
    // Removing takes the app to N-1; every other draining holder then sees it
    // short and waits while the spawner fills the gap. Two departures in a pass
    // would take a second copy off an app already mid-replacement.
    const result = await appGiveUp.checkAndGiveUpAnApp(deps());

    expect(result.gaveUp).to.equal('appone');
    sinon.assert.calledOnce(uninstall);
    sinon.assert.calledOnceWithExactly(noteEvacuated, 'appone');
  });

  it('does nothing at all when the node is not evacuating', async () => {
    residentialNodeDosService.isEvacuating.returns(false);

    const result = await appGiveUp.checkAndGiveUpAnApp(deps());

    expect(result).to.deep.equal({ considered: 0, gaveUp: null });
    expect(uninstall.called).to.be.false;
  });

  it('holds off while any folder-set-changing operation is in flight', async () => {
    // Not per-app: an install elsewhere moves the same syncthing configuration
    // these decisions rest on.
    operationRegistry.acquire('someotherapp', 'install', 'test');

    const result = await appGiveUp.checkAndGiveUpAnApp(deps());

    expect(result.considered).to.equal(0);
    expect(uninstall.called).to.be.false;
  });

  describe('what it reports', () => {
    // The pass says nothing at all when it has nothing to give up, so without
    // these a reader cannot tell "declined" from "never ran".
    it('reports a decision for every app it considered, either way', async () => {
      mayEvacuate.returns(notYet);

      await appGiveUp.checkAndGiveUpAnApp(deps());

      expect(eventsOf('giveUp:considered')).to.deep.equal([
        {
          appName: 'appone', giveUp: false, reason: 'EVACUATION', code: 'DEPARTURE_INTERVAL', detail: 'next departure in 12m',
        },
        {
          appName: 'apptwo', giveUp: false, reason: 'EVACUATION', code: 'DEPARTURE_INTERVAL', detail: 'next departure in 12m',
        },
      ]);
      expect(eventsOf('giveUp:safety'), 'a declined app is never taken to the safety gate').to.have.lengthOf(0);
    });

    it('reports the safety verdict for an app whose turn it is', async () => {
      safety.resolves({ safe: false, code: 'NO_SYNCED_PEER', reason: 'no connected peer holds fluxweb_appone in full' });

      await appGiveUp.checkAndGiveUpAnApp(deps());

      const verdicts = eventsOf('giveUp:safety');
      expect(verdicts[0]).to.include({ appName: 'appone', safe: false, code: 'NO_SYNCED_PEER' });
      expect(uninstall.called, 'an unsafe app is not removed').to.be.false;
    });
  });

  describe('the pacing and the safety halves must BOTH agree', () => {
    it('does not remove an app whose turn has not come, however safe it is', async () => {
      mayEvacuate.returns(notYet);

      await appGiveUp.checkAndGiveUpAnApp(deps());

      expect(safety.called, 'the safety gate is not even asked').to.be.false;
      expect(uninstall.called).to.be.false;
    });

    it('does not remove an app that is not safe, however overdue it is', async () => {
      safety.resolves({ safe: false, code: 'ONLY_HOST', reason: 'this is the only host holding it' });

      const result = await appGiveUp.checkAndGiveUpAnApp(deps());

      expect(uninstall.called).to.be.false;
      expect(result.gaveUp).to.equal(null);
      expect(noteEvacuated.called, 'and nothing paces a departure that did not happen').to.be.false;
    });
  });

  describe('standing down', () => {
    const standDown = {
      safe: false,
      code: 'STAND_DOWN_REQUIRED',
      reason: 'this node is the elected primary; stop the component before handing the app back',
      standDown: ['web_appone'],
    };

    it('tells the CONTROLLER to stop, not docker', async () => {
      // A container stopped behind the controller's back is restarted by the next
      // reconcile pass - the standby coming up against the election's intent.
      safety.resolves(standDown);
      const setDesired = sinon.stub(appReconciler, 'setControllerDesired');

      await appGiveUp.checkAndGiveUpAnApp(deps());

      sinon.assert.calledWith(setDesired, 'web_appone', 'stopped');
      expect(uninstall.called, 'a stand-down is not a removal').to.be.false;
    });

    it('announces the stand-down, naming what must stop', async () => {
      // Only the first app needs one, so the pass walks on to the second - which
      // is what proves a stand-down is not a full stop of the pass.
      safety.withArgs('appone').resolves(standDown);
      safety.withArgs('apptwo').resolves(safe);
      sinon.stub(appReconciler, 'setControllerDesired');

      await appGiveUp.checkAndGiveUpAnApp(deps());

      expect(eventsOf('giveUp:standDown')).to.deep.equal([
        { appName: 'appone', identifiers: ['web_appone'], reason: 'EVACUATION' },
      ]);
      // and the pass went on to hand back the app that was ready
      sinon.assert.calledOnceWithExactly(noteEvacuated, 'apptwo');
    });

    it('does not pace a departure for an app that only stood down', async () => {
      safety.resolves(standDown);
      sinon.stub(appReconciler, 'setControllerDesired');

      await appGiveUp.checkAndGiveUpAnApp(deps());

      expect(noteEvacuated.called).to.be.false;
    });
  });

  it('does not pace a departure when the removal did not take', async () => {
    uninstall.resolves({ status: appUninstaller.UninstallStatus.DEFERRED, reason: 'an operation holds it' });

    const result = await appGiveUp.checkAndGiveUpAnApp(deps());

    expect(noteEvacuated.called, 'the next departure must not be delayed by one that did not happen').to.be.false;
    expect(result.gaveUp).to.equal(null);
  });
});
