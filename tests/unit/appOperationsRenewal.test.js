'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const appSpecHistory = require('../../ZelBack/src/services/appDatabase/appSpecHistory');
const appEventVerifier = require('../../ZelBack/src/services/appMessaging/appEventVerifier');
const placementFeasibility = require('../../ZelBack/src/services/appPlacement/placementFeasibility');
const messageVerifier = require('../../ZelBack/src/services/appMessaging/messageVerifier');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const specLibs = require('../../ZelBack/src/services/utils/specLibs');
const appSubmission = require('../../ZelBack/src/services/appRequirements/appSubmission');
const { loadSpecLibrary, v9Spec } = require('./fixtures/fluxSpec');
const { stubRegistry } = require('./fixtures/appRecords');

// The update route and the app it judges an update against: the one the list
// carries under the name, or, when it carries none, the one that last held it.
// Everything the route reads on its way is stubbed at its seam; the spec
// library is real.
describe('updateAppGlobaly and the app an update is judged against', () => {
  const IDENTITY = `b${'a'.repeat(52)}`;
  let appOperations;
  let spec;
  let byName;
  let latestAppliedState;

  before(async function loadLibrary() {
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  beforeEach(async () => {
    spec = await v9Spec({ name: 'myapp' });
    appOperations = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
      '../appRequirements/appSubmission': {
        ...appSubmission,
        resolveSubmission: sinon.stub().resolves({ spec, broadcastBlob: spec.serialize() }),
        assertSecretsNotConflicting: sinon.stub().resolves(),
        assertNamesWhatStands: sinon.stub().resolves(),
      },
      '../utils/specLibs': { ...specLibs, assertUpdateInvariants: sinon.stub().resolves() },
    });
    sinon.stub(daemonStatus, 'isDaemonSynced').returns({ data: { synced: true, height: 2_600_000 } });
    byName = stubRegistry().byName.resolves(null);
    latestAppliedState = sinon.stub(appSpecHistory, 'latestAppliedState').resolves(null);
    sinon.stub(appsRepository, 'getTempMessage').resolves({ hash: 'outbound-hash' });
    sinon.stub(placementFeasibility, 'checkPlacementFeasibility').resolves(null);
    sinon.stub(appEventVerifier, 'deserializeTempMessage').resolves({ requiresArcaneAttestation: () => false });
    sinon.stub(appEventVerifier, 'authorize').resolves();
    sinon.stub(appEventVerifier, 'computeOutboundHash').resolves('outbound-hash');
    sinon.stub(fluxCommunicationMessagesSender, 'broadcastTemporaryAppMessage').resolves();
    sinon.stub(messageVerifier, 'requestAppMessage').resolves();
    sinon.stub(serviceHelper, 'delay').resolves();
  });

  afterEach(() => {
    sinon.restore();
  });

  const params = () => ({
    appSpecification: spec.serialize(), timestamp: Date.now(), signature: 's', type: 'fluxappupdate', version: 2, contentHash: spec.contentHash(), extend: false, contentCtx: null,
  });

  it('judges an update of a listed app against its row and never reads the history', async () => {
    const listed = { spec, owner: spec.owner, identity: IDENTITY };
    byName.resolves(listed);

    expect(await appOperations.updateAppGlobaly(params())).to.equal('outbound-hash');

    sinon.assert.notCalled(latestAppliedState);
    expect(appEventVerifier.authorize.firstCall.args[0].previousState).to.equal(listed);
  });

  it('judges a renewal of an expired app, one the list no longer carries, against the state it last held', async () => {
    const held = { spec, owner: spec.owner, identity: IDENTITY };
    latestAppliedState.resolves(held);

    expect(await appOperations.updateAppGlobaly(params())).to.equal('outbound-hash');

    sinon.assert.calledOnceWithExactly(latestAppliedState, 'myapp');
    expect(appEventVerifier.authorize.firstCall.args[0].previousState, 'authorized against the owner who held it').to.equal(held);
  });

  it('answers an update whose payment the chain recorded first, held as a confirmed message', async () => {
    byName.resolves({ spec, owner: spec.owner, identity: IDENTITY });
    appsRepository.getTempMessage.resolves(null);
    sinon.stub(appsRepository, 'getPermanentMessage').resolves({ hash: 'outbound-hash' });

    expect(await appOperations.updateAppGlobaly(params())).to.equal('outbound-hash');
  });

  it('refuses an update of a name no app ever held', async () => {
    const error = await appOperations.updateAppGlobaly(params()).catch((e) => e);

    expect(error.message).to.match(/application to update does not exist/);
    sinon.assert.calledOnceWithExactly(latestAppliedState, 'myapp');
    sinon.assert.notCalled(appEventVerifier.authorize);
  });
});
