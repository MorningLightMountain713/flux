'use strict';

// App Query Service - Query and information functions for installed apps
const config = require('config');
const dbHelper = require('../dbHelper');
const messageHelper = require('../messageHelper');
const dockerService = require('../dockerService');
const registryManager = require('../appDatabase/registryManager');
const appsRuntimeState = require('../appManagement/appsRuntimeState');
const appsRepository = require('../appDatabase/appsRepository');
const appConstants = require('../utils/appConstants');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const appHistory = require('../appDecisions/appHistory');
const serviceHelper = require('../serviceHelper');
const verificationHelper = require('../verificationHelper');
const { Privilege, authOf } = require('../utils/privileges');
const { socketAddressesMatch } = require('../utils/socketAddressUtils');
const peerIdentityService = require('../peerIdentityService');
const primaryRoleChanges = require('../appLifecycle/primaryRoleChanges');
const folderStates = require('../appMonitoring/folderStates');
const syncthingService = require('../syncthingService');
const operationRegistry = require('../utils/operationRegistry');
const { getSpecBackend } = require('../utils/specLibs');
const log = require('../../lib/log');
const globalState = require('../utils/globalState');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const appReconciler = require('../appMonitoring/appReconciler');

// Database collections
const globalAppsMessages = config.get('database.appsglobal.collections.appsMessages');

/**
 * The specifications of the apps installed on this node, from its own table.
 * @param {object} [query] Narrows the read, as a filter on the table.
 * @returns {Promise<object[]>}
 * @throws {Error} When the table cannot be read.
 */
async function installedAppSpecs(query = {}) {
  const appsDatabase = dbHelper.databaseConnection().db(config.database.appslocal.database);
  return dbHelper.findInDatabase(appsDatabase, appConstants.localAppsInformation, query, { projection: { _id: 0 } });
}

/**
 * The names of the apps installed on this node that the network lists at
 * `socketAddress`: what a node that held that address left there. Rejects
 * when either cannot be read.
 * @param {string} socketAddress
 * @returns {Promise<string[]>}
 */
async function installedAppsListedAt(socketAddress) {
  const names = new Set((await installedAppSpecs()).map((app) => app.name));
  return (await registryManager.appsListedAt(socketAddress)).filter((name) => names.has(name));
}

/**
 * To list installed apps. Returns apps from local database.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function installedApps(req, res) {
  try {
    let filter = {};
    if (req && req.params && req.query) {
      let { appname } = req.params;
      appname = appname || req.query.appname;
      if (appname) {
        filter = { name: appname };
      }
    } else if (req && typeof req === 'string') {
      filter = { name: req };
    }

    const installed = await appsRepository.listInstalledApps({ filter });
    const apps = installed.map((app) => app.serialize());
    const dataResponse = messageHelper.createDataMessage(apps);
    return res ? res.json(dataResponse) : dataResponse;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * The container fields a public listing carries.
 *
 * An allowlist rather than a filter: the view is built from three of docker's
 * own fields, keeping docker's names and forms, so it holds nothing else and a
 * field docker adds in a future version is absent by default rather than
 * carried until someone notices. A listing assembled this way cannot report an
 * application's image, entrypoint, ports or build metadata; those belong to its
 * owner, and are published from its specification when its specification is
 * public.
 *
 * The same three fields for every application, not a smaller view for some.
 * Choosing per application would put that choice at the exit, where getting it
 * wrong is silent.
 *
 * Names stays docker's array, verbatim. FDM builds /flux{component}_{app} and
 * matches Names[0] exactly, failing closed when it does not - so a bare name,
 * or one with the prefix stripped, takes every g: app out of routing.
 *
 * @param {Array<object>} containers - docker container objects
 * @returns {Array<object>} each container as {Names, State, Status}
 */
function publicContainerView(containers) {
  return containers.map((container) => ({
    Names: container.Names,
    State: container.State,
    Status: container.Status,
  }));
}

/**
 * The containers this node should be routed to: everything running, plus any
 * container a backup or restore is holding stopped.
 *
 * Not a filter of listAllApps. A container stopped for a backup is still the
 * application's, and leaving it out is FDM dropping that application from
 * haproxy for the length of the backup - so the in-memory backup and restore
 * sets put it back.
 *
 * Returns docker's container objects whole, for callers inside this process.
 * The public route answers from listRunningApps, which projects them.
 *
 * @returns {Array<object>} docker container objects
 */
