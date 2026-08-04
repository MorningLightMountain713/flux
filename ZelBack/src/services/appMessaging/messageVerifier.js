const config = require('config');
const dbHelper = require('../dbHelper');
const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const generalService = require('../generalService');
const fluxCommunicationMessagesSender = require('../fluxCommunicationMessagesSender');
const serviceHelper = require('../serviceHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const daemonServiceBlockchainRpcs = require('../daemonService/daemonServiceBlockchainRpcs');
const { getSpecBackend } = require('../utils/specLibs');
const { resolveSpec, resolveInstantiatedSpec } = require('../utils/specCutover');
const { regimeFor } = require('../pricing/pricingRegime');
const appsRepository = require('../appDatabase/appsRepository');
const { insertAppSpecifications, updateAppSpecifications } = require('../appDatabase/registryManager');
const appEventVerifier = require('./appEventVerifier');
const {
  globalAppsMessages,
  globalAppsTempMessages,
  appsHashesCollection,
  scannedHeightCollection,
} = require('../utils/appConstants');
const { invalidMessages } = require('../invalidMessages');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const globalState = require('../utils/globalState');
const { processPendingUpdates } = require('./messageStore');

// Import hashesNumberOfSearchs from appsService - this should be shared state
// For now, we'll create a local instance, but ideally this should be moved to globalState
const hashesNumberOfSearchs = new Map();

/**
 * Request app message from network
 * @param {string} hash - Message hash to request
 * @returns {Promise<void>}
 */
async function requestAppMessage(hash) {
  // some message type request app message, message hash
  // peer responds with data from permanent database or temporary database. If does not have it requests further
  const message = {
    type: 'fluxapprequest',
    version: 1,
    hash,
  };
  await fluxCommunicationMessagesSender.broadcastMessageToAll(message);
}

/**
 * Request multiple app messages from network
 * @param {Array} apps - List of apps with hash property
 * @param {boolean} incoming - If true, request from incoming peers
 * @returns {Promise<void>}
 */
async function requestAppsMessage(apps, incoming) {
  // some message type request app message, message hash
  // peer responds with data from permanent database or temporary database. If does not have it requests further
  const message = {
    type: 'fluxapprequest',
    version: 2,
    hashes: apps.map((a) => a.hash),
  };

  if (incoming) {
    await fluxCommunicationMessagesSender.broadcastMessageToRandomIncoming(message);
  } else {
    await fluxCommunicationMessagesSender.broadcastMessageToRandomOutgoing(message);
  }
}

/**
 * Request app message via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function requestAppMessageAPI(req, res) {
  try {
    // only flux team and node owner can do this
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    let { hash } = req.params;
    hash = hash || req.query.hash;

    if (!hash) {
      throw new Error('No Flux App Hash specified');
    }
    requestAppMessage(hash);
    const resultsResponse = messageHelper.createSuccessMessage(`Application hash ${hash} requested from the network`);
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}


/**
 * Check if app hash has message
 * @param {string} hash - Hash to check
 * @returns {Promise<boolean>} True if hash has message
 */
async function appHashHasMessage(hash) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const query = { hash };
  const update = { $set: { message: true, messageNotFound: false } };
  const options = {};
  await dbHelper.updateOneInDatabase(database, appsHashesCollection, query, update, options);
  return true;
}

/**
 * Check if app hash has message not found
 * @param {string} hash - Hash to check
 * @returns {Promise<boolean>} True if hash has message not found
 */
async function appHashHasMessageNotFound(hash) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const query = { hash };
  const update = { $set: { messageNotFound: true } };
  const options = {};
  await dbHelper.updateOneInDatabase(database, appsHashesCollection, query, update, options);
  return true;
}

