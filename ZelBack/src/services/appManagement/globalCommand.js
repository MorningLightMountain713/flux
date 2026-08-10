'use strict';

const config = require('config');
const axios = require('axios');
const serviceHelper = require('../serviceHelper');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');

const { globalCmdDelayMs } = config.fluxapps;

/**
 * Get application locations from the global database
 * @param {string} appname - Application name
 * @returns {Promise<Array>} Application locations
 */
async function appLocation(appname) {
  return appsRepository.appLocationFromEvents(appname ? { appname } : {});
}

/**
 * Execute a global command on an application across the network
 * @param {string} appname - Application name
 * @param {string} command - Command to execute
 * @param {string} zelidauth - Authorization header
 * @param {string} [paramA] - Additional parameter to append to URL
 * @param {boolean} [bypassMyIp] - Whether to bypass own IP
 * @returns {Promise<void>}
 */
async function executeAppGlobalCommand(appname, command, zelidauth, paramA, bypassMyIp, replica = null) {
  try {
    // get a list of the specific app locations
    let locations = await appLocation(appname);
    // A replica-scoped command goes only to the node(s) that run that identity
    // (location rows carry the replica).
    if (replica != null) {
      locations = locations.filter((appInstance) => appInstance.replica === replica);
    }
    const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    const localIp = extractIp(localSocketAddr);
    const localPort = extractPort(localSocketAddr);
    // eslint-disable-next-line no-restricted-syntax
    for (const appInstance of locations) {
      const instanceIp = extractIp(appInstance.ip);
      const instancePort = extractPort(appInstance.ip);
      if (bypassMyIp && localIp === instanceIp && localPort === instancePort) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const axiosConfig = {
        headers: {
          zelidauth,
        },
      };
      let url = `http://${instanceIp}:${instancePort}/apps/${command}/${appname}`;
      if (paramA) {
        url += `/${paramA}`;
      }
      if (replica != null) {
        url += `?replica=${encodeURIComponent(replica)}`;
      }
      axios.get(url, axiosConfig)
        .then((response) => {
          log.info(`Successfully sent command to ${url}: ${response.status}`);
        })
        .catch((error) => {
          log.error(`Axios request failed for ${url}`, error);
        });
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(globalCmdDelayMs);
    }
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  executeAppGlobalCommand,
};
