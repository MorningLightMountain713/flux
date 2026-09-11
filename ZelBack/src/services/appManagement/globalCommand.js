'use strict';

const config = require('config');
const axios = require('axios');
const serviceHelper = require('../serviceHelper');
const fluxNetworkHelper = require('../fluxNetworkHelper');
const log = require('../../lib/log');
const appsRepository = require('../appDatabase/appsRepository');
const { extractIp, extractPort } = require('../utils/socketAddressUtils');

const globalCmdDelayMs = config.get('fluxapps.globalCmdDelayMs');
// Guaranteed a finite non-negative integer, so a missing or malformed config
// value can never spin the retry loop below forever.
const globalCmdBootRetries = (Number.isInteger(config.get('fluxapps.globalCmdBootRetries'))
  && config.get('fluxapps.globalCmdBootRetries') >= 0)
  ? config.get('fluxapps.globalCmdBootRetries')
  : 8;

// A node still reconciling its apps after boot refuses these routes with 15s.
const BOOT_RETRY_AFTER_FALLBACK_S = 15;
// Caps a node's Retry-After so a hostile or absurd value cannot stall delivery.
const BOOT_RETRY_MAX_WAIT_MS = 60 * 1000;

/**
 * Deliver one node's copy of a global command, retrying a boot-gate 503.
 *
 * Moved here with the fan-out (development's #1780): a node that is still
 * reconciling its apps after boot answers 503 with a Retry-After, and a command
 * dropped at that moment is a command that node never carries out.
 *
 * @param {string} url
 * @param {object} axiosConfig
 * @returns {Promise<void>}
 */
async function deliverGlobalCommand(url, axiosConfig) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await axios.get(url, axiosConfig);
      log.info(`Successfully sent command to ${url}: ${response.status}`);
      return;
    } catch (error) {
      const status = error.response && error.response.status;
      if (status !== 503) {
        log.error(`Axios request failed for ${url}`, error);
        return;
      }
      if (attempt >= globalCmdBootRetries) {
        log.warn(`Node at ${url} still reconciling apps after boot; command not delivered after ${globalCmdBootRetries} retries`);
        return;
      }
      const headerRetryAfter = Number(error.response.headers && error.response.headers['retry-after']);
      const retryAfterS = headerRetryAfter > 0 ? headerRetryAfter : BOOT_RETRY_AFTER_FALLBACK_S;
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(Math.min(retryAfterS * 1000, BOOT_RETRY_MAX_WAIT_MS));
    }
  }
}

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
      // Fire-and-forget: each node's delivery, with its own bounded retry of a
      // boot-gate 503, runs on its own while the loop paces the sends.
      deliverGlobalCommand(url, axiosConfig);
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(globalCmdDelayMs);
    }
  } catch (error) {
    log.error(error);
  }
}

module.exports = {
  executeAppGlobalCommand,
  deliverGlobalCommand,
};