/**
 * Get temporary app messages via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsTemporaryMessages(req, res) {
  try {
    const db = dbHelper.databaseConnection();

    const database = db.db(config.database.appsglobal.database);
    let query = {};
    let { hash } = req.params;
    hash = hash || req.query.hash;
    if (hash) {
      query = { hash };
    }
    const projection = { projection: { _id: 0 } };
    const results = await dbHelper.findInDatabase(database, globalAppsTempMessages, query, projection);
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
 * Get permanent app messages via API
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAppsPermanentMessages(req, res) {
  try {
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.appsglobal.database);
    const query = {};
    let { hash } = req.params;
    hash = hash || req.query.hash;
    let { owner } = req.params;
    owner = owner || req.query.owner;
    let { appname } = req.params;
    appname = appname || req.query.appname;
    if (hash) {
      query.hash = hash;
    }
    if (owner) {
      query['appSpecifications.owner'] = owner;
    }
    if (appname) {
      query['appSpecifications.name'] = appname;
    }
    const projection = { projection: { _id: 0 } };
    const results = await dbHelper.findInDatabase(database, globalAppsMessages, query, projection);
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
 * Get ingress attestations for an app-message hash. fluxteam-only: this exposes
 * the source address a registration/update was submitted from, which must never
 * reach the public API.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getIngressAttestations(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('fluxteam', req);
    if (!authorized) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }
    let { hash } = req.params;
    hash = hash || req.query.hash;
    if (!hash) {
      res.json(messageHelper.createErrorMessage('hash parameter is mandatory'));
      return;
    }
    const results = await appsRepository.listIngressAttestations(hash);
    res.json(messageHelper.createDataMessage(results));
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
 * fluxteam-only: every ingress attestation for an app, grouped by the
 * register/update message it attests to. Records stay sealed — the source is
 * decrypted offline with the fluxteam keyring, never by the node.
 */
async function getIngressAttestationsByApp(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('fluxteam', req);
    if (!authorized) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }
    let { name } = req.params;
    name = name || req.query.name;
    if (!name) {
      res.json(messageHelper.createErrorMessage('name parameter is mandatory'));
      return;
    }
    const results = await appsRepository.listIngressAttestationsByApp(name);
    res.json(messageHelper.createDataMessage(results));
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

// ── Helpers for checkAndRequestApp ──────────────────────────────────

function getDaemonHeight() {
  return daemonServiceMiscRpcs.isDaemonSynced().data.height;
}

/**
 * Timestamp of the block at a given height. Fallback for v9 confirmations
 * driven by an appshashes row that predates the stored blockTime field.
 * @param {number} height - Block height
 * @returns {Promise<number|null>} Block time in seconds, or null if unavailable
 */
async function lookupBlockTime(height) {
  const req = { params: { hashheight: String(height), verbosity: 1 } };
  const blockInfo = await daemonServiceBlockchainRpcs.getBlock(req);
  if (blockInfo.status === 'success' && Number.isFinite(blockInfo.data.time)) {
    return blockInfo.data.time;
  }
  return null;
}

async function constructConfirmedEvent(tempMessage, txid, height, valueSat, blockTime) {
  const { AppEventLegacy, ConfirmedAppEvent } = await getSpecBackend();
  const specs = tempMessage.appSpecifications;

  if (tempMessage.version === 2) {
    // registeredAt anchors v9's time-based expiry (registeredAt + ttl); a
    // coerced 0/NaN stores an app every liveness query reads as long-dead.
    const registeredAt = serviceHelper.ensureNumber(blockTime);
    if (!Number.isFinite(registeredAt) || registeredAt <= 0) {
      throw new Error(`constructConfirmedEvent - no confirming block time for ${tempMessage.hash} at height ${height}`);
    }
    return ConfirmedAppEvent.deserialize({
      type: tempMessage.type,
      version: tempMessage.version,
      appSpecifications: specs,
      contentHash: tempMessage.contentHash,
      hash: tempMessage.hash,
      timestamp: tempMessage.timestamp,
      extend: tempMessage.extend ?? false,
      signature: tempMessage.signature,
      txid: serviceHelper.ensureString(txid),
      height: serviceHelper.ensureNumber(height),
      valueSat: serviceHelper.ensureNumber(valueSat),
      registeredAt,
      arcaneAttestation: tempMessage.arcaneAttestation || null,
    });
  }

  return AppEventLegacy.deserialize({
    type: tempMessage.type,
    version: tempMessage.version,
    appSpecifications: specs,
    hash: tempMessage.hash,
    timestamp: tempMessage.timestamp,
    signature: tempMessage.signature,
    txid: serviceHelper.ensureString(txid),
    height: serviceHelper.ensureNumber(height),
    valueSat: serviceHelper.ensureNumber(valueSat),
  });
}

/**
 * Consensus registration fee in satoshis, from the spec's pricing regime.
 * @param {object} spec - resolved spec
 * @param {number} height - confirming block height
 * @returns {Promise<bigint>}
 */