async function listRunningContainers() {
  const { LABEL_KEYS: labelKeys } = await getSpecBackend();
  let apps = await dockerService.dockerListContainers(false);
  if (apps.length > 0) {
    apps = apps.filter(
      (app) => dockerService.isManagedContainer({ labels: app.Labels, name: app.Names?.[0] }, labelKeys),
    );
  }

  // Apps mid backup/restore appear stopped but must still be surfaced as present.
  // Derive the set from the registry's backup/restore leases (the same app-name
  // keys the flag arrays held).
  const appsInBackupRestore = [...operationRegistry.listByType('backup'), ...operationRegistry.listByType('restore')];

  if (appsInBackupRestore.length > 0) {
    // Get all containers including stopped ones
    const allContainers = await dockerService.dockerListContainers(true);
    const fluxContainers = allContainers.filter(
      (app) => dockerService.isManagedContainer({ labels: app.Labels, name: app.Names?.[0] }, labelKeys),
    );

    // Find stopped containers that are in backup/restore and add them to running list
    fluxContainers.forEach((container) => {
      // backup/restore hold the bare MAIN app name. The container states its own
      // app in a label; the name is read only for containers created before the
      // labels shipped, because a name-derived answer is the app's identity
      // segment, which is not a name for anything registered since identity
      // minting and so would match nothing.
      const mainAppName = dockerService.containerAppName(
        { labels: container.Labels, name: container.Names?.[0] }, labelKeys,
      );

      // If this app is in backup/restore and not already in running list, add it
      if (mainAppName && appsInBackupRestore.includes(mainAppName)) {
        const alreadyIncluded = apps.some((app) => app.Names[0] === container.Names[0]);
        if (!alreadyIncluded) {
          // Keep original state - FDM treats any container in list as active
          const containerCopy = { ...container };
          apps.push(containerCopy);
        }
      }
    });
  }

  return apps;
}

/**
 * GET /apps/listrunningapps - the public view of the containers this node
 * should be routed to.
 *
 * The response is the same for every caller, which is what lets the route keep
 * its cache: apicache keys an entry on the request URL alone and answers from
 * its store before the handler runs, so anything decided from who is asking is
 * decided once and then served to everyone else.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object|undefined} the message when called without a response
 */
