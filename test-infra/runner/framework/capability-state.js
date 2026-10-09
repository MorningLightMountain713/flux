// A capability's state, read from the node rather than inferred from the event
// stream. waitForCapabilityUp answers from the buffer: an up edge the node
// published a minute ago satisfies it while the capability is down again now.
// GET /v2/node/boot serves the registry's snapshot, every capability with its
// state, to the node operator and the Flux team; the harness is the Flux team.
import { authenticate } from '../auth.js';
import { fluxTeamKey } from './keys.js';
import { waitFor } from './wait.js';

const teamAuths = new Map();

async function teamAuth(client, { fresh = false, login = authenticate } = {}) {
  if (!fresh) {
    if (client.zelidauth) return client.zelidauth;
    const cached = teamAuths.get(client.url);
    if (cached) return cached;
  }
  const { zelidauth } = await login(client.url, fluxTeamKey());
  teamAuths.set(client.url, zelidauth);
  return zelidauth;
}

/**
 * Every capability the node holds, by name, as the registry reports it:
 * {name, owner, needs, state, since, reason, waitingOn}.
 * @param {object} client a node client
 * @param {{login?: Function}} [deps]
 * @returns {Promise<Map<string, object>>}
 */
export async function capabilityStates(client, deps = {}) {
  let res = await client.getAuthed('/v2/node/boot', await teamAuth(client, deps), { noCache: true });
  if (!Array.isArray(res?.data?.capabilities)) {
    // A session the node no longer holds answers as a refusal; one fresh login.
    res = await client.getAuthed('/v2/node/boot', await teamAuth(client, { ...deps, fresh: true }), { noCache: true });
  }
  if (!Array.isArray(res?.data?.capabilities)) {
    throw new Error(`${client.ip}: /v2/node/boot did not answer with the capabilities: ${JSON.stringify(res)}`);
  }
  return new Map(res.data.capabilities.map((entry) => [entry.name, entry]));
}

/**
 * One capability's state now: 'up', 'coming-up' or 'down'.
 * @param {object} client
 * @param {string} name
 * @param {{login?: Function}} [deps]
 * @returns {Promise<string>}
 */
export async function capabilityState(client, name, deps = {}) {
  const entry = (await capabilityStates(client, deps)).get(name);
  if (!entry) throw new Error(`${client.ip} holds no capability named ${name}`);
  return entry.state;
}

/**
 * Poll the node until a capability is in `state`.
 * @param {object} client
 * @param {string} name
 * @param {string} [state]
 * @param {{timeout?: number, interval?: number, login?: Function}} [opts]
 * @returns {Promise<boolean>}
 */
export async function waitForCapabilityState(client, name, state = 'up', {
  timeout = 60000, interval = 1000, login,
} = {}) {
  return waitFor(
    async () => (await capabilityState(client, name, { login })) === state,
    { timeout, interval, label: `${name} ${state} on ${client.ip}` },
  );
}