async function computeRegistrationFee(spec, height) {
  return (await regimeFor(spec)).registrationFee(spec, height);
}

/**
 * Consensus update fee in satoshis, from the spec's pricing regime. The regime
 * is chosen by the incoming spec, so an update priced under v9 rules is one
 * that arrived as a v9 spec.
 *
 * @param {object} spec - resolved new spec
 * @param {object} prevSpec - resolved previous spec
 * @param {number} height - confirming block height
 * @param {number} prevHeight - height the previous spec registered at
 * @param {number} prevRegisteredAt - unix seconds the previous spec registered at
 * @param {number} nowBlockTime - unix seconds of the confirming block
 * @returns {Promise<bigint>}
 */
async function computeUpdateFee(spec, prevSpec, height, prevHeight, prevRegisteredAt, nowBlockTime) {
  return (await regimeFor(spec)).updateFee(
    spec, prevSpec, height, prevHeight, prevRegisteredAt, nowBlockTime,
  );
}

/**
 * The state to store for a confirmed update, with its term start decided.
 *
 * A v9 app expires at registeredAt + ttl, and an update's registeredAt is its
 * own confirming block — so applying one restarts the clock. That is right when
 * the update paid for its term: the fee already credited back whatever time was
 * left on the old one.
 *
 * A free update paid nothing, so it bought no time and must not move the expiry.
 * It keeps the term start it supersedes. The free-update policy stops the ttl
 * growing; this stops the clock restarting, which is the same guard on the other
 * axis — without it, resubmitting an unchanged spec renews an app for nothing,
 * indefinitely.
 *
 * The signed spec is never touched. Shortening the ttl to fit the remaining term
 * would rewrite content the owner signed and its hash covers; the term start is
 * FluxOS's own record of when the app's current term began.
 *
 * @param {object} InstantiatedSpec - the domain class, from the spec backend
 * @param {object} confirmedEvent - the confirmed update event
 * @param {bigint} requiredSats - the fee this update had to pay
 * @param {object} prevMessage - the permanent message being superseded
 * @returns {object} the InstantiatedSpec to store
 */
function instantiatedForStorage(InstantiatedSpec, confirmedEvent, requiredSats, prevMessage) {
  const projection = confirmedEvent.toInstantiatedSpec();
  const keepsTerm = requiredSats === 0n && Boolean(prevMessage.registeredAt);
  return InstantiatedSpec.fromEvent(
    keepsTerm ? { ...projection, registeredAt: prevMessage.registeredAt } : projection,
  );
}

async function handleExpiredApp(name) {
  log.warn(`App ${name} has expired. Cleaning up stale data.`);
  const existingGlobal = await appsRepository.existsGlobalApp(name);
  if (existingGlobal) {
    log.warn(`Removing expired app ${name} from global apps database`);
    await appsRepository.removeGlobalAppInfo(name);
  }
  const existingLocal = await appsRepository.existsInstalledApp(name);
  if (existingLocal) {
    log.warn(`REMOVAL REASON: App expired - ${name} update received after expiration (messageVerifier)`);
    // eslint-disable-next-line global-require
    const appUninstaller = require('../appLifecycle/appUninstaller');
    // background: at-tip cancel enforcement — the prelude condemns + removes the row
    // fast; the destructive teardown runs deferred.
    await appUninstaller.uninstallApplication(name, {
      forceKill: true, skipGuard: true, broadcastRemoval: true, background: true,
    });
  }
}

// ── Core promotion function ─────────────────────────────────────────

/**
 * Promote a temp message to permanent when the chain confirms it.
 * Called by explorerService when it encounters an OP_RETURN with an app hash.
 *
 * @param {string} hash - Message hash
 * @param {string} txid - Confirming transaction ID
 * @param {number} height - Block height
 * @param {number} valueSat - Satoshis paid in the transaction
 * @param {number} blockTime - Unix timestamp of the confirming block
 * @param {number} i - Retry counter (internal)
 * @returns {Promise<boolean>}
 */
