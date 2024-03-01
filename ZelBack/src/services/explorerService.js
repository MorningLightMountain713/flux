const config = require('config');
const { LRUCache } = require('lru-cache');

const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const dbHelper = require('./dbHelper');
const verificationHelper = require('./verificationHelper');
const messageHelper = require('./messageHelper');
const daemonServiceMiscRpcs = require('./daemonService/daemonServiceMiscRpcs');
const daemonServiceAddressRpcs = require('./daemonService/daemonServiceAddressRpcs');
const daemonServiceTransactionRpcs = require('./daemonService/daemonServiceTransactionRpcs');
const daemonServiceControlRpcs = require('./daemonService/daemonServiceControlRpcs');
const daemonServiceBlockchainRpcs = require('./daemonService/daemonServiceBlockchainRpcs');
const appsService = require('./appsService');
const benchmarkService = require('./benchmarkService');

const coinbaseFusionIndexCollection = config.database.daemon.collections.coinbaseFusionIndex; // fusion
const utxoIndexCollection = config.database.daemon.collections.utxoIndex;
const appsHashesCollection = config.database.daemon.collections.appsHashes;
const addressTransactionIndexCollection = config.database.daemon.collections.addressTransactionIndex;
const scannedHeightCollection = config.database.daemon.collections.scannedHeight;
const fluxTransactionCollection = config.database.daemon.collections.fluxTransactions;
const chainParamsMessagesCollection = config.database.chainparams.collections.chainMessages;

// cache for nodes
const LRUoptions = {
  max: 20000, // store 20k of nodes value forever, no ttl
};

const nodeCollateralCache = new LRUCache(LRUoptions);
// updateFluxAppsPeriod can be between every 4 to 9 blocks
const updateFluxAppsPeriod = Math.floor(Math.random() * 6 + 4);

// Block Processor Controller
let bpc = new serviceHelper.FluxController();
let blockProcessorTimeout = null;

/**
 * To return the sender's transaction info from the daemon service.
 * @param {string} txid Transaction ID.
 * @returns {object} Transaction obtained from transaction cache.
 */
async function getSenderTransactionFromDaemon(txid) {
  const verbose = 1;
  const req = {
    params: {
      txid,
      verbose,
    },
  };

  const txContent = await daemonServiceTransactionRpcs.getRawTransaction(req);
  if (txContent.status === 'success') {
    const sender = txContent.data;
    return sender;
  }
  throw txContent.data;
}

/**
 * To return sender for a transaction.
 * @param {string} txid Transaction ID.
 * @param {number} vout Transaction output number (vector of outputs).
 * @returns {object} Document.
 */
async function getSenderForFluxTxInsight(txid, vout) {
  const nodeCacheExists = nodeCollateralCache.get(`${txid}-${vout}`);
  if (nodeCacheExists) {
    return nodeCacheExists;
  }
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const queryFluxTx = {
    collateralHash: txid,
    collateralIndex: vout,
  };
  // we do not need other data as we are just asking what the sender address is.
  const projectionFluxTx = {
    projection: {
      _id: 0,
      collateralHash: 1,
      zelAddress: 1,
      lockedAmount: 1,
    },
  };
  // find previous flux transaction that
  const txContent = await dbHelper.findOneInDatabase(database, fluxTransactionCollection, queryFluxTx, projectionFluxTx);
  if (!txContent) {
    // ask blockchain for the transaction
    const verbose = 1;
    const req = {
      params: {
        txid,
        verbose,
      },
    };
    const transaction = await daemonServiceTransactionRpcs.getRawTransaction(req);
    if (transaction.status === 'success' && transaction.data.vout && transaction.data.vout[0]) {
      const transactionOutput = transaction.data.vout.find((txVout) => +txVout.n === +vout);
      if (transactionOutput) {
        const adjustedTxContent = {
          txid,
          address: transactionOutput.scriptPubKey.addresses[0],
          satoshis: transactionOutput.valueSat,
        };
        nodeCollateralCache.set(`${txid}-${vout}`, adjustedTxContent);
        return adjustedTxContent;
      }
    }
  }
  if (!txContent) {
    log.warn(`Transaction ${txid} ${vout} was not found anywhere. Uncomplete tx!`);
    const adjustedTxContent = {
      txid,
      address: undefined,
      satoshis: undefined,
    };
    return adjustedTxContent;
  }
  nodeCollateralCache.set(`${txid}-${vout}`, txContent);
  const sender = txContent;
  return sender;
}

/**
 * To return the sender address of a transaction (from Flux cache or database).
 * @param {string} txid Transaction ID.
 * @param {number} vout Transaction output number (vector of outputs).
 * @returns {object} Document.
 */
async function getSenderForFluxTx(txid, vout) {
  const nodeCacheExists = nodeCollateralCache.get(`${txid}-${vout}`);
  if (nodeCacheExists) {
    return nodeCacheExists;
  }
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const query = {
    txid,
    vout,
  };
  // we do not need other data as we are just asking what the sender address is.
  const projection = {
    projection: {
      _id: 0,
      txid: 1,
      // vout: 1,
      // height: 1,
      address: 1,
      satoshis: 1,
      // scriptPubKey: 1,
      // coinbase: 1,
    },
  };

  // find the utxo from global utxo list
  let txContent = await dbHelper.findOneInDatabase(database, utxoIndexCollection, query, projection);
  if (!txContent) {
    log.info(`Transaction ${txid} ${vout} not found in database. Falling back to previous Flux transaction`);
    const queryFluxTx = {
      collateralHash: txid,
      collateralIndex: vout,
    };
    // we do not need other data as we are just asking what the sender address is.
    const projectionFluxTx = {
      projection: {
        _id: 0,
        collateralHash: 1,
        zelAddress: 1,
        lockedAmount: 1,
      },
    };
    // find previous flux transaction that
    txContent = await dbHelper.findOneInDatabase(database, fluxTransactionCollection, queryFluxTx, projectionFluxTx);
  }
  if (!txContent) {
    log.warn(`Transaction ${txid} ${vout} was not found anywhere. Uncomplete tx!`);
    const adjustedTxContent = {
      txid: undefined,
      address: undefined,
      satoshis: undefined,
    };
    return adjustedTxContent;
  }
  const sender = txContent;
  nodeCollateralCache.set(`${txid}-${vout}`, txContent);
  return sender;
}

/**
 * To return the sender address of a transaction (from Flux database or Blockchain).
 * @param {string} txid Transaction ID.
 * @param {number} vout Transaction output number (vector of outputs).
 * @returns {object} Document.
 */
async function getSender(txid, vout) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const query = { $and: [{ txid }, { vout }] };
  // we do not need other data as we are just asking what the sender address is.
  const projection = {
    projection: {
      _id: 0,
      // txid: 1,
      // vout: 1,
      // height: 1,
      address: 1,
      // satoshis: 1,
      // scriptPubKey: 1,
      // coinbase: 1,
    },
  };

  // find and delete the utxo from global utxo list
  const txContent = await dbHelper.findOneAndDeleteInDatabase(database, utxoIndexCollection, query, projection);
  if (!txContent.value) {
    // we are spending it anyway so it wont affect users balance
    log.info(`Transaction ${txid} ${vout} not found in database. Falling back to blockchain data`);
    const sender = await getSenderTransactionFromDaemon(txid);
    const senderData = sender.vout[vout];
    const simpletxContent = {
      // txid,
      // vout,
      // height: sender.height,
      address: senderData.scriptPubKey.addresses[0], // always exists as it is utxo.
      // satoshis: senderData.valueSat,
      // scriptPubKey: senderData.scriptPubKey.hex,
    };
    return simpletxContent;
  }
  const sender = txContent.value;
  return sender;
}

