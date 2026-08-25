'use strict';

const config = require('config');
const EventEmitter = require('node:events');
const secp256k1 = require('secp256k1');

const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const chainRollback = require('./chainRollback');
const daemonSubscriptionService = require('./daemonService/daemonSubscriptionService');
const reorgSource = require('./daemonService/reorgSource');
const dbHelper = require('./dbHelper');
const verificationHelper = require('./verificationHelper');
const messageHelper = require('./messageHelper');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const daemonServiceControlRpcs = require('./daemonService/daemonServiceControlRpcs');
const daemonServiceBlockchainRpcs = require('./daemonService/daemonServiceBlockchainRpcs');
const daemonServiceUtils = require('./daemonService/daemonServiceUtils');
const chainUtilities = require('./utils/chainUtilities');
const messageVerifier = require('./appMessaging/messageVerifier');
const registryManager = require('./appDatabase/registryManager');
const appJanitor = require('./appLifecycle/appJanitor');
const specReconciler = require('./appLifecycle/specReconciler');
const benchmarkService = require('./benchmarkService');
const fluxNetworkhelper = require('./fluxNetworkHelper');
const { extractIp } = require('./utils/socketAddressUtils');
const fluxEventBus = require('./utils/fluxEventBus');
const globalState = require('./utils/globalState');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('./utils/appSyncEvents');
const { getSpecPolicy } = require('./utils/specLibs');
const priceOracleState = require('./pricing/priceOracleState');
const entitlementsState = require('./entitlementsState');
const { pubKeyToAddr } = require('./utils/fluxCryptoUtils');

const appsHashesCollection = config.database.daemon.collections.appsHashes;
const scannedHeightCollection = config.database.daemon.collections.scannedHeight;
const chainParamsMessagesCollection = config.database.chainparams.collections.chainMessages;
const priceMessagesCollection = config.database.chainparams.collections.priceMessages;
const rateMessagesCollection = config.database.chainparams.collections.rateMessages;
const priceModifierMessagesCollection = config.database.chainparams.collections.priceModifierMessages;
const oracleKeyMessagesCollection = config.database.chainparams.collections.oracleKeyMessages;
const marketplacePricingMessagesCollection = config.database.chainparams.collections.marketplacePricingMessages;
const policyGroupMessagesCollection = config.database.chainparams.collections.policyGroupMessages;

let isInInitiationOfBP = false;
let zelAppSpecsMigrationDone = false;
let explorerReadyEmitted = false;
let operationBlocked = false;
let appsTransactions = [];
let isSynced = false;
let cachedDaemonVersion = null;

// Scan state. A healthy node has none of this armed between blocks: a drain runs when
// a block event arrives, and finishes. The single timer exists only for a failure
// backoff, and for a daemon that publishes no block events at all.
let scanStopped = true;
let scanDraining = false;
let scanDrainPromise = null;
let scanRequestPending = false;
let scanFallbackPolling = false;
let scanTimer = null;
let scanBlockInFlight = false;

/**
 * Whether a block is being written right now.
 *
 * This replaces the old `someBlockIsProcessing` flag, and the difference is ownership:
 * the loop sets it around exactly one call and clears it in a `finally`, so it cannot
 * be observed as false part-way through the block it guards. The old flag was cleared
 * before the last await of its own block, which is what let a stop land mid-block and
 * see quiescence.
 *
 * @returns {boolean} True while a block is in flight.
 */
function blockInFlight() {
  return scanBlockInFlight;
}

/**
 * Whether scanning is enabled.
 * @returns {boolean} True while scanning is enabled.
 */
function scanning() {
  return !scanStopped;
}

/**
 * How many blocks between cursor writes while catching up.
 *
 * At the tip the cursor moves every block. During an initial sync it moves in batches,
 * which is only worth anything on the one full scan a node ever does — a crash costs
 * re-doing at most this many blocks, and re-doing them is safe because app hashes are
 * uniquely indexed and chain parameter messages are upserts.
 *
 * @returns {number} Batch size.
 */
function cursorBatchSize() {
  return config.fluxapps.explorerCursorBatchSize ?? 500;
}


const blockEmitter = new EventEmitter();

function getBlockEmitter() {
  return blockEmitter;
}

/**
 * To get and cache the daemon version
 * @returns {Promise<number>} Daemon version number
 */
async function getDaemonVersion() {
  if (cachedDaemonVersion !== null) {
    return cachedDaemonVersion;
  }

  try {
    const daemonInfo = await daemonServiceControlRpcs.getInfo();
    if (daemonInfo.status === 'success' && daemonInfo.data && daemonInfo.data.version) {
      cachedDaemonVersion = daemonInfo.data.version;
      return cachedDaemonVersion;
    }
  } catch (error) {
    log.warn(`Failed to get daemon version: ${error.message}`);
  }

  // Default to 0 if unable to get version
  cachedDaemonVersion = 0;
  return cachedDaemonVersion;
}

/**
 * To get the details of a verbose block.
 * @param {(number|string)} heightOrHash Block height or block hash.
 * @param {number} verbosity Verbosity level.
 * @returns {object} Block data straight from the daemon.
 */
async function getVerboseBlock(heightOrHash, verbosity = 2) {
  const blockInfo = await daemonServiceBlockchainRpcs.getBlock({
    hashheight: heightOrHash,
    verbosity,
  });
  if (blockInfo.status === 'success') {
    return blockInfo.data;
  }
  throw blockInfo.data;
}

/**
 * To decode a message from Unicode values to text characters.
 * @param {string} asm UTF-16 value.
 * @returns {string} Message.
 */
function decodeMessage(asm) {
  const parts = asm.split('OP_RETURN ', 2);
  let message = '';
  if (parts[1]) {
    const encodedMessage = parts[1];
    const hexx = encodedMessage.toString(); // force conversion
    for (let k = 0; k < hexx.length && hexx.slice(k, k + 2) !== '00'; k += 2) {
      message += String.fromCharCode(
        parseInt(hexx.slice(k, k + 2), 16),
      );
    }
  }
  return message;
}

function decodeMessageBytes(asm) {
  const parts = asm.split('OP_RETURN ', 2);
  if (!parts[1]) return null;
  const hex = parts[1].split(' ')[0];
  if (hex.length < 2 || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, 'hex');
}

function decodeLegacyAscii(bytes) {
  const nullIdx = bytes.indexOf(0x00);
  const slice = nullIdx >= 0 ? bytes.subarray(0, nullIdx) : bytes;
  return Buffer.from(slice).toString('ascii');
}

async function storeToCollection(collectionName, doc) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.chainparams.database);
  const query = { txid: doc.txid };
  const update = { $set: doc };
  const options = { upsert: true };
  await dbHelper.updateOneInDatabase(database, collectionName, query, update, options);
}

// Flux transparent (t1) P2PKH address version byte (0x1CB8).
const FLUX_T1_PUBKEY_HASH = '1cb8';

// Authority for the v9 foundation-signed soft-fork messages (PriceMessage,
// PriceModifierMessage, OracleKeyMessage, MarketplacePricingMessage,
// PolicyGroupMessage). messageAuthorityAddress is deliberately separate from the
// legacy payment multisigs (appPaymentAddresses[].legacyMessageAuthority), which
// authorise the pre-v9 ASCII price messages and receive app payments.
// SIGHASH byte semantics: only a signature whose base type is SIGHASH_ALL commits
// to every output — including the OP_RETURN carrying the message. NONE/SINGLE leave
// the OP_RETURN unbound (an attacker could graft a different message onto a partially
// signed input); ANYONECANPAY (0x80) only frees the OTHER inputs, so it still binds
// all outputs and is accepted.
const SIGHASH_ALL = 0x01;
const SIGHASH_ANYONECANPAY = 0x80;

