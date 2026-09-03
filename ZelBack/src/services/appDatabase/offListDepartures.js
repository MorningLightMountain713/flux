'use strict';

const { RUNNING_EXPIRY_MS } = require('../utils/appConstants');
const { normalizeSocketAddress } = require('../utils/socketAddressUtils');

// Liveness layer 3 (decided 2026-07-26, built 2026-09-03 as R10 of the
// node-down design): rows of an address no longer on the deterministic node
// list are negated by local derivation. Every node holds the list and every
// copy converges from chain, so the negation converges fleet-wide with no
// traffic — and a node whose daemon says "not confirmed" is off the list
// everywhere within a block or two, which closes the two hours the fleet
// would otherwise believe its apps ran (NODE_DOWN_SCENARIOS.md §3 H).
//
// The grace covers only the OBSERVER's own staleness — the 30 s fetch
// throttle, a block of daemon lag, one errored fetch: an address gone for
// four consecutive refreshes has left. There is no subject-side case: a node
// that leaves the list has genuinely left, and a negation is a view-time
// filter, so a false one reverses itself the moment the observer's list
// catches up. The pathology a longer grace would insure against is the
// observer's own daemon lying — a mid-reindex or a truncated list making a
// chunk of the network vanish at once — and that is caught by its own
// guard: a refresh that removes more than a sanity fraction of the known
// addresses records nothing and the known list holds.
//
// The deny set is the departures past the grace, and an entry ages out at
// the location TTL: an address gone that long has no rows left to negate.
// Nothing here is stored or sent; after a reboot the register is empty and
// a boot sweep of the row addresses not on the current list starts their
// grace from that observation.

const OFF_LIST_GRACE_MS = 2 * 60 * 1000;
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
  /** The addresses on the last trusted list, normalized. */
  #known = new Set();

  /** address (normalized) -> epoch ms first seen missing */
  #missingSince = new Map();

  /**
   * A refresh of the node list.
   *
   * @param {Iterable<string>} addresses the listed nodes' addresses
   * @param {number} [nowMs]
   * @returns {{departed: number, distrusted: boolean}}
   */
  noteList(addresses, nowMs = Date.now()) {
    const current = new Set();
    for (const address of addresses) {
      const normalized = normalizeSocketAddress(address);
      if (normalized) current.add(normalized);
    }
    if (this.#known.size === 0) {
      this.#known = current;
      return { departed: 0, distrusted: false };
    }
    const gone = [...this.#known].filter((address) => !current.has(address));
    if (gone.length > MASS_DEPARTURE_FRACTION * this.#known.size) {
      return { departed: 0, distrusted: true };
    }
    gone.forEach((address) => {
      if (!this.#missingSince.has(address)) this.#missingSince.set(address, nowMs);
    });
    current.forEach((address) => this.#missingSince.delete(address));
    this.#known = current;
    return { departed: gone.length, distrusted: false };
  }

  /**
   * The boot sweep: row addresses that are not on the current list start
   * their grace now — a rebooted node negates nothing prematurely.
   *
   * @param {Iterable<string>} addresses distinct row addresses
   * @param {number} [nowMs]
   */
  seedFromRows(addresses, nowMs = Date.now()) {
    for (const address of addresses) {
      const normalized = normalizeSocketAddress(address);
      if (normalized && !this.#known.has(normalized) && !this.#missingSince.has(normalized)) {
        this.#missingSince.set(normalized, nowMs);
      }
    }
  }

  /**
   * The addresses whose rows the derivation negates now, in every form a
   * row may carry them.
   *
   * @param {number} [nowMs]
   * @returns {string[]}
   */
  denySet(nowMs = Date.now()) {
    const denied = [];
    this.#missingSince.forEach((since, address) => {
      const gone = nowMs - since;
      if (gone > RUNNING_EXPIRY_MS) {
        this.#missingSince.delete(address);
        return;
      }
      if (gone > OFF_LIST_GRACE_MS) denied.push(...denyForms(address));
    });
    return denied;
  }

  resetForTests() {
    this.#known = new Set();
    this.#missingSince = new Map();
  }
}

// The one register a node keeps.
const departures = new OffListDepartures();

module.exports = {
  OffListDepartures,
  departures,
  OFF_LIST_GRACE_MS,
  MASS_DEPARTURE_FRACTION,
};
