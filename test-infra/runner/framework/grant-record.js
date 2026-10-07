// A grantor's register cell for one key, read from the node named.
//
// Only a 200 carries a cell: a refusal (the gate's 503 while the node's local
// database is not prepared, a malformed key) and a node that does not answer
// within five seconds are both no cell. An unbounded read hangs for undici's
// ~300s default and stalls a quorum verdict on one silent node; the quorum
// arithmetic already tolerates missing cells.

/**
 * @param {string} nodeUrl The node's API base URL.
 * @param {string} key `<identity>/<role>` or a row id.
 * @param {{generation?: number}} [options] A founder key's generation.
 * @returns {Promise<object|null>} The cell, or null when the node offers none.
 */
export async function readGrantRecord(nodeUrl, key, { generation } = {}) {
  const query = `key=${encodeURIComponent(key)}${generation === undefined ? '' : `&generation=${generation}`}`;
  try {
    const res = await fetch(`${nodeUrl}/flux/quorumgrant/record?${query}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data ?? null;
  } catch {
    return null;
  }
}
