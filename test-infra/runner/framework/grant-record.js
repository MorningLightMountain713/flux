// A grantor's register cell for one key, read from the node named.
//
// Only a 200 carries a cell: a refusal (the gate's 503 while the node's local
// database is not prepared, a malformed key) and a node that does not answer
// within five seconds are both no cell. An unbounded read hangs for undici's
// ~300s default and stalls a quorum verdict on one silent node; the quorum
// arithmetic already tolerates missing cells.

import { waitFor } from './wait.js';

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

/**
 * Every node named answers its record read for the key with `refereeing: true`:
 * its boot sync is complete and the serve gates would take an ask. Asked of the
 * cells themselves, never inferred from time.
 * @param {Array<{url: string, num: number, ip: string}>} clients The cells.
 * @param {string} key `<identity>/<role>` or a row id.
 * @param {{timeout?: number}} [options]
 */
export async function waitForCellsRefereeing(clients, key, { timeout = 180000 } = {}) {
  await waitForCells(clients, key, 'refereeing', timeout, 'referee again');
}

/**
 * Every node named answers its record read for the key with `serving: true`:
 * refereeing AND past its rejoin drain, so an ask lands as a row rather than a
 * `draining` refusal. A cell still draining at an ask records no row and is
 * not a referee when the cells are read.
 * @param {Array<{url: string, num: number, ip: string}>} clients The cells.
 * @param {string} key `<identity>/<role>` or a row id.
 * @param {{timeout?: number}} [options]
 */
export async function waitForCellsServing(clients, key, { timeout = 180000 } = {}) {
  await waitForCells(clients, key, 'serving', timeout, 'serve');
}

async function waitForCells(clients, key, field, timeout, verb) {
  const names = clients.map((c) => `node-${c.num} (${c.ip})`).join(', ');
  await waitFor(async () => {
    const cells = await Promise.all(clients.map((c) => readGrantRecord(c.url, key)));
    return cells.every((cell) => cell?.[field] === true);
  }, { timeout, interval: 5000, label: `cells ${names} ${verb} ${key}` });
}