// Whether a P2PKH input's signature commits to all of the transaction's outputs.
// The scriptSig's first element is a direct push of the DER signature plus a trailing
// sighash byte; the DER body is validated with secp256k1 (rejecting anything that
// isn't a real ECDSA signature), so the sighash byte we read is meaningful. Relying on
// the address alone would trust the chain's tx-signature validation without pinning the
// sighash type. Fail-closed: any parse failure returns false.
function inputSignsAllOutputs(vin) {
  const hex = vin && vin.scriptSig && vin.scriptSig.hex;
  if (typeof hex !== 'string') return false;
  try {
    const script = Buffer.from(hex, 'hex');
    const pushLen = script[0];
    // A signature is always a single-byte-opcode direct push (opcode 0x01–0x4b);
    // OP_PUSHDATA* or a bare opcode is not a standard signed input.
    if (pushLen < 1 || pushLen >= 0x4c || script.length < 1 + pushLen) return false;
    const signature = script.subarray(1, 1 + pushLen);
    const hashType = signature[signature.length - 1];
    secp256k1.signatureImport(signature.subarray(0, -1)); // throws on non-DER
    return (hashType & ~SIGHASH_ANYONECANPAY) === SIGHASH_ALL;
  } catch (error) {
    return false;
  }
}

// The oracle's t1 address in force at a height, derived from the pubkey published
// by the most recent OracleKeyMessage (0x05). Null if no oracle key is in force.
function resolveOracleAddress(height) {
  const history = priceOracleState.getOracleKeyHistory();
  const oracleKey = history && history.resolveAt(height);
  if (!oracleKey || !oracleKey.pubkey) return null;
  return pubKeyToAddr(Buffer.from(oracleKey.pubkey).toString('hex'), FLUX_T1_PUBKEY_HASH);
}

function isMessageAuthority(tx) {
  const authAddr = config.fluxapps.messageAuthorityAddress;
  if (!authAddr) return false;
  return tx.vin.some((vin) => vin.address === authAddr && inputSignsAllOutputs(vin));
}

// A RateMessage (0x03) is authorised only if its transaction is signed by the
// oracle key currently published on-chain via OracleKeyMessage (0x05), with a
// SIGHASH_ALL signature. No oracle key in force -> no RateMessage accepted.
function isOracleSigner(tx, height) {
  const oracleAddr = resolveOracleAddress(height);
  if (!oracleAddr) return false;
  return tx.vin.some((vin) => vin.address === oracleAddr && inputSignsAllOutputs(vin));
}

// Whether an address is a pre-v9 soft-fork authority (the legacy payment multisigs).
// Gates the legacy ASCII price messages — kept narrow so the v9 authority and the
// oracle can never publish a legacy price message.
function isLegacyMessageAuthority(address) {
  return chainUtilities.legacyMessageAuthorities().includes(address);
}

// Coarse entry filter: is this address a recognised source of ANY soft-fork message?
// The union of the legacy authorities, the v9 message authority, and the current
// oracle. This only decides whether a tx is worth parsing as a soft-fork — the
// per-type authority checks (isLegacyMessageAuthority / isMessageAuthority /
// isOracleSigner) still enforce which signer may publish which message type. Strict
// allowlist: any other sender is dropped at the gate, so it is no spam surface.
function isRecognizedMessageSigner(address, height) {
  if (!address) return false;
  if (isLegacyMessageAuthority(address)) return true;
  if (address === config.fluxapps.messageAuthorityAddress) return true;
  return address === resolveOracleAddress(height);
}

async function processSoftFork(txid, height, bytes, senderIsLegacyAuthority, tx) {
  const { dispatch } = await getSpecPolicy();
  let dispatched;
  try {
    dispatched = dispatch(bytes);
  } catch (error) {
    // A malformed or out-of-range message is rejected at the parse boundary.
    // Log and skip it — don't apply it, and don't abort the rest of the batch.
    log.warn(`Rejected soft-fork message ${txid} at height ${height}: ${error.message}`);
    return;
  }
  const { kind, message } = dispatched;

  switch (kind) {
    case 'legacy-price': {
      if (!senderIsLegacyAuthority) return;
      const ascii = decodeLegacyAscii(bytes);
      const splittedMess = ascii.split('_');
      const version = splittedMess[0];
      if (!version || splittedMess.length < 2) {
        log.info(`Ignoring invalid legacy soft fork message: ${txid}_${height}`);
        return;
      }
      log.info(`Legacy soft fork message: ${txid}_${height}_${ascii}`);
      const db = dbHelper.databaseConnection();
      const database = db.db(config.database.chainparams.database);
      const query = { txid };
      const update = { $set: { txid, height, message: ascii, version } };
      const options = { upsert: true };
      await dbHelper.updateOneInDatabase(database, chainParamsMessagesCollection, query, update, options);
      break;
    }
    case 'price':
      if (!isMessageAuthority(tx)) return;
      log.info(`PriceMessage at height ${height}: ${txid}`);
      await storeToCollection(priceMessagesCollection, { txid, height, message });
      if (priceOracleState.getPriceMessageHistory()) {
        priceOracleState.getPriceMessageHistory().add(message, height);
      }
      break;
    case 'rate':
      if (!isOracleSigner(tx, height)) {
        log.warn(`RateMessage rejected — wrong signer: ${txid} at height ${height}`);
        return;
      }
      log.info(`RateMessage at height ${height}: ${txid}`);
      await storeToCollection(rateMessagesCollection, { txid, height, message });
      if (priceOracleState.getRateMessageHistory()) {
        priceOracleState.getRateMessageHistory().add(message, height);
      }
      break;
    case 'price-modifier':
      if (!isMessageAuthority(tx)) return;
      log.info(`PriceModifierMessage at height ${height}: ${txid}`);
      await storeToCollection(priceModifierMessagesCollection, { txid, height, message });
      if (priceOracleState.getPriceModifierHistory()) {
        priceOracleState.getPriceModifierHistory().add(message, height);
      }
      break;
    case 'oracle-key':
      if (!isMessageAuthority(tx)) return;
      log.info(`OracleKeyMessage at height ${height}: ${txid}`);
      await storeToCollection(oracleKeyMessagesCollection, { txid, height, message });
      if (priceOracleState.getOracleKeyHistory()) {
        priceOracleState.getOracleKeyHistory().add(message, height);
      }
      break;
    case 'marketplace-pricing':
      if (!isMessageAuthority(tx)) return;
      log.info(`MarketplacePricingMessage at height ${height}: ${txid}`);
      await storeToCollection(marketplacePricingMessagesCollection, { txid, height, message });
      if (priceOracleState.getMarketplacePricingHistory()) {
        priceOracleState.getMarketplacePricingHistory().add(message, height);
      }
      break;
    case 'policy-group':
      if (!isMessageAuthority(tx)) return;
      log.info(`PolicyGroupMessage at height ${height}: ${txid}`);
      await storeToCollection(policyGroupMessagesCollection, { txid, height, message });
      if (entitlementsState.getPolicyGroupHistory()) {
        entitlementsState.getPolicyGroupHistory().add(message, height);
      }
      break;
    default:
      break;
  }
}

/**
 * To process verbose block data for entry to Insight database.
 * @param {object} blockDataVerbose Verbose block data.
 * @param {string} database Database.
 */
