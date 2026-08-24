import { createHash, randomBytes } from 'node:crypto';
import { buildEnterpriseBlob } from './enterprise-helper.js';
import { signBtcMessage } from '../auth.js';
import { appOwnerKey } from './keys.js';
import { REGISTRY_REPO_HOST } from './subnet-config.js';
import { assertHermeticRepotags } from './app-helper.js';

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fakeTxid() {
  return randomBytes(32).toString('hex');
}

export async function buildSeedableApp({
  name,
  compose = null,
  height = 2100010,
  instances = 3,
  owner = null,
  staticip = false,
  enterprise = '',
  expire = 22000,
  allowExternalRepotag = false,
}) {
  const ownerKey = appOwnerKey();
  const appOwner = owner ?? ownerKey.zelid;

  const spec = {
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
      ports: [31111],
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
    geolocation: [],
    expire,
    nodes: [],
    staticip,
    enterprise,
  };

  const type = 'fluxappregister';
  const version = 1;
  const timestamp = Date.now();
  const payload = type + version + JSON.stringify(spec) + timestamp;
  const signature = await signBtcMessage(payload, ownerKey.privkey);

  const messageContent = type + version + JSON.stringify(spec) + timestamp + signature;
  const hash = sha256(messageContent);
  const txid = fakeTxid();

  const permanentMessage = {
    type,
    version,
    appSpecifications: spec,
    hash,
    timestamp,
    signature,
    txid,
    height,
    valueSat: 200000000,
  };

  const hashEntry = {
    hash,
    txid,
    height,
    value: 200000000,
    message: true,
    messageNotFound: false,
    createdAt: new Date(),
  };

  assertHermeticRepotags(spec, allowExternalRepotag);
  const specWithMeta = { ...spec, hash, height };

  return { spec: specWithMeta, permanentMessage, hashEntry, hash, txid };
}

// The v9 sync-mode names, mapped to the legacy containerData letter flags
// flux-spec still parses on the wire. The names are the product vocabulary;
// the letters exist only here, at the wire boundary.
const CONTAINER_DATA_FLAG = { activeStandby: 'g', syncFirst: 'r', sync: 's' };

/**
 * A seedable app whose primary component carries a syncthing sync mode
 * (`activeStandby`, `syncFirst`, or `sync`), encoded into the spec's legacy
 * containerData flag. Drive its sync state with framework/syncthing-control
 * and its election with framework/fdm-control. Pass `sibling: true` to add a
 * plain (non-synced) component so a test can prove the decider only acts on
 * the synced component and leaves siblings running.
 */
