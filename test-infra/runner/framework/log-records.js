// Shared primitives for the fluxos logging suites (803 file sink, 804
// journald sink). Both sinks carry the same pino NDJSON lines and the admin
// log endpoints render them identically — only the storage differs.

// pino always emits `level` as the first key, so a fluxos NDJSON line inside
// a mixed stream (container stdout, journal MESSAGEs) is exactly a line with
// this prefix.
export const NDJSON_PREFIX = '{"level":';

export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Endpoint rendering: `<iso-time> <LEVEL> <msg>`; a record's continuation
// lines (rendered error stacks) never start with an iso timestamp.
export const RECORD_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

// Rendered endpoint text -> records: a record starts at an "<iso> LEVEL ..."
// line; continuation lines attach to the record above them.
export function splitRecords(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (RECORD_START.test(line) || records.length === 0) records.push([line]);
    else records[records.length - 1].push(line);
  }
  return records.map((lines) => lines.join('\n')).filter((r) => r.trim() !== '');
}

export const recordLabel = (record) => record.split('\n')[0].split(' ')[1];

// A record's own line. Two downloads compare records by it: a raw stdout line
// folds into whichever record precedes it in each, which differs between them.
export const firstLine = (record) => record.split('\n')[0];

// The label an endpoint renders for each pino level.
export const LEVEL_LABELS = {
  10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL',
};

// The head an endpoint renders for one NDJSON record: `<time> <LABEL> `. It is
// how a suite finds, in an endpoint's text, a record it read from the sink.
export const renderedHead = (record) => `${record.time} ${LEVEL_LABELS[record.level]} `;

export const hasRecord = (records, record) => records.some((r) => r.startsWith(renderedHead(record)));

// A request that fails logs its Error at level 50. The record that refusal
// produced is the error record at or after `sinceMs` whose message is the one
// the route answered with: the node's two outputs agree, and the suite states
// neither.
export function errorRecordFor(ndjsonRecords, refusal, sinceMs) {
  return ndjsonRecords.find((r) => r.level === 50
    && new Date(r.time).getTime() >= sinceMs
    && r.err?.message === refusal) ?? null;
}

// A case-swapped copy, so a filter proven to match it matches case-insensitively.
export const swapCase = (text) => [...text]
  .map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
