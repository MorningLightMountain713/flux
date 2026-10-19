'use strict';

/**
 * What held this process's boot up, read from a capability snapshot
 * (capabilities.snapshot()). A capability counts at its first rise in this
 * process; a later fall and rise is in its transitions, not here.
 *
 * What a capability waited on is, of the prerequisites it declares and the
 * capabilities the code bringing it up waited for, the one that came up last
 * before it did. A capability that rose with none of them still down waited on
 * its own owner, and names none.
 */

/**
 * The prerequisite or waited-for capability that came up last, at or before
 * the capability's own first rise.
 * @param {object} capability a snapshot entry that has come up
 * @param {Map<string, object>} byName
 * @returns {string|null}
 */
function lastPrerequisite(capability, byName) {
  let latest = null;
  new Set([...capability.needs, ...capability.waits]).forEach((name) => {
    const prerequisite = byName.get(name);
    if (!prerequisite?.firstUp || prerequisite.firstUp.at > capability.firstUp.at) return;
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
 * What decided when the last capability came up: from the first link, which
 * waited on nothing, to the last capability to come up, each link what the
 * next waited on. Capabilities rising in the same millisecond are taken in
 * declaration order, where a prerequisite is listed before what needs it; a
 * capability is in the chain once.
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
  const seen = new Set();
  while (current && !seen.has(current.name)) {
    seen.add(current.name);
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
