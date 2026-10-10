import { generationRecordText } from '@runonflux/flux-spec';
import { authenticate, signBtcMessage } from '../auth.js';
import {
  advanceBlocks, getState, startTicker, stopTicker,
} from './daemon-control.js';
import { manifestStanding } from './content-helper.js';
import { submitToNode } from './gated-fetch.js';
import { grantVerdict } from './grant-record.js';
import { waitFor, waitForReconcileActuated } from './wait.js';

/**
 * Post an owner-signed generation record to a node. The signed text is the
 * library's, and `ownedFrom` is the height the listed owner took the app, read
 * from the node the record goes to: the door checks the record against that
 * node's own applied history.
 *
 * @param {string} nodeUrl
 * @param {{ name: string, identity: string, role: string, generation: number,
 *   ownerKey: { privkey: string }, auth: string, at?: number }} opts
 * @returns {Promise<{ status: number, body: string, json: object|null, height: number, record: object }>}
 *   `json` is the parsed body, or null when the body is not JSON.
 */
export async function postGenerationRecord(nodeUrl, {
  name, identity, role, generation, ownerKey, auth, at = Date.now(),
}) {
  const { currentHeight } = await getState();
  const { ownership } = await manifestStanding(nodeUrl, name);
  const record = {
    identity, role, generation, height: currentHeight, at, ownedFrom: ownership.from,
  };
  const signature = await signBtcMessage(generationRecordText(record), ownerKey.privkey);
  const res = await submitToNode(`${nodeUrl}/apps/grantgeneration`, {
    method: 'POST',
    headers: { zelidauth: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ ...record, signature }),
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { json = null; }
  return {
    status: res.status, body, json, height: currentHeight, record,
  };
}

async function ownerGet(nodeUrl, path, ownerKey) {
  const { zelidauth } = await authenticate(nodeUrl, ownerKey);
  const res = await fetch(`${nodeUrl}${path}`, { headers: { zelidauth } });
  const body = await res.json();
  if (body.status !== 'success') throw new Error(`${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/**
 * The owner's re-roll of a role to `generation`, the app stopped across it, as
 * the owner performs it: the app yields and stops on every holder, the yielded
 * term is released, the record is posted and reaches every holder, the app
 * restarts, and the generation's drain is mined. Resolves once a quorum of
 * cells holds a term at the new generation. The ticker is stopped for the
 * sequence, so the drain is the blocks mined here.
 *
 * @param {object} env - the test environment
 * @param {{ name: string, identity: string, identifier: string, generation: number,
 *   ownerKey: object, via: number, holders: number[], drainBlocks: number,
 *   quorum: number, role?: string, timeout?: number }} opts - `identifier` is the
 *   component's container identifier, `via` the node the owner's calls go to
 * @returns {Promise<object>} the record posted
 */
export async function rerollRole(env, {
  name, identity, identifier, generation, ownerKey, via, holders, drainBlocks, quorum,
  role = 'master', timeout = 300000,
}) {
  const key = `${identity}/${role}`;
  const verdict = () => grantVerdict(env.clients, key, { quorum });
  const url = env.clients[via].url;
  await stopTicker();
  try {
    const markers = env.clients.map((c) => c?.getLastEventId());
    await ownerGet(url, `/apps/appyield/${name}/true`, ownerKey);
    await Promise.all(holders.map((i) => waitForReconcileActuated(
      env.clients[i], identifier, 'settledStopped', 120000, { afterId: markers[i] },
    )));
    await waitFor(async () => (await verdict()) === null, {
      timeout, interval: 5000, label: `${key}: the yielded term is released`,
    });
    const { zelidauth } = await authenticate(url, ownerKey);
    const posted = await postGenerationRecord(url, {
      name, identity, role, generation, ownerKey, auth: zelidauth,
    });
    if (posted.status !== 200) throw new Error(`the generation-${generation} record: ${posted.body}`);
    await Promise.all(holders.map((i) => env.clients[i].waitForEvent(
      'quorumGrant:generationRecord',
      (d) => d.identity === identity && d.role === role && d.generation === generation,
      120000,
      { afterId: markers[i] },
    )));
    await ownerGet(url, `/apps/apprestart/${name}/true`, ownerKey);
    await advanceBlocks(drainBlocks);
    await waitFor(async () => (await verdict())?.generation === generation, {
      timeout, interval: 5000, label: `${key}: a generation-${generation} term forms`,
    });
    return posted.record;
  } finally {
    await startTicker();
  }
}
