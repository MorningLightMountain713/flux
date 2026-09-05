'use strict';

const config = require('config');
const { RUNNING_EXPIRY_MS } = require('../utils/appConstants');
const { normalizeSocketAddress } = require('../utils/socketAddressUtils');

// Liveness layer 3 (decided 2026-07-26, built 2026-09-03 as R10 of the
// node-down design): rows of an address no longer on the deterministic node
// list are negated by local derivation. Every node holds the list and every
// copy converges from chain, so the negation converges fleet-wide with no
// traffic. This replaced the nodeStatusMonitor eviction loop — a twenty-minute
// tick, an HTTP probe per off-list address, and an unsigned `evicted` event
// relayed by sync that nobody could verify — which is deleted.
//
// Each node's list is push-driven: a block event triggers the fetch, rate-
// capped at 30 s, and a skipped fetch is caught by the next block. A stale
// list can only DELAY a negation, never invent one. A false departure needs
// the observer's own daemon to answer with a list missing a node the chain
// still has — a short fork, or a partial fetch small enough to pass the
// mass-departure guard — and such a glitch lasts a block or two and corrects
// itself. The grace exists so that a glitch of that length cannot negate a
// live node's rows on this observer and hand its spawner a wrong count:
//   grace > 2 blocks of fork or skew + 1 capped fetch = 2 × 30 s + 30 s = 90 s
// at 30 s blocks; 120 s is the first round figure above it, four blocks.
// Nothing needs the rows gone sooner: the fleet refuses a delisted node's
// messages the moment it leaves the list, and the only effect of its rows
// lingering is that replacements are placed at two minutes rather than one.
// There is no subject-side case: a node that leaves the list has genuinely
// left, and a negation is a view-time filter, so a false one reverses itself
// the moment the observer's list catches up. The pathology a longer grace
// would insure against is the observer's own daemon lying wholesale — a
// mid-reindex or a truncated list making a chunk of the network vanish at
// once — and that is caught by its own guard: a refresh that removes more
// than a sanity fraction of the known addresses records nothing and the
// known list holds.
//
// A departure past the grace negates the rows the node announced BEFORE it
// left, and keeps negating them if the node comes back: a node that leaves
// the list removes its apps, so what it announced before is stale on its
// return, and only what it announces after it is back on the list counts.
// While the node is absent every row of its is older than its departure
// (the fleet refuses a delisted node's messages), so the whole address is
// denied; once it is back, the rows older than the return are. An entry
// ages out at the location TTL: an address gone that long has no rows left
// to negate. Nothing here is stored or sent; after a reboot the register is
// empty and a boot sweep of the row addresses not on the current list starts
// their grace from that observation.
//
// The same register, keyed on collateral outpoints, serves the mesh seats
// (quorumGrant/delistedHolders.js): a seat held by a node no longer on the
// list reads as free at the cells, with this grace and this guard.

// Two blocks of fork or skew plus one capped fetch is 90 s at 30 s blocks;
// 120 s is the first round figure above it, four blocks. A harness with
// shorter blocks carries the same figure in its own blocks.
const OFF_LIST_GRACE_MS = (config.fluxapps.offListGraceS ?? 120) * 1000;
const MASS_DEPARTURE_FRACTION = 0.1;
const DEFAULT_PORT_SUFFIX = ':16127';

// A row's `ip` is the announcer's own string: with its port, or bare for the
// default port. Deny both forms for a default-port node, the one form
// otherwise — the bare host still names the default-port node on that host.
function denyForms(address) {
  return address.endsWith(DEFAULT_PORT_SUFFIX)
    ? [address, address.slice(0, -DEFAULT_PORT_SUFFIX.length)]
    : [address];
}

class OffListDepartures {
  /** The keys on the last trusted list, normalized. */
  #known = new Set();

  /** key (normalized) -> {since: epoch ms first seen missing, returnedAt: epoch ms back on the list, or null} */
  #departed = new Map();

  #keyOf;

  #forms;

  #expiryMs;