/**
 * To process a transaction. This checks that a transaction is UTXO and if so, stores it to the database to include the sender.
 * @param {object} txContent Transaction content.
 * @param {number} height Blockchain height.
 * @returns {object} Transaction detail.
 */
async function processTransaction(txContent, height) {
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  let transactionDetail = {};
  transactionDetail = txContent;
  if (txContent.version < 5 && txContent.version > 0) {
    // if transaction has no vouts, it cannot be an utxo. Do not store it.
    await Promise.all(transactionDetail.vout.map(async (vout, index) => {
      // we need only utxo related information
      let coinbase = false;
      if (transactionDetail.vin[0]) {
        if (transactionDetail.vin[0].coinbase) {
          coinbase = true;
        }
      }
      // account for messages
      if (vout.scriptPubKey.addresses) {
        const utxoDetail = {
          txid: txContent.txid,
          vout: index,
          height,
          address: vout.scriptPubKey.addresses[0],
          satoshis: vout.valueSat,
          scriptPubKey: vout.scriptPubKey.hex,
          coinbase,
        };
        // put the utxo to our mongoDB utxoIndex collection.
        await dbHelper.insertOneToDatabase(database, utxoIndexCollection, utxoDetail);
        // track coinbase txs for additional rewards on paralel chains for fusion
        if (coinbase && height > 825000) { // 825000 is snapshot, 825001 is first block eligible for rewards on other chains
          await dbHelper.insertOneToDatabase(database, coinbaseFusionIndexCollection, utxoDetail);
        }
      }
    }));

    // fetch senders from our mongoDatabase
    const sendersToFetch = [];

    txContent.vin.forEach((vin) => {
      if (!vin.coinbase) {
        // we need an address who sent those coins and amount of it.
        sendersToFetch.push(vin);
      }
    });

    const senders = []; // Can put just value and address
    // parallel reading causes daemon to fail with error 500
    // await Promise.all(sendersToFetch.map(async (sender) => {
    //   const senderInformation = await getSender(sender.txid, sender.vout);
    //   senders.push(senderInformation);
    // }));
    // use sequential
    // eslint-disable-next-line no-restricted-syntax
    for (const sender of sendersToFetch) {
      // eslint-disable-next-line no-await-in-loop
      const senderInformation = await getSender(sender.txid, sender.vout);
      senders.push(senderInformation);
    }
    transactionDetail.senders = senders;
  }
  // transactionDetail now contains senders. So then going through senders and vouts when generating indexes.
  return transactionDetail;
}

/**
 * To process a block of transactions.
 * @param {object[]} txs Array of transaction content objects.
 * @param {number} height Blockchain height.
 * @returns {Promise<object[]>} Array of transaction detail objects.
 */
async function processBlockTransactions(txs, height) {
  const transactions = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const transaction of txs) {
    // eslint-disable-next-line no-await-in-loop
    const txContent = await processTransaction(transaction, height);
    transactions.push(txContent);
    // eslint-disable-next-line no-await-in-loop
    await serviceHelper.delay(75); // delay of 75ms to not kill mongodb 800 transactions per minute.
  }
  return transactions;
}

/**
 * To get the details of a verbose block.
 * @param {(number|string)} heightOrHash Block height or block hash.
 * @param {number} verbosity Verbosity level.
 * @returns {object} Block data from block cache.
 */
async function getVerboseBlock(heightOrHash, verbosity = 2) {
  const req = {
    params: {
      hashheight: heightOrHash,
      verbosity,
    },
  };
  const blockInfo = await daemonServiceBlockchainRpcs.getBlock(req);
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

/**
 * To process soft fork messages and reactin upon observing one
 * @param {string} txid TXID of soft fork message occurance
 * @param {number} heightBlockchain height of soft fork message occurance
 * @param {string} message Already decoded message.
 */
async function processSoftFork(txid, height, message) {
  // let it throw to stop block processing
  const splittedMess = message.split('_');
  const version = splittedMess[0];
  const data = {
    txid,
    height,
    message,
    version,
  };
  log.info('New Soft Fork message received');
  log.info(`${txid}_${height}_${message}`);
  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.chainparams.database);
  const query = { txid }; // unique
  const update = { $set: data };
  const options = {
    upsert: true,
  };
  await dbHelper.updateOneInDatabase(database, chainParamsMessagesCollection, query, update, options);
}

/**
 * To process verbose block data for entry to Insight database.
 * @param {object} blockDataVerbose Verbose block data.
 * @param {string} database Database.
 */
async function processInsight(blockDataVerbose, database) {
  // get Block Deltas information
  const txs = blockDataVerbose.tx;
  const transactions = [];
  const appsTransactions = [];
  // go through each transaction in deltas
  // eslint-disable-next-line no-restricted-syntax
  for (const tx of txs) {
    if (tx.version < 5 && tx.version > 0) {
      let message = '';
      let isFluxAppMessageValue = 0;
      let isSenderFoundation = false;
      let isReceiverFounation = false;

      tx.vin.forEach((sender) => {
        if (sender.address === config.fluxapps.addressMultisig) { // coinbase vin.addr is undefined
          isSenderFoundation = true;
        }
      });

      tx.vout.forEach((receiver) => {
        if (receiver.scriptPubKey.addresses) { // count for messages
          if (receiver.scriptPubKey.addresses[0] === config.fluxapps.address || (receiver.scriptPubKey.addresses[0] === config.fluxapps.addressMultisig && blockDataVerbose.height >= config.fluxapps.appSpecsEnforcementHeights[6])
            || (receiver.scriptPubKey.addresses[0] === config.fluxapps.addressDevelopment && config.development)) { // DEVELOPMENT MODE
            // it is an app message. Get Satoshi amount
            isFluxAppMessageValue += receiver.valueSat;
          }
          if (receiver.scriptPubKey.addresses[0] === config.fluxapps.addressMultisig) {
            isReceiverFounation = true;
          }
        }
        if (receiver.scriptPubKey.asm) {
          message = decodeMessage(receiver.scriptPubKey.asm);
        }
      });
      if (isFluxAppMessageValue) {
        // eslint-disable-next-line no-await-in-loop
        const appPrices = await appsService.getChainParamsPriceUpdates();
        const intervals = appPrices.filter((i) => i.height < blockDataVerbose.height);
        const priceSpecifications = intervals[intervals.length - 1]; // filter does not change order
        // MAY contain App transaction. Store it.
        if (isFluxAppMessageValue >= (priceSpecifications.minPrice * 1e8) && message.length === 64 && blockDataVerbose.height >= config.fluxapps.epochstart) { // min of X flux had to be paid for us bothering checking
          const appTxRecord = {
            txid: tx.txid, height: blockDataVerbose.height, hash: message, value: isFluxAppMessageValue, message: false, // message is boolean saying if we already have it stored as permanent message
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
              appsService.checkAndRequestApp(message, tx.txid, blockDataVerbose.height, isFluxAppMessageValue);
            } else {
              throw new Error(`Found an existing hash app ${serviceHelper.ensureString(result)}`);
            }
          } catch (error) {
            log.error(`Hash ${message} already exists. Not adding at height ${blockDataVerbose.height}`);
            log.error(error);
          }
        }
      }
      // check for softForks
      const isSoftFork = isSenderFoundation && isReceiverFounation;
      if (isSoftFork) {
        // eslint-disable-next-line no-await-in-loop
        await processSoftFork(tx.txid, blockDataVerbose.height, message);
      }
    } else if (tx.version === 5) {
      // todo include to daemon better information about hash and index and preferably address associated
      const collateralHash = tx.txhash;
      const collateralIndex = tx.outidx;
      // eslint-disable-next-line no-await-in-loop
      const senderInfo = await getSenderForFluxTxInsight(collateralHash, collateralIndex);
      const fluxTxData = {
        txid: tx.txid,
        version: tx.version,
        type: tx.type,
        updateType: tx.update_type,
        ip: tx.ip,
        benchTier: tx.benchmark_tier,
        collateralHash,
        collateralIndex,
        zelAddress: senderInfo.address || senderInfo.zelAddress,
        lockedAmount: senderInfo.satoshis || senderInfo.lockedAmount,
        height: blockDataVerbose.height,
      };

      transactions.push(fluxTxData);
    }
  }
  const options = {
    ordered: false, // If false, continue with remaining inserts when one fails.
  };
  if (appsTransactions.length > 0) {
    await dbHelper.insertManyToDatabase(database, appsHashesCollection, appsTransactions, options);
  }
  if (transactions.length > 0) {
    await dbHelper.insertManyToDatabase(database, fluxTransactionCollection, transactions, options);
  }
}

