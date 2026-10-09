// The lines a dump writes for a node's events: one per event, its id, when the
// client received it, and whether the node re-served it after a reconnect. An
// event served twice (a reconnect replays the ring) is written once.

/**
 * @param {Array<{id: number, at?: number, replayed?: boolean, event: string, data: *}>} events
 * @returns {string[]}
 */
export function eventLines(events) {
  const seen = new Set();
  const lines = [];
  for (const ev of events) {
    const data = JSON.stringify(ev.data);
    const key = `${ev.id}|${ev.event}|${data}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const when = ev.at ? new Date(ev.at).toISOString() : '-';
    lines.push(`#${ev.id} ${when}${ev.replayed ? ' replay' : ''} ${ev.event}: ${data}`);
  }
  return lines;
}
