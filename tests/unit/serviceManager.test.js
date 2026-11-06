'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');

chai.use(chaiAsPromised);
const { expect } = chai;

const { prepareDatabaseSchema, dosState } = require('../../ZelBack/src/services/serviceManager');
const { untilSucceeds } = require('../../ZelBack/src/services/utils/untilSucceeds');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const nodeDosState = require('../../ZelBack/src/services/nodeDosState');
const serviceManager = require('../../ZelBack/src/services/serviceManager');
const nodeDownService = require('../../ZelBack/src/services/nodeDownService');
const appStartupManager = require('../../ZelBack/src/services/appLifecycle/appStartupManager');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const daemonSubscriptionService = require('../../ZelBack/src/services/daemonService/daemonSubscriptionService');
const log = require('../../ZelBack/src/lib/log');

describe('untilSucceeds', () => {
  afterEach(() => sinon.restore());

  it('runs a failing step again after a wait, until it succeeds, and answers what it resolved', async () => {
    const wait = sinon.stub(serviceHelper, 'delay').resolves();
    const step = sinon.stub();
    step.onFirstCall().rejects(new Error('connection timed out'));
    step.onSecondCall().rejects(new Error('connection timed out'));
    step.resolves('prepared');

    expect(await untilSucceeds('a step', step)).to.equal('prepared');

    sinon.assert.calledThrice(step);
    sinon.assert.calledTwice(wait);
    sinon.assert.alwaysCalledWithExactly(wait, 15 * 1000);
  });
});

describe('serviceManager prepareDatabaseSchema', () => {
  afterEach(() => sinon.restore());

  it('rejects when the login rows cannot be cleared of signatures, so boot prepares the schema again', async () => {
    sinon.stub(dbHelper, 'maintenanceConnection').returns({ db: (name) => ({ name, client: 'maintenance' }) });
    const unset = sinon.stub(dbHelper, 'updateInDatabase').rejects(new Error('connection timed out'));

    await expect(prepareDatabaseSchema()).to.be.rejectedWith('connection timed out');
    expect(unset.firstCall.args[0].client, 'the schema runs on the maintenance client').to.equal('maintenance');
  });
});

describe('serviceManager apps availability DOS state', () => {
  afterEach(() => {
    nodeDosState.setDosMessage(null);
    nodeDosState.setDosStateValue(0);
  });

  it('writes its message as the node\'s own', () => {
    dosState.dosMessage = 'Ports tested not reachable from outside';

    chai.expect(nodeDosState.getDosMessage()).to.equal('Ports tested not reachable from outside');
  });

  it('reads the node\'s own message, whoever set it', () => {
    nodeDosState.setDosMessage('Flux IP detection failed');

    chai.expect(dosState.dosMessage).to.equal('Flux IP detection failed');
  });
});

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
