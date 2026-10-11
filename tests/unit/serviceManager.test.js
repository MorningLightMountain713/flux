'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const serviceManager = require('../../ZelBack/src/services/serviceManager');
const nodeDownService = require('../../ZelBack/src/services/nodeDownService');
const appStartupManager = require('../../ZelBack/src/services/appLifecycle/appStartupManager');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const daemonSubscriptionService = require('../../ZelBack/src/services/daemonService/daemonSubscriptionService');
const log = require('../../ZelBack/src/lib/log');

describe('serviceManager tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('wireServices', () => {
    it('hands the node-down service the placement check that removes apps', () => {
      const setPlacementCheck = sinon.stub(nodeDownService, 'setPlacementCheck');

      serviceManager.wireServices();

      sinon.assert.calledOnce(setPlacementCheck);
      expect(setPlacementCheck.firstCall.args[0]).to.equal(appStartupManager.enforceNodePlacement);
    });
  });

  describe('startDaemon', () => {
    class Exited extends Error {}

    beforeEach(() => {
      sinon.stub(daemonServiceUtils, 'buildFluxdClient').resolves();
      sinon.stub(log, 'error');
      // The real exit ends the process; this one ends the call, so what would
      // have run after it is observable.
      sinon.stub(process, 'exit').throws(new Exited());
    });

    it('exits before following a daemon that runs another chain', async () => {
      sinon.stub(daemonStatus, 'waitForDaemonRpc').resolves({ blocks: 10, chain: 'labnet' });
      const subscribe = sinon.stub(daemonSubscriptionService, 'start');

      let thrown;
      try { await serviceManager.startDaemon(); } catch (error) { thrown = error; }

      expect(thrown).to.be.instanceOf(Exited);
      sinon.assert.calledOnceWithExactly(process.exit, 1);
      sinon.assert.calledWithMatch(log.error, /"labnet".*"main"/);
      sinon.assert.notCalled(subscribe);
    });

    it('follows a daemon that runs the configured chain', async () => {
      sinon.stub(daemonStatus, 'waitForDaemonRpc').resolves({ blocks: 10, chain: 'main' });
      const subscribe = sinon.stub(daemonSubscriptionService, 'start').throws(new Error('followed'));

      let thrown;
      try { await serviceManager.startDaemon(); } catch (error) { thrown = error; }

      expect(thrown.message).to.equal('followed');
      sinon.assert.notCalled(process.exit);
      sinon.assert.calledOnce(subscribe);
    });
  });
});
