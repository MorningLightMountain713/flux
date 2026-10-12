import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnterpriseBlob } from './enterprise-helper.js';
import { signBtcMessage } from '../auth.js';
import { appOwnerKey } from './keys.js';
import { REGISTRY_REPO_HOST } from './subnet-config.js';
import { assertHermeticRepotags } from './app-helper.js';
import { appIdentityFromUuid, appUuid, Chain } from '@runonflux/flux-spec';
import { deserializeSpec } from '@runonflux/flux-spec-backend';
import { allocatePortFor, assignPorts } from './port-allocator.js';
import { harnessNow } from './harness-clock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const deterministicList = JSON.parse(
  readFileSync(join(HERE, '..', '..', 'fixtures', 'deterministic-list.json'), 'utf-8'),
);

/**
 * A node's collateral outpoint, in the form a spec's `nodes` array uses.
 *
 * The other half of how a pin can name a node. It reads from the same fixture the daemon
 * stub answers getzelnodestatus from, so the value a suite pins with is the value the node
 * will report for itself - restating it in a suite is how a pin silently matches nobody.
 * @param {number} index Node index, 0-based, as env.clients is indexed.
 * @returns {string} `<txhash>:<outidx>`
 */
export function nodeOutpoint(index) {
  const node = deterministicList[index];
  if (!node) throw new Error(`nodeOutpoint: no node at index ${index}`);
  return `${node.txhash}:${node.outidx}`;
}

/**
 * A specification in the spelling its version's messages are signed in: the
 * fields the version has, in the library's order. A node hashes the forms the
 * library knows, so a message whose hash is over any other spelling of the same
 * specification is refused as one whose contents do not hash to its hash.
 * @param {object} spec
 * @returns {object}
 */
