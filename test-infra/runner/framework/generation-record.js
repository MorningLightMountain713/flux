import { generationRecordText } from '@runonflux/flux-spec';
import { signBtcMessage } from '../auth.js';
import { getState } from './daemon-control.js';
import { manifestStanding } from './content-helper.js';
import { submitToNode } from './gated-fetch.js';

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