async function checkAndRequestApp(hash, txid, height, valueSat, blockTime = null, i = 0) {
  try {
    if (height < config.fluxapps.epochstart) return false;

    const existing = await appsRepository.getPermanentMessage(hash);
    if (existing) {
      await appHashHasMessage(hash);
      return true;
    }

    const tempMessage = await appsRepository.getTempMessage(hash);
    if (!tempMessage || typeof tempMessage !== 'object' || Array.isArray(tempMessage)) {
      if (i < 2) {
        await requestAppMessage(hash);
        await serviceHelper.delay(60 * 1000);
        return checkAndRequestApp(hash, txid, height, valueSat, blockTime, i + 1);
      }
      return false;
    }

    const specifications = tempMessage.appSpecifications;
    if (!specifications) {
      log.error(`Temp message ${hash} has no specifications`);
      return false;
    }

    // Construct the confirmed event from temp message + chain data.
    // This deserializes the spec into its class instance (v1-v9).
    // v2 events need the confirming block's timestamp (v9 registeredAt); an
    // appshashes row written before blockTime was stored lacks it — recover it
    // from the daemon, or leave the hash unresolved for a later retry.
    let confirmedBlockTime = blockTime;
    if (confirmedBlockTime == null && tempMessage.version === 2) {
      confirmedBlockTime = await lookupBlockTime(height);
      if (confirmedBlockTime === null) {
        log.error(`checkAndRequestApp - could not resolve block time for ${hash} at height ${height}`);
        return false;
      }
    }
    const confirmedEvent = await constructConfirmedEvent(tempMessage, txid, height, valueSat, confirmedBlockTime);

    // Re-verify an update against the app's active row at promotion time.
    // Prevents a race: two updates verified against the same state while
    // temporary, where the first changes the owner before the second promotes.
    // The row is the only authority here — the name's message history spans
    // every app that has ever held the name, so an expired app's owner would
    // still authorize an update to whoever holds the name now.
    if (confirmedEvent.isUpdate) {
      const currentState = await appsRepository.getGlobalAppInfo(specifications.name);
      await appEventVerifier.authorize({
        appEvent: confirmedEvent,
        previousState: currentState,
        daemonHeight: getDaemonHeight(),
      });
    }

    // Store the permanent message
    await appsRepository.storePermanentMessage(confirmedEvent.serialize());
    // The message is durable now — clear the orphan TTL on its ingress
    // attestations so their attribution persists alongside the permanent record.
    await appsRepository.confirmIngressAttestations(hash);
    await appHashHasMessage(hash);

    // Project to InstantiatedSpec — the domain type for live app state
    const { InstantiatedSpec } = await getSpecBackend();
    const instantiated = InstantiatedSpec.fromEvent(confirmedEvent.toInstantiatedSpec());

    // Expiry check
    const daemonHeight = getDaemonHeight();
    if (instantiated.isExpired(confirmedBlockTime, daemonHeight)) {
      await handleExpiredApp(instantiated.name);
      return true;
    }

    // Pricing — the spec is a class instance on confirmedEvent.spec. Pricing
    // reads the cleartext components (DeploymentSpec.fromSpec), so an encrypted
    // (enterprise) spec must be decrypted first. Identity/lookups still use the
    // encrypted wire form (no decrypt needed).
    const { spec } = instantiated;
    // Cleartext apps resolve to their own spec; encrypted apps to a
    // DecryptedCanonicalSpec the pricer reads through.
    const pricingSpec = await resolveInstantiatedSpec(instantiated);
    if (!pricingSpec) {
      log.error(`checkAndRequestApp - could not resolve spec for ${instantiated.name} to compute fee`);
      return true;
    }
    if (confirmedEvent.isRegistration) {
      const requiredSats = await computeRegistrationFee(pricingSpec, height);
      if (requiredSats === 0n) {
        // Fail-closed: a registration always pays for its TTL, so a fee of 0 can
        // only mean pricing isn't in force yet (no PriceMessage on chain for v9).
        // Reject rather than mint a free app. Legacy (v1-v8) always has a minPrice
        // floor, so this only ever catches the un-bootstrapped v9 case.
        log.warn(`App ${hash} registration rejected: pricing not available at height ${height}`);
      } else if (BigInt(valueSat) >= requiredSats) {
        await insertAppSpecifications(instantiated.serialize());
        await processPendingUpdates(instantiated.name);
      } else {
        log.warn(`App ${hash} registration underpaid: ${valueSat} < ${requiredSats}`);
      }
    } else {
      // The state this update supersedes, and so what it is priced against.
      // Each regime resolves it its own way — this message is already stored
      // above, and whether that matters is a property of the economics, not of
      // this function.
      const regime = await regimeFor(pricingSpec);
      const prevMessage = await regime.supersededMessage(spec.name, {
        height, timestamp: tempMessage.timestamp,
      });
      if (!prevMessage) {
        log.error(`Last permanent message for ${spec.name} not found`);
        return true;
      }
      const prevSpecs = prevMessage.appSpecifications;
      // resolveSpec deserializes and decrypts (if encrypted) the previous spec —
      // computeUpdateFee prices the previous spec too.
      const prevSpec = await resolveSpec(prevSpecs);
      if (!prevSpec) {
        log.error(`checkAndRequestApp - could not resolve previous spec for ${spec.name} to compute update fee`);
        return true;
      }
      const requiredSats = await computeUpdateFee(
        pricingSpec, prevSpec, height, prevMessage.height,
        prevMessage.registeredAt || 0, confirmedBlockTime,
      );
      if (BigInt(valueSat) >= requiredSats) {
        const stored = instantiatedForStorage(
          InstantiatedSpec, confirmedEvent, requiredSats, prevMessage,
        );
        await updateAppSpecifications(stored.serialize());
      } else {
        log.warn(`App ${hash} update underpaid: ${valueSat} < ${requiredSats}`);
      }
    }

    return true;
  } catch (error) {
    log.error(`Error checking and requesting app ${hash}:`, error);
    log.error(`Error details - Message: ${error.message}, Stack: ${error.stack}`);
    return false;
  }
}