async function processInsight(blockDataVerbose, database) {
  // get Block Deltas information
  const txs = blockDataVerbose.tx;
  // go through each transaction in deltas
  // eslint-disable-next-line no-restricted-syntax
  for (const tx of txs) {
    if (tx.version < 5 && tx.version > 0) {
      let message = '';
      let isFluxAppMessageValue = 0;
      let senderIsRecognizedSigner = false;
      let senderIsLegacyAuthority = false;
      let receiverIsRecognizedSigner = false;

      tx.vin.forEach((sender) => { // coinbase vin.addr is undefined
        if (isRecognizedMessageSigner(sender.address, blockDataVerbose.height)) senderIsRecognizedSigner = true;
        if (isLegacyMessageAuthority(sender.address)) senderIsLegacyAuthority = true;
      });

      tx.vout.forEach((receiver) => {
        if (receiver.scriptPubKey.addresses) { // count for messages
          if (chainUtilities.isAppPaymentReceiver(receiver.scriptPubKey.addresses[0], blockDataVerbose.height)) {
            // it is an app message. Get Satoshi amount
            isFluxAppMessageValue += receiver.valueSat;
          }
          if (isRecognizedMessageSigner(receiver.scriptPubKey.addresses[0], blockDataVerbose.height)) {
            receiverIsRecognizedSigner = true;
          }
        }
        if (receiver.scriptPubKey.asm) {
          message = decodeMessage(receiver.scriptPubKey.asm);
        }
      });
      if (isFluxAppMessageValue) {
        // eslint-disable-next-line no-await-in-loop
        const appPrices = await chainUtilities.getChainParamsPriceUpdates();
        const intervals = appPrices.filter((i) => i.height < blockDataVerbose.height);
        const priceSpecifications = intervals[intervals.length - 1]; // filter does not change order
        // MAY contain App transaction. Store it.
        if (isFluxAppMessageValue >= (priceSpecifications.minPrice * 1e8) && message.length === 64 && blockDataVerbose.height >= config.fluxapps.epochstart) { // min of X flux had to be paid for us bothering checking
          const appTxRecord = {
            txid: tx.txid, height: blockDataVerbose.height, hash: message, value: isFluxAppMessageValue, message: false, // message is boolean saying if we already have it stored as permanent message
            blockTime: blockDataVerbose.time, // confirming block timestamp — v9 registeredAt
            syncAttempts: 0, nextRetryHeight: blockDataVerbose.height, retryFromHeight: blockDataVerbose.height,
          };
          // Unique hash - If we already have a hash of this app in our database, do not insert it!
          try {
            // 5501c7dd6516c3fc2e68dee8d4fdd20d92f57f8cfcdc7b4fcbad46499e43ed6f
            const querySearch = {
              hash: message,
            };
            const projectionSearch = {
              projection: {
                _id: 0,
                txid: 1,
                hash: 1,
                height: 1,
                value: 1,
                message: 1,
              },
            };
            // eslint-disable-next-line no-await-in-loop
            const result = await dbHelper.findOneInDatabase(database, appsHashesCollection, querySearch, projectionSearch); // this search can be later removed if nodes rescan apps and reconstruct the index for unique
            if (!result) {
              appsTransactions.push(appTxRecord);
            } else {
              throw new Error(`Found an existing hash app ${serviceHelper.ensureString(result)}`);
            }
          } catch (error) {
            log.error(`Hash ${message} already exists. Not adding at height ${blockDataVerbose.height}`);
            log.error(error);
          }
        }
      }
      // check for softForks — coarse filter: a recognized signer self-send carrying
      // an OP_RETURN. The per-type authority checks inside processSoftFork enforce
      // which signer may publish which message type.
      const isSoftFork = senderIsRecognizedSigner && receiverIsRecognizedSigner && message;
      if (isSoftFork) {
        try {
          const asmField = tx.vout.find((v) => v.scriptPubKey && v.scriptPubKey.asm);
          const rawBytes = asmField ? decodeMessageBytes(asmField.scriptPubKey.asm) : null;
          if (rawBytes) {
            // eslint-disable-next-line no-await-in-loop
            await processSoftFork(tx.txid, blockDataVerbose.height, rawBytes, senderIsLegacyAuthority, tx);
          }
        } catch (error) {
          log.error('Error processing soft fork message:', error);
        }
      }
    }
  }
}

async function insertTransactions(transactions, database) {
  if (transactions.length > 0) {
    log.info(`Explorer - insertTransactions - Inserting ${transactions.length} transactions to apps hashes collection`);
    try {
      const options = {
        ordered: false,
      };
      await dbHelper.insertManyToDatabase(database, appsHashesCollection, transactions, options);
    } catch (error) {
      log.error(`Explorer- insertTransactions - Inserting ${transactions.length} - transactions error - ${error}`);
      // eslint-disable-next-line no-restricted-syntax
      for (const transaction of transactions) {
        try {
          const query = { hash: transaction.hash, height: transaction.height };
          const update = { $set: transaction };
          const options = {
            upsert: true,
          };
          // eslint-disable-next-line no-await-in-loop
          await dbHelper.updateOneInDatabase(database, appsHashesCollection, query, update, options);
        } catch (errorTx) {
          log.error(`Explorer - insertTransactions - Inserting ${transaction.hash} - transaction error - ${errorTx}`);
        }
      }
    }
    appsTransactions = [];
  }
}

/**
 * To process transactions inserts on database and calling app messages.
 * @param {array} apps array with appstransactions to be processed.
 * @param {string} database Database.
 */
async function insertAndRequestAppHashes(apps, database) {
  if (apps.length > 0) {
    await insertTransactions(apps, database);
    setTimeout(async () => {
      const appsToRemove = [];
      let hasUnresolved = false;
      // eslint-disable-next-line no-restricted-syntax
      for (const app of apps) {
        // eslint-disable-next-line no-await-in-loop
        const messageReceived = await messageVerifier.checkAndRequestApp(app.hash, app.txid, app.height, app.value, app.blockTime ?? null, 2);
        if (messageReceived) {
          appsToRemove.push(app);
        } else {
          hasUnresolved = true;
        }
      }
      if (hasUnresolved) {
        appSyncEvents.emit(SYNC_EVENTS.HASH_UNRESOLVED);
      }
      const remaining = apps.filter((item) => !appsToRemove.includes(item));
      while (remaining.length > 500) {
        messageVerifier.checkAndRequestMultipleApps(remaining.splice(0, 500));
        // eslint-disable-next-line no-await-in-loop
        await serviceHelper.delay(30 * 1000); // delay 30 seconds
      }
      if (remaining.length > 0) {
        messageVerifier.checkAndRequestMultipleApps(remaining);
      }
    }, 1);
  }
}
/**
 * To process block data for entry to Insight database.
 * @param {number} blockHeight Block height.
 * @param {boolean} isInsightExplorer True if node is insight explorer based.
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */
async function processOneBlock(blockHeight, isInsightExplorer, loopOptions) {
  {
    const atTip = Boolean(loopOptions && loopOptions.atTip);
    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.daemon.database);
    // get Block information
    const verbosity = 2;
    const blockDataVerbose = await getVerboseBlock(blockHeight, verbosity);
    if (blockDataVerbose.height % 50 === 0) {
      log.info(`Processing Explorer Block Height: ${blockDataVerbose.height}`);
    }
    if (isInsightExplorer && blockDataVerbose.height > 699420 && blockDataVerbose.height < 862002) {
      // speed up sync as there were no app messages between these two blocks
      return 862002;
    }
    await processInsight(blockDataVerbose, database);

    // After fork block, chain runs 4x faster, so multiply periods by 4
    const speedMultiplier = blockHeight >= config.fluxapps.daemonPONFork ? 4 : 1;

    const scannedHeight = blockDataVerbose.height;
    // update scanned Height in scannedBlockHeightCollection
    const query = { generalScannedHeight: { $gte: 0 } };
    const update = { $set: { generalScannedHeight: scannedHeight } };
    const options = {
      upsert: true,
    };
    // Decided by comparison against the daemon's tip rather than inferred from the
    // block's own confirmation count. getblock returns -1 for a block that is not on
    // the main chain, which satisfies "confirmations < 2" — so an orphan used to read
    // as being at the tip and took the tip path.
    isSynced = atTip;
    if (isSynced) {
      if (globalState.dbReady && blockDataVerbose.height >= config.fluxapps.epochstart) {
        // Desired-state convergence at every tip block: cheap (this node's
        // handful of installed rows), level-triggered, and the reconciler
        // staggers any actual redeploys itself — so evaluating every block
        // cannot stampede anything.
        await specReconciler.requestFullConvergence({ reason: 'block' });
        if (blockHeight % (2 * speedMultiplier) === 0) {
          // Registry hygiene at tip cadence: expired global rows, their error
          // records, and orphaned content manifests. The sweep never throws,
          // so it cannot stall the block loop; removing an expired LOCAL
          // install is the reconciler's job (the convergence call above).
          await appJanitor.sweepRegistryExpiry();
        }
        if (blockDataVerbose.height % (config.fluxapps.reconstructAppMessagesHashPeriod * speedMultiplier) === 0) {
          try {
            const reconstructResult = await registryManager.reconstructAppMessagesHashCollection();
            log.info(`Validation of App Messages Hash Collection — ${reconstructResult}`);
          } catch (error) {
            log.error(error);
          }
        }
      }
      if (blockDataVerbose.height % (config.fluxapps.benchUpnpPeriod * speedMultiplier) === 0) {
        try {
          // every node behind the same ip will benchmark at the same time. I.e.
          // we spread the network out (grouped by ip) over 4 hours so we don't
          // absolutely hammer the speedtest servers at the same time.
          const maxBenchDelay = 4 * 3_600_000;
          const socketAddress = await fluxNetworkhelper.getLocalSocketAddress();

          // socketAddress can be null. If it is, we just use an empty string. This
          // has the effect of creating an initializer of just the block number. If
          // this happens, every node on the network that uses the block number will
          // run the bench at the same time. However this is an extreme edge case, as
          // all nodes should just return the ip.
          const localIp = socketAddress ? extractIp(socketAddress) : '';
          // This is: string + number = string
          const initializer = localIp + blockDataVerbose.height;
          const benchDelayMs = serviceHelper.randomDelayMs(maxBenchDelay, { initializer });
          const benchDelayS = Math.round((benchDelayMs / 1000) * 100) / 100;

          log.info(`Random seed: ${initializer}. Starting multiport bench in: ${benchDelayS}s`);

          setTimeout(benchmarkService.executeUpnpBench, benchDelayMs);
        } catch (error) {
          log.error(error);
        }
      }
      await insertAndRequestAppHashes(appsTransactions, database, true);
      await dbHelper.updateOneInDatabase(database, scannedHeightCollection, query, update, options);
      fluxEventBus.publish('block:processed', { height: scannedHeight });
      // After the cursor, never before it: a subscriber that reads the persisted
      // height in response to this event would otherwise read the previous block.
      blockEmitter.emit('blocksProcessed', scannedHeight);
    } else if (blockDataVerbose.height % cursorBatchSize() === 0) {
      log.info(`Processing Explorer Number of Transactions: ${appsTransactions.length}.`);
      await appJanitor.sweepRegistryExpiry(); // in case node was shutdown for a while and it is started
      await insertTransactions(appsTransactions, database);
      await dbHelper.updateOneInDatabase(database, scannedHeightCollection, query, update, options);
      fluxEventBus.publish('block:processed', { height: scannedHeight });
      blockEmitter.emit('syncProgress', scannedHeight);
    }

    return blockDataVerbose.height + 1;
  }
}