async function listRunningApps(req, res) {
  try {
    const apps = await listRunningContainers();
    if (res) {
      return res.json(messageHelper.createDataMessage(publicContainerView(apps)));
    }
    const modifiedApps = apps.map((app) => {
      const copy = { ...app };
      delete copy.HostConfig;
      delete copy.NetworkSettings;
      delete copy.Mounts;
      return copy;
    });
    return messageHelper.createDataMessage(modifiedApps);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Component identifiers this node holds by its own account: running here,
 * committed to running and not started yet, or deliberately stopped here by the
 * operator.
 *
 * The answer is about OWNERSHIP, not about what is up. Three sources, because no
 * one of them answers it on its own:
 *
 * - Running containers miss a node becoming the primary, which makes its folder
 *   send before it starts anything. For that whole window the node has decided
 *   but has no container.
 * - The promotion in progress covers that window, and the reconciler's
 *   committedIdentifiers everything asked to run after it. Both are in-memory and
 *   re-derived from live truth, so a FluxOS restart empties them. They are only
 *   ever written when a node wins an election, never re-asserted while it goes on
 *   being the primary.
 * - The operator stop lock is the durable one. `appstop` writes it to hold the
 *   component down HERE - the election skips this node and the reconciler will
 *   not restart it. A lock holds the component only on the node that was its
 *   primary when it was stopped - see appsRuntimeState.operatorHeldIdentifiers.
 *
 * Throws when the lock store cannot be read.
 * @returns {Promise<string[]>} container-name identifiers
 */
async function ownHoldings() {
  const containers = await dockerService.dockerListContainers(false);
  const running = containers
    .map((container) => (container.Names?.[0] || '').replace(/^\//, ''))
    .filter((name) => name.slice(0, 3) === 'zel' || name.slice(0, 4) === 'flux');

  const committed = [...appReconciler.committedIdentifiers(), ...primaryRoleChanges.promotingIdentifiers()]
    .map((identifier) => dockerService.getAppIdentifier(identifier));

  const operatorHeld = (await appsRuntimeState.operatorHeldIdentifiers())
    .map((identifier) => dockerService.getAppIdentifier(identifier));

  return [...new Set([...running, ...committed, ...operatorHeld])];
}

function notKnownYet() {
  return messageHelper.createErrorMessage('Which folders send here is not known yet', 'ServiceUnavailable', 503);
}

/**
 * The folders syncthing holds sendreceive, read from its configuration. A
 * paused syncthing answers too: pausing stops a folder moving data, not its
 * configuration being read.
 * @returns {Promise<string[]|null>} folder ids, null when syncthing cannot say
 */
async function sendingFolderIds() {
  try {
    const folders = await syncthingService.getConfigFolders();
    if (!Array.isArray(folders)) return null;
    return folders.filter((folder) => folder.type === 'sendreceive').map((folder) => folder.id);
  } catch {
    return null;
  }
}

/**
 * The container names of the activeStandby components of each installed app
 * that has more than one, anchor first: the first in compose order. Read from
 * the app's deployment, which carries each component's identifier already built.
 *
 * Throws when the installed apps cannot be read.
 * @returns {Promise<string[][]>}
 */
async function multiComponentElectedApps() {
  const installed = await installedApps();
  if (installed.status !== 'success') throw new Error('the installed apps cannot be read');
  const apps = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const app of installed.data) {
    // eslint-disable-next-line no-await-in-loop
    const deployments = await deploymentProvider.getInstalledDeployments(app.name);
    deployments.forEach((deployment) => {
      const names = deployment.componentEntries()
        .filter(([, component]) => component.hasActiveStandbySyncthing())
        .map(([, component]) => dockerService.getAppIdentifier(component.identifier));
      if (names.length > 1) apps.push(names);
    });
  }
  return apps;
}

/**
 * A holdings list with the anchor of every app it holds any g: component of.
 *
 * A peer on a release that elects one g: component asks only about the anchor,
 * so to it a node holding another of the app's g: components - one whose
 * anchor has not started yet, has stopped on its own, or failed to start -
 * holds nothing, and it starts the app beside it.
 * @param {string[]} holding Container names.
 * @param {string[][]} apps As multiComponentElectedApps.
 * @returns {string[]}
 */
function withAnchors(holding, apps) {
  const names = new Set(holding);
  apps.forEach((members) => {
    if (members.some((name) => names.has(name))) names.add(members[0]);
  });
  return [...names];
}

/**
 * What this node holds, both ways a peer reads it: `decided` is its own account
 * (ownHoldings), and `held` adds every component whose folder sends here. A
 * component in `held` and not in `decided` has a sending folder and nothing
 * behind it yet: a primary back from a stop, still deciding whether another
 * holder took over. Each list carries the anchor of every app it holds a g:
 * component of (withAnchors).
 *
 * Throws when the lock store or the installed apps cannot be read.
 * @returns {Promise<{decided: string[], held: string[]}|null>} null while
 *   syncthing cannot say which folders send here
 */
async function holdingsAccount() {
  const sending = await sendingFolderIds();
  if (sending === null) return null;
  const decided = await ownHoldings();
  const apps = await multiComponentElectedApps();
  return {
    decided: withAnchors(decided, apps),
    held: withAnchors([...decided, ...sending], apps),
  };
}

/**
 * Component identifiers this node holds, as a peer is told: its own account,
 * and every component whose folder sends here. The question a primary election
 * asks a peer, and FDM's last way to name a primary.
 *
 * A sending folder is a writer. A primary back from a stop has its folder still
 * sending, paused, and no container or commitment until it has decided whether
 * another holder took over; read without its folder, it answers that it holds
 * nothing, and the holder asking starts the component beside it. Which folders
 * send is read from syncthing; while syncthing cannot say, this node answers
 * that it cannot say yet rather than that it holds nothing.
 *
 * Not filtered to g: components. The list answers "is this component mine", and
 * the callers ask about g: components alone - so filtering would cost a spec
 * lookup to leave out entries nobody looks up.
 *
 * Cached for one second at the route, not the fifteen listrunningapps takes: long
 * enough to bound an anonymous caller to one pass of this work per second, short
 * enough to be meaningless against the tens of seconds the window it closes runs
 * for.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message carrying an array of container-name identifiers.
 */
async function heldComponents(req, res) {
  try {
    const account = await holdingsAccount();
    if (!account) {
      const notReady = notKnownYet();
      return res ? res.json(notReady) : notReady;
    }
    const response = messageHelper.createDataMessage(account.held);
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Whether this node holds a component by its own account - running here,
 * committed to start here, or stopped here by its owner. Not its folder: this
 * asks whether a folder that sends here has anything behind it.
 *
 * @param {string} identifier - The component's container name, e.g. fluxcomp_app
 * @returns {Promise<boolean|null>} null when the account cannot be read
 */
async function holdsComponent(identifier) {
  try {
    return (await ownHoldings()).includes(identifier);
  } catch (error) {
    log.error(error);
    return null;
  }
}

// Peers ask what this node holds on every election pass, unauthenticated and
// uncached (each answer is signed for one call), so the account
// behind the answer is read at most once a second however often it is asked.
const HELD_FOR_PEERS_TTL_MS = 1000;
let heldForPeers = null;

/**
 * heldComponents as a peer asks it: `{ held, decided }` (see holdingsAccount),
 * signed over the challenge the request body carries.
 *
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {Promise<object>} Message carrying the signed `{ held, decided }`.
 */
async function heldComponentsAnswer(req, res) {
  try {
    const seal = peerIdentityService.answerSealer(
      peerIdentityService.AnswerPurpose.HELD_COMPONENTS,
      serviceHelper.ensureObject(req?.body) || {},
    );
    const now = Number(process.hrtime.bigint() / 1_000_000n);
    if (!heldForPeers || now - heldForPeers.at >= HELD_FOR_PEERS_TTL_MS) {
      const account = await holdingsAccount();
      if (!account) return res.json(notKnownYet());
      heldForPeers = { ...account, at: now };
    }
    return res.json(messageHelper.createDataMessage(await seal({ held: heldForPeers.held, decided: heldForPeers.decided })));
  } catch (error) {
    log.error(error);
    return res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
  }
}

/**
 * Syncthing folder ids this node has promoted to sendreceive - the folders it
 * holds the writable copy of.
 *
 * Asked by a peer before it promotes a folder of its own. Promotion is decided
 * from each node's own view of the holder list, and those views fill in at
 * different moments, so two nodes can each conclude they are the one - the first
 * while it is briefly the only holder it knows of, the second once it can see
 * more and wins the tiebreak among them. Neither revisits the decision, because a
 * promoted folder never re-enters the election. Nothing else carries this: folder
 * type is local syncthing config, and at genesis the promoted node has no data
 * yet, so the has-data signal is silent exactly when it is needed.
 *
 * Served from the set the syncthing monitor refreshes each pass, not by reading
 * syncthing per request: the route is unauthenticated and reachable by any peer,
 * so an on-demand read would be an amplifier into syncthing, and the API has no
 * rate limiting of its own. It is also then O(1), so it needs no response cache
 * and carries no staleness beyond one monitor pass.
 *
 * `ready` is what stops a booting node being read as a free one. Before the
 * monitor's first pass this node cannot distinguish "I hold nothing" from "I have
 * not looked", and answering the first would invite a peer to promote alongside a
 * folder this node is already holding. The asker treats an unready peer as a
 * reason to wait rather than a clearance.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message carrying { ready, folders }.
 */
async function promotedFolders(req, res) {
  try {
    const ids = globalState.promotedFolderIds;
    const response = messageHelper.createDataMessage({
      ready: ids !== null,
      folders: ids === null ? [] : [...ids],
    });
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * Every container of an application on this node, running or not.
 *
 * Returns docker's container objects whole, for callers inside this process.
 * The public route answers from listAllAppsApi, which projects them.
 *
 * @returns {object} Message carrying the container objects.
 */
async function listAllApps() {
  try {
    const { LABEL_KEYS } = await getSpecBackend();
    let apps = await dockerService.dockerListContainers(true);
    if (apps.length > 0) {
      apps = apps.filter(
        (app) => dockerService.isManagedContainer({ labels: app.Labels, name: app.Names?.[0] }, LABEL_KEYS),
      );
    }
    const modifiedApps = [];
    apps.forEach((app) => {
      // eslint-disable-next-line no-param-reassign
      delete app.HostConfig;
      // eslint-disable-next-line no-param-reassign
      delete app.NetworkSettings;
      // eslint-disable-next-line no-param-reassign
      delete app.Mounts;
      modifiedApps.push(app);
    });
    return messageHelper.createDataMessage(modifiedApps);
  } catch (error) {
    log.error(error);
    return messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
  }
}

/**
 * GET /apps/listallapps - the public view of every container on this node.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
async function listAllAppsApi(req, res) {
  const response = await listAllApps();
  if (response.status === 'error') {
    res.json(response);
    return;
  }
  res.json(messageHelper.createDataMessage(publicContainerView(response.data)));
}

/**
 * To get latest application specification API version.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getlatestApplicationSpecificationAPI(req, res) {
  const latestSpec = config.get('fluxapps.latestAppSpecification') || 1;

  const message = messageHelper.createDataMessage(latestSpec);

  res.json(message);
}

/**
 * To get application original owner.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getApplicationOriginalOwner(req, res) {
  try {
    let { appname } = req.params;
    appname = appname || req.query.appname;
    if (!appname) {
      throw new Error('No Application Name specified');
    }
    const registration = await appHistory.latestApplied(appname, { type: 'registration' });
    // An app nobody has registered is an ordinary answer, not a fault.
    if (!registration) {
      throw new Error(`No registration message found for ${appname}`);
    }
    const ownerResponse = messageHelper.createDataMessage(registration.message.appSpecifications.owner);
    res.json(ownerResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To get apps installing locations.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsInstallingLocations(req, res) {
  try {
    const results = await registryManager.appInstallingLocation();
    const resultsResponse = messageHelper.createDataMessage(results);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To get count of app messages by owner.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsMessagesCount(req, res) {
  try {
    let { appowner } = req.params;
    appowner = appowner || req.query.appowner;
    if (!appowner) {
      throw new Error('No Application Owner specified');
    }
    const db = dbHelper.databaseConnection();
    const database = db.db(config.get('database.appsglobal.database'));

    const query = { 'appSpecifications.owner': appowner };

    const count = await dbHelper.countInDatabase(database, globalAppsMessages, query);
    const countResponse = messageHelper.createDataMessage(count);
    res.json(countResponse);
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * Whether a request was signed by a node on the deterministic list, for THIS node, now.
 *
 * Three questions, and all three have to hold. The signature says a Fluxnode sent it.
 * `target` says it was sent to this node, so one captured in flight cannot be turned on
 * the rest of the fleet. The timestamp says it was sent recently, on the bound the
 * network already holds every signed broadcast to - which is what makes a captured
 * request expire rather than become a credential.
 *
 * Required at all because this node cannot be told who is calling by the connection: a
 * source address is not a proof, and several nodes share one behind UPnP.
 *
 * ASKED IN THE ORDER THEY COST. The route is open, so everything before the signature
 * runs for whoever sends bytes at it: the shape and the timestamp answer from the body
 * alone, and the signature is checked against the node list before this node looks
 * anything up about itself. Own-address is served from a cached value that expires on a
 * timer, so the read behind it is a status call to the local benchmark daemon rather
 * than work - but which caller is holding the door when the timer expires is still a
 * choice, and it should be one that has proved itself.
 *
 * `target` therefore comes last, and loses nothing by it: it exists to stop a request
 * captured here being replayed at another node, which it does wherever it sits.
 *
 * @param {object} body - the request body, already an object
 * @returns {Promise<boolean>}
 */
async function callerIsFluxnode(body) {
  if (!body || !body.pubKey || !body.signature || !body.target) return false;

  // BOUNDED BOTH WAYS, because only one of them is a freshness question.
  // verifyTimestampInFluxBroadcast asks whether a request is too OLD, which is what
  // makes one captured off the wire stop working. It says nothing about a request
  // stamped for next year, and that is the one a node can mint deliberately: signed
  // once against a chosen target, it authorises whoever holds the body, for as long as
  // they hold it - so what a node may serve only to a node becomes public the moment
  // that body is. The forward bound is the network's own tolerance for clocks that do
  // not agree, and beyond it a timestamp is a choice rather than skew.
  //
  // Freshness first: it establishes that the timestamp is a number, and the forward
  // comparison below is arithmetic on it.
  const now = Date.now();
  if (!fluxCommunicationUtils.verifyTimestampInFluxBroadcast(body, now)) return false;
  if (body.timestamp > now + fluxCommunicationUtils.BROADCAST_CLOCK_SKEW_MS) return false;

  const verified = await fluxNetworkHelper.verifySignedFluxnodeMessage(body);
  if (verified !== true) return false;

  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  return Boolean(localSocketAddr) && socketAddressesMatch(body.target, localSocketAddr);
}

/**
 * The same answer, plus what each receive-only folder here holds.
 *
 * `holding` is a size and a last-write time per app whose data this node is carrying,
 * which is the tenant's, so it is not served to whoever asks. A caller proves itself
 * the way every node-to-node call on this API does - a signature whose public key is
 * on the deterministic node list - or holds Flux team privilege. The folder ids beside
 * it stay on the open GET, because they are app names and the location table already
 * publishes those.
 *
 * SIGNED FOR ONE RECIPIENT AND ONE MOMENT. `target` is the address of the node being
 * asked, checked against this node's own, so a signature captured in flight cannot be
 * turned on the rest of the fleet. `timestamp` is held to the bound every signed Flux
 * broadcast is held to (verifyTimestampInFluxBroadcast, fluxCommunicationUtils.js) -
 * the network's own figure rather than one chosen here, and wide enough for the clock
 * skew the fleet actually carries.
 *
 * A caller that cannot show either gets the open answer, not an error: a peer too old
 * to sign is not a peer doing something wrong, and it reads an absent `holding` as
 * claiming nothing - which is what the address-order election already expects of it.
 *
 * The answer is signed over the challenge the request body carries, when it
 * carries one.
 *
 * `seeding` is where this node stands in deciding which holder seeds each folder at a
 * cold start (globalState.seedMarks); it carries the same figures as `holding`, so it
 * goes only where `holding` does.
 *
 * `notLookedAt` is every receive-only folder of an installed app this node has not yet
 * looked at (folderStates). A peer about to seed waits on them, so a holder that has
 * not looked is never read as holding nothing.
 *
 * `heldOut` and `volumeGone` are the receive-only folders this node cannot seed because
 * their volume will not mount: under `heldOut` with the volume's image still on the node,
 * so what it holds is unknown, and under `volumeGone` with the image gone, so it holds
 * nothing. A peer about to seed leaves this node out of the choice, and does not seed
 * over a `heldOut` folder unless another holder has data.
 *
 * @param {object} req Request.
 * @param {object} res Response.
 * @returns {object} Message carrying { ready, folders, notLookedAt, heldOut, volumeGone, holding, seeding }.
 */
async function promotedFolderHoldings(req, res) {
  try {
    const ids = globalState.promotedFolderIds;
    const body = serviceHelper.ensureObject(req?.body) || {};

    const authorized = await verificationHelper.verifyPrivilege(Privilege.FLUX_TEAM, authOf(req));
    const entitled = authorized === true || await callerIsFluxnode(body);

    const ready = ids !== null;
    const {
      holding, notLookedAt, heldOut, volumeGone,
    } = ready ? folderStates.answer(ids) : {
      holding: {}, notLookedAt: [], heldOut: [], volumeGone: [],
    };
    const seal = peerIdentityService.answerSealer(peerIdentityService.AnswerPurpose.PROMOTED_FOLDERS, body);
    const response = messageHelper.createDataMessage(await seal({
      ready,
      folders: ids === null ? [] : [...ids],
      notLookedAt,
      heldOut,
      volumeGone,
      ...(entitled ? {
        holding,
        seeding: Object.fromEntries(globalState.seedMarks),
      } : {}),
    }));
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res ? res.json(errorResponse) : errorResponse;
  }
}

module.exports = {
  installedAppSpecs,
  installedAppsListedAt,
  publicContainerView,
  installedApps,
  listRunningContainers,
  listRunningApps,
  heldComponents,
  heldComponentsAnswer,
  holdsComponent,
  promotedFolders,
  promotedFolderHoldings,
  listAllApps,
  listAllAppsApi,
  getlatestApplicationSpecificationAPI,
  getApplicationOriginalOwner,
  getAppsInstallingLocations,
  getAppsMessagesCount,
};