/**
 * To process verbose block data for entry to database.
 * @param {object} blockDataVerbose Verbose block data.
 * @param {string} database Database.
 */
async function processStandard(blockDataVerbose, database) {
  // get Block transactions information
  const transactions = await processBlockTransactions(blockDataVerbose.tx, blockDataVerbose.height);
  // now we have verbose transactions of the block extended for senders - object of
  // utxoDetail = { txid, vout, height, address, satoshis, scriptPubKey )
  // and can create addressTransactionIndex.
  // amount in address can be calculated from utxos. We do not need to store it.
  await Promise.all(transactions.map(async (tx) => {
    // normal transactions
    if (tx.version < 5 && tx.version > 0) {
      let message = '';
      let isFluxAppMessageValue = 0;
      let isSenderFoundation = false;
      let isReceiverFounation = false;

      const addresses = [];
      tx.senders.forEach((sender) => {
        addresses.push(sender.address);
        if (sender.address === config.fluxapps.addressMultisig) {
          isSenderFoundation = true;
        }
      });
      tx.vout.forEach((receiver) => {
        if (receiver.scriptPubKey.addresses) { // count for messages
          addresses.push(receiver.scriptPubKey.addresses[0]);
          if (receiver.scriptPubKey.addresses[0] === config.fluxapps.address || (receiver.scriptPubKey.addresses[0] === config.fluxapps.addressMultisig && blockDataVerbose.height >= config.fluxapps.appSpecsEnforcementHeights[6])) {
            // it is an app message. Get Satoshi amount
            isFluxAppMessageValue += receiver.valueSat;
          }
          if (receiver.scriptPubKey.addresses[0] === config.fluxapps.addressMultisig) {
            isReceiverFounation = true;
          }
        }
        if (receiver.scriptPubKey.asm) {
          message = decodeMessage(receiver.scriptPubKey.asm);
        }
      });
      const addressesOK = [...new Set(addresses)];
      const transactionRecord = { txid: tx.txid, height: blockDataVerbose.height };
      // update addresses from addressesOK array in our database. We need blockheight there too. transac
      await Promise.all(addressesOK.map(async (address) => {
        // maximum of 10000 txs per address in one document
        const query = { address, count: { $lt: 10000 } };
        const update = { $set: { address }, $push: { transactions: transactionRecord }, $inc: { count: 1 } };
        const options = {
          upsert: true,
        };
        await dbHelper.updateOneInDatabase(database, addressTransactionIndexCollection, query, update, options);
      }));
      if (isFluxAppMessageValue) {
        const appPrices = await appsService.getChainParamsPriceUpdates();
        const intervals = appPrices.filter((i) => i.height < blockDataVerbose.height);
        const priceSpecifications = intervals[intervals.length - 1]; // filter does not change order
        // MAY contain App transaction. Store it.
        if (isFluxAppMessageValue >= (priceSpecifications.minPrice * 1e8) && message.length === 64 && blockDataVerbose.height >= config.fluxapps.epochstart) { // min of 1 flux had to be paid for us bothering checking
          const appTxRecord = {
            txid: tx.txid, height: blockDataVerbose.height, hash: message, value: isFluxAppMessageValue, message: false, // message is boolean saying if we already have it stored as permanent message
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
            const result = await dbHelper.findOneInDatabase(database, appsHashesCollection, querySearch, projectionSearch); // this search can be later removed if nodes rescan apps and reconstruct the index for unique
            if (!result) {
              await dbHelper.insertOneToDatabase(database, appsHashesCollection, appTxRecord);
              appsService.checkAndRequestApp(message, tx.txid, blockDataVerbose.height, isFluxAppMessageValue);
            } else {
              throw new Error(`Found an existing hash app ${serviceHelper.ensureString(result)}`);
            }
          } catch (error) {
            log.error(`Hash ${message} already exists. Not adding at height ${blockDataVerbose.height}`);
            log.error(error);
          }
        }
      }
      // check for softForks
      const isSoftFork = isSenderFoundation && isReceiverFounation;
      if (isSoftFork) {
        await processSoftFork(tx.txid, blockDataVerbose.height, message);
      }
    }
    // tx version 5 are flux transactions. Put them into flux
    if (tx.version === 5) {
      // todo include to daemon better information about hash and index and preferably address associated
      const collateral = tx.collateral_output;
      const partialCollateralHash = collateral.split('COutPoint(')[1].split(', ')[0];
      const collateralIndex = Number(collateral.split(', ')[1].split(')')[0]);
      const senderInfo = await getSenderForFluxTx(partialCollateralHash, collateralIndex);
      const fluxTxData = {
        txid: tx.txid,
        version: tx.version,
        type: tx.type,
        updateType: tx.update_type,
        ip: tx.ip,
        benchTier: tx.benchmark_tier,
        collateralHash: senderInfo.txid || senderInfo.collateralHash || partialCollateralHash,
        collateralIndex,
        zelAddress: senderInfo.address || senderInfo.zelAddress,
        lockedAmount: senderInfo.satoshis || senderInfo.lockedAmount,
        height: blockDataVerbose.height,
      };
      await dbHelper.insertOneToDatabase(database, fluxTransactionCollection, fluxTxData);
    }
  }));
}

/**
 * To restore database to specified block height.
 * @param {number} height Block height.
 * @param {boolean} rescanGlobalApps Value set to false on function call.
 * @returns {Promise<boolean>} Value set to true after database is restored.
 */
