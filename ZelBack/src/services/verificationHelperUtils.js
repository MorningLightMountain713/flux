/**
 * @module
 * Contains utility functions to be used only by verificationHelper.
 * To verify privilege use verifyPrivilege from verificationHelper module.
 */

const config = require('config');
const signatureVerifier = require('./signatureVerifier');
const serviceHelper = require('./serviceHelper');
const dbHelper = require('./dbHelper');
// Removed registryManager to avoid circular dependency - will use dynamic require where needed

/**
 * Whether a self-presented login phrase is inside its validity window.
 *
 * Used on nodes that never issued the phrase, so there is no stored challenge to
 * compare against and the embedded timestamp is the only bound on how long a signed
 * phrase keeps authenticating. The prefix is therefore required to be 13 digits: a
 * non-numeric prefix parses to NaN, and every comparison against NaN is false, so an
 * arithmetic-only check silently admits the phrase with no expiry at all.
 *
 * @param {string} message loginPhrase presented by the caller.
 * @param {number} maxAgeMs how far back the embedded timestamp may sit.
 * @returns {boolean} true only if the length and the timestamp window both hold.
 */
function loginPhraseWithinWindow(message, maxAgeMs) {
  if (typeof message !== 'string') return false;
  if (message.length < 40 || message.length > 70) return false;

  const prefix = message.substring(0, 13);
  if (!/^\d{13}$/.test(prefix)) return false;

  const issuedAt = Number(prefix);
  const now = Date.now();

  return issuedAt >= now - maxAgeMs && issuedAt <= now;
}

/**
 * Verifies admin session
 * @param {object} headers
 *
 * @returns {Promise<boolean>}
 */
async function verifyAdminSession(headers) {
  if (!headers || !headers.zelidauth) return false;
  const auth = serviceHelper.ensureObject(headers.zelidauth);
  if (!auth.zelid || !auth.signature || !auth.loginPhrase) return false;
  const { userconfig } = globalThis;
  if (auth.zelid !== userconfig.initial.zelid) return false;

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.local.database);
  const collection = config.database.local.collections.loggedUsers;
  const query = { $and: [{ loginPhrase: auth.loginPhrase }, { zelid: auth.zelid }] };
  const projection = {};
  const loggedUser = await dbHelper.findOneInDatabase(database, collection, query, projection);
  if (!loggedUser) return false;

  // check if signature corresponds to message with that zelid
  let valid = false;
  try {
    valid = await signatureVerifier.verifySignature(auth.loginPhrase, auth.zelid, auth.signature);
  } catch (error) {
    return false;
  }
  if (valid) {
    // now we know this is indeed a logged admin
    return true;
  }
  return false;
}

/**
 * Verifies user session
 * @param {object} headers
 *
 * @returns {Promise<boolean>}
 */
async function verifyUserSession(headers) {
  if (!headers || !headers.zelidauth) return false;
  const auth = serviceHelper.ensureObject(headers.zelidauth);
  if (!auth.zelid || !auth.signature || !auth.loginPhrase) return false;

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.local.database);
  const collection = config.database.local.collections.loggedUsers;
  const query = { $and: [{ loginPhrase: auth.loginPhrase }, { zelid: auth.zelid }] };
  const projection = {};
  const loggedUser = await dbHelper.findOneInDatabase(database, collection, query, projection);
  // if not logged, check if not older than 16 hours
  if (!loggedUser) {
    const maxHours = 16 * 60 * 60 * 1000;
    if (!loginPhraseWithinWindow(auth.loginPhrase, maxHours)) return false;
  }

  // check if signature corresponds to message with that zelid
  let valid = false;
  try {
    valid = await signatureVerifier.verifySignature(auth.loginPhrase, auth.zelid, auth.signature);
  } catch (error) {
    return false;
  }
  // console.log(valid)
  if (valid) {
    // now we know this is indeed a logged admin
    return true;
  }
  return false;
}

/**
 * Verifies flux team session
 * @param {object} headers
 *
 * @returns {Promise<boolean>}
 */
async function verifyFluxTeamSession(headers) {
  if (!headers || !headers.zelidauth) return false;
  const auth = serviceHelper.ensureObject(headers.zelidauth);
  if (!auth.zelid || !auth.signature || !auth.loginPhrase) return false;
  if (auth.zelid !== config.fluxTeamFluxID && auth.zelid !== config.fluxSupportTeamFluxID) return false;

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.local.database);
  const collection = config.database.local.collections.loggedUsers;
  const query = { $and: [{ loginPhrase: auth.loginPhrase }, { zelid: auth.zelid }] };
  const projection = {};
  const result = await dbHelper.findOneInDatabase(database, collection, query, projection);
  const loggedUser = result;
  if (!loggedUser) return false;
  // check if signature corresponds to message with that zelid
  let valid = false;
  try {
    valid = await signatureVerifier.verifySignature(auth.loginPhrase, auth.zelid, auth.signature);
  } catch (error) {
    return false;
  }
  if (valid) {
    // now we know this is indeed a logged fluxteam
    return true;
  }
  return false;
}

