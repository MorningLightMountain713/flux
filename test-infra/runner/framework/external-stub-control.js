// Drives the external HTTP stub (test-infra/external-http-stub), which stands in for every
// third party a node reaches: the policy documents it enforces, the github release feed,
// geolocation, the stats service, fiat rates.
//
// Policy is the interesting part here. config.policy.baseUrl points every node at this stub
// (test-env wires it), so setting a document below is the same act as merging to the policy
// repo — and failPaths() is the same act as that repo becoming unreachable, which is the case
// policyStore's whole last-known-good layer exists for.
import { getSubnetConfig } from './subnet-config.js';

const CONTROL = process.env.EXTERNAL_STUB_CONTROL || `http://${getSubnetConfig().externalStub}:3001`;

// The document paths, as the node requests them. failPaths() is keyed on these.
export const POLICY_PATHS = {
  blockedRepositories: '/helpers/blockedrepositories.json',
  tamperingBlocklist: '/helpers/tamperingblockednodes.json',
  enterpriseNodes: '/helpers/enterprisenodes.json',
};

async function post(path, body) {
  const res = await fetch(`${CONTROL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`external stub control ${path} returned ${res.status}`);
  return res.json();
}

async function get(path) {
  const res = await fetch(`${CONTROL}${path}`);
  return res.json();
}

/** Images, app owners and app hashes no node may run. */
export async function setBlockedRepositories(entries) {
  return post('/blocked-repos', entries);
}

/** Collateral txhashes eligible for a tampering DOS. */
export async function setTamperingBlocklist(txhashes) {
  return post('/tampering-blocklist', txhashes);
}

/** node pubkey -> allowed app owner addresses. */
export async function setEnterpriseNodes(map) {
  return post('/enterprise-nodes', map);
}

/**
 * Make the given paths fail, so a node sees the policy source as unreachable.
 *
 * This is how the outage half of any policy test is staged: it is not the same as setting a
 * document to empty, and a node must not treat it as such.
 * @param {object} statusByPath e.g. { [POLICY_PATHS.blockedRepositories]: 503 }
 */
export async function failPaths(statusByPath) {
  return post('/failing-paths', statusByPath);
}

/** Stop failing everything. */
export async function healPaths() {
  return post('/failing-paths', {});
}

/**
 * Per-path { 200, 304 } tallies. A node that revalidates conditionally shows a 304; one that
 * re-downloads shows another 200, which is the difference between a cheap refresh and every
 * node pulling every document on every interval.
 */
export async function policyRequestCounts() {
  const { policyRequests } = await get('/state');
  return policyRequests;
}

/** Zero the tallies, so a suite counts one restart's requests rather than all of them. */
export async function clearPolicyRequestCounts() {
  return post('/policy-requests');
}

export async function resetExternalStub() {
  return post('/reset');
}

export async function getExternalStubState() {
  return get('/state');
}