async function restoreDatabaseToBlockheightState(height, rescanGlobalApps = false) {
  if (!height) {
    throw new Error('No blockheight for restoring provided');
  }
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.daemon.database);

  const query = { height: { $gt: height } };
  const queryForAddresses = {}; // we need to remove those transactions in transactions field that have height greater than height
  const queryForAddressesDeletion = { transactions: { $exists: true, $size: 0 } };
  const projection = { $pull: { transactions: { height: { $gt: height } } } };

  // restore utxoDatabase collection
  await dbHelper.removeDocumentsFromCollection(database, utxoIndexCollection, query);
  // restore coinbaseDatabase collection
  await dbHelper.removeDocumentsFromCollection(database, coinbaseFusionIndexCollection, query);
  // restore addressTransactionIndex collection
  // remove transactions with height bigger than our scanned height
  await dbHelper.updateInDatabase(database, addressTransactionIndexCollection, queryForAddresses, projection);
  // remove addresses with 0 transactions
  await dbHelper.removeDocumentsFromCollection(database, addressTransactionIndexCollection, queryForAddressesDeletion);
  // restore fluxTransactions collection
  await dbHelper.removeDocumentsFromCollection(database, fluxTransactionCollection, query);
  // restore appsHashes collection
  await dbHelper.removeDocumentsFromCollection(database, appsHashesCollection, query);
  log.info('Rescanning Blockchain Parameters!');
  const databaseGlobal = dbopen.db(config.database.appsglobal.database);
  const databaseUpdates = dbopen.db(config.database.chainparams.database);
  await dbHelper.removeDocumentsFromCollection(databaseUpdates, chainParamsMessagesCollection, query);
  if (rescanGlobalApps === true) {
    log.info('Rescanning Apps!');
    await dbHelper.removeDocumentsFromCollection(databaseGlobal, config.database.appsglobal.collections.appsMessages, query);
    await dbHelper.removeDocumentsFromCollection(databaseGlobal, config.database.appsglobal.collections.appsInformation, query);
  }
  log.info('Rescan completed');
  return true;
}

/**
 * @returns {Promise<void>}
 */
async function prepareExplorerDatabase(con, database, reindexOrRescanGlobalApps) {
  log.info('Preparing daemon collections');
  const result = await dbHelper.dropCollection(database, utxoIndexCollection).catch((error) => {
    if (error.message !== 'ns not found') {
      throw error;
    }
  });
  const resultB = await dbHelper.dropCollection(database, addressTransactionIndexCollection).catch((error) => {
    if (error.message !== 'ns not found') {
      throw error;
    }
  });
  const resultC = await dbHelper.dropCollection(database, fluxTransactionCollection).catch((error) => {
    if (error.message !== 'ns not found') {
      throw error;
    }
  });
  const resultD = await dbHelper.dropCollection(database, appsHashesCollection).catch((error) => {
    if (error.message !== 'ns not found') {
      throw error;
    }
  });
  const resultFusion = await dbHelper.dropCollection(database, coinbaseFusionIndexCollection).catch((error) => {
    if (error.message !== 'ns not found') {
      throw error;
    }
  });
  const databaseUpdates = con.db(config.database.chainparams.database);
  const resultChainParams = await dbHelper.dropCollection(databaseUpdates, chainParamsMessagesCollection).catch((error) => {
    if (error.message !== 'ns not found') {
      throw error;
    }
  });
  log.info(result, resultB, resultC, resultD, resultFusion, resultChainParams);

  await database.collection(utxoIndexCollection).createIndex({ txid: 1, vout: 1 }, { name: 'query for getting utxo', unique: true });
  await database.collection(utxoIndexCollection).createIndex({ txid: 1, vout: 1, satoshis: 1 }, { name: 'query for getting utxo for zelnode tx', unique: true });
  await database.collection(utxoIndexCollection).createIndex({ address: 1 }, { name: 'query for addresses utxo' });
  await database.collection(utxoIndexCollection).createIndex({ scriptPubKey: 1 }, { name: 'query for scriptPubKey utxo' });
  await database.collection(coinbaseFusionIndexCollection).createIndex({ txid: 1, vout: 1 }, { name: 'query for getting coinbase fusion utxo', unique: true });
  await database.collection(coinbaseFusionIndexCollection).createIndex({ txid: 1, vout: 1, satoshis: 1 }, { name: 'query for getting coinbase fusion utxo for zelnode tx', unique: true });
  await database.collection(coinbaseFusionIndexCollection).createIndex({ address: 1 }, { name: 'query for addresses coinbase fusion utxo' });
  await database.collection(coinbaseFusionIndexCollection).createIndex({ scriptPubKey: 1 }, { name: 'query for scriptPubKey coinbase fusion utxo' });
  await database.collection(addressTransactionIndexCollection).createIndex({ address: 1 }, { name: 'query for addresses transactions' });
  await database.collection(addressTransactionIndexCollection).createIndex({ address: 1, count: 1 }, { name: 'query for addresses transactions with count' });
  await database.collection(fluxTransactionCollection).createIndex({ ip: 1 }, { name: 'query for getting list of zelnode txs associated to IP address' });
  await database.collection(fluxTransactionCollection).createIndex({ zelAddress: 1 }, { name: 'query for getting list of zelnode txs associated to ZEL address' });
  await database.collection(fluxTransactionCollection).createIndex({ tier: 1 }, { name: 'query for getting list of zelnode txs according to benchmarking tier' });
  await database.collection(fluxTransactionCollection).createIndex({ type: 1 }, { name: 'query for getting all zelnode txs according to type of transaction' });
  await database.collection(fluxTransactionCollection).createIndex({ collateralHash: 1, collateralIndex: 1 }, { name: 'query for getting list of zelnode txs associated to specific collateral' });
  await database.collection(appsHashesCollection).createIndex({ txid: 1 }, { name: 'query for getting txid' });
  await database.collection(appsHashesCollection).createIndex({ height: 1 }, { name: 'query for getting height' });
  await database.collection(appsHashesCollection).createIndex({ hash: 1 }, { name: 'query for getting app hash', unique: true }).catch((error) => {
    // 5501c7dd6516c3fc2e68dee8d4fdd20d92f57f8cfcdc7b4fcbad46499e43ed6f
    log.error('Expected throw on index creation as of new uniquness. Do not remove this check until all nodes have rebuild apps data');
    log.error(error);
  }); // has to be unique!
  await database.collection(appsHashesCollection).createIndex({ message: 1 }, { name: 'query for getting app hashes depending if we have message' });
  await databaseUpdates.collection(chainParamsMessagesCollection).createIndex({ txid: 1 }, { name: 'query for getting txid of some chain parameters update message' });
  await databaseUpdates.collection(chainParamsMessagesCollection).createIndex({ height: 1 }, { name: 'query for getting height of some chain parameters update message' });
  await databaseUpdates.collection(chainParamsMessagesCollection).createIndex({ message: 1 }, { name: 'query for getting message of some chain parameters update message' });
  await databaseUpdates.collection(chainParamsMessagesCollection).createIndex({ version: 1 }, { name: 'query for getting version of some chain parameters update message' });

  const databaseGlobal = con.db(config.database.appsglobal.database);
  log.info('Preparing apps collections');
  if (reindexOrRescanGlobalApps === true) {
    const resultE = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsMessages).catch((error) => {
      if (error.message !== 'ns not found') {
        throw error;
      }
    });
    const resultF = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsInformation).catch((error) => {
      if (error.message !== 'ns not found') {
        throw error;
      }
    });
    const resultG = await dbHelper.dropCollection(databaseGlobal, config.database.appsglobal.collections.appsLocations).catch((error) => {
      if (error.message !== 'ns not found') {
        throw error;
      }
    });
    log.info(resultE, resultF, resultG);
  }
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ hash: 1 }, { name: 'query for getting zelapp message based on hash' }); // , unique: true
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ txid: 1 }, { name: 'query for getting zelapp message based on txid' });
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ height: 1 }, { name: 'query for getting zelapp message based on height' });
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'zelAppSpecifications.name': 1 }, { name: 'query for getting zelapp message based on zelapp specs name' }); // , unique: true
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'zelAppSpecifications.owner': 1 }, { name: 'query for getting zelapp message based on zelapp specs owner' });
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'zelAppSpecifications.repotag': 1 }, { name: 'query for getting zelapp message based on image' });
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'appSpecifications.name': 1 }, { name: 'query for getting app message based on zelapp specs name' }); // , unique: true
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'appSpecifications.owner': 1 }, { name: 'query for getting app message based on zelapp specs owner' });
  await databaseGlobal.collection(config.database.appsglobal.collections.appsMessages).createIndex({ 'appSpecifications.repotag': 1 }, { name: 'query for getting app message based on image' });
  await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ name: 1 }, { name: 'query for getting zelapp based on zelapp specs name' }); // , unique: true
  await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ owner: 1 }, { name: 'query for getting zelapp based on zelapp specs owner' });
  await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ repotag: 1 }, { name: 'query for getting zelapp based on image' });
  await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ height: 1 }, { name: 'query for getting zelapp based on last height update' }); // we need to know the height of app adjustment
  await databaseGlobal.collection(config.database.appsglobal.collections.appsInformation).createIndex({ hash: 1 }, { name: 'query for getting zelapp based on last hash' }); // , unique: true // we need to know the hash of the last message update which is the true identifier
  await database.collection(config.database.appsglobal.collections.appsLocations).createIndex({ name: 1 }, { name: 'query for getting zelapp location based on zelapp specs name' });
  await database.collection(config.database.appsglobal.collections.appsLocations).createIndex({ hash: 1 }, { name: 'query for getting zelapp location based on zelapp hash' });
  await database.collection(config.database.appsglobal.collections.appsLocations).createIndex({ ip: 1 }, { name: 'query for getting zelapp location based on ip' });
  await database.collection(config.database.appsglobal.collections.appsLocations).createIndex({ name: 1, ip: 1 }, { name: 'query for getting app based on ip and name' });
  await database.collection(config.database.appsglobal.collections.appsLocations).createIndex({ name: 1, ip: 1, broadcastedAt: 1 }, { name: 'query for getting app to ensure we possess a message' });
  // what if 2 app adjustment come in the same block?
  // log.info(resultE, resultF);
  log.info('Preparation done');
}

