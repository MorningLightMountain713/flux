const config = require('config');
const path = require('path');

// Directory paths
const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
const appsFolder = path.join(appsFolderPath, '/');
// Backing FLUXFSVOL images live here when the host volume is the root
// filesystem (the directory ships with the repo - see appvolumes/.gitkeep).
const appVolumesPath = path.join(fluxDirPath, 'appvolumes');
// The path used to be assembled by string concatenation without a separator,
// landing images in a glued '<fluxDir>appvolumes' sibling directory (e.g.
// ~/zelfluxappvolumes). Volumes created by older FluxOS still live there, so
// discovery must keep checking it.
const legacyAppVolumesPath = `${fluxDirPath}appvolumes`;
// Node-owned store of declared content blobs (framed ciphertext, one file per
// hash) — the artifact copy peer-serving reads, never the app's live mount. A
// sibling of the apps folder so it lands on the appdata partition but can
// never be reached through a container bind mount. Arcane declares
// FLUX_CONTENT_STORE in /etc/flux_environment; the sibling derivation covers
// environments without it (harness, dev).
const contentStorePath = process.env.FLUX_CONTENT_STORE
  || path.join(path.dirname(appsFolderPath), 'flux-content');

// Database collections - Daemon
const scannedHeightCollection = config.database.daemon.collections.scannedHeight;
const appsHashesCollection = config.database.daemon.collections.appsHashes;

// Database collections - Local apps
const localAppsInformation = config.database.appslocal.collections.appsInformation;

// Database collections - Global apps
const globalAppsMessages = config.database.appsglobal.collections.appsMessages;
const globalAppsInformation = config.database.appsglobal.collections.appsInformation;
const globalAppsTempMessages = config.database.appsglobal.collections.appsTemporaryMessages;
const globalAppsLocations = config.database.appsglobal.collections.appsLocations;
const globalAppsInstallingLocations = config.database.appsglobal.collections.appsInstallingLocations;
const globalAppStateEvents = config.database.appsglobal.collections.appStateEvents;
const globalAppsInstallingErrorsLocations = config.database.appsglobal.collections.appsInstallingErrorsLocations;
const globalAppsInstallingErrorsBroadcasts = config.database.appsglobal.collections.appsInstallingErrorsBroadcasts;

// App / component name validation regexes.
// v8+ app names allow internal hyphens; v<=7 app names and all component names are strictly alphanumeric.
const APP_NAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const APP_NAME_REGEX_LEGACY = /^[a-zA-Z0-9]+$/;

// Supported architectures
const supportedArchitectures = ['amd64', 'arm64'];

// Architectures an encrypted app must support — it runs on Arcane nodes, which are amd64-only
const arcaneRequiredArchitectures = ['amd64'];

// Apps that might be using old gateway IP assignment
const appsThatMightBeUsingOldGatewayIpAssignment = [
  'HNSDoH', 'dane', 'fdm', 'Jetpack2', 'fdmdedicated',
  'isokosse', 'ChainBraryDApp', 'health', 'ethercalc',
];

// Default node specifications
const defaultNodeSpecs = {
  cpuCores: 0,
  ram: 0,
  ssdStorage: 0,
};

// Apps monitored structure template
const appsMonitoredTemplate = {
  // component1_appname2: { // >= 4 or name for <= 3
  //   oneMinuteInterval: null, // interval
  //   fifteenMinInterval: null, // interval
  //   oneMinuteStatsStore: [ // stores last hour of stats of app measured every minute
  //     { // object of timestamp, data
  //       timestamp: 0,
  //       data: { },
  //     },
  //   ],
  //   fifteenMinStatsStore: [ // stores last 24 hours of stats of app measured every 15 minutes
  //     { // object of timestamp, data
  //       timestamp: 0,
  //       data: { },
  //     },
  //   ],
  // },
};

// Expiry / TTL constants (milliseconds), derived from config (fluxapps) — the
// integrity-checked tunable surface. Config carries these in seconds.
const GOSSIP_VALIDITY_MS = config.fluxapps.gossipValidityS * 1000;
const RUNNING_EXPIRY_MS = config.fluxapps.locationTtlS * 1000;
const INSTALLING_EXPIRY_MS = config.fluxapps.installingTtlS * 1000;
// Renewal cadence for a long-running install's fluxappinstalling claim: re-broadcast
// before INSTALLING_EXPIRY_MS lapses so a live install keeps its seat, with slack for
// gossip propagation. A dead node stops renewing and its claim expires on the TTL.
const INSTALLING_RENEWAL_MS = config.fluxapps.installingRenewalS * 1000;
const INSTALLING_ERRORS_EXPIRY_MS = config.fluxapps.installErrorTtlS * 1000;
const SIGTERM_EXPIRY_MS = config.fluxapps.sigtermTtlS * 1000;
const EVICTED_EXPIRY_MS = RUNNING_EXPIRY_MS;

// Hash sync constants (blocks, at 30s per block)
const HASH_EXPIRY_BLOCKS = 1051200; // ~1 year — permanently flag unresolvable hashes
const HASH_RETRY_BACKOFF = [0, 100, 500, 2500, 12500, 50000, 100000]; // ~0, 50min, 4h, 21h, 4d, 17d, 35d

module.exports = {
  // Paths
  fluxDirPath,
  appsFolderPath,
  appsFolder,
  appVolumesPath,
  legacyAppVolumesPath,
  contentStorePath,

  // Database collections
  scannedHeightCollection,
  appsHashesCollection,
  localAppsInformation,
  globalAppsMessages,
  globalAppsInformation,
  globalAppsTempMessages,
  globalAppsLocations,
  globalAppsInstallingLocations,
  globalAppStateEvents,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,

  // Validation regexes
  APP_NAME_REGEX,
  APP_NAME_REGEX_LEGACY,

  // Configuration
  supportedArchitectures,
  arcaneRequiredArchitectures,
  appsThatMightBeUsingOldGatewayIpAssignment,
  defaultNodeSpecs,
  appsMonitoredTemplate,

  // Expiry / TTL
  GOSSIP_VALIDITY_MS,
  RUNNING_EXPIRY_MS,
  INSTALLING_EXPIRY_MS,
  INSTALLING_RENEWAL_MS,
  INSTALLING_ERRORS_EXPIRY_MS,
  SIGTERM_EXPIRY_MS,
  EVICTED_EXPIRY_MS,

  // Hash sync
  HASH_EXPIRY_BLOCKS,
  HASH_RETRY_BACKOFF,
};
