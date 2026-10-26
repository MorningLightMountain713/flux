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
const appHistory = require('../../ZelBack/src/services/appDecisions/appHistory');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const {
  loadSpecLibrary, v8Spec, v9Spec, decryptedV9Spec, sealedV9Spec,
} = require('./fixtures/fluxSpec');
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
  let assertUpdateInvariants;
  let resolveSubmission;

  before(async function loadLibrary() {
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  beforeEach(async () => {
    spec = await v9Spec({ name: 'myapp' });
    assertUpdateInvariants = sinon.stub().resolves();
    resolveSubmission = sinon.stub().resolves({ spec, broadcastBlob: spec.serialize() });
    appOperations = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
      '../appRequirements/appSubmission': {
        ...appSubmission,
        resolveSubmission,
        assertSecretsNotConflicting: sinon.stub().resolves(),
        assertNamesWhatStands: sinon.stub().resolves(),
        holdsEnoughPeersToSubmit: () => true,
      },
      '../utils/specLibs': { ...specLibs, assertUpdateInvariants },
    });
    sinon.stub(daemonStatus, 'daemonSyncState').returns({ synced: true, height: 2_600_000 });
    byName = stubRegistry().byName.resolves(null);
    latestAppliedState = sinon.stub(appSpecHistory, 'latestAppliedState').resolves(null);
    sinon.stub(appsRepository, 'getTempMessage').resolves({ hash: 'outbound-hash' });
    sinon.stub(appsRepository, 'getTempMessageByName').resolves(null);
    sinon.stub(appHistory, 'replacedBy').resolves(null);
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

  it('opens a listed encrypted app\'s sealed spec before judging the update against it', async () => {
    const sealed = await sealedV9Spec({ name: 'myapp' });
    expect(sealed.sealed, 'fixture: a listed row\'s sealed spec').to.equal(true);
    byName.resolves({ spec: sealed, owner: spec.owner, identity: IDENTITY });

    await appOperations.updateAppGlobaly(params()).catch(() => null);

    const [prior] = assertUpdateInvariants.firstCall.args;
    expect(prior.sealed, 'the invariants read the opened spec').to.equal(false);
  });

  // The state an expired app last held is read from its applied message,
  // already opened: an encrypted app's spec arrives readable.
  it('renews an expired encrypted app on the state it last held, which arrives already opened', async () => {
    const opened = await decryptedV9Spec({ name: 'myapp' });
    expect(opened.isEncrypted, 'fixture: an encrypted app\'s opened spec').to.equal(true);
    latestAppliedState.resolves({ spec: opened, owner: spec.owner, identity: IDENTITY });

    expect(await appOperations.updateAppGlobaly(params())).to.equal('outbound-hash');
  });

  it('answers an update whose payment the chain recorded first, held as a confirmed message', async () => {
    byName.resolves({ spec, owner: spec.owner, identity: IDENTITY });
    appsRepository.getTempMessage.resolves(null);
    sinon.stub(appsRepository, 'getPermanentMessage').resolves({ hash: 'outbound-hash' });

    expect(await appOperations.updateAppGlobaly(params())).to.equal('outbound-hash');
  });

  it('answers no hash for an update this node broadcast and does not hold', async () => {
    byName.resolves({ spec, owner: spec.owner, identity: IDENTITY });
    appsRepository.getTempMessage.resolves(null);
    sinon.stub(appsRepository, 'getPermanentMessage').resolves(null);

    expect(await appOperations.updateAppGlobaly(params())).to.equal(null);
  });

  it('answers the v1 update route\'s caller to try again for an update this node does not hold', async () => {
    byName.resolves({ spec, owner: spec.owner, identity: IDENTITY });
    appsRepository.getTempMessage.resolves(null);
    sinon.stub(appsRepository, 'getPermanentMessage').resolves(null);
    sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
    const res = { json: sinon.stub() };

    await appOperations.updateAppGlobalyApi({ headers: {}, body: params() }, res);

    sinon.assert.calledOnce(res.json);
    expect(res.json.firstCall.args[0].status).to.equal('error');
    expect(res.json.firstCall.args[0].data.message).to.equal('Unable to update application on the network. Try again later.');
  });

  describe('a v9 update the chain would price against a message it does not replace', () => {
    const listed = () => ({ spec, owner: spec.owner, identity: IDENTITY });

    it('is refused when signed at or before the message it replaces was mined or signed', async () => {
      byName.resolves(listed());
      const p = params();
      appHistory.replacedBy.resolves({ hash: 'r', signAfter: p.timestamp });

      const error = await appOperations.updateAppGlobaly(p).catch((e) => e);

      expect(error.name).to.equal('StampedEarly');
      sinon.assert.notCalled(fluxCommunicationMessagesSender.broadcastTemporaryAppMessage);
    });

    it('is taken when signed after it', async () => {
      byName.resolves(listed());
      const p = params();
      appHistory.replacedBy.resolves({ hash: 'r', signAfter: p.timestamp - 1 });

      expect(await appOperations.updateAppGlobaly(p)).to.equal('outbound-hash');
    });

    it('is refused while another message for the app waits for its payment', async () => {
      byName.resolves(listed());
      appsRepository.getTempMessageByName.resolves({ hash: 'waiting-hash' });

      const error = await appOperations.updateAppGlobaly(params()).catch((e) => e);

      expect(error.message).to.match(/already in progress/);
      sinon.assert.calledOnceWithExactly(appsRepository.getTempMessageByName, 'myapp');
      sinon.assert.notCalled(fluxCommunicationMessagesSender.broadcastTemporaryAppMessage);
    });

    it('is taken again when the message waiting is itself', async () => {
      byName.resolves(listed());
      appsRepository.getTempMessageByName.resolves({ hash: 'outbound-hash' });

      expect(await appOperations.updateAppGlobaly(params())).to.equal('outbound-hash');
    });

    it('does not apply to a v1-v8 update', async () => {
      const legacy = await v8Spec({ name: 'myapp' });
      resolveSubmission.resolves({ spec: legacy, broadcastBlob: legacy.serialize() });
      byName.resolves({ spec: legacy, owner: legacy.owner, identity: IDENTITY });
      appHistory.replacedBy.resolves({ hash: 'r', signAfter: Number.MAX_SAFE_INTEGER });
      appsRepository.getTempMessageByName.resolves({ hash: 'waiting-hash' });

      const result = await appOperations.updateAppGlobaly({ ...params(), version: 1 }).catch((e) => e);

      expect(result?.name, 'not refused as stamped early').to.not.equal('StampedEarly');
      expect(String(result?.message), 'not refused as in progress').to.not.match(/already in progress/);
      sinon.assert.notCalled(appHistory.replacedBy);
    });
  });

  it('refuses an update of a name no app ever held', async () => {
    const error = await appOperations.updateAppGlobaly(params()).catch((e) => e);

    expect(error.message).to.match(/application to update does not exist/);
    sinon.assert.calledOnceWithExactly(latestAppliedState, 'myapp');
    sinon.assert.notCalled(appEventVerifier.authorize);
  });
});