/**
 * To start the block processor.
 * @param {{restoreDatabase?: Boolean, deepRestore?: Boolean, reindexOrRescanGlobalApps?: Boolean}} options
 * -
 * - restoreDatabase True if database is to be restored
 * - deepRestore True if a deep restore is required.
 * - reindexOrRescanGlobalApps True if apps collections are to be reindexed.
 * @returns {Promise<void>}
 *
 * do a deepRestore of 100 blocks if daemon encounters an error (mostly flux daemon was down)
 * or if its initial start of flux use reindexGlobalApps with caution!!!
 */

async function setupBlockProcessor(options = {}) {
  if (bpc.aborted) return {};

  // if (bpc.aborted) throw new Error('This should never happen')

  bpc.lock.enable();

  const restoreDatabase = options.restoreDatabase !== false;
  const deepRestore = options.deepRestore !== false;
  const reindexOrRescanGlobalApps = options.deepRestore === true;

  const con = dbHelper.databaseConnection();
  const database = con.db(config.database.daemon.database);

  const query = { generalScannedHeight: { $gte: 0 } };
  const projection = {
    projection: {
      _id: 0,
      generalScannedHeight: 1,
    },
  };

  let scannedBlockHeight = 0;

  try {
    const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
    if (!syncStatus.data.synced) {
      return { delayMs: 2 * 60 * 1000 };
    }

    const currentHeight = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
    if (currentHeight && currentHeight.generalScannedHeight) {
      scannedBlockHeight = currentHeight.generalScannedHeight;
    }
    // fix for a node if they have corrupted global app list
    if (scannedBlockHeight >= config.fluxapps.epochstart) {
      const globalAppsSpecs = await appsService.getAllGlobalApplications(['height']); // already sorted from oldest lowest height to newest highest height
      if (globalAppsSpecs.length >= 2) {
        const defaultExpire = config.fluxapps.blocksLasting;
        const minBlockheightDifference = defaultExpire * 0.9; // it is highly unlikely that there was no app registration or an update for default of 2200 blocks ~3days
        const blockDifference = globalAppsSpecs[globalAppsSpecs.length - 1] - globalAppsSpecs[0]; // most recent app - oldest app
        if (blockDifference < minBlockheightDifference) {
          await appsService.reindexGlobalAppsInformation();
        }
      } else {
        await appsService.reindexGlobalAppsInformation();
      }
    }

    if (scannedBlockHeight === 0) {
      // rename this appropriately
      await prepareExplorerDatabase(con, database, reindexOrRescanGlobalApps);
    }

    if (scannedBlockHeight && restoreDatabase) {
      try {
        // adjust for initial reorg
        if (deepRestore) {
          log.info('Deep restoring of database...');
          scannedBlockHeight = Math.max(scannedBlockHeight - 100, 0);
          await restoreDatabaseToBlockheightState(scannedBlockHeight, reindexOrRescanGlobalApps);
          const queryHeight = { generalScannedHeight: { $gte: 0 } };
          const update = { $set: { generalScannedHeight: scannedBlockHeight } };
          await dbHelper.updateOneInDatabase(database, scannedHeightCollection, queryHeight, update, { upsert: true });
          log.info('Database restored OK');
        } else {
          log.info('Restoring database...');
          await restoreDatabaseToBlockheightState(scannedBlockHeight, reindexOrRescanGlobalApps);
          log.info('Database restored OK');
        }
      } catch (e) {
        log.error('Error restoring database!');
        return { delayMs: 15 * 60 * 1000 };
      }
    } else if (scannedBlockHeight > config.daemon.chainValidHeight) {
      const daemonGetChainTips = await daemonServiceBlockchainRpcs.getChainTips();
      if (daemonGetChainTips.status !== 'success') {
        log.error(daemonGetChainTips.data.message || daemonGetChainTips.data);
        return { delayMs: 15 * 60 * 1000 };
      }

      const reorganisations = daemonGetChainTips.data;
      // database can be off for up to 2 blocks compared to daemon
      const reorgDepth = scannedBlockHeight - 2;
      const reorgs = reorganisations.filter((reorg) => reorg.status === 'valid-fork' && reorg.height === reorgDepth);
      let rescanDepth = 0;
      // if more valid forks on the same height. Restore from the longest one
      reorgs.forEach((reorg) => {
        if (reorg.branchlen > rescanDepth) {
          rescanDepth = reorg.branchlen;
        }
      });

      if (rescanDepth > 0) {
        try {
          // restore rescanDepth + 2 more blocks back
          rescanDepth += 2;
          log.warn(`Potential chain reorganisation spotted at height ${reorgDepth}. Rescanning last ${rescanDepth} blocks...`);
          scannedBlockHeight = Math.max(scannedBlockHeight - rescanDepth, 0);
          await restoreDatabaseToBlockheightState(scannedBlockHeight, reindexOrRescanGlobalApps);
          const queryHeight = { generalScannedHeight: { $gte: 0 } };
          const update = { $set: { generalScannedHeight: scannedBlockHeight } };
          await dbHelper.updateOneInDatabase(database, scannedHeightCollection, queryHeight, update, { upsert: true });
          log.info('Database restored OK');
        } catch (e) {
          log.error(`Error restoring database!: ${e}`);
          return { delayMs: 15 * 60 * 1000 };
        }
      }
    }

    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();

    // if node is insight explorer based, we are only processing flux app messages
    if (isInsightExplorer && scannedBlockHeight < config.deterministicNodesStart - 1) {
      scannedBlockHeight = config.deterministicNodesStart - 1;
    }

    return { delayMs: 0, scannedBlockHeight, isInsightExplorer };
  } catch (error) {
    log.error(error);
    return { delayMs: 15 * 60 * 1000 };
  } finally {
    bpc.lock.disable();
  }
}