function signedSpelling(spec) {
  // the harness fleet runs mainnet's chain: its stub daemon reports `main`
  const parsed = deserializeSpec(spec, { chain: Chain.MAIN });
  return typeof parsed.allSerializations === 'function' ? parsed.allSerializations()[0] : parsed.toCanonical();
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Every option this builder reads. An option outside this set is a fixture
// describing an app it did not build, so it is refused here rather than dropped.
const SEEDABLE_APP_OPTIONS = new Set([
  'name', 'compose', 'instances', 'owner', 'staticip',
  'enterprise', 'expire', 'allowExternalRepotag', 'allowPortReuse',
  'nodes', 'pinnedTo', 'geolocation',
]);

export async function buildSeedableApp(opts) {
  const unknown = Object.keys(opts).filter((key) => !SEEDABLE_APP_OPTIONS.has(key));
  if (unknown.length) {
    throw new Error(`buildSeedableApp: unknown option(s) ${unknown.join(', ')}; a sync mode is syncMode on buildSeedableSyncthingApp`);
  }
  const {
  name,
  compose = null,
  instances = 3,
  owner = null,
  staticip = false,
  enterprise = '',
  expire = 22000,
  allowExternalRepotag = false,
  // Two apps in a suite wanting one port is refused here by default. A suite
  // for which the collision IS the subject - 98 - says so.
  allowPortReuse = false,
  // Pin the app to named nodes. An entry names a node EITHER by socket address
  // ('198.18.1.0:16127') or by collateral outpoint ('<txhash>:<outidx>') - both
  // are live on the network, and nodeOutpoint() below builds the second form.
  //
  // Set HERE and nowhere else: the signature and the hash are taken over
  // JSON.stringify(spec) a few lines down, so a suite that pins an app by
  // writing to the returned spec gets a specification whose hash belongs to a
  // different one. Nothing rejects that - the node simply decides the app is
  // obsolete and reinstalls it forever.
  nodes = [],
  // The same pin, by node index: the nodes the app runs on and nowhere else.
  // Every node learns of an app the network has, so a suite that installs on
  // chosen nodes names them here, and the pin keeps the rest of the fleet off it.
  pinnedTo = null,
  // Where the app may and may not be placed, in the spec's own entries.
  geolocation = [],
  } = opts;
  if (pinnedTo && nodes.length) {
    throw new Error(`buildSeedableApp: ${name} names its nodes twice, by pinnedTo and by nodes`);
  }
  const targets = pinnedTo ? pinnedTo.map(nodeOutpoint) : nodes;
  const ownerKey = appOwnerKey();
  const appOwner = owner ?? ownerKey.zelid;

  const draft = {
    version: 8,
    name,
    description: `Seeded test app ${name}`,
    owner: appOwner,
    compose: compose ?? [{
      name,
      description: 'seeded component',
      // harness registry, never bare Docker Hub: hub repotags make installs
      // pull over live internet (rate-limit flakes); the env registry is
      // seeded with this image at bootstrap (test-env.js)
      repotag: `${REGISTRY_REPO_HOST}/e2e-pause:v1`,
      ports: [],
      domains: [''],
      environmentParameters: [],
      commands: [],
      containerPorts: [80],
      containerData: '/tmp',
      cpu: 0.1,
      ram: 100,
      hdd: 1,
      repoauth: '',
    }],
    instances,
    contacts: [],
    geolocation,
    expire,
    nodes: targets,
    staticip,
    enterprise,
  };

  // Components copied before anything is written into them: assignPorts sets the
  // allocated port on the component it is given, and a caller that reuses the array
  // it passed in would get a port stamped into its own object.
  draft.compose = draft.compose.map((component) => ({ ...component }));

  // Before the signature and the hash, never after: both are taken over
  // JSON.stringify(spec), so a port added later leaves the app carrying a hash
  // of a specification that no longer exists. An enterprise app has an empty
  // compose here - its components are already inside the blob, ported by
  // buildSeedableEnterpriseApp before it encrypted them.
  if (draft.compose.length) assignPorts(draft.compose, name, { allowPortReuse });
  const spec = signedSpelling(draft);

  const type = 'fluxappregister';
  const version = 1;
  const timestamp = harnessNow();
  const payload = type + version + JSON.stringify(spec) + timestamp;
  const signature = await signBtcMessage(payload, ownerKey.privkey);

  const messageContent = type + version + JSON.stringify(spec) + timestamp + signature;
  const hash = sha256(messageContent);

  // The message as its owner signed it: what a node is handed. The chain
  // carries its payment, and every record of the app is the node's own.
  const message = {
    type,
    version,
    appSpecifications: spec,
    hash,
    timestamp,
    signature,
  };

  assertHermeticRepotags(spec, allowExternalRepotag);
  // The app as its registration makes it: the uuid minted from the name and the
  // message hash, and the identity every container, directory, image and network
  // of the app is named from. The version the app is registered with fixes its
  // syncthing folder ids and the alias an app registered before v9 keeps.
  const uuid = appUuid(name, hash);
  const identity = appIdentityFromUuid(uuid);

  return {
    spec: {
      ...spec, hash, uuid, identity,
    },
    message,
    hash,
    uuid,
    identity,
    registrationVersion: spec.version,
  };
}

// The v9 sync-mode names, mapped to the legacy containerData letter flags
// flux-spec still parses on the wire. The names are the product vocabulary;
// the letters exist only here, at the wire boundary.
const CONTAINER_DATA_FLAG = { activeStandby: 'g', syncFirst: 'r', sync: 's' };

/**
 * The containerData a v8 component carries for a synced mount in this sync mode.
 * @param {string} syncMode activeStandby, syncFirst or sync
 * @param {string} [path] the container path the mount binds to
 * @returns {string}
 */
export function syncedContainerData(syncMode, path = '/appdata') {
  const mode = CONTAINER_DATA_FLAG[syncMode];
  if (!mode) throw new Error(`syncedContainerData: unknown syncMode '${syncMode}'`);
  return `${mode}:${path}`;
}

/**
 * The same app, one specification later.
 *
 * An owner changing a running app is most of what owners do, and until this
 * existed the harness could create an app and destroy one but never change one -
 * so every path that answers a spec change (the periodic reinstall pass, the
 * change detector that decides soft against hard, the strip list that decides
 * what counts as a change at all) had no fleet coverage.
 *
 * The node decides an app is obsolete by comparing the hash it installed against
 * the hash the global specification now carries, so `mutate` has to change
 * something: an update that leaves the spec identical is signed over the same
 * bytes, hashes the same, and the node is right to do nothing with it.
 *
 * Ports are NOT reassigned. They were allocated for this app when it was first
 * built and are already stamped into the components being copied; re-running the
 * allocator would either hand out a second port or trip its own reuse guard.
 *
 * @param {object} app - what buildSeedableApp returned
 * @param {(spec: object) => void} mutate - changes the copy in place
 * @param {object} [opts] - { signerKey }: who signs the update, the harness's
 *   app owner unless given; after a sale the owner on record is the buyer
 * @returns {Promise<object>} the same shape buildSeedableApp returns
 */
export async function buildSeedableUpdate(app, mutate, { signerKey = appOwnerKey() } = {}) {

  // hash, uuid and identity are what the registration made; the signature and
  // the hash below are taken over the specification alone, exactly as
  // registration took them.
  const { uuid, identity } = app.spec;
  const { registrationVersion } = app;
  const bare = JSON.parse(JSON.stringify(app.spec));
  delete bare.hash;
  delete bare.uuid;
  delete bare.identity;
  const before = JSON.stringify(bare);

  const draft = JSON.parse(before);
  draft.compose = (draft.compose ?? []).map((component) => ({ ...component }));
  mutate(draft);
  const spec = signedSpelling(draft);

  if (JSON.stringify(spec) === before) {
    throw new Error(`buildSeedableUpdate: mutate left ${spec.name} unchanged, so its hash is unchanged and the node has nothing to notice`);
  }

  const type = 'fluxappupdate';
  const version = 1;
  const timestamp = harnessNow();
  const payload = type + version + JSON.stringify(spec) + timestamp;
  const signature = await signBtcMessage(payload, signerKey.privkey);

  const hash = sha256(type + version + JSON.stringify(spec) + timestamp + signature);

  // An updated app keeps its registration's uuid, identity and version.
  return {
    spec: {
      ...spec, hash, uuid, identity,
    },
    message: {
      type, version, appSpecifications: spec, hash, timestamp, signature,
    },
    hash,
    uuid,
    identity,
    registrationVersion,
  };
}

/**
 * A seedable LEGACY app - version 3, which has no compose array at all: the
 * one component's fields sit flat on the specification itself.
 *
 * That shape is why a restore of such an app used to throw before it did
 * anything: the code reached for `.compose` and found nothing. `seed-helper`
 * builds v8 everywhere else, so nothing in the harness could produce an app that
 * takes the legacy branch.
 *
 * The field list is what appValidator demands of version <= 3, including two
 * details that are easy to get wrong: `ports` and `containerPorts` are arrays of
 * STRINGS rather than numbers, and the environment array is spelled
 * `enviromentParameters` - the historical misspelling that dockerService still
 * reads as a fallback.
 *
 * @param {object} opts - name, containerData and the usual overrides
 * @returns {Promise<object>} the same shape buildSeedableApp returns
 */
export async function buildSeedableLegacyApp({
  name,
  containerData = '/appdata',
  // A version 3 specification names its instance count, and the network has
  // never accepted fewer than three.
  instances = 3,
  owner = null,
  allowExternalRepotag = false,
}) {
  const ownerKey = appOwnerKey();
  const appOwner = owner ?? ownerKey.zelid;

  const spec = signedSpelling({
    version: 3,
    name,
    description: `Seeded legacy test app ${name}`,
    owner: appOwner,
    repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
    // A v3 spec spells its ports as STRINGS, so this is the one builder that
    // has to ask the allocator for a number rather than leave the field absent
    // for buildSeedableApp to fill in - it builds its own spec.
    ports: [String(allocatePortFor(name))],
    domains: [''],
    enviromentParameters: [],
    commands: [],
    containerPorts: ['80'],
    containerData,
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    tiered: false,
    instances,
  });

  const type = 'fluxappregister';
  const messageVersion = 1;
  const timestamp = harnessNow();
  const payload = type + messageVersion + JSON.stringify(spec) + timestamp;
  const signature = await signBtcMessage(payload, ownerKey.privkey);

  const messageContent = type + messageVersion + JSON.stringify(spec) + timestamp + signature;
  const hash = sha256(messageContent);

  assertHermeticRepotags(spec, allowExternalRepotag);
  const uuid = appUuid(name, hash);
  const identity = appIdentityFromUuid(uuid);
  return {
    spec: {
      ...spec, hash, uuid, identity,
    },
    message: {
      type,
      version: messageVersion,
      appSpecifications: spec,
      hash,
      timestamp,
      signature,
    },
    hash,
    uuid,
    identity,
    registrationVersion: spec.version,
  };
}

/**
 * A seedable app whose primary component carries a syncthing sync mode
 * (`activeStandby`, `syncFirst`, or `sync`), encoded into the spec's legacy
 * containerData flag. Drive its sync state with framework/syncthing-control
 * and its election with framework/fdm-control. Pass `sibling: true` to add a
 * plain (non-synced) component so a test can prove the decider only acts on
 * the synced component and leaves siblings running.
 *
 * `extraMounts` appends mount segments after the primary, which is the only way to
 * build the forms that put something of FluxOS's OWN on the volume: `f:` is touched
 * as a zero-length file so docker cannot create a directory in its place, `m:` and
 * `ml:` are mkdir'd. Every one of them lands inside the syncthing folder, so a suite
 * that never uses them is testing sync against a volume real apps do not have -
 * which is how a cold start could deadlock on every `g:`+`f:` app on the network
 * while the suite written for exactly that standoff stayed green.
 */
export async function buildSeedableSyncthingApp({
  name,
  syncMode = 'activeStandby',
  repotag = `${REGISTRY_REPO_HOST}/${name}:v1`,
  containerPorts = [80],
  sibling = false,
  extraMounts = [],
  hdd = 1,
  ...rest
}) {
  const mode = CONTAINER_DATA_FLAG[syncMode];
  if (!mode) throw new Error(`buildSeedableSyncthingApp: unknown syncMode '${syncMode}'`);
  const compose = [{
    name,
    description: `${syncMode} sync component`,
    repotag,
    ports: [],
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerPorts,
    containerData: [`${mode}:/appdata`, ...extraMounts].join('|'),
    cpu: 0.1,
    ram: 100,
    hdd,
    repoauth: '',
  }];

  if (sibling) {
    compose.push({
      name: `${name}sib`,
      description: 'plain sibling component',
      repotag,
      ports: [],
      domains: [''],
      environmentParameters: [],
      commands: [],
      containerPorts,
      containerData: '/sibdata',
      cpu: 0.1,
      ram: 100,
      hdd: 1,
      repoauth: '',
    });
  }

  return buildSeedableApp({ name, compose, ...rest });
}

/**
 * A seedable app backed by the configurable test-app image (see
 * test-infra/test-app). Exit behaviour is driven by env vars passed through the
 * spec's environmentParameters: EXIT_CODE (status on signal/timed exit) and
 * optional EXIT_AFTER_S (self-exit after N seconds). Push the image first with
 * registry-helper.pushTestApp(name).
 */
export async function buildSeedableTestApp({
  name, exitCode = 0, exitAfterS = null, exitAfterMs = null, ...rest
}) {
  const environmentParameters = [`EXIT_CODE=${exitCode}`];
  if (exitAfterS != null) environmentParameters.push(`EXIT_AFTER_S=${exitAfterS}`);
  // Sub-second, for an app that must never be observed running: the install's
  // own start still succeeds, so the node holds the app, but nothing that polls
  // docker afterwards can catch the process alive.
  if (exitAfterMs != null) environmentParameters.push(`EXIT_AFTER_MS=${exitAfterMs}`);

  const compose = [{
    name,
    description: 'configurable exit test container',
    repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
    ports: [],
    domains: [''],
    environmentParameters,
    commands: [],
    containerPorts: [80],
    containerData: '/tmp',
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    repoauth: '',
  }];

  return buildSeedableApp({ name, compose, ...rest });
}

/**
 * A seedable v8 GRACEFUL app: the configurable test-app image plus the legacy
 * `gracefulShutdownSec:<n>` token in the component description, which AppComponentV8
 * parses onto the v9 shutdown shape — so the app reads as graceful
 * (appRequiresDaemonShutdown) and, on an arcane node with flux-shutdownd, is drained
 * rather than force-stopped. exitCode 0 makes the container exit cleanly on SIGTERM
 * so a test can tell a graceful stop from a SIGKILL. Push the image first with
 * registry-helper.pushTestApp(name).
 */
export async function buildSeedableGracefulV8App({
  name, gracefulSec = 3, exitCode = 0, port = 31111, ...rest
}) {
  const compose = [{
    name,
    description: `graceful test container. gracefulShutdownSec:${gracefulSec}`,
    repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
    ports: [port],
    domains: [''],
    environmentParameters: [`EXIT_CODE=${exitCode}`],
    commands: [],
    containerPorts: [80],
    containerData: '/tmp',
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    repoauth: '',
  }];
  return buildSeedableApp({ name, compose, ...rest });
}

/**
 * A seedable app with a MIXED-mount component: a plain primary mount plus a synced
 * (g:/r:/s:) mount in a LATER `|`-segment (e.g. `/data|g:/db`, like real roundcube).
 * Exercises the case where the sync flag is NOT the first segment — the shape that
 * deadlocks today because syncthingMonitor only inspects segment 0.
 * See design-gapp-placement-and-coldstart.md (F1) and project_harness_gaps #2.
 */
export async function buildSeedableMixedMountApp({
  name,
  syncMode = 'activeStandby',
  plainPath = '/data',
  syncPath = '/db',
  repotag = `${REGISTRY_REPO_HOST}/${name}:v1`,
  containerPorts = [80],
  ...rest
}) {
  const mode = CONTAINER_DATA_FLAG[syncMode];
  if (!mode) throw new Error(`buildSeedableMixedMountApp: unknown syncMode '${syncMode}'`);
  const compose = [{
    name,
    description: `mixed plain + ${syncMode} component`,
    repotag,
    ports: [],
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerPorts,
    containerData: `${plainPath}|${mode}:${syncPath}`,
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    repoauth: '',
  }];

  return buildSeedableApp({ name, compose, ...rest });
}

/**
 * A seedable app with MULTIPLE synced (g:/r:) components — like real SimpleXxFTP
 * (xftp + onion, both g:). Each component gets its own syncthing folder, exercising
 * multi-folder masterSlave election/coordination. `components` controls the count.
 * See project_harness_gaps #3.
 */
export async function buildSeedableMultiSyncthingApp({
  name,
  syncMode = 'activeStandby',
  components = 2,
  repotag = `${REGISTRY_REPO_HOST}/${name}:v1`,
  containerPorts = [80],
  ...rest
}) {
  const mode = CONTAINER_DATA_FLAG[syncMode];
  if (!mode) throw new Error(`buildSeedableMultiSyncthingApp: unknown syncMode '${syncMode}'`);
  const compose = [];
  for (let i = 0; i < components; i += 1) {
    compose.push({
      name: `${name}c${i}`,
      description: `${syncMode} component ${i}`,
      repotag,
      ports: [],
      domains: [''],
      environmentParameters: [],
      commands: [],
      containerPorts,
      containerData: `${mode}:/appdata${i}`,
      cpu: 0.1,
      ram: 100,
      hdd: 1,
      repoauth: '',
    });
  }

  return buildSeedableApp({ name, compose, ...rest });
}

/**
 * A seedable app exercising component index-ref mounts (`N:` references component
 * N's volume). `selfRef:false` (default) builds a VALID two-component app whose
 * second component references the first (index 1 -> 0, like real SimpleXxFTP's
 * `…|0:/srv/xftp`). `selfRef:true` builds the INVALID single-component self-ref
 * (`g:/data|0:/x`, like real baserow) that the deployment path must reject
 * ("Component 0 cannot reference component 0"). See project_harness_gaps #1.
 */
export async function buildSeedableIndexRefApp({
  name,
  selfRef = false,
  syncMode = 'activeStandby',
  repotag = `${REGISTRY_REPO_HOST}/${name}:v1`,
  containerPorts = [80],
  ...rest
}) {
  const mode = CONTAINER_DATA_FLAG[syncMode];
  if (!mode) throw new Error(`buildSeedableIndexRefApp: unknown syncMode '${syncMode}'`);
  const base = {
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerPorts,
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    repoauth: '',
    repotag,
  };

  const compose = selfRef
    ? [{
      ...base,
      name,
      description: 'invalid self-referencing component (index 0 -> 0)',
      ports: [],
      containerData: `${mode}:/appdata|0:/selfref`,
    }]
    : [
      {
        ...base,
        name: `${name}c0`,
        description: `${syncMode} base component (index 0)`,
        ports: [],
        containerData: `${mode}:/appdata`,
      },
      {
        ...base,
        name: `${name}c1`,
        description: 'component referencing component 0 volume (index 1 -> 0)',
        ports: [],
        containerData: '/own|0:/shared',
      },
    ];

  return buildSeedableApp({ name, compose, ...rest });
}

/**
 * A seedable ENTERPRISE app in exactly the production storage shape: version 8,
 * compose EMPTY, the real component list AES-encrypted into the enterprise blob
 * (the daemon stub's decryptrsamessage hands FluxOS the known AES key, so the
 * node decrypts it through the normal path). Pass the same `compose` you would
 * give buildSeedableApp.
 */
export async function buildSeedableEnterpriseApp({
  name, compose, contacts = [], allowPortReuse = false, ...rest
}) {
  const components = compose ?? [{
    name,
    description: 'seeded enterprise component',
    repotag: `${REGISTRY_REPO_HOST}/e2e-pause:v1`,
    ports: [],
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerPorts: [80],
    containerData: '/tmp',
    cpu: 0.1,
    ram: 100,
    hdd: 1,
    repoauth: '',
  }];
  // Ported here, not in buildSeedableApp: once these are encrypted into the
  // blob the spec's own compose is empty and there is nothing left to give a
  // port to. Copied first, for the reason buildSeedableApp copies.
  const ported = components.map((component) => ({ ...component }));
  assignPorts(ported, name, { allowPortReuse });
  const enterprise = buildEnterpriseBlob(ported, contacts);
  return buildSeedableApp({
    name, compose: [], enterprise, ...rest,
  });
}
