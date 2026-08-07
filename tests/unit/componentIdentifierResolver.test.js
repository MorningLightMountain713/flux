const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('componentIdentifierResolver', () => {
  let stubs;
  let resolver;

  function load() {
    stubs = {
      getInstalledApp: sinon.stub(),
      buildDeployment: sinon.stub(),
      getComponentAppIdsFromVolumeFiles: sinon.stub().resolves([]),
      getBaseAppName: sinon.stub().callsFake((id) => (id.startsWith('flux') ? id.slice(4) : id)),
    };
    return proxyquire.load('../../ZelBack/src/services/appLifecycle/componentIdentifierResolver', {
      '../appDatabase/appsRepository': { getInstalledApp: stubs.getInstalledApp },
      '../appRuntime/deploymentProvider': { buildDeployment: stubs.buildDeployment },
      '../dockerService': { getBaseAppName: stubs.getBaseAppName },
      '../utils/volumeService': {
        getComponentAppIdsFromVolumeFiles: stubs.getComponentAppIdsFromVolumeFiles,
      },
    });
  }

  const deploymentOf = (...ids) => ({
    componentEntries: () => ids.map((id) => [id, { identifier: id }]),
  });

  beforeEach(() => { resolver = load(); });
  afterEach(() => sinon.restore());

  it('takes the identifiers from the deployment when the spec can be read', async () => {
    stubs.getInstalledApp.resolves({ name: 'app', isEncrypted: false });
    stubs.buildDeployment.resolves(deploymentOf('web_app', 'db_app'));

    expect(await resolver.resolveComponentIdentifiers('app', null))
      .to.deep.equal(['web_app', 'db_app']);
    expect(stubs.getComponentAppIdsFromVolumeFiles.called, 'disk must not be consulted').to.equal(false);
  });

  it('reads the images on disk for a sealed spec it cannot open', async () => {
    // The one case disk can answer: an enterprise app stores `compose` empty, so
    // with the benchmark channel down nothing else records its components.
    stubs.getInstalledApp.resolves({ name: 'ent', isEncrypted: true });
    stubs.buildDeployment.rejects(new Error('benchd unavailable'));
    stubs.getComponentAppIdsFromVolumeFiles.withArgs('ent').resolves(['fluxweb_ent']);

    // Stored bare: consumers add docker's prefix back, so storing it would double it.
    expect(await resolver.resolveComponentIdentifiers('ent', null)).to.deep.equal(['web_ent']);
  });

  it('does not guess from disk for a plain spec that failed to build', async () => {
    // A plain spec failed for some other reason; filenames would paper over it.
    stubs.getInstalledApp.resolves({ name: 'plain', isEncrypted: false });
    stubs.buildDeployment.rejects(new Error('something else'));

    expect(await resolver.resolveComponentIdentifiers('plain', null)).to.equal(null);
    expect(stubs.getComponentAppIdsFromVolumeFiles.called).to.equal(false);
  });

  it('answers null rather than an empty list when disk holds nothing either', async () => {
    stubs.getInstalledApp.resolves({ name: 'ent', isEncrypted: true });
    stubs.buildDeployment.rejects(new Error('benchd unavailable'));
    stubs.getComponentAppIdsFromVolumeFiles.resolves([]);

    // An empty list would be recorded as "this app has no components" for ever.
    expect(await resolver.resolveComponentIdentifiers('ent', null)).to.equal(null);
  });

  it('answers null for a row that is not installed here', async () => {
    stubs.getInstalledApp.resolves(null);
    expect(await resolver.resolveComponentIdentifiers('gone', null)).to.equal(null);
  });

  it('resolves the replica it was asked about', async () => {
    stubs.getInstalledApp.resolves({ name: 'app', isEncrypted: false });
    stubs.buildDeployment.resolves(deploymentOf('web_app_r2'));

    await resolver.resolveComponentIdentifiers('app', 'r2');
    expect(stubs.buildDeployment.firstCall.args[1]).to.deep.equal({ replica: 'r2' });
  });
});
