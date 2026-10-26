/**
 * The component keys of a v9 app the harness registered or updated, worked out
 * as every node that runs the app works them out (flux-spec componentKeysFor):
 * a registration mints each component's key from the app's identity and the
 * registration's message hash, and an update carries each continuing
 * component's key and mints one for each it adds. A component's container,
 * data directory and Syncthing folder are named by its key.
 */
import {
  OpenedSpec, appIdentityFromUuid, appUuid, componentKeysFor,
} from '@runonflux/flux-spec';

const MESSAGE_HASH = /^[a-f0-9]{64}$/;

// Under the private rules, which hold every spec the harness registers, sealed
// or in the clear.
function specOf(submissionSpec) {
  return OpenedSpec.fromSubmission(submissionSpec);
}

function messageHashOf(hash, what) {
  if (typeof hash !== 'string' || !MESSAGE_HASH.test(hash)) {
    throw new Error(`${what}: the message hash the door answered is not one: ${JSON.stringify(hash)}`);
  }
  return hash;
}

/**
 * The keys of a v9 registration, by component name.
 * @param {object} submissionSpec - the v9 submission registered
 * @param {string} hash - the registration's message hash
 * @returns {Map<string, string>}
 */
export function registrationKeys(submissionSpec, hash) {
  const messageHash = messageHashOf(hash, `registrationKeys(${submissionSpec.name})`);
  return componentKeysFor(specOf(submissionSpec), {
    previous: null,
    appIdentity: appIdentityFromUuid(appUuid(submissionSpec.name, messageHash)),
    messageHash,
  });
}

/**
 * The keys of a v9 update, by component name.
 * @param {object} submissionSpec - the v9 submission of the update
 * @param {string} hash - the update's message hash
 * @param {{previous: Map<string, string>, identity: string}} app - the keys of the
 *   version it updates and the app's identity
 * @returns {Map<string, string>}
 */
export function updateKeys(submissionSpec, hash, { previous, identity }) {
  const what = `updateKeys(${submissionSpec.name})`;
  if (!(previous instanceof Map)) throw new Error(`${what}: state the keys of the version it updates`);
  if (typeof identity !== 'string' || identity === '') throw new Error(`${what}: state the app's identity`);
  return componentKeysFor(specOf(submissionSpec), { previous, appIdentity: identity, messageHash: messageHashOf(hash, what) });
}