let lastchainTipCheck = 0;
/**
 * Removes duplicate scannedheight documents, keeping only the one with the highest block height.
 * This cleans up legacy seeded documents that may exist on nodes.
 * @param {object} database MongoDB database connection.
 * @returns {Promise<void>}
 */
async function cleanupDuplicateScannedHeight(database) {
  try {
    const count = await dbHelper.countInDatabase(database, scannedHeightCollection, {});

    if (count <= 1) {
      return; // No duplicates, nothing to clean
    }

    log.warn(`Found ${count} scannedheight documents, cleaning up duplicates...`);

    // Get the document with highest block height (MongoDB sorts it)
    const highestArr = await dbHelper.findInDatabase(database, scannedHeightCollection, {}, {
      sort: { generalScannedHeight: -1 },
      limit: 1,
    });

    const highest = highestArr[0];

    log.info(`Keeping scannedheight document with height ${highest.generalScannedHeight} (_id: ${highest._id})`);

    // Delete all EXCEPT the highest
    const deleteResult = await dbHelper.removeDocumentsFromCollection(database, scannedHeightCollection, {
      _id: { $ne: highest._id },
    });

    log.info(`Removed ${deleteResult.deletedCount} duplicate scannedheight documents`);
  } catch (error) {
    log.error(`Error cleaning up duplicate scannedheight documents: ${error.message}`);
  }
}

// One-time migration for nodes carrying records from before the Feb 2021
// zelAppSpecifications → appSpecifications rename: bring data at rest in line
// with the field name the rest of the code now reads exclusively, and drop the
// indexes that backed the old field name. Idempotent (matches zero docs once
// migrated). Safe to remove, along with the gating flag, once the whole fleet
// has run it.
async function migrateZelAppSpecifications(databaseGlobal) {
  const col = databaseGlobal.collection(config.database.appsglobal.collections.appsMessages);
  const result = await col.updateMany(
    { zelAppSpecifications: { $exists: true } },
    { $rename: { zelAppSpecifications: 'appSpecifications' } },
  );
  if (result.modifiedCount > 0) {
    log.info(`Migrated ${result.modifiedCount} records from zelAppSpecifications to appSpecifications`);
  }
  const existingIndexes = await col.indexes();
  const legacyIndexNames = [
    'query for getting zelapp message based on zelapp specs name',
    'query for getting zelapp message based on zelapp specs owner',
    'query for getting zelapp message based on image',
  ];
  for (const idx of existingIndexes) {
    if (legacyIndexNames.includes(idx.name)) {
      // eslint-disable-next-line no-await-in-loop
      await col.dropIndex(idx.name);
      log.info(`Dropped legacy index: ${idx.name}`);
    }
  }
}

/**
 * To start the block processor.
 * @param {boolean} restoreDatabase True if database is to be restored.
 * @param {boolean} deepRestore True if a deep restore is required.
 * @param {boolean} rescanGlobalApps True if apps collections are to be reindexed.
 * @returns {void} Return statement is only used here to interrupt the function and nothing is returned.
 */

function getPriceSpecForHeight(priceSpecs, height) {
  let lo = 0;
  let hi = priceSpecs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (priceSpecs[mid].height < height) lo = mid;
    else hi = mid - 1;
  }
  return priceSpecs[lo];
}

async function bootstrapSoftForks(currentDaemonHeight) {
  // Phase 1 — the STATIC recognized signers: the legacy payment multisigs and the
  // v9 message authority. Finds legacy price + PriceMessage/PriceModifier/OracleKey/
  // Marketplace/PolicyGroup. TODO: RateMessages are signed by the dynamic oracle
  // address (rotated via OracleKeyMessage), so a cold rebuild also needs a phase-2
  // scan of the discovered oracle addresses — see
  // fluxModels fluxos/BOOTSTRAP_ORACLE_RATE_HISTORY_REBUILD.md.
  const signerAddresses = [
    ...chainUtilities.legacyMessageAuthorities(),
    config.fluxapps.messageAuthorityAddress,
  ].filter(Boolean);
  const deltaResult = await daemonServiceUtils.executeCall('getaddressdeltas', [{
    addresses: signerAddresses,
    start: config.fluxapps.epochstart,
    end: currentDaemonHeight,
  }]);
  if (deltaResult.status !== 'success') {
    log.warn(`Bootstrap: getaddressdeltas failed: ${deltaResult.data?.message || deltaResult.data}`);
    return;
  }

  const byTx = new Map();
  for (const d of deltaResult.data) {
    if (!byTx.has(d.txid)) byTx.set(d.txid, []);
    byTx.get(d.txid).push(d);
  }
  const selfSendTxids = [];
  for (const [txid, deltas] of byTx) {
    const hasSpend = deltas.some((d) => d.satoshis < 0);
    const hasReceive = deltas.some((d) => d.satoshis > 0);
    if (hasSpend && hasReceive) selfSendTxids.push(txid);
  }

  if (selfSendTxids.length === 0) return;
  log.info(`Bootstrap: Found ${selfSendTxids.length} recognized-signer self-send transactions, checking for soft forks`);

  const BATCH_SIZE = 500;
  const signerSet = new Set(signerAddresses);
  let totalForks = 0;
  for (let i = 0; i < selfSendTxids.length; i += BATCH_SIZE) {
    const batch = selfSendTxids.slice(i, i + BATCH_SIZE);
    const calls = batch.map((txid) => ({ method: 'getrawtransaction', params: [txid, 1] }));
    // eslint-disable-next-line no-await-in-loop
    const batchResult = await daemonServiceUtils.executeBatchCall(calls);
    if (batchResult.status !== 'success') continue;

    for (const response of batchResult.data) {
      if (response.error || !response.result) continue;
      const tx = response.result;
      let senderRecognized = false;
      let senderIsLegacyAuthority = false;
      let receiverRecognized = false;
      let message = '';

      for (const vin of (tx.vin || [])) {
        if (vin.address && signerSet.has(vin.address)) senderRecognized = true;
        if (vin.address && isLegacyMessageAuthority(vin.address)) senderIsLegacyAuthority = true;
      }
      for (const vout of tx.vout) {
        if (vout.scriptPubKey.addresses) {
          for (const addr of vout.scriptPubKey.addresses) {
            if (signerSet.has(addr)) receiverRecognized = true;
          }
        }
        if (vout.scriptPubKey.asm) {
          const decoded = decodeMessage(vout.scriptPubKey.asm);
          if (decoded) message = decoded;
        }
      }

      if (senderRecognized && receiverRecognized && message) {
        const asmField = tx.vout.find((v) => v.scriptPubKey && v.scriptPubKey.asm);
        const rawBytes = asmField ? decodeMessageBytes(asmField.scriptPubKey.asm) : null;
        if (rawBytes) {
          // eslint-disable-next-line no-await-in-loop
          await processSoftFork(tx.txid, tx.height, rawBytes, senderIsLegacyAuthority, tx);
          totalForks += 1;
        }
      }
    }
  }
  log.info(`Bootstrap: Stored ${totalForks} soft fork messages`);
}

