const config = require('config');

const log = require('../../lib/log');
const daemonServiceUtils = require('./daemonServiceUtils');
const nodeListSource = require('../nodeListSource');

/**
 * Reports what the node actually asked the daemon for, and what the daemon pushed back.
 *
 * Both halves were previously invisible. RPC calls were never counted anywhere, so the
 * traffic this workstream removed could only be argued from the poll intervals in the
 * source. Deltas logged only when something went wrong, which left a working node and a
 * dead one saying exactly the same nothing.
 *
 * One line, on an interval, rather than a line per block: deltas arrive every ~30s and
 * almost all of them are unremarkable. Anything that went wrong has already logged at the
 * moment it happened, so this is the positive signal, not the alarm.
 */

let timer = null;

function formatCalls(counts) {
  if (!counts.size) return 'none';

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([method, count]) => `${method} ${count}`)
    .join(', ');
}

function formatDeltas(summary) {
  if (!summary.deltas) return 'no deltas applied';

  const span = summary.fromHeight === null
    ? `${summary.deltas}`
    : `${summary.deltas} over ${summary.fromHeight}→${summary.toHeight}`;

  return `${span}, ${summary.added} added / ${summary.removed} removed / ${summary.updated} updated`;
}

/**
 * Emits one report covering the window since the last one.
 * @returns {void}
 */
function report() {
  const counts = daemonServiceUtils.takeRpcCallCounts();
  const deltas = nodeListSource.takeAppliedSummary();
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

  log.info(`daemonUsage - rpc calls ${total} (${formatCalls(counts)}); node list ${formatDeltas(deltas)}`);
}

/**
 * Begins reporting. Safe to call more than once.
 * @returns {void}
 */
function start() {
  if (timer) return;

  timer = setInterval(report, config.daemon.subscriptions.usageReportIntervalMs);
  // The report is a diagnostic; it must never be the reason a node stays awake.
  if (timer.unref) timer.unref();
}

/**
 * Stops reporting.
 * @returns {void}
 */
function stop() {
  if (!timer) return;

  clearInterval(timer);
  timer = null;
}

module.exports = {
  report,
  start,
  stop,
};
