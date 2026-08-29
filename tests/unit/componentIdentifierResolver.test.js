'use strict';

// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const dockerService = require('../../ZelBack/src/services/dockerService');
const {
  loadSpecLibrary, V9_SUBMISSION, v9Spec, sealedV9Spec, instantiatedSpec,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. It matters more in this file than in most: the identifiers under test
// are MINTED by flux-spec (DeploymentSpec -> AppComponent.containerIdentifier),
// so a double that hands back literal ids is a second copy of the very rule the
// resolver exists to read, and the two can drift without a single test going red.
//
// dockerService is real too, and deliberately: the disk branch round-trips the
// production PAIR — getAppIdentifier mints the prefixed volume name, and the
// resolver's getBaseAppName strips it back. A stubbed `startsWith('flux')`
// re-implementation of that (what stood here) is blind to the legacy `zel`
// namespace the real function also claims.
//
// What stays stubbed is I/O: mongo (appsRepository), the deploymentProvider —
// which resolves node identity through two daemon RPCs and the docker socket —
// and the filesystem sweep behind volumeService.

// Every DeploymentSpec here is built with the same apps folder, so a component's
// own `dir` and any path derived from its identifier cannot drift apart.
const APPS_FOLDER = '/tmp/flux/apps/';

let flux;

/** A real FluxAppSpecV9 whose components are named copies of the fixture's.
 *  Host ports are handed out per component: co-resident components cannot both
 *  claim 31000, and the real schema is the thing that says so. */
function specWithComponents(appName, componentNames) {
  const components = {};
  componentNames.forEach((compName, index) => {
    components[compName] = {
      ...V9_SUBMISSION.components.web,
      name: compName,
      ports: { http: { containerPort: 80, hostPort: 31000 + index } },
    };
  });
  return v9Spec({ name: appName, components });
}

/** A real DeploymentSpec, built exactly the way deploymentProvider.toDeployment
 *  builds one: from the row's readable spec, replica stated (never defaulted),
 *  identity READ off the row rather than recomputed from the name. */
function deploymentFor(spec, opts = {}) {
  return flux.DeploymentSpec.fromSpec(spec, APPS_FOLDER, { replica: null, ...opts });
}

describe('componentIdentifierResolver', () => {
  let stubs;
  let resolver;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30000);
    flux = await loadSpecLibrary();
  });

  function load() {
    stubs = {
      getInstalledApp: sinon.stub(),
      // The provider is stubbed, but what it DOES with the row is not: the fake
      // runs the real DeploymentSpec.fromSpec on what it was handed, exactly as
      // toDeployment does, so a row this module hands over that the real
      // provider could not build from fails here.
      buildDeployment: sinon.stub().callsFake(async (installed, opts) => deploymentFor(
        installed.spec, { replica: opts.replica, identity: installed.identity ?? null },
      )),
      getComponentAppIdsFromVolumeFiles: sinon.stub().resolves([]),
    };
    return proxyquire.load('../../ZelBack/src/services/appLifecycle/componentIdentifierResolver', {
      '../appDatabase/appsRepository': { getInstalledApp: stubs.getInstalledApp },
      '../appRuntime/deploymentProvider': { buildDeployment: stubs.buildDeployment },
      '../utils/volumeService': {
        getComponentAppIdsFromVolumeFiles: stubs.getComponentAppIdsFromVolumeFiles,
      },
    });
  }

  /**
   * The row handed to the (stubbed) provider must answer what the REAL
   * toDeployment reads off it. These are properties, not methods:
   * resolveInstantiatedSpec branches on `isEncrypted`, DeploymentSpec.fromSpec
   * takes `spec`, the identifier's identity segment comes from `identity`, and
   * the error paths name the app by `name`.
   */
  function assertRowAnswersTheProvider(installed, appName) {
    expect(installed, 'nothing was handed to the provider').to.be.an('object');
    expect(installed.isEncrypted, 'resolveInstantiatedSpec branches on this').to.be.a('boolean');
    expect(installed.name, 'toDeployment names the app by this').to.equal(appName);
    expect(installed, 'the identity is read off the row, never recomputed').to.have.property('identity');
    expect(installed.spec, 'DeploymentSpec.fromSpec is fed this').to.be.an('object');
  }

  beforeEach(() => { resolver = load(); });
  afterEach(() => sinon.restore());

  it('takes the identifiers from the deployment when the spec can be read', async () => {
    const spec = await specWithComponents('app', ['web', 'db']);
    stubs.getInstalledApp.resolves(await instantiatedSpec(spec));

    // The expectation is the real minting rule's output, asserted against the
    // literal so the rule itself is pinned: `<component>_<app>` for v4+.
    const identifiers = deploymentFor(spec).componentEntries().map(([, comp]) => comp.identifier);
    expect(identifiers, 'the real container-naming rule').to.deep.equal(['web_app', 'db_app']);

    expect(await resolver.resolveComponentIdentifiers('app', null)).to.deep.equal(identifiers);
    expect(stubs.getComponentAppIdsFromVolumeFiles.called, 'disk must not be consulted').to.equal(false);

    const [handed, opts] = stubs.buildDeployment.firstCall.args;
    assertRowAnswersTheProvider(handed, 'app');
    expect(
      flux.DeploymentSpec.fromSpec(handed.spec, APPS_FOLDER, {
        replica: opts.replica, identity: handed.identity ?? null,
      }).componentEntries().map(([, comp]) => comp.identifier),
      'the real provider must be able to build from what it was handed',
    ).to.deep.equal(identifiers);
  });

  it('reads the images on disk for a sealed spec it cannot open', async () => {
    // The one case disk can answer: an enterprise app stores `compose` empty, so
    // with the benchmark channel down nothing else records its components. The
    // row is a really sealed EncryptedSpecV9, so `isEncrypted` is derived from
    // the stored spec's type rather than asserted onto a literal.
    const spec = await specWithComponents('ent', ['web']);
    const installed = await instantiatedSpec(await sealedV9Spec({
      name: spec.name, components: V9_SUBMISSION.components,
    }));
    expect(installed.isEncrypted, 'a sealed row is what this branch is for').to.equal(true);
    stubs.getInstalledApp.resolves(installed);
    stubs.buildDeployment.rejects(new Error('benchd unavailable'));

    // The disk name is minted by the production function that names volumes, and
    // the resolver strips it with that function's own inverse.
    const [identifier] = deploymentFor(spec).componentEntries().map(([, comp]) => comp.identifier);
    stubs.getComponentAppIdsFromVolumeFiles.withArgs('ent')
      .resolves([dockerService.getAppIdentifier(identifier)]);

    // Stored bare: consumers add docker's prefix back, so storing it would double it.
    expect(await resolver.resolveComponentIdentifiers('ent', null)).to.deep.equal(['web_ent']);
    expect(identifier, 'the bare form is what the row records').to.equal('web_ent');
  });

  it('does not guess from disk for a plain spec that failed to build', async () => {
    // A plain spec failed for some other reason; filenames would paper over it.
    const installed = await instantiatedSpec(await specWithComponents('plain', ['web']));
    expect(installed.isEncrypted, 'a cleartext row must report itself as such').to.equal(false);
    stubs.getInstalledApp.resolves(installed);
    stubs.buildDeployment.rejects(new Error('something else'));

    expect(await resolver.resolveComponentIdentifiers('plain', null)).to.equal(null);
    expect(stubs.getComponentAppIdsFromVolumeFiles.called).to.equal(false);
  });

  it('answers null rather than an empty list when disk holds nothing either', async () => {
    stubs.getInstalledApp.resolves(await instantiatedSpec(await sealedV9Spec({ name: 'ent' })));
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
    const spec = await specWithComponents('app', ['web']);
    stubs.getInstalledApp.resolves(await instantiatedSpec(spec));

    // A named replica qualifies the identifier — `<component>_<app>_<replica>` —
    // and that third segment only appears if the replica actually reached the
    // provider, which is the whole point of the call.
    const qualified = deploymentFor(spec, { replica: 'r2' })
      .componentEntries().map(([, comp]) => comp.identifier);
    expect(qualified, 'the real qualified-identifier rule').to.deep.equal(['web_app_r2']);

    expect(await resolver.resolveComponentIdentifiers('app', 'r2')).to.deep.equal(qualified);
    expect(stubs.buildDeployment.firstCall.args[1]).to.deep.equal({ replica: 'r2' });
  });
});