/**
 * To process block data for entry to Insight database.
 * @param {number} blockHeight Block height to fetch and process.
 * @param {mongodb.Db} database The Daemon database
 * @param {boolean} isInsightExplorer True if node is insight explorer based.
 * @returns {Promise<number>} Block confirmations
 */
async function processBlock(blockHeight, database, isInsightExplorer) {
  const currentBlock = await getVerboseBlock(blockHeight);
  if (currentBlock.height % 50 === 0) log.info(`Processing Explorer Block Height: ${currentBlock.height}`);

  if (isInsightExplorer) {
    await processInsight(currentBlock, database);
  } else {
    await processStandard(currentBlock, database);
  }

  if (blockHeight % config.fluxapps.expireFluxAppsPeriod === 0) {
    if (!isInsightExplorer) {
      const result = await dbHelper.collectionStats(database, utxoIndexCollection);
      const resultB = await dbHelper.collectionStats(database, addressTransactionIndexCollection);
      const resultFusion = await dbHelper.collectionStats(database, coinbaseFusionIndexCollection);
      log.info(`UTXO documents: ${result.size}, ${result.count}, ${result.avgObjSize}`);
      log.info(`ADDR documents: ${resultB.size}, ${resultB.count}, ${resultB.avgObjSize}`);
      log.info(`Fusion documents: ${resultFusion.size}, ${resultFusion.count}, ${resultFusion.avgObjSize}`);
    }
    const resultC = await dbHelper.collectionStats(database, fluxTransactionCollection);
    log.info(`FLUX documents: ${resultC.size}, ${resultC.count}, ${resultC.avgObjSize}`);
  }

  // this should run only when node is synced
  const newBlock = !(currentBlock.confirmations >= 2);
  if (newBlock) {
    if (blockHeight % config.fluxapps.expireFluxAppsPeriod === 0) {
      if (currentBlock.height >= config.fluxapps.epochstart) {
        appsService.expireGlobalApplications();
      }
    }
    if (blockHeight % config.fluxapps.removeFluxAppsPeriod === 0) {
      if (currentBlock.height >= config.fluxapps.epochstart) {
        appsService.checkAndRemoveApplicationInstance();
      }
    }
    if (blockHeight % updateFluxAppsPeriod === 0) {
      if (currentBlock.height >= config.fluxapps.epochstart) {
        appsService.reinstallOldApplications();
      }
    }
    if (currentBlock.height % config.fluxapps.reconstructAppMessagesHashPeriod === 0) {
      try {
        appsService.reconstructAppMessagesHashCollection();
        log.info('Validation of App Messages Hash Collection');
      } catch (error) {
        log.error(error);
      }
    }
    if (currentBlock.height % config.fluxapps.benchUpnpPeriod === 0) {
      try {
        benchmarkService.executeUpnpBench();
      } catch (error) {
        log.error(error);
      }
    }
  }

  // update scanned Height in scannedBlockHeightCollection
  const query = { generalScannedHeight: { $gte: 0 } };
  const update = { $set: { generalScannedHeight: blockHeight } };
  await dbHelper.updateOneInDatabase(database, scannedHeightCollection, query, update, { upsert: true });

  return currentBlock.confirmations;
}

/**
 * To process block data for entry to Insight database.
 * @param {number} blockHeight Block height.
 * @param {{blockHeight: number, isInsightExplorer?: Boolean}} options
 * @returns {Promise<[number, number]>} tuple containing ms to wait for next run, and the current height
 */
async function processBlocks(options) {
  if (bpc.aborted) return [0, 0];

  await bpc.lock.enable();

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.daemon.database);
  const isInsightExplorer = options.isInsightExplorer || false;

  let blockHeight = options.fromHeight || 1;

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    // this is the processed height
    return [2 * 60 * 1000, blockHeight - 1];
  }

  let confirmations = 0;
  confirmations = await processBlock(blockHeight, database, isInsightExplorer);

  while (confirmations > 1) {
    blockHeight += 1;
    // eslint-disable-next-line no-await-in-loop
    confirmations = await processBlock(blockHeight, database, isInsightExplorer);
  }

  const infoRes = await daemonServiceControlRpcs.getInfo();

  let daemonHeight = 0;
  if (infoRes.status === 'success') {
    daemonHeight = infoRes.data.blocks;
  }

  if (daemonHeight > blockHeight) {
    blockHeight += 1;
    await processBlock(blockHeight, database, isInsightExplorer);
  }

  bpc.lock.disable();

  // no more blocks to process
  return [5 * 1000, blockHeight];
}

// finally {
//   bpc.lock.disable();
//   // it was some other error that got us here
//   if (!bpc.aborted) {
//     setupBlockProcessor({ restoreDatabase: true });
//   }
// }
// return [0, blockHeight];

async function startBlockProcessor(options = {}) {
  const { delayMs, scannedBlockHeight, isInsightExplorer } = await setupBlockProcessor(options);

  if (bpc.aborted) return;

  if (delayMs) {
    blockProcessorTimeout = setTimeout(() => startBlockProcessor(options), delayMs);
    return;
  }
  // eslint-disable-next-line no-use-before-define
  loopProcessBlocks({ fromHeight: scannedBlockHeight + 1, isInsightExplorer });
}

async function loopProcessBlocks(options = {}) {
  let ms;
  let blockHeight;

  try {
    [ms, blockHeight] = await processBlocks(options);
  } catch (err) {
    if (err.message && err.message.includes('duplicate key')) {
      startBlockProcessor({ restoreDatabase: true, deepRestore: true });
    } else {
      startBlockProcessor({ restoreDatabase: true, deepRestore: false });
    }
    return;
  }

  if (bpc.aborted) return;

  const opts = { fromHeight: blockHeight + 1, isInsightExplorer: options.isInsightExplorer };
  blockProcessorTimeout = setTimeout(() => loopProcessBlocks(opts), ms);
}

