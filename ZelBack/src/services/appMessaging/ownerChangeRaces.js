/**
 * The updates on chain that the ownership rule cannot verify.
 *
 * An update is authorized by the owner the app has at the height the update is
 * mined. One message does not satisfy that. An ownership transfer for
 * `wordpress1735018430692` confirmed at height 1,880,959; this update was mined
 * two blocks later and had already been signed by the owner that transfer
 * replaced. The network accepted it, so it is part of history — a node
 * rebuilding history must reach the same verdict or it cannot sync past it.
 *
 * Each entry names the address that authorizes that one message. The exception
 * is a stated fact about a specific message rather than a rule something else
 * can satisfy: naming the signer means nothing is looked up, and no property a
 * new message could arrange grants it anything.
 *
 * The set is closed. It was derived by replaying the ownership rule over every
 * update on chain (40,519 of them, at height 2,831,782); this was the only
 * message that needed it. Nothing mined later can join it — a message hash
 * commits to the content it authorizes, so an entry cannot be repurposed.
 *
 * Keyed through a Map so a hash arriving off the network cannot reach
 * Object.prototype.
 */
const OWNER_CHANGE_RACES = new Map([
  [
    '70b2d8a546f003b906055e168d3e7921bfedfe9c83b5bd8fc79b84d979977b76',
    '1GTMhsaa55GaH7sGYif9d5dEzkGrGXYW4N',
  ],
]);

/**
 * The address that authorizes a known owner-change race.
 *
 * @param {string} hash - permanent message hash
 * @returns {string|null} the authorizing address, or null for every other message
 */
function ownerChangeRaceSigner(hash) {
  return OWNER_CHANGE_RACES.get(hash) ?? null;
}

module.exports = { ownerChangeRaceSigner, OWNER_CHANGE_RACES };
