'use strict';

const path = require('node:path');
const fs = require('node:fs');

const USER_CONFIG_PATH = path.join(__dirname, '../../../../config/userconfig.js');

const DEFAULT_CONFIG = {
  initial: {
    ipaddress: '127.0.0.1',
    zelid: null,
    testnet: false,
    development: false,
    apiport: 16127,
    routerIP: '',
  },
};

/**
 * Loads config/userconfig.js once, at startup.
 *
 * The file is operator input and FluxOS has no writer for it: node runtime state lives in
 * the local database, and the settings themselves belong to the installer — flux-configd
 * renders the file on ArcaneOS, an operator edits it directly elsewhere.
 *
 * It is deliberately not re-read while the process runs. Much of what it holds is captured
 * at startup — the HTTP server has already bound apiport, ZelBack/config/default.js bakes
 * development in at require time — so republishing the file mid-flight produced a process
 * whose stated configuration and actual behaviour disagreed. apiport is the sharp case: it
 * is read at runtime in seven places, one of which builds the socket address this node
 * announces to the network, so a live change had the node advertising an address it was
 * not listening on. Applying a change means restarting, which is what flux-configd already
 * does after it rewrites the file.
 *
 * Usage:
 *   const configManager = require('./utils/configManager');
 *   const apiPort = globalThis.userconfig.initial.apiport;
 */
class ConfigManager {
  constructor() {
    this.configPath = USER_CONFIG_PATH;
    this.lastLoadError = null;
    this.loadConfig();
  }

  /**
   * Evaluate the config file's text.
   *
   * Evaluated rather than `require`d so a reload reads the file exactly once. The
   * previous implementation read it twice — synchronously for the hash, then again
   * through the require cache for the content — so the hash could describe a
   * different revision than the one it published.
   * @param {string} text - File contents
   * @returns {object} The module's exports
   */
  static evaluate(text) {
    const shim = { exports: {} };
    // eslint-disable-next-line no-new-func
    const load = new Function('module', 'exports', text);
    load(shim, shim.exports);
    return shim.exports;
  }

  /**
   * Reject a config that parsed but cannot be used.
   *
   * A truncated or empty file is the case that matters: an empty JavaScript file is
   * a legal program exporting `{}`, so it loads successfully and then every reader of
   * `userconfig.initial.zelid` throws. Refusing the shape here is what stops a bad
   * read reaching globalThis at all.
   * @param {object} candidate - Freshly evaluated config
   * @returns {string|null} Reason it is unusable, or null when valid
   */
  static validate(candidate) {
    if (!candidate || typeof candidate !== 'object') return 'config is not an object';
    const { initial } = candidate;
    if (!initial || typeof initial !== 'object') return 'config has no initial section';
    if (typeof initial.zelid !== 'string' || !initial.zelid) return 'initial.zelid is missing';

    // eslint-disable-next-line global-require
    const config = require('config');
    if (initial.apiport !== undefined && initial.apiport !== ''
      && !config.server.allowedPorts.includes(Number(initial.apiport))) {
      return `initial.apiport ${initial.apiport} is not an allowed port`;
    }

    const booleans = ['testnet', 'development', 'debug', 'upnp'];
    const badBoolean = booleans.find(
      (key) => initial[key] !== undefined && typeof initial[key] !== 'boolean',
    );
    if (badBoolean) return `initial.${badBoolean} is not a boolean`;

    if (initial.routerIP !== undefined && typeof initial.routerIP !== 'string') {
      return 'initial.routerIP is not a string';
    }

    return null;
  }

  /**
   * Read and publish the userconfig. Called once, from the constructor.
   *
   * A file that cannot be read or does not validate publishes DEFAULT_CONFIG and records
   * the reason rather than throwing, so requiring this module is never what fails. Acting
   * on that is the entrypoint's job: apiServer refuses to start when getLastLoadError()
   * is set, which keeps the decision to abort in one place instead of at require time.
   * @returns {boolean} Whether the operator's config was published
   */
  loadConfig() {
    let candidate;
    try {
      const text = fs.readFileSync(this.configPath, 'utf8');
      candidate = ConfigManager.evaluate(text);
    } catch (error) {
      this.lastLoadError = `unreadable: ${error.message}`;
      console.error('Error loading userconfig:', error);
      globalThis.userconfig = DEFAULT_CONFIG;
      return false;
    }

    const invalid = ConfigManager.validate(candidate);
    if (invalid) {
      this.lastLoadError = invalid;
      // An empty or truncated file parses as `{}`, which is a legal program and a
      // useless config. Refusing the shape here is what keeps it off globalThis.
      console.error(`Refusing to apply userconfig: ${invalid}`);
      globalThis.userconfig = DEFAULT_CONFIG;
      return false;
    }

    this.lastLoadError = null;
    globalThis.userconfig = candidate;
    return true;
  }

  /**
   * Get the current userconfig object
   * @returns {object} Current userconfig
   */
  getUserConfig() {
    return globalThis.userconfig;
  }

  /**
   * Why the config on disk was refused at startup, or null when it was published.
   * A node running on DEFAULT_CONFIG has no zelid; this says why.
   * @returns {string|null}
   */
  getLastLoadError() {
    return this.lastLoadError;
  }

  /**
   * Get a specific config value
   * @param {string} path - Dot notation path (e.g., 'initial.apiport')
   * @returns {*} Config value
   */
  getConfigValue(path) {
    const config = globalThis.userconfig;
    const parts = path.split('.');
    let value = config;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Check if config has been initialized
   * @returns {boolean}
   */
  isInitialized() {
    return globalThis.userconfig !== null && globalThis.userconfig !== undefined;
  }
}

// Create singleton instance
const configManager = new ConfigManager();

module.exports = configManager;
// The loading rules — what parses, what is fit to publish, what changed — are pure
// functions on the class, so they are exercised directly rather than through the
// singleton's file and global state.
module.exports.ConfigManager = ConfigManager;
module.exports.USER_CONFIG_PATH = USER_CONFIG_PATH;
