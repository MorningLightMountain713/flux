'use strict';

/**
 * What held this process's boot up, read from a capability snapshot
 * (capabilities.snapshot()). A capability counts at its first rise in this
 * process; a later fall and rise is in its transitions, not here.
 *
 * What a capability waited on is the prerequisite it declares that came up
 * last before it did. A capability that rose with no prerequisite still down
 * waited on its own owner, and names none.
 */

/**
 * The declared prerequisite of a capability that came up last before it did.
 * @param {object} capability a snapshot entry that has come up
 * @param {Map<string, object>} byName
 * @returns {string|null}
 */
function lastPrerequisite(capability, byName) {
  let latest = null;
  capability.needs.forEach((need) => {
    const prerequisite = byName.get(need);
    if (!prerequisite?.firstUp) return;
    if (!latest || prerequisite.firstUp.at >= latest.firstUp.at) latest = prerequisite;
  });
  return latest ? latest.name : null;
}

/**
 * Every capability, slowest to come up first, and every one that never has
 * ahead of them all.
 *
 * `upAfterMs` is the time from the process start to its first rise and
 * `comingUpMs` the part of it spent coming up, held below a prerequisite; both
 * are null for a capability that never came up, whose `waitedOn` is what it
 * waits on now (its own name while its owner has not raised it).
 * @param {object[]} snapshot
 * @param {number} startedAt the process start, ms since the epoch
 * @returns {Array<{name: string, upAfterMs: number|null, comingUpMs: number|null,
 *   waitedOn: string|null, state: string, reason: string}>}
 */
function blame(snapshot, startedAt) {
  const byName = new Map(snapshot.map((capability) => [capability.name, capability]));
  const rows = snapshot.map((capability) => ({
    name: capability.name,
    upAfterMs: capability.firstUp ? capability.firstUp.at - startedAt : null,
    comingUpMs: capability.firstUp ? capability.firstUp.comingUpMs : null,
    waitedOn: capability.firstUp ? lastPrerequisite(capability, byName) : capability.waitingOn,
    state: capability.state,
    reason: capability.reason,
  }));
  const order = (row) => row.upAfterMs ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => order(b) - order(a) || a.name.localeCompare(b.name));
}

/**
 * The prerequisites that decided when the last capability came up: from the
 * first link, which waited on nothing, to the last capability to come up.
 * Capabilities rising in the same millisecond are taken in declaration order,
 * where a prerequisite is listed before what needs it.
 * @param {object[]} snapshot
 * @param {number} startedAt the process start, ms since the epoch
 * @returns {Array<{name: string, upAfterMs: number, comingUpMs: number}>}
 */
function criticalChain(snapshot, startedAt) {
  const byName = new Map(snapshot.map((capability) => [capability.name, capability]));
  const up = snapshot.filter((capability) => capability.firstUp);
  if (up.length === 0) return [];
  let current = up.reduce((last, capability) => (capability.firstUp.at >= last.firstUp.at ? capability : last));
  const chain = [];
  while (current) {
    chain.push({
      name: current.name,
      upAfterMs: current.firstUp.at - startedAt,
      comingUpMs: current.firstUp.comingUpMs,
    });
    const prerequisite = lastPrerequisite(current, byName);
    current = prerequisite ? byName.get(prerequisite) : null;
  }
  return chain.reverse();
}

module.exports = {
  blame,
  criticalChain,
};