/**
 * Verifies admin or flux team session
 * @param {object} headers
 *
 * @returns {Promise<boolean>}
 */
async function verifyAdminAndFluxTeamSession(headers) {
  if (!headers || !headers.zelidauth) return false;
  const auth = serviceHelper.ensureObject(headers.zelidauth);
  if (!auth.zelid || !auth.signature || !auth.loginPhrase) return false;
  const { userconfig } = globalThis;
  if (auth.zelid !== config.fluxTeamFluxID && auth.zelid !== userconfig.initial.zelid && auth.zelid !== config.fluxSupportTeamFluxID) return false; // admin is considered as fluxTeam

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.local.database);
  const collection = config.database.local.collections.loggedUsers;
  const query = { $and: [{ loginPhrase: auth.loginPhrase }, { zelid: auth.zelid }] };
  const projection = {};
  const loggedUser = await dbHelper.findOneInDatabase(database, collection, query, projection);
  if (!loggedUser) return false;
  // check if signature corresponds to message with that zelid
  let valid = false;
  try {
    valid = await signatureVerifier.verifySignature(auth.loginPhrase, auth.zelid, auth.signature);
  } catch (error) {
    return false;
  }
  if (valid) {
    // now we know this is indeed a logged admin or fluxteam
    return true;
  }
  return false;
}

/**
 * Verifies app owner session
 * @param {object} headers
 *
 * @returns {Promise<boolean>}
 */
async function verifyAppOwnerSession(headers, appName) {
  if (!headers || !headers.zelidauth || !appName) return false;
  const auth = serviceHelper.ensureObject(headers.zelidauth);
  if (!auth.zelid || !auth.signature || !auth.loginPhrase) return false;
  // Use dynamic require to avoid circular dependency
  // eslint-disable-next-line global-require
  const registryManager = require('./appDatabase/registryManager');
  const ownerFluxID = await registryManager.getApplicationOwner(appName);
  if (auth.zelid !== ownerFluxID) return false;

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.local.database);
  const collection = config.database.local.collections.loggedUsers;
  const query = { $and: [{ loginPhrase: auth.loginPhrase }, { zelid: auth.zelid }] };
  const projection = {};
  const loggedUser = await dbHelper.findOneInDatabase(database, collection, query, projection);
  // if not logged, check if not older than 2 hours
  if (!loggedUser) {
    const twoHours = 2 * 60 * 60 * 1000;
    if (!loginPhraseWithinWindow(auth.loginPhrase, twoHours)) return false;
  }
  // check if signature corresponds to message with that zelid
  let valid = false;
  try {
    valid = await signatureVerifier.verifySignature(auth.loginPhrase, auth.zelid, auth.signature);
  } catch (error) {
    return false;
  }
  if (valid) {
    // now we know this is indeed a logged application owner
    return true;
  }
  return false;
}

/**
 * Verifies app owner (or higher privilege) session
 * @param {object} headers
 *
 * @returns {Promise<boolean>}
 */
async function verifyAppOwnerOrHigherSession(headers, appName) {
  if (!headers || !headers.zelidauth || !appName) return false;
  const auth = serviceHelper.ensureObject(headers.zelidauth);
  if (!auth.zelid || !auth.signature || !auth.loginPhrase) return false;
  // Use dynamic require to avoid circular dependency
  // eslint-disable-next-line global-require
  const registryManager = require('./appDatabase/registryManager');
  const ownerFluxID = await registryManager.getApplicationOwner(appName);
  const { userconfig } = globalThis;
  if (auth.zelid !== ownerFluxID && auth.zelid !== config.fluxTeamFluxID && auth.zelid !== userconfig.initial.zelid && auth.zelid !== config.fluxSupportTeamFluxID) return false;

  const db = dbHelper.databaseConnection();
  const database = db.db(config.database.local.database);
  const collection = config.database.local.collections.loggedUsers;
  const query = { $and: [{ loginPhrase: auth.loginPhrase }, { zelid: auth.zelid }] };
  const projection = {};
  const loggedUser = await dbHelper.findOneInDatabase(database, collection, query, projection);
  // if not logged, check if not older than 2 hours
  if (!loggedUser) {
    const maxHours = 2 * 60 * 60 * 1000;
    if (!loginPhraseWithinWindow(auth.loginPhrase, maxHours)) return false;
  }

  // check if signature corresponds to message with that zelid
  let valid = false;
  try {
    valid = await signatureVerifier.verifySignature(auth.loginPhrase, auth.zelid, auth.signature);
  } catch (error) {
    return false;
  }
  if (valid) {
    // now we know this is indeed a logged application owner
    return true;
  }
  return false;
}

module.exports = {
  loginPhraseWithinWindow,
  verifyAdminAndFluxTeamSession,
  verifyAdminSession,
  verifyAppOwnerOrHigherSession,
  verifyAppOwnerSession,
  verifyFluxTeamSession,
  verifyUserSession,
};
