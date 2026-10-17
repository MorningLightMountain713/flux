'use strict';

const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const daemonServiceUtils = require('./daemonServiceUtils');
const { Privilege, authOf } = require('../utils/privileges');

let response = messageHelper.createErrorMessage();

/**
 * To request help message. Command required as parameter for RPC call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function help(req, res) {
  let { command } = req.params; // we accept both help/command and help?command=getinfo
  command = command || req.query.command || '';

  const rpccall = 'help';
  const rpcparameters = [command];

  response = await daemonServiceUtils.executeCall(rpccall, rpcparameters);

  return res.json(response);
}

/**
 * The daemon's version, RPC port and state. The wallet balance is left out
 * unless asked for.
 * @param {{withBalance?: boolean}} [options]
 * @returns {Promise<{value: object|null, reason?: object}>}
 */
async function getInfo({ withBalance = false } = {}) {
  const info = messageHelper.answerOf(await daemonServiceUtils.executeCall('getInfo'));
  if (info.value && !withBalance) delete info.value.balance;
  return info;
}

/**
 * GET /daemon/getinfo. The balance is a node operator's to see.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function getInfoAPI(req, res) {
  const withBalance = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR, authOf(req)) === true;
  res.json(messageHelper.messageOf(await getInfo({ withBalance })));
}

/**
 * To stop node daemon. Only accessible by admins.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {object} Message.
 */
async function stop(req, res) { // practically useless
  const authorized = await verificationHelper.verifyPrivilege(Privilege.NODE_OPERATOR, authOf(req));
  if (authorized !== true) {
    response = messageHelper.errUnauthorizedMessage();
    return res ? res.json(response) : response;
  }
  const rpccall = 'stop';

  response = await daemonServiceUtils.executeCall(rpccall);

  return res ? res.json(response) : response;
}

module.exports = {
  help,
  getInfo,
  getInfoAPI,
  stop,
};
