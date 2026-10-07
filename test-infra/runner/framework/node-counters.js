// A node's test counters read from inside its own container. The read crosses
// a partition that cuts the harness off the node's network, where the event
// stream and the API cannot.
import { execInContainer } from './container.js';

/**
 * @param {object} client a node client (its container is exec'd into)
 * @returns {Promise<object>} the node's counters
 */
export async function countersInside(client) {
  const { stdout } = await execInContainer(client.container, 'curl -s -m 5 http://127.0.0.1:16127/flux/testcounters');
  const body = JSON.parse(stdout);
  return body.status === 'success' ? body.data : {};
}

/**
 * How many times the node's orchestrator entered a state, from any state.
 * @param {object} counters as countersInside answers
 * @param {string} state
 * @returns {number}
 */
export function orchestratorEntries(counters, state) {
  return Object.values(counters['orchestrator:transition'] ?? {})
    .reduce((total, byTarget) => total + (byTarget[state] ?? 0), 0);
}

/**
 * How many times the node's orchestrator moved from one state to another.
 * @param {object} counters as countersInside answers
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export function orchestratorTransitions(counters, from, to) {
  return counters['orchestrator:transition']?.[from]?.[to] ?? 0;
}
