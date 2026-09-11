'use strict';

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

/**
 * The role label on a container FluxOS runs for its OWN purposes, rather than
 * for a tenant.
 *
 * It answers the single question isManagedContainer cannot: a container with no
 * identity label and no name of ours is either the node's own work or a
 * stranger's, and a sweep that stops strangers has to tell them apart.
 *
 * Deliberately NOT in the spec library's LABEL_KEYS, and deliberately not
 * namespaced to look as though it were. Every key in that registry is stamped
 * by identityLabels() on every app container, which is what lets a key's
 * ABSENCE mean "not one of ours". This one inverts that - present only on
 * containers that have no IDENTIFIER, absent on every real app - so admitting
 * it would turn the registry from "the keys describing an app container" into
 * "the keys used somewhere", and a later reader could no longer tell which kind
 * it was looking at. Both its ends are in FluxOS (volumeExecutor writes it, the
 * non-flux sweep reads it), so one constant here gives it the single definition
 * the cross-repo registry exists to provide. It moves into that registry if
 * something outside FluxOS ever has to read it, and not before.
 *
 * It lives here rather than beside its reader in dockerService because a
 * consumer that stubs dockerService would otherwise get `undefined` as the
 * label KEY at module load, which writes a container labelled `undefined` and
 * fails nowhere.
 *
 * The name stays in the pre-unification namespace: the containers carrying it
 * are short-lived and in flight across an upgrade - a copy started by 8.18.0 is
 * still running when v9 takes over the sweep, and renaming the key would make
 * the new sweep stop it.
 */
const UTILITY_ROLE_LABEL = 'runonflux.role';

// Database collections - Daemon
const scannedHeightCollection = config.get('database.daemon.collections.scannedHeight');
const appsHashesCollection = config.get('database.daemon.collections.appsHashes');

// Database collections - Local apps
const localAppsInformation = config.get('database.appslocal.collections.appsInformation');

// Database collections - Global apps
const globalAppsMessages = config.get('database.appsglobal.collections.appsMessages');
const globalAppsInformation = config.get('database.appsglobal.collections.appsInformation');
const globalAppsTempMessages = config.get('database.appsglobal.collections.appsTemporaryMessages');
const globalAppsInstallingLocations = config.get('database.appsglobal.collections.appsInstallingLocations');
const globalAppsInstallingBroadcasts = config.get('database.appsglobal.collections.appsInstallingBroadcasts');
const globalAppStateEvents = config.get('database.appsglobal.collections.appStateEvents');
const globalAppsInstallingErrorsLocations = config.get('database.appsglobal.collections.appsInstallingErrorsLocations');
const globalAppsInstallingErrorsBroadcasts = config.get('database.appsglobal.collections.appsInstallingErrorsBroadcasts');
const globalAppsIngressAttestations = config.get('database.appsglobal.collections.appsIngressAttestations');
const globalAppsIngressAttestationDigests = config.get('database.appsglobal.collections.appsIngressAttestationDigests');

// App / component name validation regexes.
// v8+ app names allow internal hyphens; v<=7 app names and all component names are strictly alphanumeric.
const APP_NAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const APP_NAME_REGEX_LEGACY = /^[a-zA-Z0-9]+$/;

// Mount options for an app's FLUXFSVOL. An app volume holds data its owner
// writes, so nothing stored there should be able to confer privilege on
// whatever reads it back.
//
// `nosuid` makes any setuid/setgid bit on the volume inert. It does NOT prevent
// execution - an app that downloads and runs a binary from its own volume is
// unaffected - it only stops that binary switching to another user. Legitimate
// setuid binaries live in the container image, not in appdata.
//
// `nodev` stops a device node on the volume being honoured; an app that needs
// device access gets it from docker's device mapping.
//
// This belongs at the mount rather than in any one caller because there is more
// than one way for such a file to arrive: unpacking a user-supplied archive is
// the obvious one, but a copy preserves the bits too. A bind mount inherits its
// source's options, so a volume handed to a container carries them as well.
const APP_VOLUME_MOUNT_OPTIONS = 'loop,nosuid,nodev';

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

