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

/**
 * The term a quorum of cells stands on for a key: the grantee at least `quorum`
 * live cells (granted, not released, time left) name, with the highest epoch and
 * generation among them; null when no grantee has a quorum.
 * @param {Array<{url: string}>} clients The cells; a missing client is skipped.
 * @param {string} key `<identity>/<role>`.
 * @param {{quorum: number}} options How many cells make a quorum.
 * @returns {Promise<{grantee: string, epoch: number, generation: number}|null>}
 */
export async function grantVerdict(clients, key, { quorum }) {
  const cells = await Promise.all(clients.filter(Boolean).map((c) => readGrantRecord(c.url, key)));
  const live = cells.filter((c) => c?.accepted?.grantee && !c.accepted.released && c.remainingMs !== 0);
  const byGrantee = new Map();
  for (const cell of live) {
    const list = byGrantee.get(cell.accepted.grantee) ?? [];
    list.push(cell.accepted);
    byGrantee.set(cell.accepted.grantee, list);
  }
  for (const [grantee, accepted] of byGrantee.entries()) {
    if (accepted.length >= quorum) {
      return {
        grantee,
        epoch: Math.max(...accepted.map((a) => a.epoch)),
        generation: Math.max(...accepted.map((a) => a.generation ?? 0)),
      };
    }
  }
  return null;
}

/**
 * The grant plane on, at harness timescales: a held term outlives two failed
 * pass cycles (about 35 s each under a partition), and the plane governs from
 * the floor already in force.
 * @param {object} [extra] - fluxapps settings the suite adds or overrides
 * @returns {object} fluxapps config overrides
 */
export function grantPlaneOverrides(extra = {}) {
  return {
    quorumGrantMastership: true,
    quorumGrantHeldTtlMs: 90000,
    quorumGrantRenewIntervalMs: 10000,
    quorumGrantLockDelayMs: 15000,
    quorumGrantDemotionSlackMs: 5000,
    quorumGrantMaxTtlMs: 120000,
    quorumGrantDrainMs: 90000,
    quorumGrantMinHolderAgeMs: 0,
    quorumGrantPursuitIntervalMs: 10000,
    ...extra,
  };
}
