'use strict';

/**
 * Real flux-spec objects for unit tests.
 *
 * The spec library is NOT stubbed in this repo's tests, and this file is what
 * makes that practical. It is pure, deterministic and in-process — measured at
 * ~557ms to load, ~1806ms for the first `fromSubmission` while ajv compiles its
 * schemas, then ~1.5ms per spec — so stubbing it bought nothing and cost
 * correctness.
 *
 * The cost was concrete. A hand-written double is always a SUBSET of the real
 * class, and production code gets written to the subset: appSubmission carried
 * `spec.spec || spec` for months because a test double's inner spec had only
 * `serialize` and `version`, a shape the real DecryptedCanonicalSpec has never
 * had — it delegates contentHash, and its own comment says reaching through
 * `.spec` is the thing not to do.
 *
 * What SHOULD still be stubbed is I/O and FluxOS policy: daemon RPCs, the
 * repository, the benchmark channel behind transportHelper, fork-height gates.
 *
 * One rule when you do stub such a collaborator — see `assertAnswers`.
 */

const { expect } = require('chai');
const { load } = require('@runonflux/flux-spec-cjs');

let cached = null;

/**
 * The real library, with a test crypto provider registered for both encrypted
 * classes. Memoised: the first call compiles the schemas, later calls are free.
 *
 * The provider comes from flux-spec's own `/testing` subpath rather than being
 * written here. Sealing means reproducing the wire shape AND the AAD binding,
 * and the AAD is the half that fails silently — flux-spec's own test tree grew
 * three mock providers, two of which ignored the aad argument entirely.
 *
 * @returns {Promise<object>} the flattened flux-spec namespace
 */
async function loadSpecLibrary() {
  const flux = cached ?? await load();
  const {
    InsecureTestCryptoProvider, InsecureLegacyTestCryptoProvider,
  } = await import('@runonflux/flux-spec-backend/testing');
  // Two providers, because v8 and v9 store a sealed spec differently and
  // production has two for the same reason. v9 keeps the whole `encrypted`
  // object; v8's wire form is one opaque `enterprise` string, so a nonce and tag
  // returned alongside are dropped at storage and the spec comes back
  // undecryptable. The legacy provider packs them into the blob.
  //
  // Re-registered on EVERY call, not just the first. The library is memoised but
  // the provider slot is global and something else overwrites it:
  // specCutover.ensureProvidersRegistered() swaps in FluxOS's real providers the
  // first time production code resolves an encrypted spec, and those need the
  // benchmark channel. Registering only once meant a later file in the same
  // mocha process inherited FluxOS's providers from an earlier file and its
  // sealed fixtures tried to reach the network — which tests/init.js correctly
  // fails the run over. Alphabetical order decides who poisons whom, which is
  // not a property a suite should have.
  flux.EncryptedSpecV8.registerProvider(() => new InsecureLegacyTestCryptoProvider());
  flux.EncryptedSpecV9.registerProvider(() => new InsecureTestCryptoProvider());
  cached = flux;
  return cached;
}

/** A real, minimal v9 submission. Ordinary test data, deliberately defined here:
 * flux-spec's own fixtures are not published and stop resolving once the
 * package is installed from the registry rather than symlinked. */
const V9_SUBMISSION = Object.freeze({
  version: 9,
  name: 'myapp',
  description: 'submission under test',
  owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
  instances: 3,
  ttl: 2592000,
  components: {
    web: {
      name: 'web',
      description: 'nginx',
      image: 'nginx:latest',
      cpu: 0.5,
      memory: 300,
      rootFsGb: 2,
      persistentStorage: {
        sizeGb: 5,
        mounts: { '/usr/share/nginx/html': { source: 'html', destination: '/usr/share/nginx/html' } },
      },
      ports: { http: { containerPort: 80, hostPort: 31000 } },
    },
  },
  contacts: { email: ['ops@example.com'] },
});

/** A real, minimal cleartext v8 submission. */
const V8_SUBMISSION = Object.freeze({
  version: 8,
  name: 'myapp',
  description: 'legacy submission under test',
  owner: '19z6SjrVrWqBTLiCXWLRjcu9ydnzWNz3UD',
  compose: [{
    name: 'web',
    description: 'web',
    repotag: 'nginx:latest',
    ports: [31443],
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerPorts: [443],
    containerData: '/tmp',
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    repoauth: '',
  }],
  instances: 3,
  contacts: [],
  geolocation: [],
  expire: 88000,
  nodes: [],
  staticip: false,
});

/** A real FluxAppSpecV9. Overrides are merged into the submission blob, so an
 * override the schema does not accept is rejected — which is the point. */
async function v9Spec(overrides = {}) {
  const flux = await loadSpecLibrary();
  return flux.FluxAppSpecV9.fromSubmission({ ...V9_SUBMISSION, ...overrides });
}

/** A real FluxAppSpecV8. */
async function v8Spec(overrides = {}) {
  const flux = await loadSpecLibrary();
  return flux.FluxAppSpecV8.fromSubmission({ ...V8_SUBMISSION, ...overrides });
}