function processBootstrapTx(tx, priceSpecs, seenHashes, hashBatch) {
  if (tx.version >= 5 || tx.version <= 0) return;
  const { height } = tx;
  if (!height) return;

  let message = '';
  let appValue = 0;

  for (const vout of tx.vout) {
    if (vout.scriptPubKey.addresses) {
      const addr = vout.scriptPubKey.addresses[0];
      if (chainUtilities.isAppPaymentReceiver(addr, height)) {
        appValue += vout.valueSat;
      }
    }
    if (vout.scriptPubKey.asm) {
      message = decodeMessage(vout.scriptPubKey.asm);
    }
  }

  if (appValue > 0) {
    const priceSpec = getPriceSpecForHeight(priceSpecs, height);
    if (appValue >= (priceSpec.minPrice * 1e8) && message.length === 64
      && height >= config.fluxapps.epochstart && !seenHashes.has(message)) {
      seenHashes.add(message);
      hashBatch.push({
        txid: tx.txid, height, hash: message, value: appValue,
        blockTime: tx.blocktime ?? null, // verbose getrawtransaction field — v9 registeredAt
        message: false, syncAttempts: 0, nextRetryHeight: height, retryFromHeight: height,
      });
    }
  }

}

async function bootstrapAppHashes(currentDaemonHeight) {
  // Every payment-collection address (the dev receiver is only in the array on dev builds).
  const appAddresses = config.fluxapps.appPaymentAddresses.map((entry) => entry.address);

  log.info(`Bootstrap: Fetching txids for ${appAddresses.length} app addresses from height ${config.fluxapps.epochstart} to ${currentDaemonHeight}`);

  const txidResult = await daemonServiceUtils.executeCall('getaddresstxids', [{
    addresses: appAddresses,
    start: config.fluxapps.epochstart,
    end: currentDaemonHeight,
  }]);
  if (txidResult.status !== 'success') {
    throw new Error(`getaddresstxids failed: ${txidResult.data.message || txidResult.data}`);
  }

  const allTxids = [...new Set(txidResult.data)];
  log.info(`Bootstrap: ${allTxids.length} unique txids to process`);

  await bootstrapSoftForks(currentDaemonHeight);
  const priceSpecs = await chainUtilities.getChainParamsPriceUpdates();

  const seenHashes = new Set();
  let hashBatch = [];
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);

  const BATCH_SIZE = 500;
  const INSERT_THRESHOLD = 5000;
  let totalHashes = 0;

  for (let i = 0; i < allTxids.length; i += BATCH_SIZE) {
    const batch = allTxids.slice(i, i + BATCH_SIZE);
    const calls = batch.map((txid) => ({ method: 'getrawtransaction', params: [txid, 1] }));

    // eslint-disable-next-line no-await-in-loop
    const batchResult = await daemonServiceUtils.executeBatchCall(calls);
    if (batchResult.status !== 'success') {
      throw new Error(`Batch getrawtransaction failed: ${batchResult.data.message || batchResult.data}`);
    }

    for (const response of batchResult.data) {
      if (response.error) {
        log.warn(`Bootstrap: failed to fetch tx: ${response.error.message || JSON.stringify(response.error)}`);
        continue;
      }
      processBootstrapTx(response.result, priceSpecs, seenHashes, hashBatch);
    }

    if (hashBatch.length >= INSERT_THRESHOLD || i + BATCH_SIZE >= allTxids.length) {
      if (hashBatch.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await insertTransactions(hashBatch, database);
        totalHashes += hashBatch.length;
        hashBatch = [];
      }
    }

    const processed = Math.min(i + BATCH_SIZE, allTxids.length);
    if (processed % 5000 < BATCH_SIZE || processed === allTxids.length) {
      log.info(`Bootstrap: ${processed}/${allTxids.length} txids processed, ${totalHashes + hashBatch.length} hashes`);
    }
  }

  const query = { generalScannedHeight: { $gte: 0 } };
  const update = { $set: { generalScannedHeight: currentDaemonHeight } };
  await dbHelper.updateOneInDatabase(database, scannedHeightCollection, query, update, { upsert: true });

  log.info(`Bootstrap complete: ${totalHashes} app hashes, scanned to height ${currentDaemonHeight}`);
}

async function waitForDaemonSync() {
  const retryMs = config.fluxapps.explorerSyncRetryMs ?? 120000;
  while (!daemonServiceMiscRpcs.isDaemonSynced().data.synced) {
    log.info(`Explorer - Daemon not synced, retrying in ${retryMs / 1000}s`);
    await serviceHelper.delay(retryMs);
  }
}

async function getScannedBlockHeightFromDb(database) {
  const query = { generalScannedHeight: { $gte: 0 } };
  const projection = { projection: { _id: 0, generalScannedHeight: 1 } };
  const current = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
  return current?.generalScannedHeight ?? 0;
}

/**
 * Rolls the scan back when the daemon reports a reorg.
 *
 * This is what re-homes reorg handling off the poll loop. Polling could only notice a
 * reorg by asking for chain tips, gated to once per 101 blocks and only while the tip
 * was not advancing — so a reorg during normal block flow went unseen until the chain
 * stalled. The event names the fork block outright, so no inference and no safety
 * margin are needed: the daemon has told us the last height both chains agree on.
 *
 * @param {{fork: {height: number}, depth: number}} reorg The reorg event.
 * @returns {Promise<void>} Resolves once any rollback has completed.
 */
async function handleChainReorg(reorg) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const scannedBlockHeight = await getScannedBlockHeightFromDb(database);

  if (scannedBlockHeight <= reorg.fork.height) {
    log.info(`Explorer - reorg at ${reorg.fork.height} is above our scan (${scannedBlockHeight}), nothing to roll back`);
    return;
  }

  log.warn(`Explorer - rolling back from ${scannedBlockHeight} to fork at ${reorg.fork.height}`);
  await chainRollback.rollbackTo(reorg.fork.height);
  lastchainTipCheck = reorg.fork.height;
}

async function checkAndHandleReorgs(database, scannedBlockHeight) {
  if (scannedBlockHeight < config.daemon.chainValidHeight || lastchainTipCheck === 0 || lastchainTipCheck + 100 >= scannedBlockHeight) {
    if (lastchainTipCheck === 0) {
      lastchainTipCheck = scannedBlockHeight - 1;
    }
    return scannedBlockHeight;
  }

  log.info(`Explorer - Checking for chain reorganisations - lastchainTipCheck: ${lastchainTipCheck} scannedBlockHeight: ${scannedBlockHeight}`);
  const daemonVersion = await getDaemonVersion();
  let daemonGetChainTips;
  if (daemonVersion > 7020050) {
    daemonGetChainTips = await daemonServiceBlockchainRpcs.getChainTips({ params: { minheight: lastchainTipCheck + 1 } });
  } else {
    daemonGetChainTips = await daemonServiceBlockchainRpcs.getChainTips();
  }
  if (daemonGetChainTips.status !== 'success') {
    throw new Error(daemonGetChainTips.data.message || daemonGetChainTips.data);
  }

  const reorganisations = daemonGetChainTips.data;
  let reorgs = reorganisations.filter((reorg) => reorg.status === 'valid-fork' && reorg.height >= lastchainTipCheck + 1);
  if (reorgs.length > 1) {
    reorgs = reorgs.sort((a, b) => a.height - b.height);
  }

  let reorgBlockHeight;
  let rescanDepth = 0;
  let finished = false;
  let index = 0;
  while (!finished && index < reorgs.length) {
    const reorg = reorgs[index];
    if (!reorgBlockHeight || (reorg.height === reorgBlockHeight && reorg.branchlen > rescanDepth)) {
      rescanDepth = reorg.branchlen;
      reorgBlockHeight = reorg.height;
    } else {
      finished = true;
    }
    index += 1;
  }

  let height = scannedBlockHeight;
  if (rescanDepth > 0) {
    rescanDepth += 2;
    log.warn(`Potential chain reorganisation spotted at height ${reorgBlockHeight}. Rescanning last ${rescanDepth} blocks...`);
    height = Math.max(reorgBlockHeight - rescanDepth, 0);
    await chainRollback.rollbackTo(height);
    log.info('Database restored OK');
  }
  lastchainTipCheck = scannedBlockHeight;
  return height;
}

