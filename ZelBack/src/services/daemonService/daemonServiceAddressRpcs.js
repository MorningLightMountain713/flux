'use strict';

const serviceHelper = require('../serviceHelper');
const messageHelper = require('../messageHelper');
const daemonServiceUtils = require('./daemonServiceUtils');

let response = messageHelper.createErrorMessage();

/**
 * To get transaction IDs for specified address/es. Addresses, start and end required as parameters for RPC call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function getAddressTxids(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    const processedBody = serviceHelper.ensureObject(body);
    const { addresses, start, end } = processedBody;

    const options = {
      addresses,
    };

    if (start) {
      options.start = serviceHelper.ensureNumber(start);
    }
    if (end) {
      options.end = serviceHelper.ensureNumber(end);
    }

    const rpccall = 'getaddresstxids';
    const rpcparameters = [options];

    response = await daemonServiceUtils.executeCall(rpccall, rpcparameters);

    return res.json(response);
  });
}

/**
 * The transaction ids of one address, between two heights when given.
 * @param {string} address
 * @param {number|null} [start]
 * @param {number|null} [end]
 * @returns {Promise<{value: string[]|null, reason?: object}>}
 */
async function getSingleAddresssTxids(address, start = null, end = null) {
  const options = { addresses: [address] };
  if (start) options.start = start;
  if (end) options.end = end;
  return messageHelper.answerOf(await daemonServiceUtils.executeCall('getaddresstxids', [options]));
}

/**
 * GET /daemon/getaddresstxids/:address?/:start?/:end?
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getSingleAddresssTxidsAPI(req, res) {
  const address = req.params.address || req.query.address;
  const start = req.params.start || req.query.start;
  const end = req.params.end || req.query.end;
  res.json(messageHelper.messageOf(await getSingleAddresssTxids(
    address,
    start ? serviceHelper.ensureNumber(start) : null,
    end ? serviceHelper.ensureNumber(end) : null,
  )));
}

/**
 * To get balance of address/es. Addresses required as parameter for RPC call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function getAddressBalance(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    const processedBody = serviceHelper.ensureObject(body);
    const { addresses } = processedBody;

    const options = {
      addresses,
    };

    const rpccall = 'getaddressbalance';
    const rpcparameters = [options];

    response = await daemonServiceUtils.executeCall(rpccall, rpcparameters);

    return res.json(response);
  });
}

/**
 * The balance of one address.
 * @param {string} address
 * @returns {Promise<{value: object|null, reason?: object}>}
 */
async function getSingleAddressBalance(address) {
  return messageHelper.answerOf(await daemonServiceUtils.executeCall('getaddressbalance', [{ addresses: [address] }]));
}

/**
 * GET /daemon/getaddressbalance/:address?
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getSingleAddressBalanceAPI(req, res) {
  res.json(messageHelper.messageOf(await getSingleAddressBalance(req.params.address || req.query.address)));
}

/**
 * To get address deltas. Addresses, start, end and chain info required as parameters for RPC call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function getAddressDeltas(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    const processedBody = serviceHelper.ensureObject(body);
    const {
      addresses, start, end, chaininfo,
    } = processedBody;

    const options = {
      addresses,
    };

    if (start) {
      options.start = serviceHelper.ensureNumber(start);
    }
    if (end) {
      options.end = serviceHelper.ensureNumber(end);
    }

    if (chaininfo) {
      options.chainInfo = serviceHelper.ensureBoolean(chaininfo);
    }

    const rpccall = 'getaddressdeltas';
    const rpcparameters = [options];

    response = await daemonServiceUtils.executeCall(rpccall, rpcparameters);

    return res.json(response);
  });
}

/**
 * To get deltas for a single address. Address, start, end and chain info required as parameters for RPC call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function getSingleAddressDeltas(req, res) {
  let { address } = req.params;
  address = address || req.query.address;
  let { start } = req.params;
  start = start || req.query.start;
  let { end } = req.params;
  end = end || req.query.end;
  let { chaininfo } = req.params;
  chaininfo = chaininfo || req.query.chaininfo;

  const options = {
    addresses: [address],
  };

  if (start) {
    options.start = serviceHelper.ensureNumber(start);
  }
  if (end) {
    options.end = serviceHelper.ensureNumber(end);
  }

  if (chaininfo) {
    options.chainInfo = serviceHelper.ensureBoolean(chaininfo);
  }

  const rpccall = 'getaddressdeltas';
  const rpcparameters = [options];

  response = await daemonServiceUtils.executeCall(rpccall, rpcparameters);

  return res.json(response);
}

/**
 * To get UTXOs for multiple addresses. Addresses and chain info required as parameters for RPC call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function getAddressUtxos(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    const processedBody = serviceHelper.ensureObject(body);
    const {
      addresses, chainInfo,
    } = processedBody;

    const options = {
      addresses,
      chainInfo,
    };

    const rpccall = 'getaddressutxos';
    const rpcparameters = [options];

    response = await daemonServiceUtils.executeCall(rpccall, rpcparameters);

    return res.json(response);
  });
}

/**
 * The unspent outputs of one address, with the chain's state when chaininfo is
 * asked for.
 * @param {string} address
 * @param {*} [chaininfo]
 * @returns {Promise<{value: object[]|object|null, reason?: object}>}
 */
async function getSingleAddressUtxos(address, chaininfo) {
  return messageHelper.answerOf(await daemonServiceUtils.executeCall('getaddressutxos', [{ addresses: [address], chainInfo: chaininfo }]));
}

/**
 * GET /daemon/getaddressutxos/:address?/:chaininfo?
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getSingleAddressUtxosAPI(req, res) {
  const address = req.params.address || req.query.address;
  const chaininfo = req.params.chaininfo || req.query.chaininfo;
  res.json(messageHelper.messageOf(await getSingleAddressUtxos(address, chaininfo)));
}

/**
 * To get mempool (memory pool) for multiple addresses. Addresses required as parameter for RPC call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function getAddressMempool(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    const processedBody = serviceHelper.ensureObject(body);
    const {
      addresses,
    } = processedBody;

    const options = {
      addresses,
    };

    const rpccall = 'getaddressmempool';
    const rpcparameters = [options];

    response = await daemonServiceUtils.executeCall(rpccall, rpcparameters);

    return res.json(response);
  });
}

/**
 * To get mempool (memory pool) for a single address. Address required as parameter for RPC call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function getSingleAddressMempool(req, res) {
  let { address } = req.params;
  address = address || req.query.address;

  const options = {
    addresses: [address],
  };

  const rpccall = 'getaddressmempool';
  const rpcparameters = [options];

  response = await daemonServiceUtils.executeCall(rpccall, rpcparameters);

  return res.json(response);
}

module.exports = {
  getAddressTxids, // insight explorer
  getSingleAddresssTxids,
  getSingleAddresssTxidsAPI,
  getAddressBalance, // insight explorer
  getSingleAddressBalance,
  getSingleAddressBalanceAPI,
  getAddressDeltas, // insight explorer
  getSingleAddressDeltas,
  getAddressUtxos, // insight explorer
  getSingleAddressUtxos,
  getSingleAddressUtxosAPI,
  getAddressMempool, // insight explorer
  getSingleAddressMempool,
};
