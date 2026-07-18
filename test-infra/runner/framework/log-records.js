// Shared primitives for the fluxos logging suites (71 file-sink, 72
// journald-sink). Both sinks carry the same pino NDJSON lines and the admin
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