/**
 * Cancels whatever the scan has scheduled. There is at most one thing.
 * @returns {void}
 */
function clearScanTimer() {
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
}

/**
 * Schedules one future scan attempt, replacing any already scheduled.
 *
 * Only two things schedule: a failure, which backs off rather than retrying straight
 * away, and the fallback for a daemon that does not publish block events. Neither
 * exists on the push path, so a healthy node has nothing armed between blocks.
 *
 * @param {number} delayMs How long to wait.
 * @param {string} reason What scheduled it, for the log.
 * @returns {void}
 */
function scheduleScan(delayMs, reason) {
  if (scanStopped) return;

  clearScanTimer();

  scanTimer = setTimeout(() => {
    scanTimer = null;
    // eslint-disable-next-line no-use-before-define
    requestScan(reason);
  }, delayMs);
}

/**
 * Brings the scan up to the daemon's tip, then returns.
 *
 * Iterates because block N+1 cannot be written before block N, but it does not idle
 * and it does not schedule: when there is nothing left to do it simply finishes, and
 * the next block event starts it again. That is the difference from the loop this
 * replaces, which slept five seconds between checks forever, and — because a failure
 * could return without delay — could spin at full CPU when the database was
 * unavailable.
 *
 * @returns {Promise<void>} Resolves when caught up, stopped, or backed off.
 */
async function drainToTip() {
  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();

  if (!syncStatus.data.synced) {
    scheduleScan(config.fluxapps.explorerUnsyncedRetryMs ?? 5000, 'daemon unsynced');
    return;
  }

  const daemonHeight = syncStatus.data.height;
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);

  // Read once. The durable cursor only moves every `cursorBatchSize()` blocks while
  // catching up, so re-reading it each time would ask the same question forever — the
  // drain would never see progress and never terminate. Advancement comes from the
  // height the previous block returned, which is also what the batching is safe
  // against: the cursor lagging is expected, standing still is not.
  let next = (await getScannedBlockHeightFromDb(database)) + 1;

  if (next > daemonHeight) {
    // Reorgs normally arrive as an event naming the fork block. A daemon that does not
    // publish the topic still needs them found, so the chain-tips check remains for
    // exactly that case, on its own 100-block gate.
    if (!daemonSubscriptionService.isTopicAvailable(daemonSubscriptionService.TOPICS.chainReorg)) {
      await checkAndHandleReorgs(database, next - 1);
    }

    return;
  }

  const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();

  while (!scanStopped && next <= daemonHeight) {
    const current = next;

    scanBlockInFlight = true;
    try {
      // eslint-disable-next-line no-await-in-loop
      next = await processOneBlock(current, isInsightExplorer, { atTip: current >= daemonHeight });
    } finally {
      scanBlockInFlight = false;
    }

    // A block that does not move the scan forward would be an infinite drain. Nothing
    // should be able to produce it, which is exactly why it is worth refusing rather
    // than trusting.
    if (!Number.isInteger(next) || next <= current) {
      throw new Error(`Block ${current} did not advance the scan (next: ${next})`);
    }
  }
}

/**
 * Asks for the scan to run.
 *
 * Called by the block event, by the fallback timer, and once at startup. Single
 * flight: a request arriving while a drain is in progress is remembered rather than
 * starting a second one, and the drain re-checks before finishing. Exactly one drain
 * exists at a time, which is what makes "a block is in flight" answerable at all.
 *
 * @param {string} reason What asked for it, for the log.
 * @returns {Promise<void>} Resolves when the drain this call caused has finished.
 */
async function requestScan(reason = 'requested') {
  if (scanStopped) return;

  if (scanDraining) {
    scanRequestPending = true;
    return;
  }

  scanDraining = true;
  scanDrainPromise = (async () => {
    try {
      do {
        scanRequestPending = false;
        // eslint-disable-next-line no-await-in-loop
        await drainToTip();
      } while (scanRequestPending && !scanStopped);
    } catch (error) {
      log.error(`Block processor encountered an error (${reason})`);
      log.error(error);

      const deep = error.message && error.message.includes('duplicate key');

      try {
        await recoverFromError(deep);
      } catch (recoveryError) {
        log.error(`Recovery failed: ${recoveryError.message}`);
      }

      // Backed off rather than retried immediately: a database that is gone stays
      // gone for a while, and an immediate retry is a busy loop.
      scheduleScan(config.fluxapps.explorerRecoveryRetryMs ?? 60000, 'after error');
    } finally {
      scanDraining = false;
      scanDrainPromise = null;

      // A daemon that publishes no block events has nothing to wake the next scan,
      // so the timer is re-armed here: after every drain, not only after one that
      // found nothing to do. Arming it only on the idle path meant a node that had
      // blocks to process at startup scanned them, returned, and then slept forever
      // while the chain moved on — with nothing logged, because doing no work is
      // indistinguishable from having no work.
      //
      // Skipped when a timer already exists so the error backoff above, which is
      // deliberately much longer, is not replaced by the short idle interval.
      if (scanFallbackPolling && !scanStopped && !scanTimer) {
        scheduleScan(config.fluxapps.explorerIdlePollMs ?? 5000, 'fallback poll');
      }
    }
  })();

  await scanDrainPromise;
}

/**
 * Enables scanning and runs it once. Blocks then arrive by event.
 * @returns {Promise<void>} Resolves once the initial drain has finished.
 */
async function startScanning() {
  scanStopped = false;

  // A daemon that publishes no block events has nothing to wake us, so that case —
  // and only that case — keeps a timer.
  if (!daemonSubscriptionService.isTopicAvailable(daemonSubscriptionService.TOPICS.hashBlockHeight)) {
    scanFallbackPolling = true;
  }

  await requestScan('startup');
}

/**
 * Stops scanning and waits for the block in flight to finish.
 *
 * Stays stopped: the flag is not restored for the caller, and the single timer is
 * cancelled rather than left armed.
 *
 * @returns {Promise<void>} Resolves once nothing is running or scheduled.
 */
async function stopScanning() {
  scanStopped = true;
  scanFallbackPolling = false;
  clearScanTimer();

  if (scanDrainPromise) await scanDrainPromise;
}

/**
 * Called when the daemon reports a new block. The only thing that drives scanning on
 * a healthy node.
 * @param {number} height The new tip height.
 * @returns {void}
 */
function onNewBlock(height) {
  if (scanStopped) return;

  requestScan(`block ${height}`).catch((error) => {
    log.error(`Block processor scan request failed: ${error.message}`);
  });
}

/**
 * Rewinds after a block failed, so the retry starts from a consistent point.
 *
 * Only repairs; it neither retries nor schedules. The caller backs off and asks again,
 * which is what stops a failure from becoming a busy loop. The 15-minute uncancellable
 * retry this replaces could fire long after the scan had been restarted by another
 * route, and start a second one.
 *
 * @param {boolean} deepRestore Whether to rewind further than the last block.
 * @returns {Promise<void>} Resolves once the rollback has been applied.
 */
async function recoverFromError(deepRestore) {
  await waitForDaemonSync();

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const scannedBlockHeight = await getScannedBlockHeightFromDb(database);

  if (scannedBlockHeight === 0) return;

  const deepRestoreBlocks = config.fluxapps.explorerDeepRestoreBlocks ?? 100;

  if (deepRestore && deepRestoreBlocks > 0) {
    log.info('Deep restoring of database...');
    await chainRollback.rollbackTo(Math.max(scannedBlockHeight - deepRestoreBlocks, 0));
  } else {
    log.info('Restoring database...');
    await chainRollback.restoreDatabaseToBlockheightState(scannedBlockHeight);
  }

  log.info('Database restored OK');
}

