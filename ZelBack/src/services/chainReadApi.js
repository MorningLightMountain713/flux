'use strict';

const config = require('config');

const log = require('../lib/log');
const daemonServiceAddressRpcs = require('./daemonService/daemonServiceAddressRpcs');
const daemonStatus = require('./daemonService/daemonStatus');
const dbHelper = require('./dbHelper');
const messageHelper = require('./messageHelper');

/**
 * Read-side chain queries.
 *
 * These are stateless: the address endpoints answer from the daemon's own address
 * index and the height endpoint reads the scan cursor. Nothing here shares state with
 * the block processor, which is why it lives apart from it.
 *
 * They are not bare pass-throughs — each reshapes the daemon's response into the
 * shape this API has always returned, and `getAddressUtxos` deliberately recomputes
 * confirmations rather than forwarding the daemon's.
 */

const scannedHeightCollection = config.get('database.daemon.collections.scannedHeight');

/**
 * To get all UTXOs for a specific address.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAddressUtxos(req, res) {
  try {
    let { address } = req?.params || {}; // we accept both help/command and help?command=getinfo
    address = address || req?.query?.address;
    if (!address) {
      throw new Error('No address provided');
    }
    const insightResult = await daemonServiceAddressRpcs.getSingleAddressUtxos(address);
    if (insightResult.reason) {
      res.json(messageHelper.messageOf(insightResult));
      return;
    }
    const syncStatus = daemonStatus.daemonSyncState();
    const curHeight = syncStatus.height;
    const utxos = [];
    insightResult.value.forEach((utxo) => {
      const adjustedUtxo = {
        address: utxo.address,
        txid: utxo.txid,
        vout: utxo.outputIndex,
        height: utxo.height,
        satoshis: utxo.satoshis,
        scriptPubKey: utxo.script,
        // Recomputed rather than passed through, so coinbase spendability matches
        // what Zelcore expects.
        confirmations: curHeight - utxo.height,
      };
      utxos.push(adjustedUtxo);
    });
    const resMessage = messageHelper.createDataMessage(utxos);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get transactions for a specific address.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAddressTransactions(req, res) {
  try {
    let { address } = req.params || {}; // we accept both help/command and help?command=getinfo
    address = address || req.query.address;
    if (!address) {
      throw new Error('No address provided');
    }
    const insightResult = await daemonServiceAddressRpcs.getSingleAddresssTxids(address);
    if (insightResult.reason) {
      res.json(messageHelper.messageOf(insightResult));
      return;
    }
    const txids = insightResult.value.reverse(); // newest first
    const txidsOK = [];
    txids.forEach((txid) => {
      txidsOK.push({
        txid,
      });
    });
    const resMessage = messageHelper.createDataMessage(txidsOK);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get the Flux balance for a specific address.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getAddressBalance(req, res) {
  try {
    let { address } = req.params; // we accept both help/command and help?command=getinfo
    address = address || req.query.address || '';
    if (!address) {
      throw new Error('No address provided');
    }
    const insightResult = await daemonServiceAddressRpcs.getSingleAddressBalance(address);
    if (insightResult.reason) {
      res.json(messageHelper.messageOf(insightResult));
      return;
    }
    const { balance } = insightResult.value;
    const resMessage = messageHelper.createDataMessage(balance);
    res.json(resMessage);
  } catch (error) {
    log.error(error);
    const errMessage = messageHelper.createErrorMessage(error.message, error.name, error.code);
    res.json(errMessage);
  }
}

/**
 * To get scanned block height.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getScannedHeight(req, res) {
  try {
    const dbopen = dbHelper.databaseConnection();
    const database = dbopen.db(config.get('database.daemon.database'));
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

module.exports = {
  getAddressBalance,
  getAddressTransactions,
  getAddressUtxos,
  getScannedHeight,
};