/**
 * Check and request multiple app messages in batch
 * @param {object[]} apps - Array of app objects with hash, txid, height, value properties
 * @param {boolean} incoming - Whether messages are incoming
 * @param {number} i - Retry counter
 * @returns {Promise<void>} Completion status
 */
async function checkAndRequestMultipleApps(apps, incoming = false, i = 1) {
  try {
    const numberOfPeers = fluxNetworkHelper.getNumberOfPeers();
    if (numberOfPeers < config.fluxapps.minHashSyncPeers) {
      log.info('checkAndRequestMultipleApps - Not enough connected peers to request missing Flux App messages');
      return;
    }
    await requestAppsMessage(apps, incoming);
    await serviceHelper.delay(30 * 1000);
    const appsToRemove = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      const messageReceived = await checkAndRequestApp(app.hash, app.txid, app.height, app.value, app.blockTime ?? null, 2);
      if (messageReceived) {
        appsToRemove.push(app);
      }
    }
    // eslint-disable-next-line no-param-reassign
    apps = apps.filter((item) => !appsToRemove.includes(item));
    if (apps.length > 0 && i < 5) {
      await checkAndRequestMultipleApps(apps, i % 2 === 0, i + 1);
    }
  } catch (error) {
    log.error(error);
  }
}

// Global variables for continuousFluxAppHashesCheck
let continuousFluxAppHashesCheckRunning = false;
let firstContinuousFluxAppHashesCheckRun = true;

/**
 * Continuously checks for missing flux app hashes and requests missing messages
 * @param {boolean} force - Force check even if already running
 * @returns {Promise<void>}
 */