// do a deepRestore of 100 blocks if daemon if enouncters an error (mostly flux daemon was down) or if its initial start of flux
// use reindexGlobalApps with caution!!!
async function initiateBlockProcessor(options = {}) {
  const { restoreDatabase = false, deepRestore = false, rescanGlobalApps = false } = options;

  try {
    await waitForDaemonSync();

    if (isInInitiationOfBP) return;
    isInInitiationOfBP = true;

    const db = dbHelper.databaseConnection();
    const database = db.db(config.database.daemon.database);

    await cleanupDuplicateScannedHeight(database);

    if (!zelAppSpecsMigrationDone) {
      // Wrapped so a malformed or fresh-sync DB (e.g. col.indexes() on a
      // not-yet-created collection) can't stall block-processor init.
      try {
        const globalDb = db.db(config.database.appsglobal.database);
        await migrateZelAppSpecifications(globalDb);
        zelAppSpecsMigrationDone = true;
      } catch (error) {
        log.error(`zelAppSpecifications migration failed: ${error.message}`);
      }
    }
    // Rebuild in-memory chain-message state from persisted messages before the
    // scan resumes adding to it (otherwise the incremental history.add() calls in
    // processSoftFork are no-ops and nothing reads the chain-derived state).
    await entitlementsState.rebuildPolicyGroupState();
    await priceOracleState.rebuildPriceOracleState();

    let scannedBlockHeight = await getScannedBlockHeightFromDb(database);

    const daemonBlockCount = await daemonServiceBlockchainRpcs.getBlockCount();
    if (daemonBlockCount.status !== 'success') {
      throw new Error(daemonBlockCount.data.message || daemonBlockCount.data);
    }
    const daemonHeight = daemonBlockCount.data;

    if (scannedBlockHeight === 0) {
      log.info('Preparing daemon collections');
      const resultD = await dbHelper.dropCollection(database, appsHashesCollection).catch((error) => {
        if (error.message !== 'ns not found') throw error;
      });
      const databaseUpdates = db.db(config.database.chainparams.database);
      const resultChainParams = await dbHelper.dropCollection(databaseUpdates, chainParamsMessagesCollection).catch((error) => {
        if (error.message !== 'ns not found') throw error;
      });
      log.info(resultD, resultChainParams);

      await database.collection(appsHashesCollection).createIndex({ txid: 1 }, { name: 'query for getting txid' });
      await database.collection(appsHashesCollection).createIndex({ height: 1 }, { name: 'query for getting height' });
      await database.collection(appsHashesCollection).createIndex({ hash: 1 }, { name: 'query for getting app hash', unique: true }).catch((error) => {
        log.error('Expected throw on index creation as of new uniquness. Do not remove this check until all nodes have rebuild apps data');
        log.error(error);
      });
      await database.collection(appsHashesCollection).createIndex({ message: 1 }, { name: 'query for getting app hashes depending if we have message' });
      await databaseUpdates.collection(chainParamsMessagesCollection).createIndex({ txid: 1 }, { name: 'query for getting txid of some chain parameters update message' });
      await databaseUpdates.collection(chainParamsMessagesCollection).createIndex({ height: 1 }, { name: 'query for getting height of some chain parameters update message' });
      await databaseUpdates.collection(chainParamsMessagesCollection).createIndex({ message: 1 }, { name: 'query for getting message of some chain parameters update message' });
      await databaseUpdates.collection(chainParamsMessagesCollection).createIndex({ version: 1 }, { name: 'query for getting version of some chain parameters update message' });

      const databaseGlobal = db.db(config.database.appsglobal.database);
      log.info('Preparing apps collections');
      if (rescanGlobalApps === true) {
        const resultE = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsMessages).catch((error) => {
          if (error.message !== 'ns not found') throw error;
        });
        const resultF = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsInformation).catch((error) => {
          if (error.message !== 'ns not found') throw error;
        });
        const resultH = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsInstallingLocations).catch((error) => {
          if (error.message !== 'ns not found') throw error;
        });
        const resultI = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsInstallingErrorsLocations).catch((error) => {
          if (error.message !== 'ns not found') throw error;
        });
        const resultJ = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsInstallingErrorsBroadcasts).catch((error) => {
          if (error.message !== 'ns not found') throw error;
        });
        const resultK = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appStateEvents).catch((error) => {
          if (error.message !== 'ns not found') throw error;
        });
        const resultL = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsInstallingBroadcasts).catch((error) => {
          if (error.message !== 'ns not found') throw error;
        });
        log.info(resultE, resultF, resultH, resultI, resultJ, resultK, resultL);
        await databaseGlobal.collection(config.database.appsglobal.collections.appStateEvents).createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
        await databaseGlobal.collection(config.database.appsglobal.collections.appStateEvents).createIndex({ ip: 1, type: 1, dedupKey: 1 }, { unique: true });
        await databaseGlobal.collection(config.database.appsglobal.collections.appStateEvents).createIndex({ broadcastedAt: 1 });
        await databaseGlobal.collection(config.database.appsglobal.collections.appStateEvents).createIndex({ createdAt: 1 });
      }
      await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ hash: 1 }, { name: 'query for getting zelapp message based on hash', unique: true });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ txid: 1 }, { name: 'query for getting zelapp message based on txid' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ height: 1 }, { name: 'query for getting zelapp message based on height' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'appSpecifications.name': 1 }, { name: 'query for getting app message based on zelapp specs name' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'appSpecifications.owner': 1 }, { name: 'query for getting app message based on zelapp specs owner' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'appSpecifications.repotag': 1 }, { name: 'query for getting app message based on image' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'appSpecifications.version': 1 }, { name: 'query for getting app message based on version' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'appSpecifications.nodes': 1 }, { name: 'query for getting app message based on nodes' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ name: 1 }, { name: 'query for getting zelapp based on zelapp specs name' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ owner: 1 }, { name: 'query for getting zelapp based on zelapp specs owner' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ repotag: 1 }, { name: 'query for getting zelapp based on image' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ height: 1 }, { name: 'query for getting zelapp based on last height update' });
      await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ hash: 1 }, { name: 'query for getting zelapp based on last hash' });
      await database.collection(config.database.appsglobal.collections.appsInstallingLocations).createIndex({ name: 1 }, { name: 'query for getting zelapp install location based on zelapp specs name' });
      await database.collection(config.database.appsglobal.collections.appsInstallingLocations).createIndex({ name: 1, ip: 1 }, { name: 'query for getting flux app install location based on specs name and node ip' });
      await database.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations).createIndex({ name: 1 }, { name: 'query for getting flux app install errors location based on specs name' });
      await database.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations).createIndex({ name: 1, hash: 1 }, { name: 'query for getting flux app install errors location based on specs name and hash' });
      await database.collection(config.database.appsglobal.collections.appsInstallingErrorsLocations).createIndex({ name: 1, hash: 1, ip: 1 }, { name: 'query for getting flux app install errors location based on specs name and hash and node ip' });
      log.info('Preparation done');
    }

    if (daemonHeight > scannedBlockHeight) {
      if (scannedBlockHeight !== 0 && restoreDatabase) {
        const deepRestoreBlocks = config.fluxapps.explorerDeepRestoreBlocks ?? 100;
        if (deepRestore && deepRestoreBlocks > 0) {
          log.info('Deep restoring of database...');
          scannedBlockHeight = Math.max(scannedBlockHeight - deepRestoreBlocks, 0);
          await chainRollback.rollbackTo(scannedBlockHeight, { rescanGlobalApps });
          log.info('Database restored OK');
        } else if (!deepRestore) {
          log.info('Restoring database...');
          await chainRollback.restoreDatabaseToBlockheightState(scannedBlockHeight, rescanGlobalApps);
          log.info('Database restored OK');
        }
      }
    }

    isInInitiationOfBP = false;

    if (!explorerReadyEmitted) {
      explorerReadyEmitted = true;
      fluxEventBus.publish('explorer:ready', { height: scannedBlockHeight });
    }

    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();

    if (daemonHeight <= scannedBlockHeight) {
      if (lastchainTipCheck === 0) {
        lastchainTipCheck = scannedBlockHeight - 1;
      }
      await startScanning();
      return;
    }

    if (scannedBlockHeight === 0 && isInsightExplorer) {
      try {
        log.info('Bootstrap: Using address-index fast path');
        await bootstrapAppHashes(daemonHeight);
        log.info('Bootstrap complete, entering steady-state block processing');
      } catch (error) {
        log.error('Bootstrap failed, falling back to block-by-block scan');
        log.error(error);
        await chainRollback.setScannedHeight(database, config.fluxapps.epochstart - 1);
      }
    } else if (isInsightExplorer && scannedBlockHeight < config.fluxapps.epochstart - 1) {
      await chainRollback.setScannedHeight(database, config.fluxapps.epochstart - 1);
    }

    // The loop reads the cursor itself, so everything above only has to leave the
    // cursor where scanning should resume from.
    await startScanning();
  } catch (error) {
    log.error(error);
    isInInitiationOfBP = false;
    await recoverFromError(true);
    await startScanning();
  }
}