/**
 * A real FluxAppSpecV1 — the oldest stored form, and the only one that carries
 * no `instances` field at all. That absence is not trivia: appsRepository reads
 * `doc.instances ?? 3`, and the default cannot be tested honestly against any
 * later version, because v2+ REQUIRE instances and the real class rejects a row
 * without it. A hand-written double will happily omit it at any version and
 * prove nothing.
 *
 * Derived from V8_SUBMISSION's single component so the two stay describing the
 * same app.
 */
async function v1Spec(overrides = {}) {
  const flux = await loadSpecLibrary();
  const [component] = V8_SUBMISSION.compose;
  return flux.FluxAppSpecBase.getVersionClass(1).fromSubmission({
    version: 1,
    name: V8_SUBMISSION.name,
    description: V8_SUBMISSION.description,
    owner: V8_SUBMISSION.owner,
    repotag: component.repotag,
    port: component.ports[0],
    enviromentParameters: [],
    commands: [],
    containerPort: component.containerPorts[0],
    containerData: component.containerData,
    cpu: component.cpu,
    ram: component.ram,
    hdd: component.hdd,
    ...overrides,
  });
}

/** A real EncryptedSpecV9 — the node-sealed form a v9 app is stored and
 * gossiped as. In production the NODE produces this, after validating cleartext
 * that arrived HPKE-sealed; the owner never holds it. */
async function sealedV9Spec(overrides = {}) {
  const flux = await loadSpecLibrary();
  const spec = await v9Spec(overrides);
  return flux.EncryptedSpecV9.fromSpec(
    spec, await flux.EncryptedSpecV9.createProviderFor(spec.name, spec.owner),
  );
}

/**
 * A real EncryptedSpecV8 — the enterprise blob an owner seals and submits.
 *
 * Sealed with the legacy provider, so this survives serialize() ->
 * deserialize() -> decrypt() the way a production one does. It did not before:
 * v8 has nowhere to store a separate nonce and tag.
 */
async function sealedV8Spec(overrides = {}) {
  const flux = await loadSpecLibrary();
  const spec = await v8Spec(overrides);
  return flux.EncryptedSpecV8.fromSpec(
    spec, await flux.EncryptedSpecV8.createProviderFor(spec.name, spec.owner),
  );
}

/** A real DecryptedCanonicalSpec — what a node holds after opening a sealed
 * spec. Note `serialize()` is blocked on it by design; `toCanonical()` is not. */
async function decryptedV9Spec(overrides = {}) {
  const sealed = await sealedV9Spec(overrides);
  return sealed.decrypt(await sealed.createProvider());
}

/** A real DecryptedCanonicalSpec over a v8 enterprise blob. */
async function decryptedV8Spec(overrides = {}) {
  const sealed = await sealedV8Spec(overrides);
  return sealed.decrypt(await sealed.createProvider());
}

/** A real InstantiatedSpec — a stored spec plus its chain state. */
async function instantiatedSpec(spec, state = {}) {
  const flux = await loadSpecLibrary();
  return flux.InstantiatedSpec.fromEvent({
    spec,
    hash: state.hash ?? 'a'.repeat(64),
    height: state.height ?? 2500000,
    registeredAt: state.registeredAt ?? 1751628800,
    identity: state.identity ?? null,
    uuid: state.uuid ?? null,
  });
}

/**
 * Assert that an object can answer everything a stubbed collaborator will ask
 * of it.
 *
 * Using the real classes is not enough on its own. When a collaborator stays
 * stubbed — the entitlements gate, the image validator, the registry — nothing
 * exercises what it does with the object it was handed, so a delegation can
 * disappear from flux-spec with the suite still green. That happened: removing
 * `toCanonical` from DecryptedCanonicalSpec left appSubmission's 21 tests
 * passing even after they were rewritten to use real objects.
 *
 * So read the argument back off the stub and call what the real collaborator
 * calls.
 *
 *   const [handed] = stubs.entitlementsState.assertSpecEntitled.firstCall.args;
 *   assertAnswers(handed, ['toCanonical']);
 *
 * @param {object} subject - the object the stub received
 * @param {string[]} members - methods the real collaborator invokes on it
 */
function assertAnswers(subject, members) {
  for (const member of members) {
    expect(subject, `nothing was handed to the collaborator`).to.be.an('object');
    expect(subject[member], `the collaborator calls ${member}(), which this object does not have`)
      .to.be.a('function');
    expect(() => subject[member](), `${member}() threw on the object handed over`).to.not.throw();
  }
}

module.exports = {
  loadSpecLibrary,
  V9_SUBMISSION,
  V8_SUBMISSION,
  v9Spec,
  v8Spec,
  v1Spec,
  sealedV9Spec,
  sealedV8Spec,
  decryptedV9Spec,
  decryptedV8Spec,
  instantiatedSpec,
  assertAnswers,
};