export async function buildSeedableSyncthingApp({
  name,
  syncMode = 'activeStandby',
  repotag = `${REGISTRY_REPO_HOST}/${name}:v1`,
  ports = [31111],
  containerPorts = [80],
  sibling = false,
  hdd = 1,
  ...rest
}) {
  const mode = CONTAINER_DATA_FLAG[syncMode];
  if (!mode) throw new Error(`buildSeedableSyncthingApp: unknown syncMode '${syncMode}'`);
  const compose = [{
    name,
    description: `${syncMode} sync component`,
    repotag,
    ports: [ports[0]],
    domains: [''],
    environmentParameters: [],
    commands: [],
    containerPorts,
    containerData: `${mode}:/appdata`,
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
      ports: [ports[0] + 1],
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
  name, exitCode = 0, exitAfterS = null, port = 31111, ...rest
}) {
  const environmentParameters = [`EXIT_CODE=${exitCode}`];
  if (exitAfterS != null) environmentParameters.push(`EXIT_AFTER_S=${exitAfterS}`);

  const compose = [{
    name,
    description: 'configurable exit test container',
    repotag: `${REGISTRY_REPO_HOST}/${name}:v1`,
    ports: [port],
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
  mode = 'g',
  plainPath = '/data',
  syncPath = '/db',
  repotag = `${REGISTRY_REPO_HOST}/${name}:v1`,
  ports = [31111],
  containerPorts = [80],
  ...rest
}) {
  const compose = [{
    name,
    description: `mixed plain + ${mode}: component`,
    repotag,
    ports: [ports[0]],
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
  basePort = 31111,
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
      ports: [basePort + i],
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
 * (`g:/data|0:/x`, like real baserow) that volumeConstructor must reject
 * ("Component 0 cannot reference component 0"). See project_harness_gaps #1.
 */
export async function buildSeedableIndexRefApp({
  name,
  selfRef = false,
  mode = 'g',
  repotag = `${REGISTRY_REPO_HOST}/${name}:v1`,
  containerPorts = [80],
  ...rest
}) {
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
      ports: [31111],
      containerData: `${mode}:/appdata|0:/selfref`,
    }]
    : [
      {
        ...base,
        name: `${name}c0`,
        description: `${mode}: base component (index 0)`,
        ports: [31111],
        containerData: `${mode}:/appdata`,
      },
      {
        ...base,
        name: `${name}c1`,
        description: 'component referencing component 0 volume (index 1 -> 0)',
        ports: [31112],
        containerData: '/own|0:/shared',
      },
    ];

  return buildSeedableApp({ name, compose, ...rest });
}

// The running set is a derivation over the app state event log, so seeding a
// location means asserting the event the derivation reads - there is no
// materialized row to write, and writing one would be seeding a shape nothing
// consults.
export function buildRunningState({ appName, nodeIps, hash, broadcastedAt = null }) {
  const ts = broadcastedAt ?? Date.now();

  const stateEvents = nodeIps.map((ip) => ({
    type: 'apprunning',
    ip,
    dedupKey: 'v2',
    broadcastedAt: new Date(ts),
    expireAt: new Date(ts + 125 * 60 * 1000),
    receivedAt: new Date(ts),
    data: {
      apps: [{ name: appName, hash, runningSince: ts - 60000 }],
      ip,
      broadcastedAt: ts,
    },
  }));

  return { stateEvents };
}

export async function seedAppOnAllNodes(dbClients, { name, compose, height, instances } = {}) {
  const app = await buildSeedableApp({ name, compose, height, instances });

  const seedPromises = dbClients.map(async (dbc) => {
    await dbc.seedGlobalAppSpec(app.spec);
    await dbc.seedPermanentMessage(app.permanentMessage);
    await dbc.seedAppHash(app.hash, app.permanentMessage.height, true);
  });
  await Promise.all(seedPromises);

  return app;
}

export async function seedAppWithRunningState(dbClients, nodeIps, { name, compose, height, instances } = {}) {
  const app = await seedAppOnAllNodes(dbClients, { name, compose, height, instances });
  const state = buildRunningState({ appName: name, nodeIps, hash: app.hash });

  const seedPromises = dbClients.map(async (dbc) => {
    for (const evt of state.stateEvents) {
      await dbc.seedAppStateEvent(evt);
    }
  });
  await Promise.all(seedPromises);

  return { ...app, stateEvents: state.stateEvents };
}

/**
 * A seedable ENTERPRISE app in exactly the production storage shape: version 8,
 * compose EMPTY, the real component list AES-encrypted into the enterprise blob
 * (the daemon stub's decryptrsamessage hands FluxOS the known AES key, so the
 * node decrypts it through the normal path). Pass the same `compose` you would
 * give buildSeedableApp.
 */
export async function buildSeedableEnterpriseApp({ name, compose, contacts = [], ...rest }) {
  const components = compose ?? [{
    name,
    description: 'seeded enterprise component',
    repotag: `${REGISTRY_REPO_HOST}/e2e-pause:v1`,
    ports: [31131],
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
  const enterprise = buildEnterpriseBlob(components, contacts);
  return buildSeedableApp({
    name, compose: [], enterprise, ...rest,
  });
}