/**
 * To get all UTXOs (unspent transaction outputs).
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAllUtxos(req, res) {
  try {
    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();
    if (isInsightExplorer) {
      throw new Error('Data unavailable. Deprecated');
    }
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const query = {};
    const projection = {
      projection: {
        _id: 0,
        txid: 1,
        vout: 1,
        height: 1,
        address: 1,
        satoshis: 1,
        scriptPubKey: 1,
        coinbase: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, utxoIndexCollection, query, projection);
    const resMessage = messageHelper.createDataMessage(results);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get all Fusion/Coinbase transactions.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAllFusionCoinbase(req, res) {
  try {
    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();
    if (isInsightExplorer) {
      throw new Error('Data unavailable. Deprecated');
    }
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const query = {};
    const projection = {
      projection: {
        _id: 0,
        txid: 1,
        vout: 1,
        height: 1,
        address: 1,
        satoshis: 1,
        scriptPubKey: 1,
        coinbase: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, coinbaseFusionIndexCollection, query, projection);
    const resMessage = messageHelper.createDataMessage(results);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get all Flux transactions.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAllFluxTransactions(req, res) {
  try {
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const query = {};
    const projection = {
      projection: {
        _id: 0,
        txid: 1,
        version: 1,
        type: 1,
        updateType: 1,
        ip: 1,
        benchTier: 1,
        collateralHash: 1,
        collateralIndex: 1,
        zelAddress: 1,
        fluxAddress: 1,
        lockedAmount: 1,
        height: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, fluxTransactionCollection, query, projection);
    results.forEach((rec) => {
      // eslint-disable-next-line no-param-reassign
      rec.fluxAddress = rec.fluxAddress || rec.zelAddress;
    });
    const resMessage = messageHelper.createDataMessage(results);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get all addresses with transactions.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAllAddressesWithTransactions(req, res) {
  try {
    // FIXME outputs all documents in the collection. We shall group same addresses. But this call is disabled and for testing purposes anyway
    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();
    if (isInsightExplorer) {
      throw new Error('Data unavailable. Deprecated');
    }
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const query = {};
    const projection = {
      projection: {
        _id: 0,
        transactions: 1,
        address: 1,
        count: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, addressTransactionIndexCollection, query, projection);
    const resMessage = messageHelper.createDataMessage(results);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get all addresses.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAllAddresses(req, res) {
  try {
    // FIXME outputs all documents in the collection. We shall group same addresses. But this call is disabled and for testing purposes anyway
    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();
    if (isInsightExplorer) {
      throw new Error('Data unavailable. Deprecated');
    }
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const variable = 'address';
    const results = await dbHelper.distinctDatabase(database, addressTransactionIndexCollection, variable);
    const resMessage = messageHelper.createDataMessage(results);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get all UTXOs for a specific address.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAddressUtxos(req, res) {
  try {
    let { address } = req.params; // we accept both help/command and help?command=getinfo
    address = address || req.query.address;
    if (!address) {
      throw new Error('No address provided');
    }
    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();
    if (isInsightExplorer) {
      const daemonRequest = {
        params: {
          address,
        },
        query: {},
      };
      const insightResult = await daemonServiceAddressRpcs.getSingleAddressUtxos(daemonRequest);
      const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
      const curHeight = syncStatus.data.height;
      const utxos = [];
      insightResult.data.forEach((utxo) => {
        const adjustedUtxo = {
          address: utxo.address,
          txid: utxo.txid,
          vout: utxo.outputIndex,
          height: utxo.height,
          satoshis: utxo.satoshis,
          scriptPubKey: utxo.script,
          confirmations: curHeight - utxo.height, // HERE DIFFERS, insight more compatible with zelcore as coinbase is spendable after 100
        };
        utxos.push(adjustedUtxo);
      });
      const resMessage = messageHelper.createDataMessage(utxos);
      res.json(resMessage);
    } else {
      const dbopen = dbHelper.databaseConnection();
      const database = dbopen.db(config.database.daemon.database);
      const query = { address };
      const projection = {
        projection: {
          _id: 0,
          txid: 1,
          vout: 1,
          height: 1,
          address: 1,
          satoshis: 1,
          scriptPubKey: 1,
          coinbase: 1, // HERE DIFFERS
        },
      };
      const results = await dbHelper.findInDatabase(database, utxoIndexCollection, query, projection);
      const resMessage = messageHelper.createDataMessage(results);
      res.json(resMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get UTXOs for a specific Fusion/Coinbase address.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAddressFusionCoinbase(req, res) {
  try {
    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();
    if (isInsightExplorer) {
      throw new Error('Data unavailable. Deprecated');
    }
    let { address } = req.params; // we accept both help/command and help?command=getinfo
    address = address || req.query.address;
    if (!address) {
      throw new Error('No address provided');
    }
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const query = { address };
    const projection = {
      projection: {
        _id: 0,
        txid: 1,
        vout: 1,
        height: 1,
        address: 1,
        satoshis: 1,
        scriptPubKey: 1,
        coinbase: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, coinbaseFusionIndexCollection, query, projection);
    const resMessage = messageHelper.createDataMessage(results);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get Flux transactions filtered by either IP address, collateral hash or Flux address.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getFilteredFluxTxs(req, res) {
  try {
    let { filter } = req.params; // we accept both help/command and help?command=getinfo
    filter = filter || req.query.filter;
    let query = {};
    if (!filter) {
      throw new Error('No filter provided');
    }
    if (filter.includes('.')) {
      // IP address case
      query = { ip: filter };
    } else if (filter.length === 64) {
      // collateralHash case
      query = { collateralHash: filter };
    } else if (filter.length >= 30 && filter.length < 38) {
      // flux address case
      query = { zelAddress: filter };
    } else {
      throw new Error('It is possible to only filter via IP address, Flux address and Collateral hash.');
    }
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const projection = {
      projection: {
        _id: 0,
        txid: 1,
        version: 1,
        type: 1,
        updateType: 1,
        ip: 1,
        benchTier: 1,
        collateralHash: 1,
        collateralIndex: 1,
        zelAddress: 1,
        fluxAddress: 1,
        lockedAmount: 1,
        height: 1,
      },
    };
    const results = await dbHelper.findInDatabase(database, fluxTransactionCollection, query, projection);
    results.forEach((rec) => {
      // eslint-disable-next-line no-param-reassign
      rec.fluxAddress = rec.fluxAddress || rec.zelAddress;
    });
    const resMessage = messageHelper.createDataMessage(results);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get transactions for a specific address.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAddressTransactions(req, res) {
  try {
    let { address } = req.params; // we accept both help/command and help?command=getinfo
    address = address || req.query.address;
    if (!address) {
      throw new Error('No address provided');
    }
    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();
    if (isInsightExplorer) {
      const daemonRequest = {
        params: {
          address,
        },
        query: {},
      };
      const insightResult = await daemonServiceAddressRpcs.getSingleAddresssTxids(daemonRequest);
      const txids = insightResult.data.reverse(); // from newest txid to lastest [{txid:'abc'}, {txid: 'efg'}]
      const txidsOK = [];
      txids.forEach((txid) => {
        txidsOK.push({
          txid,
        });
      });
      const resMessage = messageHelper.createDataMessage(txidsOK);
      res.json(resMessage);
    } else {
      const dbopen = dbHelper.databaseConnection();
      const database = dbopen.db(config.database.daemon.database);
      const query = { address };
      const distinct = 'transactions';
      const results = await dbHelper.distinctDatabase(database, addressTransactionIndexCollection, distinct, query);
      // sort by height, newest first
      // only return txids
      results.sort((a, b) => {
        if (a.height > b.height) return -1;
        if (a.height < b.height) return 1;
        return 0;
      });
      // eslint-disable-next-line no-param-reassign
      results.map((tx) => delete tx.height);
      // TODO FIX documentation.
      // now we have array of transactions txids only sorted from newest to latest [{txid}, {}...]
      const resMessage = messageHelper.createDataMessage(results);
      res.json(resMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get scanned block height.
 * @param {object} req Reqest.
 * @param {object} res Response.
 */