async function continuousFluxAppHashesCheck(force = false) {
  try {
    if (continuousFluxAppHashesCheckRunning) {
      return;
    }
    log.info('Requesting missing Flux App messages');
    continuousFluxAppHashesCheckRunning = true;
    const numberOfPeers = fluxNetworkHelper.getNumberOfPeers();
    if (numberOfPeers < config.fluxapps.minHashSyncPeers) {
      log.info('Not enough connected peers to request missing Flux App messages');
      continuousFluxAppHashesCheckRunning = false;
      return;
    }

    const synced = await generalService.checkSynced();
    if (synced !== true) {
      log.info('Flux not yet synced');
      continuousFluxAppHashesCheckRunning = false;
      return;
    }

    if (firstContinuousFluxAppHashesCheckRun && !globalState.checkAndSyncAppHashesWasEverExecuted) {
      // Import checkAndSyncAppHashes from appHashSyncService
      // eslint-disable-next-line global-require
      const appHashSyncService = require('./appHashSyncService');
      await appHashSyncService.checkAndSyncAppHashes();
    }

    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const queryHeight = { generalScannedHeight: { $gte: 0 } };
    const projectionHeight = {
      projection: {
        _id: 0,
        generalScannedHeight: 1,
      },
    };
    const scanHeight = await dbHelper.findOneInDatabase(database, scannedHeightCollection, queryHeight, projectionHeight);
    if (!scanHeight) {
      throw new Error('Scanning not initiated');
    }
    const explorerHeight = serviceHelper.ensureNumber(scanHeight.generalScannedHeight);

    // get flux app hashes that do not have a message
    const query = { message: false };
    const projection = {
      projection: {
        _id: 0,
        txid: 1,
        hash: 1,
        height: 1,
        value: 1,
        message: 1,
        messageNotFound: 1,
        blockTime: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, appsHashesCollection, query, projection);
    // sort it by height, so we request oldest messages first
    results.sort((a, b) => a.height - b.height);
    let appsMessagesMissing = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const result of results) {
      if (!result.messageNotFound || force || firstContinuousFluxAppHashesCheckRun) { // most likely wrong data, if no message found. This attribute is cleaned every reconstructAppMessagesHashPeriod blocks so all nodes search again for missing messages
        let heightDifference = explorerHeight - result.height;
        if (heightDifference < 0) {
          heightDifference = 0;
        }
        let maturity = Math.round(heightDifference / config.fluxapps.blocksLasting);
        if (maturity > 12) {
          maturity = 16; // maturity of max 16 representing its older than 1 year. Old messages will only be searched 3 times, newer messages more oftenly
        }
        if (invalidMessages.find((message) => message.hash === result.hash && message.txid === result.txid)) {
          if (!force) {
            maturity = 30; // do not request known invalid messages.
          }
        }
        // every config.fluxapps.blocksLasting increment maturity by 2;
        let numberOfSearches = maturity;
        if (hashesNumberOfSearchs.has(result.hash)) {
          numberOfSearches = hashesNumberOfSearchs.get(result.hash) + 2; // max 10 tries
        }
        hashesNumberOfSearchs.set(result.hash, numberOfSearches);
        log.info(`Requesting missing Flux App message: ${result.hash}, ${result.txid}, ${result.height}`);
        if (numberOfSearches <= 20) { // up to 10 searches
          const appMessageInformation = {
            hash: result.hash,
            txid: result.txid,
            height: result.height,
            value: result.value,
            blockTime: result.blockTime ?? null,
          };
          appsMessagesMissing.push(appMessageInformation);
          if (appsMessagesMissing.length === 500) {
            log.info('Requesting 500 app messages');
            checkAndRequestMultipleApps(appsMessagesMissing);
            // eslint-disable-next-line no-await-in-loop
            await serviceHelper.delay(2 * 60 * 1000); // delay 2 minutes to give enough time to process all messages received
            appsMessagesMissing = [];
          }
        } else {
          // eslint-disable-next-line no-await-in-loop
          await appHashHasMessageNotFound(result.hash); // mark message as not found
          hashesNumberOfSearchs.delete(result.hash); // remove from our map
        }
      }
    }
    if (appsMessagesMissing.length > 0) {
      log.info(`Requesting ${appsMessagesMissing.length} app messages`);
      checkAndRequestMultipleApps(appsMessagesMissing);
    }
    continuousFluxAppHashesCheckRunning = false;
    firstContinuousFluxAppHashesCheckRun = false;
  } catch (error) {
    log.error(error);
    continuousFluxAppHashesCheckRunning = false;
    firstContinuousFluxAppHashesCheckRun = false;
  }
}

/**
 * API endpoint to manually trigger app hashes check
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function triggerAppHashesCheckAPI(req, res) {
  try {
    // only flux team and node owner can do this
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
      return;
    }

    continuousFluxAppHashesCheck(true);
    const resultsResponse = messageHelper.createSuccessMessage('Running check on missing application messages ');
    res.json(resultsResponse);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

module.exports = {
  requestAppMessage,
  requestAppsMessage,
  requestAppMessageAPI,
  appHashHasMessage,
  appHashHasMessageNotFound,
  getAppsTemporaryMessages,
  getAppsPermanentMessages,
  getIngressAttestations,
  getIngressAttestationsByApp,
  checkAndRequestApp,
  checkAndRequestMultipleApps,
  computeRegistrationFee,
  computeUpdateFee,
  continuousFluxAppHashesCheck,
  triggerAppHashesCheckAPI,
};