  /**
   * @param {object} [options]
   * @param {(raw: string) => string|null} [options.keyOf] normalizes a listed
   *   or row key; null drops it. Default: socket addresses.
   * @param {(key: string) => string[]} [options.forms] every form a row may
   *   carry the key in. Default: with and without the default port.
   * @param {number|null} [options.expiryMs] how long after its departure an
   *   entry is kept; null keeps it for good (write-once rows never age).
   *   Default: the running-row TTL.
   */
  constructor(options = {}) {
    this.#keyOf = options.keyOf ?? normalizeSocketAddress;
    this.#forms = options.forms ?? denyForms;
    this.#expiryMs = options.expiryMs === undefined ? RUNNING_EXPIRY_MS : options.expiryMs;
  }

  /**
   * A refresh of the node list.
   *
   * @param {Iterable<string>} keys the listed nodes' keys
   * @param {number} [nowMs]
   * @returns {{departed: number, distrusted: boolean}}
   */
  noteList(keys, nowMs = Date.now()) {
    const current = new Set();
    for (const raw of keys) {
      const key = this.#keyOf(raw);
      if (key) current.add(key);
    }
    if (this.#known.size === 0) {
      this.#known = current;
      return { departed: 0, distrusted: false };
    }
    const gone = [...this.#known].filter((key) => !current.has(key));
    if (gone.length > MASS_DEPARTURE_FRACTION * this.#known.size) {
      return { departed: 0, distrusted: true };
    }
    gone.forEach((key) => {
      if (!this.#departed.has(key)) this.#departed.set(key, { since: nowMs, returnedAt: null });
    });
    current.forEach((key) => {
      const entry = this.#departed.get(key);
      if (!entry) return;
      if (nowMs - entry.since <= OFF_LIST_GRACE_MS) {
        // back inside the grace: it never left, as far as this observer knows
        this.#departed.delete(key);
      } else if (entry.returnedAt === null) {
        entry.returnedAt = nowMs;
      }
    });
    this.#known = current;
    return { departed: gone.length, distrusted: false };
  }

  /**
   * The boot sweep: row keys that are not on the current list start their
   * grace now — a rebooted node negates nothing prematurely.
   *
   * @param {Iterable<string>} keys distinct row keys
   * @param {number} [nowMs]
   */
  seedFromRows(keys, nowMs = Date.now()) {
    for (const raw of keys) {
      const key = this.#keyOf(raw);
      if (key && !this.#known.has(key) && !this.#departed.has(key)) {
        this.#departed.set(key, { since: nowMs, returnedAt: null });
      }
    }
  }

  #sweep(nowMs) {
    if (this.#expiryMs === null) return;
    this.#departed.forEach((entry, key) => {
      if (nowMs - entry.since > this.#expiryMs) this.#departed.delete(key);
    });
  }

  /**
   * When the key's departure was first observed, if it is past the grace;
   * null while it is listed, or gone for less than the grace. A key that
   * came back after the grace still answers with its departure: what it
   * had before it left stays negated.
   *
   * @param {string} raw
   * @param {number} [nowMs]
   * @returns {number|null} epoch ms
   */
  departedSince(raw, nowMs = Date.now()) {
    this.#sweep(nowMs);
    const key = this.#keyOf(raw);
    const entry = key ? this.#departed.get(key) : undefined;
    if (!entry || nowMs - entry.since <= OFF_LIST_GRACE_MS) return null;
    return entry.since;
  }

  /**
   * What the derivation negates now: every row of a key still absent past
   * the grace, and the rows older than the return of a key that came back
   * after it — each in every form a row may carry the key.
   *
   * @param {number} [nowMs]
   * @returns {{absent: string[], returned: Array<{keys: string[], before: number}>}}
   */
  denySet(nowMs = Date.now()) {
    this.#sweep(nowMs);
    const absent = [];
    const returned = [];
    this.#departed.forEach((entry, key) => {
      if (nowMs - entry.since <= OFF_LIST_GRACE_MS) return;
      if (entry.returnedAt === null) absent.push(...this.#forms(key));
      else returned.push({ keys: this.#forms(key), before: entry.returnedAt });
    });
    return { absent, returned };
  }

  resetForTests() {
    this.#known = new Set();
    this.#departed = new Map();
  }
}

// The one register a node keeps for row addresses.
const departures = new OffListDepartures();

module.exports = {
  OffListDepartures,
  departures,
  OFF_LIST_GRACE_MS,
  MASS_DEPARTURE_FRACTION,
};