async function getScannedHeight(req, res) {
  try {
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.database.daemon.database);
    const query = { generalScannedHeight: { $gte: 0 } };
    const projection = {
      projection: {
        _id: 0,
        generalScannedHeight: 1,
      },
    };
    const result = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);
    if (!result) {
      throw new Error('Scanning not initiated');
    }
    const resMessage = messageHelper.createDataMessage(result);
    return res ? res.json(resMessage) : resMessage;
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    return res ? res.json(errMessage) : errMessage;
  }
}

async function stopBlockProcessor() {
  if (!bpc.aborted) {
    clearTimeout(blockProcessorTimeout);
    await bpc.abort();
    bpc = new serviceHelper.FluxController();
    blockProcessorTimeout = null;
  }
}

/**
 * To stop block processing. Only accessible by admins and Flux team members.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function stopBlockProcessorApi(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (authorized === true) {
    stopBlockProcessor();
  } else {
    const errMessage = messageHelper.errUnauthorizedMessage();
    res.json(errMessage);
  }
}

async function restartBlockProcessor() {
  await stopBlockProcessor();
  startBlockProcessor({ restoreDatabase: true });
}

/**
 * To restart block processing. Only accessible by admins and Flux team members.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function restartBlockProcessorApi(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (authorized === true) {
    restartBlockProcessor();
  } else {
    const errMessage = messageHelper.errUnauthorizedMessage();
    res.json(errMessage);
  }
}

async function reindexExplorer(reindexOrRescanGlobalApps) {
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.daemon.database);

  await stopBlockProcessor();

  const resultOfDropping = await dbHelper.dropCollection(database, scannedHeightCollection).catch((error) => {
    // ns not found = collection didn't exist
    if (error.message !== 'ns not found') {
      log.error(error);
      return false;
    }
    return true;
  });

  if (resultOfDropping) {
    startBlockProcessor({ restoreDatabase: true, deepRestore: false, reindexOrRescanGlobalApps }); // restore database and possibly do reindex of apps
    return null;
  }
  return { message: 'Collection dropping error' };
}

/**
 * To reindex Flux explorer database. Only accessible by admins and Flux team members.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function reindexExplorerApi(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (authorized !== true) {
    const errMessage = messageHelper.errUnauthorizedMessage();
    res.json(errMessage);
    return;
  }

  let { reindexapps } = req.params;
  reindexapps = reindexapps ?? req.query.rescanapps ?? false;
  reindexapps = serviceHelper.ensureBoolean(reindexapps);

  const error = await reindexExplorer(reindexapps);

  if (error) {
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
    return;
  }

  const message = messageHelper.createSuccessMessage('Explorer database reindex initiated');
  res.json(message);
}

/**
 * To rescan Flux explorer database from a specific block height. Only accessible by admins and Flux team members.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function rescanExplorer(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (authorized !== true) {
    const errMessage = messageHelper.errUnauthorizedMessage();
    res.json(errMessage);
    return;
  }

  // since what blockheight
  let { blockheight } = req.params; // we accept both help/command and help?command=getinfo
  blockheight = blockheight || req.query.blockheight;
  if (!blockheight) {
    const errMessage = messageHelper.createErrorMessage('No blockheight provided');
    res.json(errMessage);
  }
  blockheight = serviceHelper.ensureNumber(blockheight);
  const dbopen = dbHelper.databaseConnection();
  const database = dbopen.db(config.database.daemon.database);

  const query = { generalScannedHeight: { $gte: 0 } };
  const projection = {
    projection: {
      _id: 0,
      generalScannedHeight: 1,
    },
  };
  const currentHeight = await dbHelper.findOneInDatabase(database, scannedHeightCollection, query, projection);

  // this is ridiculous, just handle these here without wrapping in try / catch - don't need try at all.
  let errStr = '';
  if (!currentHeight) {
    errStr = 'No scanned height found';
  }
  if (currentHeight.generalScannedHeight <= blockheight) {
    errStr = 'Block height shall be lower than currently scanned';
  }
  if (blockheight < 0) {
    errStr = 'BlockHeight lower than 0';
  }

  if (errStr) {
    const errMessage = messageHelper.createErrorMessage(errStr);
    res.json(errMessage);
    return;
  }

  let { rescanapps } = req.params;
  rescanapps = rescanapps ?? req.query.rescanapps ?? false;
  rescanapps = serviceHelper.ensureBoolean(rescanapps);

  await stopBlockProcessor();

  const update = { $set: { generalScannedHeight: blockheight } };
  const options = {
    upsert: true,
  };
  // update scanned Height in scannedBlockHeightCollection
  await dbHelper.updateOneInDatabase(database, scannedHeightCollection, query, update, options);
  startBlockProcessor({ restoreDatabase: true, deepRestore: false, reindexOrRescanGlobalApps: rescanapps }); // restore database and possibly do rescan of apps
  const message = messageHelper.createSuccessMessage(`Explorer rescan from blockheight ${blockheight} initiated`);
  res.json(message);
}

/**
 * To get the Flux balance for a specific address.
 * @param {object} req Request.
 * @param {object} res Response.
 */
async function getAddressBalance(req, res) {
  try {
    let { address } = req.params; // we accept both help/command and help?command=getinfo
    address = address || req.query.address || '';
    if (!address) {
      throw new Error('No address provided');
    }
    const isInsightExplorer = daemonServiceMiscRpcs.isInsightExplorer();
    if (isInsightExplorer) {
      const daemonRequest = {
        params: {
          address,
        },
        query: {},
      };
      const insightResult = await daemonServiceAddressRpcs.getSingleAddressBalance(daemonRequest);
      const { balance } = insightResult.data;
      const resMessage = messageHelper.createDataMessage(balance);
      res.json(resMessage);
    } else {
      const dbopen = dbHelper.databaseConnection();
      const database = dbopen.db(config.database.daemon.database);
      const query = { address };
      const projection = {
        projection: {
          _id: 0,
          // txid: 1,
          // vout: 1,
          // height: 1,
          // address: 1,
          satoshis: 1,
          // scriptPubKey: 1,
          // coinbase: 1,
        },
      };
      const results = await dbHelper.findInDatabase(database, utxoIndexCollection, query, projection);
      let balance = 0;
      results.forEach((utxo) => {
        balance += utxo.satoshis;
      });
      const resMessage = messageHelper.createDataMessage(balance);
      res.json(resMessage);
    }
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

// // testing purposes
// function setBlockProccessingCanContinue(value) {
//   blockProccessingCanContinue = value;
// }

// // testing purposes
// function setIsInInitiationOfBP(value) {
//   isInInitiationOfBP = value;
// }

module.exports = {
  setupBlockProcessor,
  processBlocks,
  reindexExplorerApi,
  rescanExplorer,
  startBlockProcessor,
  stopBlockProcessorApi,
  stopBlockProcessor,
  restartBlockProcessorApi,
  getAllUtxos,
  getAllAddressesWithTransactions,
  getAllAddresses,
  getAllFluxTransactions,
  getAddressUtxos,
  getAddressTransactions,
  getAddressBalance,
  getFilteredFluxTxs,
  getScannedHeight,
  getAllFusionCoinbase,
  getAddressFusionCoinbase,

  // exports for testing puproses
  getSenderTransactionFromDaemon,
  getSenderForFluxTxInsight,
  getSenderForFluxTx,
  getSender,
  processBlockTransactions,
  getVerboseBlock,
  decodeMessage,
  processInsight,
  processTransaction,
  processStandard,
  restoreDatabaseToBlockheightState,
};