/**
 * Stops the scan and waits for it, so a caller can safely mutate what it reads.
 *
 * The version this replaces polled a flag for up to twelve seconds and then set the
 * guard back to `true` before handing control to the caller — so every reindex and
 * rescan ran with block processing free to resume underneath it. Awaiting the loop
 * removes both the timeout and the window.
 *
 * @returns {Promise<void>} Resolves once the scan has stopped.
 */
async function stopBlockProcessing() {
  await stopScanning();

  // An initiation parked on waitForDaemonSync has not started the loop yet, so it
  // would restart the scan the moment the daemon answers.
  if (isInInitiationOfBP) {
    throw new Error('Block processor is still initiating. Try again later.');
  }
}

/**
 * Stops the scan, then starts it again from a restored database.
 * @returns {Promise<void>} Resolves once the processor has been asked to start.
 */
async function restartBlockProcessing() {
  await stopBlockProcessing();
  initiateBlockProcessor({ restoreDatabase: true });
}

/**
 * Drops the scan cursor so the next start rebuilds from the beginning.
 * @param {{rescanGlobalApps?: boolean}} options
 * @returns {Promise<void>} Resolves once the reindex has been started.
 */
async function reindexExplorer(options = {}) {
  await stopBlockProcessing();

  if (operationBlocked) throw new Error('Operation blocked');
  operationBlocked = true;

  try {
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);

    await dbHelper.dropCollection(database, scannedHeightCollection).catch((error) => {
      if (error.message !== 'ns not found') throw error;
    });
  } finally {
    operationBlocked = false;
  }

  initiateBlockProcessor({
    restoreDatabase: true,
    rescanGlobalApps: options.rescanGlobalApps === true,
  });
}

/**
 * Rewinds the scan cursor to a height and restarts from there.
 * @param {{blockheight: number, rescanGlobalApps?: boolean}} options
 * @returns {Promise<number>} The height rescanning will resume from.
 */
async function rescanExplorer(options = {}) {
  const blockheight = serviceHelper.ensureNumber(options.blockheight);

  if (!Number.isFinite(blockheight)) throw new Error('No blockheight provided');
  if (blockheight < 0) throw new Error('BlockHeight lower than 0');

  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.daemon.database);
  const query = { generalScannedHeight: { $gte: 0 } };
  const projection = { projection: { _id: 0, generalScannedHeight: 1 } };

  const currentHeight = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
  if (!currentHeight) throw new Error('No scanned height found');
  if (currentHeight.generalScannedHeight <= blockheight) {
    throw new Error('Block height shall be lower than currently scanned');
  }

  await stopBlockProcessing();

  if (operationBlocked) throw new Error('Operation blocked');
  operationBlocked = true;

  try {
    await chainRollback.setScannedHeight(database, blockheight);
  } finally {
    operationBlocked = false;
  }

  initiateBlockProcessor({
    restoreDatabase: true,
    rescanGlobalApps: options.rescanGlobalApps === true,
  });

  return blockheight;
}

/**
 * To stop block processing. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function stopBlockProcessingApi(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (authorized !== true) {
    res.json(messageHelper.errUnauthorizedMessage());
    return;
  }

  try {
    await stopBlockProcessing();
    res.json(messageHelper.createSuccessMessage('Block processing is stopped'));
  } catch (error) {
    log.error(error);
    res.json(messageHelper.createErrorMessage(error.message, error.name, error.code));
  }
}

/**
 * To restart block processing. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function restartBlockProcessingApi(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (authorized !== true) {
    res.json(messageHelper.errUnauthorizedMessage());
    return;
  }

  try {
    await restartBlockProcessing();
    res.json(messageHelper.createSuccessMessage('Block processing initiated'));
  } catch (error) {
    log.error(error);
    res.json(messageHelper.createErrorMessage(error.message, error.name, error.code));
  }
}

/**
 * To reindex Flux explorer database. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function reindexExplorerApi(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (authorized !== true) {
    res.json(messageHelper.errUnauthorizedMessage());
    return;
  }

  try {
    const raw = req?.params?.reindexapps ?? req?.query?.reindexapps ?? false;
    await reindexExplorer({ rescanGlobalApps: serviceHelper.ensureBoolean(raw) });
    res.json(messageHelper.createSuccessMessage('Explorer database reindex initiated'));
  } catch (error) {
    log.error(error);
    res.json(messageHelper.createErrorMessage(error.message, error.name, error.code));
  }
}

/**
 * To rescan Flux explorer database from a specific block height. Only accessible by
 * admins and Flux team members.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function rescanExplorerApi(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (authorized !== true) {
    res.json(messageHelper.errUnauthorizedMessage());
    return;
  }

  try {
    const blockheight = req?.params?.blockheight ?? req?.query?.blockheight;
    const rawRescan = req?.params?.rescanapps ?? req?.query?.rescanapps ?? false;

    const from = await rescanExplorer({
      blockheight,
      rescanGlobalApps: serviceHelper.ensureBoolean(rawRescan),
    });

    res.json(messageHelper.createSuccessMessage(`Explorer rescan from blockheight ${from} initiated`));
  } catch (error) {
    log.error(error);
    res.json(messageHelper.createErrorMessage(error.message, error.name, error.code));
  }
}

/**
 * To get if explorer is synced.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function isExplorerSynced(req, res) {
  const resMessage = messageHelper.createDataMessage(isSynced);
  res.json(resMessage);
}

// testing purposes
function setIsInInitiationOfBP(value) {
  isInInitiationOfBP = value;
}

// testing purposes
function setZelAppSpecsMigrationDone(value) {
  zelAppSpecsMigrationDone = value;
}

// Registered at require time so the subscription service opens its socket with these
// already attached. A topic the daemon does not publish simply never delivers, and the
// scan falls back to its own timer.
reorgSource.onReorg(handleChainReorg);

daemonSubscriptionService.subscribe(daemonSubscriptionService.TOPICS.hashBlockHeight, {
  onMessage: (decoded) => {
    // Handlers dispatch synchronously in registration order, and this one
    // registers at require time — before chainTipSource. The drain reads the
    // cached daemon height, so record the height this message itself carries
    // FIRST, or the scan compares against the pre-block tip, returns without
    // scanning, and nothing re-arms in push mode.
    daemonServiceMiscRpcs.recordChainTip(decoded.height);
    onNewBlock(decoded.height);
  },
});

module.exports = {
  initiateBlockProcessor,
  processOneBlock,
  reindexExplorer,
  reindexExplorerApi,
  rescanExplorer,
  rescanExplorerApi,
  stopBlockProcessing,
  stopBlockProcessingApi,
  restartBlockProcessing,
  restartBlockProcessingApi,
  blockInFlight,
  getBlockEmitter,
  onNewBlock,
  requestScan,
  scanning,
  startScanning,
  stopScanning,
  handleChainReorg,

  // exports for testing purposes
  bootstrapSoftForks,
  bootstrapAppHashes,
  getPriceSpecForHeight,
  processBootstrapTx,
  getVerboseBlock,
  decodeMessage,
  processInsight,
  setIsInInitiationOfBP,
  setZelAppSpecsMigrationDone,
  isOracleSigner,
  isMessageAuthority,

  isExplorerSynced,
};