// Expiry / TTL constants (milliseconds).
//
// The three stamped onto records live in config as seconds, so the harness can
// compress them the way it compresses every other cadence; the literal after
// `??` is the production default and is what a node runs when the key is absent.
// They lived here as bare literals from the day expiry moved per-document: the
// config keys were wired to the collection-level TTL indexes that scheme
// replaced, so when those indexes were dropped the keys were left reading
// nothing, and a later unused-variable sweep removed the last binding to them.
// Reading config here cannot reintroduce the cycle those literals were moved to
// break - that was messageVerifier -> registryManager -> messageStore ->
// messageVerifier, entirely between services, and `config` is a leaf this file
// already requires for the collection names above.
// The freshness window for accepting app gossip. Config-driven for the same reason
// as the rest of the block: the harness compresses the TTLs these messages are
// stamped against, and a validity window that does not move with them makes peers
// refuse each other's perfectly current broadcasts.
const GOSSIP_VALIDITY_MS = (config.get('fluxapps.gossipValidityS')) * 1000;
const RUNNING_EXPIRY_MS = (config.get('fluxapps.locationTtlS')) * 1000;
const INSTALLING_EXPIRY_MS = (config.get('fluxapps.installingTtlS')) * 1000;
// Bounds clock disagreement, not message usefulness — see the config comment.
// Defaulted, not read bare: consumed in arithmetic, so a missing key would become NaN
// and silently disable every comparison that uses it.
const CLOCK_SKEW_ALLOWANCE_MS = config.get('fluxapps.clockSkewAllowanceMs');
// Renewal cadence for a long-running install's fluxappinstalling claim: re-broadcast
// before INSTALLING_EXPIRY_MS lapses so a live install keeps its seat, with slack for
// gossip propagation. A dead node stops renewing and its claim expires on the TTL.
//
// DERIVED from the expiry rather than declared, for the reason the block above gives:
// a harness that compresses installingTtlS and leaves a hardcoded renewal behind
// inverts the pair, and a renewal longer than the expiry means a live install loses
// its seat mid-pull - the exact failure the claim exists to prevent. 80% of the TTL
// is 12 minutes at the 900s default, which is what installingRenewalS carries.
//
// An explicit key wins where one is set (the harness tunes it against a compressed
// TTL); the derivation is the fallback, so an absent key can never invert the pair.
const INSTALLING_RENEWAL_MS = config.get('fluxapps.installingRenewalS')
  ? config.get('fluxapps.installingRenewalS') * 1000
  : Math.floor(INSTALLING_EXPIRY_MS * 0.8);
const INSTALLING_ERRORS_EXPIRY_MS = (config.get('fluxapps.installErrorTtlS')) * 1000;
// The grace every stop gets, announced or not. A juror that saw a
// SHUTTING_DOWN close waits this long before it looks; the derivation
// negates a certified node's rows this long after the certificate's since;
// a booting node compares its downtime with it. One value for a whole
// fleet, because every node must negate the same rows at the same instant
// — a node whose value differed would replace apps the rest of the fleet
// still believes placed. Production's 420 s is the default; a harness
// fleet scales it for every node together, at its block cadence's factor.
const NODE_DOWN_GRACE_MS = (config.get('fluxapps.nodeDownGraceS')) * 1000;
// A FluxOS restart is back in seconds; a juror that saw a RESTARTING close
// waits only this long.
const RESTART_GRACE_MS = (config.get('fluxapps.restartGraceS')) * 1000;

/**
 * How often a node announces the apps it is running.
 *
 * Derived, not configured. A node writes its OWN location row when it
 * announces, and that row expires RUNNING_EXPIRY_MS after the announcement that
 * carried it - so the interval and the expiry are one decision and the pair
 * cannot be allowed to drift. Two numbers here were a pairing an edit could set
 * wrong in either file, with a node's presence on the network as the thing that
 * silently degraded.
 *
 * TWO announcements inside one lifetime, because a node must be able to miss
 * one and still be refreshed before the row lapses. The 4% is the slack that
 * miss needs: without it the refresh lands exactly as the row expires.
 *
 * Production 7500s -> 3600s, and the harness's 63s -> 30s: the values both
 * configurations were carrying by hand.
 */
const ANNOUNCES_PER_EXPIRY = 2;
const ANNOUNCE_SLACK = 0.04;
const ANNOUNCE_INTERVAL_MS = Math.floor(
  (RUNNING_EXPIRY_MS * (1 - ANNOUNCE_SLACK)) / ANNOUNCES_PER_EXPIRY / 1000,
) * 1000;

// How long a removal waits for an announcement cycle to finish sending before it
// tells the network the app is gone. A cycle is one database read per installed
// app, one signature and one broadcast, so this is orders of magnitude above a
// healthy one at any plausible app count - and it is bounded at all because a
// wedged cycle must not hold up the node's removals, which take the removal lock
// and block every install and redeploy behind them.
const ANNOUNCE_CYCLE_WAIT_MS = 30 * 1000;

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
  globalAppsInstallingLocations,
  globalAppsInstallingBroadcasts,
  globalAppStateEvents,
  globalAppsInstallingErrorsLocations,
  globalAppsInstallingErrorsBroadcasts,
  globalAppsIngressAttestations,
  globalAppsIngressAttestationDigests,

  // Validation regexes
  APP_NAME_REGEX,
  APP_NAME_REGEX_LEGACY,

  // Volumes
  APP_VOLUME_MOUNT_OPTIONS,

  // Configuration
  supportedArchitectures,
  arcaneRequiredArchitectures,
  appsThatMightBeUsingOldGatewayIpAssignment,
  defaultNodeSpecs,

  // Expiry / TTL
  GOSSIP_VALIDITY_MS,
  CLOCK_SKEW_ALLOWANCE_MS,
  RUNNING_EXPIRY_MS,
  ANNOUNCE_INTERVAL_MS,
  ANNOUNCE_CYCLE_WAIT_MS,
  INSTALLING_EXPIRY_MS,
  INSTALLING_RENEWAL_MS,
  INSTALLING_ERRORS_EXPIRY_MS,
  NODE_DOWN_GRACE_MS,
  RESTART_GRACE_MS,

  UTILITY_ROLE_LABEL,

  // Hash sync
  HASH_EXPIRY_BLOCKS,
  HASH_RETRY_BACKOFF,
};
