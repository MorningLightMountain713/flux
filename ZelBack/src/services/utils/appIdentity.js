const crypto = require('crypto');

/**
 * Which app INSTANCE this is, as opposed to which name it currently answers to.
 *
 * A name is a lease. It expires, and the same string can then be registered by
 * somebody else — while the volume directory, the syncthing folder and the port
 * reservation keyed on it outlive that handover. Everything keyed on a name is
 * therefore keyed on something that can change hands underneath it.
 *
 * The transaction that carried the registration cannot change hands. Hashing the
 * name together with it gives a value that exists for the life of one
 * registration and never again after it: a re-registration of the same name
 * arrives in a different transaction, so its uuid cannot equal the previous
 * holder's, and none of the leftovers keyed on the old one can be mistaken for
 * the new app's.
 *
 * Derived, never assigned. Every node decodes the same registration from the
 * same transaction and computes the same value without exchanging anything, so
 * this changes FluxOS's idea of identity with no protocol change at all — no
 * spec field, no message-format bump, no fork — and legacy registrations get one
 * retroactively from the same two inputs.
 *
 * @param {string} name app name, as registered
 * @param {string} txid txid of the transaction carrying the FIRST registration
 * @returns {string|null} 64 hex characters, or null if either input is missing
 */
function mintAppUuid(name, txid) {
  if (!name || !txid) return null;
  return crypto.createHash('sha256').update(`${name}${txid}`).digest('hex');
}

/**
 * How much of the uuid physical names carry: the first 12 hex characters, which
 * is docker's own short-id convention. Mongo keeps the whole value; a container
 * name does not need to.
 */
const IDENTITY_HEX_CHARS = 12;

/**
 * The app-identity segment a new registration's containers, volumes and folders
 * are named from.
 *
 * Only ever called for an app being registered NOW. An app that already exists
 * keeps whatever identity its row already states — its artifacts are already
 * named, and renaming them is a data migration, not a derivation.
 *
 * @param {string|null} uuid
 * @returns {string|null}
 */
function identityFromUuid(uuid) {
  return uuid ? uuid.slice(0, IDENTITY_HEX_CHARS) : null;
}

module.exports = {
  mintAppUuid,
  identityFromUuid,
  IDENTITY_HEX_CHARS,
};
