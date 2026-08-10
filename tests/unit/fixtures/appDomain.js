'use strict';

/**
 * Real domain objects for tests, built from the same spec library production
 * loads (@runonflux/flux-spec-cjs, the bridge specLibs.getSpecBackend uses).
 *
 * These exist because a double cannot enforce an invariant it does not know
 * about. ConfirmedAppEvent rejects a registration without extend=true and
 * freezes itself; InstantiatedSpec decides expiry from the term start it was
 * built with. A stub returning {} satisfies every assertion and states none of
 * that, so a test written against one proves the wiring and nothing about the
 * type it stands in for.
 *
 * Stub at the database and network boundary instead. Everything here is the
 * real class.
 */

const { load } = require('@runonflux/flux-spec-cjs');

const OWNER = '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1';

/**
 * A v9 submission body. Deliberately the smallest one the spec accepts, so a
 * test that cares about a field sets it and a test that does not is not
 * silently relying on it.
 */
function submission(overrides = {}) {
  const { components, ...rest } = overrides;
  return {
    version: 9,
    name: 'testapp',
    description: 'fixture',
    owner: OWNER,
    instances: 3,
    ttl: 2_592_000,
    contacts: { email: ['test@example.com'] },
    components: components ?? {
      web: {
        name: 'web',
        image: 'nginx:latest',
        cpu: 1,
        memory: 1000,
        swapGb: 2,
        rootFsGb: 2,
        persistentStorage: { sizeGb: 10, mounts: {} },
        ports: { tcp_80: { containerPort: 80, hostPort: 31000, protocol: 'tcp' } },
      },
    },
    ...rest,
  };
}

/**
 * A v8 submission body. The legacy path is still live — a temp message below
 * version 2 deserializes through AppEventLegacy — so tests covering it need a
 * spec the real deserializer accepts. It rejects a bare {name, version, owner}:
 * description, nodes, staticip and enterprise are all required.
 */
function submissionV8(overrides = {}) {
  const { compose, ...rest } = overrides;
  return {
    version: 8,
    name: 'testapp',
    description: 'fixture',
    owner: OWNER,
    instances: 3,
    expire: 22_000,
    contacts: [],
    geolocation: [],
    nodes: [],
    staticip: false,
    enterprise: null,
    compose: compose ?? [{
      name: 'web',
      description: 'c',
      repotag: 'nginx:latest',
      ports: [31000],
      domains: [''],
      environmentParameters: [],
      commands: [],
      containerPorts: [80],
      containerData: '/data',
      cpu: 1,
      ram: 1000,
      hdd: 10,
      tiered: false,
      secrets: '',
      repoauth: '',
    }],
    ...rest,
  };
}

/** The real FluxAppSpecV8, through the same deserializer production uses. */
async function v8Spec(overrides = {}) {
  const { deserializeSpec } = await load();
  return deserializeSpec(submissionV8(overrides));
}

/**
 * A real ENCRYPTED v8 spec. No key material is needed: the enterprise blob stays
 * opaque, so this deserializes to a genuine EncryptedSpecV8 and an
 * InstantiatedSpec built from it reports isEncrypted truthfully. Opening the
 * blob is the part that needs the benchmark channel — a test covering that
 * stubs resolveInstantiatedSpec, and only that.
 */
async function encryptedV8Spec(overrides = {}) {
  const { deserializeSpec } = await load();
  return deserializeSpec({
    ...submissionV8({ compose: [] }),
    name: 'encapp',
    enterprise: 'base64blob',
    ...overrides,
  });
}

/** The real AppEventLegacy, for temp messages below version 2. */
async function legacyEvent(overrides = {}) {
  const { AppEventLegacy } = await load();
  const { spec, ...rest } = overrides;
  const appSpecifications = (spec ?? await v8Spec()).serialize();
  return AppEventLegacy.deserialize({
    type: 'fluxappupdate',
    version: 1,
    appSpecifications,
    hash: 'fixtureHash',
    timestamp: 1_760_000_000_000,
    signature: 'fixtureSignature',
    txid: 'fixtureTxid',
    height: 2_000_000,
    valueSat: 100_000_000,
    ...rest,
  });
}

/** The real FluxAppSpecV9. */
async function v9Spec(overrides = {}) {
  const { FluxAppSpecV9 } = await load();
  return FluxAppSpecV9.fromSubmission(submission(overrides));
}

/**
 * The real ConfirmedAppEvent. `type` decides which invariants apply — a
 * registration must carry extend=true, which is why that is not a caller's
 * problem to remember here.
 */
async function confirmedEvent(overrides = {}) {
  const { ConfirmedAppEvent } = await load();
  const { spec, ...rest } = overrides;
  const type = rest.type ?? 'fluxappregister';
  const appSpecifications = (spec ?? await v9Spec()).serialize();
  return ConfirmedAppEvent.deserialize({
    type,
    version: 2,
    appSpecifications,
    contentHash: 'fixtureContentHash',
    hash: 'fixtureHash',
    timestamp: 1_760_000_000_000,
    extend: type === 'fluxappregister' ? true : (rest.extend ?? false),
    signature: 'fixtureSignature',
    txid: 'fixtureTxid',
    height: 2_000_000,
    valueSat: 100_000_000,
    registeredAt: 1_760_000_000,
    arcaneAttestation: null,
    ...rest,
  });
}

/** The real InstantiatedSpec, projected from a real event the way production does. */
async function instantiatedSpec(overrides = {}) {
  const { InstantiatedSpec } = await load();
  const { event, ...rest } = overrides;
  const source = event ?? await confirmedEvent();
  return InstantiatedSpec.fromEvent({ ...source.toInstantiatedSpec(), ...rest });
}

/**
 * The temporary message a verifier reads before promoting it.
 *
 * `version` here is the MESSAGE version, not the spec's, and it decides which
 * event class deserializes it: 2 and above is ConfirmedAppEvent (v9 specs
 * only), below that is AppEventLegacy. The spec blob has to match — that
 * pairing is the thing a double could not enforce.
 */
async function tempMessage(overrides = {}) {
  const { spec, ...rest } = overrides;
  const version = rest.version ?? 2;
  const built = spec ?? (version >= 2 ? await v9Spec() : await v8Spec());
  const type = rest.type ?? 'fluxappregister';
  return {
    type,
    version,
    appSpecifications: built.serialize(),
    hash: 'fixtureHash',
    timestamp: 1_760_000_000_000,
    signature: 'fixtureSignature',
    // A registration carries extend=true or it does not exist: AppEvent,
    // SignedAppEvent and ConfirmedAppEvent each refuse to construct one
    // without it, so a stored message could never have reached a verifier
    // lacking it. Set here so no test can build an impossible registration.
    ...(type === 'fluxappregister' ? { extend: true } : {}),
    ...rest,
  };
}

module.exports = {
  OWNER,
  submission,
  submissionV8,
  v9Spec,
  v8Spec,
  encryptedV8Spec,
  confirmedEvent,
  legacyEvent,
  instantiatedSpec,
  tempMessage,
};
