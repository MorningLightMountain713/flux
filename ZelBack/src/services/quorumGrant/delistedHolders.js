'use strict';

const { OffListDepartures } = require('../appDatabase/offListDepartures');

// A delisted holder resolves to nobody (David, 2026-09-07; modelled in
// formal/ordinal-register, the or-delisted-* cells): a mesh seat whose
// holder's collateral outpoint is no longer on the deterministic node list
// reads as FREE at the cells at read time. A referee answers free for it and
// the joiner's probe-then-found takes it. No op, no message, no timer, no
// certificate, no jury — the list every node reads from the chain is the
// fact, exactly as the off-list negation of app rows works, and it carries
// that negation's two guards, shared not restated: the grace between
// confirmations that covers an observer's own stale list, and the
// mass-disappearance halt that ignores a refresh which empties a chunk of
// the network at once (a sick daemon, not a thousand departures).
//
// The register below is the off-list register keyed on outpoints instead of
// addresses, fed by the same list refresh. Its entries never age: a seat is
// write-once and has no TTL, so the one thing that ends a departure's effect
// on a seat is a founding that overwrites the row — by anyone, the returned
// holder included through the register's free-or-mine rule. A holder that
// comes back therefore finds its old seat still free (or taken) and founds
// again; it is never handed the old row back, because a node that left the
// list removed its apps and what it held before is stale.
//
// The predicate the register core reads (grantRegisterCore.viewed): a row is
// read as released when its holder departed past the grace AND the row was
// granted before that departure — a row the same node founds after it is
// back on the list is newer than its departure and reads as held.

function outpointKey(raw) {
  if (typeof raw !== 'string') return null;
  const [txhash, outidx] = raw.split(':');
  if (!/^[0-9a-f]{64}$/.test(txhash) || !/^\d{1,6}$/.test(outidx ?? '')) return null;
  return `${txhash}:${Number(outidx)}`;
}

function outpointOf(entry) {
  if (!entry || typeof entry.txhash !== 'string' || entry.outidx === undefined || entry.outidx === null) return null;
  return outpointKey(`${entry.txhash}:${entry.outidx}`);
}

// The one register a node keeps for seat holders.
const holders = new OffListDepartures({ keyOf: outpointKey, forms: (key) => [key], expiryMs: null });

/**
 * A refresh of the deterministic node list, as the state manager holds it.
 *
 * @param {Iterable<{txhash: string, outidx: number|string}>} entries
 * @param {number} [nowMs]
 * @returns {{departed: number, distrusted: boolean}}
 */
function noteList(entries, nowMs = Date.now()) {
  const keys = [];
  for (const entry of entries) {
    const key = outpointOf(entry);
    if (key) keys.push(key);
  }
  return holders.noteList(keys, nowMs);
}

/**
 * The boot sweep: the holders of the seats this cell's register records that
 * are not on the current list start their grace now.
 *
 * @param {Iterable<string>} outpoints
 * @param {number} [nowMs]
 */
function seedFromRows(outpoints, nowMs = Date.now()) {
  holders.seedFromRows(outpoints, nowMs);
}

/**
 * Whether a seat granted at `acceptedAt` to `outpoint` reads as released:
 * the holder left the list past the grace, and the seat predates that
 * departure.
 *
 * @param {string} outpoint the row's grantee
 * @param {number} acceptedAt this cell's clock at the grant; 0 for a row
 *   from before the stamp existed (older than any departure)
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function isDelistedHolder(outpoint, acceptedAt, nowMs = Date.now()) {
  const since = holders.departedSince(outpoint, nowMs);
  return since !== null && (acceptedAt ?? 0) < since;
}

function resetForTests() {
  holders.resetForTests();
}

module.exports = {
  outpointKey,
  noteList,
  seedFromRows,
  isDelistedHolder,
  resetForTests,
};
