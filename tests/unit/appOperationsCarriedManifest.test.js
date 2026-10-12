'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
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

// The update route's wiring of a carried manifest: what the submission door
// returns rides in the one message the route gossips. Everything the route
// reads on its way is stubbed at its seam; the spec library is real.
describe('updateAppGlobaly and the manifest an update carries', () => {
  const IDENTITY = `b${'a'.repeat(52)}`;
  const CARRIED = { appName: 'myapp', identity: IDENTITY, version: 2, slots: { sealed: { ciphertext: 'c' } } };
  let appOperations;
  let uploadSealedContent;
  let assertNamesWhatStands;
  let broadcast;
  let spec;

  before(async function loadLibrary() {
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  beforeEach(async () => {
    spec = await v9Spec({ name: 'myapp' });
    uploadSealedContent = sinon.stub().resolves({ payload: {}, blobs: new Map(), carriedManifest: null });
    assertNamesWhatStands = sinon.stub().resolves();
    appOperations = proxyquire('../../ZelBack/src/services/appLifecycle/appOperations', {
      '../appRequirements/appSubmission': {
        ...appSubmission,
        resolveSubmission: sinon.stub().resolves({ spec, broadcastBlob: spec.serialize() }),
        assertSecretsNotConflicting: sinon.stub().resolves(),
        uploadSealedContent,
        assertNamesWhatStands,
      },
      '../utils/specLibs': { ...specLibs, assertUpdateInvariants: sinon.stub().resolves() },
    });
    sinon.stub(daemonStatus, 'isDaemonSynced').returns({ data: { synced: true, height: 2_600_000 } });
    stubRegistry().byName.resolves({ spec, owner: spec.owner, identity: IDENTITY });
    sinon.stub(appsRepository, 'getTempMessage').resolves({ hash: 'outbound-hash' });
    sinon.stub(placementFeasibility, 'checkPlacementFeasibility').resolves(null);
    sinon.stub(appEventVerifier, 'deserializeTempMessage').resolves({ requiresArcaneAttestation: () => false });
    sinon.stub(appEventVerifier, 'authorize').resolves();
    sinon.stub(appEventVerifier, 'computeOutboundHash').resolves('outbound-hash');
    broadcast = sinon.stub(fluxCommunicationMessagesSender, 'broadcastTemporaryAppMessage').resolves();
    sinon.stub(messageVerifier, 'requestAppMessage').resolves();
    sinon.stub(serviceHelper, 'delay').resolves();
  });

  afterEach(() => {
    sinon.restore();
  });

  const params = (contentCtx) => ({
    appSpecification: spec.serialize(), timestamp: Date.now(), signature: 's', type: 'fluxappupdate', version: 2, contentHash: spec.contentHash(), extend: false, contentCtx,
  });

  it('verifies the carried manifest for the listed app and its listed owner, and gossips it in the update message', async () => {
    uploadSealedContent.resolves({ payload: {}, blobs: new Map(), carriedManifest: CARRIED });

    const hash = await appOperations.updateAppGlobaly(params({ content: { sealed: true }, ownerSigs: new Map() }));

    expect(hash).to.equal('outbound-hash');
    const [, , , bind] = uploadSealedContent.firstCall.args;
    // The FluxDrive writes the upload makes name this update's message, so the
    // hash is computed before the content is opened.
    expect(bind).to.include({ identity: IDENTITY, owner: spec.owner, messageHash: 'outbound-hash' });
    sinon.assert.callOrder(appEventVerifier.computeOutboundHash, uploadSealedContent);
    expect(bind.priorSpec).to.equal(spec);
    const [message] = broadcast.firstCall.args;
    expect(message.hash).to.equal('outbound-hash');
    expect(message.contentManifest).to.deep.equal(CARRIED);
  });

  it('judges what the update names against the manifest it carries before anything is gossiped', async () => {
    uploadSealedContent.resolves({ payload: {}, blobs: new Map(), carriedManifest: CARRIED });
    await appOperations.updateAppGlobaly(params({ content: { sealed: true }, ownerSigs: new Map() }));
    sinon.assert.calledOnce(assertNamesWhatStands);
    const [judged, app, options] = assertNamesWhatStands.firstCall.args;
    expect(judged).to.equal(spec);
    expect(app).to.include({ identity: IDENTITY, owner: spec.owner });
    expect(options).to.deep.equal({ carriedManifest: CARRIED });
    sinon.assert.callOrder(uploadSealedContent, assertNamesWhatStands, broadcast);
  });

  it('an update with no content judges against the standing manifest', async () => {
    await appOperations.updateAppGlobaly(params(null));
    expect(assertNamesWhatStands.firstCall.args[2]).to.deep.equal({ carriedManifest: null });
  });

  it('an update refused for what it names is never gossiped', async () => {
    assertNamesWhatStands.rejects(new Error('Flux App myapp update refused: content must name the manifest the update stands on'));
    let refused = null;
    try {
      await appOperations.updateAppGlobaly(params(null));
    } catch (error) {
      refused = error;
    }
    expect(refused?.message).to.match(/content must name/);
    sinon.assert.notCalled(broadcast);
  });

  it('gossips no manifest field for an update that carries none', async () => {
    await appOperations.updateAppGlobaly(params({ content: { sealed: true }, ownerSigs: new Map() }));
    expect(broadcast.firstCall.args[0]).to.not.have.property('contentManifest');

    broadcast.resetHistory();
    uploadSealedContent.resetHistory();
    await appOperations.updateAppGlobaly(params(null));
    sinon.assert.notCalled(uploadSealedContent);
    expect(broadcast.firstCall.args[0]).to.not.have.property('contentManifest');
  });
});
