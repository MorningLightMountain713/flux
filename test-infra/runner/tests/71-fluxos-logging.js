import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { waitFor } from '../framework/wait.js';
import { execInContainer } from '../framework/container.js';
import { authenticate } from '../auth.js';
import { fluxTeamKey } from '../framework/keys.js';
import {
  NDJSON_PREFIX, ISO_TIME, splitRecords, recordLabel,
} from '../framework/log-records.js';

// FluxOS logging (pino NDJSON, one sink — ZelBack/src/lib/log.js): harness
// containers run the NON-journald mode (no systemd, so no JOURNAL_STREAM),
// which means the active sink is the pino-roll rolling file beside the
// checkout (fluxos.N.log — pino-roll numbers its files) with logConsole
// mirroring the same NDJSON to container stdout, where the log collectors
// read it. This suite pins that half of the sink matrix end to end:
//   - the NDJSON line shape on stdout (numeric level, iso time, msg),
//   - the admin log endpoints through the real API with zelidauth
//     (downloads = level-filtered attachments, tails = last-100 JSON
//     success, the lines/since/grep query filters),
//   - error-stack rendering on the served text,
//   - the in-container rolling file carrying the same NDJSON.
// The journald half (journalctl -u fluxos reads, server-side --since
// pushdown) CANNOT be harness-tested — the containers have no systemd — and
// belongs to the live stage-2 validation on a real Arcane node.
//
// Every content assertion is against self-provoked lines:
//   - POST /flux/adjustblockedports logs the submitted value at info
//     (`blockedPorts: <json>`) BEFORE validating, then throws a real Error
//     on a non-array — one call yields a unique info marker AND an error
//     record carrying a stack.
//   - GET /flux/tailbenchmarkdebug always shells out through
//     serviceHelper.runCommand, which logs `Run Cmd: ...` at debug before
//     executing — a guaranteed debug-level line (absent at the production
//     'info' level; the harness runs logLevel 'debug').

const MARKER = 'E2E-71-LOG-GREP-MARKER';
const PROVOKED_ERROR = 'Blocked Ports is not a valid array';

// Docker's json-file logger stores one entry per written line, splitting
// only lines that exceed its 16KB frame buffer — the head fragment of such a
// split is the only legitimately unparseable NDJSON-prefixed "line", and it
// is always ~16384 chars. Anything shorter must parse.
const DOCKER_LINE_SPLIT = 16000;

describe('fluxos logging: pino NDJSON sink and the admin log endpoints (non-journald mode)', function () {
  let env;
  let client;
  let zelidauth;

  // The stdout mirror lines, stripped of the collector's own capture stamp
  // (getLines prepends it), narrowed to fluxos NDJSON.
  const ndjsonLines = () => env.nodeLogLines(0)
    .map((entry) => entry.slice(entry.indexOf(' ') + 1))
    .filter((line) => line.startsWith(NDJSON_PREFIX));

  // Tolerant variant for content lookups: shape violations are scenario 1's
  // job, so an unparseable line here is skipped, not thrown on.
  const parsedNdjson = () => ndjsonLines().flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

  // Raw fetches: the download endpoints serve text attachments, which the
  // node client's JSON helpers cannot carry.
  const fetchRaw = (path) => fetch(`${client.url}${path}`, { headers: { zelidauth } });
  const fetchText = async (path) => (await fetchRaw(path)).text();

  // The rolling file pino-roll is currently writing inside the node
  // container (WORKDIR /flux, so the checkout-adjacent path is /flux).
  async function newestLogFile() {
    const { stdout } = await execInContainer(client.container, 'ls -v /flux/fluxos.*.log 2>/dev/null | tail -1');
    const file = stdout.trim();
    expect(file, 'rolling fluxos.N.log exists in-container').to.match(/fluxos\.\d+\.log$/);
    return file;
  }

  before(async function () {
    this.timeout(240000);
    env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false });
    client = env.clients[0];
    // Anchor on a boot log line the same way suite 02 does: the SSE gate in
    // createTestEnv and the docker log pipeline are separate channels.
    await waitFor(
      () => env.nodeHasLog(0, 'Daemon Sync status'),
      { timeout: 10000, interval: 250, label: 'boot log lines reached the collector' },
    );
    ({ zelidauth } = await authenticate(client.url, fluxTeamKey()));

    // Provocations (see the header): one guaranteed debug line...
    await client.getAuthed('/flux/tailbenchmarkdebug', zelidauth);
    // ...and one info marker + one stack-carrying error from a single call.
    const res = await client.post('/flux/adjustblockedports', { blockedPorts: MARKER }, { zelidauth });
    expect(res.status).to.equal('error');
    expect(res.data.message).to.equal(PROVOKED_ERROR);

    // De-race both sinks before any assertion: the stdout mirror and the
    // rolling file are fed by the same transport worker but flushed
    // independently. Gate the file through the endpoint that reads it.
    await waitFor(
      () => env.nodeHasLog(0, MARKER) && env.nodeHasLog(0, PROVOKED_ERROR),
      { timeout: 15000, interval: 250, label: 'provoked lines on the stdout mirror' },
    );
    await waitFor(
      async () => (await fetchText(`/flux/debuglog?grep=${MARKER.toLowerCase()}`)).includes(MARKER),
      { timeout: 15000, interval: 500, label: 'provoked marker readable through the log endpoint' },
    );
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('mirrors NDJSON to stdout: every fluxos line parses with numeric level and iso time', function () {
    const lines = ndjsonLines();
    expect(lines.length, 'a debug-level boot writes a substantial stream').to.be.greaterThan(50);
    for (const line of lines) {
      if (line.length > DOCKER_LINE_SPLIT) continue; // json-file split fragment
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`unparseable NDJSON line on stdout: ${line.slice(0, 200)}`);
      }
      expect(record.level, line.slice(0, 120)).to.be.a('number');
      expect(record.level, line.slice(0, 120)).to.be.oneOf([10, 20, 30, 40, 50, 60]);
      expect(record.time, line.slice(0, 120)).to.be.a('string').and.match(ISO_TIME);
    }
    // Known boot lines ride as structured records with a string msg.
    const msgs = parsedNdjson().map((r) => r.msg);
    expect(msgs.some((m) => typeof m === 'string' && m.includes('Local database prepared'))).to.equal(true);
    expect(msgs.some((m) => typeof m === 'string' && m.includes('Daemon Sync status'))).to.equal(true);
  });

  it('honors logLevel debug and stamps exact numeric levels; errors carry err.stack on the line', function () {
    const records = parsedNdjson();

    const info = records.find((r) => r.msg === `blockedPorts: ${JSON.stringify(MARKER)}`);
    expect(info, 'provoked info marker line').to.exist;
    expect(info.level).to.equal(30);

    const error = records.find((r) => r.msg === PROVOKED_ERROR);
    expect(error, 'provoked error line').to.exist;
    expect(error.level).to.equal(50);
    expect(error.err, 'the err serializer keeps the Error structured').to.be.an('object');
    expect(error.err.stack).to.be.a('string').and.include('adjustBlockedPorts');

    // Present only because the harness runs logLevel 'debug' — at the
    // production 'info' default this line would not exist.
    const debug = records.find((r) => typeof r.msg === 'string' && r.msg.startsWith('Run Cmd: tail -n 100'));
    expect(debug, 'provoked debug line').to.exist;
    expect(debug.level).to.equal(20);
  });

  it('rejects log reads without adminandfluxteam auth', async function () {
    const download = await (await fetch(`${client.url}/flux/errorlog`)).json();
    expect(download.status).to.equal('error');
    expect(download.data.name).to.equal('Unauthorized');

    const tail = await client.get('/flux/tailerrorlog');
    expect(tail.status).to.equal('error');
    expect(tail.data.name).to.equal('Unauthorized');
  });

  it('serves the error download as an attachment of only ERROR/FATAL records with rendered stacks', async function () {
    const res = await fetchRaw('/flux/errorlog');
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-disposition')).to.include('attachment').and.include('error.log');

    const records = splitRecords(await res.text());
    expect(records.length).to.be.greaterThan(0);
    for (const record of records) {
      expect(['ERROR', 'FATAL'], record.split('\n')[0]).to.include(recordLabel(record));
    }

    const provoked = records.find((r) => r.includes(PROVOKED_ERROR));
    expect(provoked, 'provoked error record').to.exist;
    expect(provoked, 'stack rides the rendered record').to.match(/\n\s+at /);
    expect(provoked).to.include('adjustBlockedPorts');
  });

  it('serves the info download as only INFO records, excluding error and debug lines', async function () {
    const records = splitRecords(await fetchText('/flux/infolog'));
    expect(records.length).to.be.greaterThan(0);
    for (const record of records) {
      expect(recordLabel(record), record.split('\n')[0]).to.equal('INFO');
    }
    expect(records.some((r) => r.includes(MARKER))).to.equal(true);
    expect(records.some((r) => r.includes(PROVOKED_ERROR))).to.equal(false);
    expect(records.some((r) => r.includes('Run Cmd: tail -n 100'))).to.equal(false);
  });

  it('serves the warn download as only WARN records, excluding the provoked lines', async function () {
    // A clean harness boot may warn zero times — the pin is exclusivity
    // (exact-level semantics), not presence.
    const records = splitRecords(await fetchText('/flux/warnlog'));
    for (const record of records) {
      expect(recordLabel(record), record.split('\n')[0]).to.equal('WARN');
    }
    expect(records.some((r) => r.includes(MARKER))).to.equal(false);
    expect(records.some((r) => r.includes(PROVOKED_ERROR))).to.equal(false);
  });

  it('serves the debug download as everything — info, error and debug lines together', async function () {
    const records = splitRecords(await fetchText('/flux/debuglog'));
    expect(records.some((r) => r.includes(MARKER))).to.equal(true);
    expect(records.some((r) => r.includes(PROVOKED_ERROR))).to.equal(true);
    expect(records.some((r) => r.includes('Run Cmd: tail -n 100'))).to.equal(true);
    const labels = new Set(records.map((r) => recordLabel(r)));
    expect(labels).to.include('INFO');
    expect(labels).to.include('ERROR');
    expect(labels).to.include('DEBUG');
  });

  it('tails return the last 100 records as a JSON success message', async function () {
    this.timeout(180000);
    // Make the 100-record cap the binding constraint before asserting it.
    const file = await newestLogFile();
    await waitFor(async () => {
      const { stdout } = await execInContainer(client.container, `wc -l < ${file}`);
      return Number(stdout.trim()) >= 120;
    }, { timeout: 120000, interval: 2000, label: 'sink holds >= 120 records' });

    // The file read can transiently catch the newest line mid-write (the
    // transport's flushes are not line-aligned); such a partial folds into
    // the record above it and shifts the count by one. Retry until the read
    // lands on a settled line boundary — a broken cap never converges.
    await waitFor(async () => {
      const tail = await client.getAuthed('/flux/taildebuglog', zelidauth);
      return tail.status === 'success'
        && typeof tail.data.message === 'string'
        && splitRecords(tail.data.message).length === 100;
    }, { timeout: 30000, interval: 1000, label: 'taildebuglog serves exactly the last 100 records' });

    const errorTail = await client.getAuthed('/flux/tailerrorlog', zelidauth);
    expect(errorTail.status).to.equal('success');
    expect(errorTail.data.message).to.include(PROVOKED_ERROR);

    const infoTail = await client.getAuthed('/flux/tailinfolog', zelidauth);
    expect(infoTail.status).to.equal('success');
    expect(infoTail.data.message).to.include(MARKER);
  });

  it('honors the lines filter on downloads and tails', async function () {
    // Retried for the same mid-write partial-line transient as the tail cap.
    await waitFor(async () => {
      const one = splitRecords(await fetchText('/flux/infolog?lines=1'));
      return one.length === 1 && recordLabel(one[0]) === 'INFO';
    }, { timeout: 30000, interval: 1000, label: 'infolog?lines=1 serves exactly one INFO record' });

    await waitFor(async () => {
      const five = await client.getAuthed('/flux/taildebuglog?lines=5', zelidauth);
      return five.status === 'success' && splitRecords(five.data.message).length === 5;
    }, { timeout: 30000, interval: 1000, label: 'taildebuglog?lines=5 serves exactly five records' });
  });

  it('honors the since filter in both relative and absolute forms', async function () {
    // Relative window: the sink is minutes old, so 2h spans all of it and
    // composes with grep.
    const recent = await fetchText(`/flux/debuglog?since=2h&grep=${MARKER.toLowerCase()}`);
    expect(recent).to.include(MARKER);

    // Absolute ISO cutoff in the future: no record qualifies.
    const future = await fetchText('/flux/debuglog?since=2099-01-01T00:00:00.000Z');
    expect(future).to.equal('');
  });

  it('honors the grep filter case-insensitively over the rendered lines', async function () {
    const records = splitRecords(await fetchText(`/flux/debuglog?grep=${MARKER.toLowerCase()}`));
    expect(records.length).to.be.greaterThan(0);
    for (const record of records) {
      expect(record.toLowerCase()).to.include(MARKER.toLowerCase());
    }
    // Matched case-insensitively, served verbatim.
    expect(records.some((r) => r.includes(MARKER))).to.equal(true);
  });

  it('writes the same NDJSON to the rolling fluxos.N.log beside the checkout', async function () {
    const file = await newestLogFile();

    const marker = await execInContainer(client.container, `grep -c ${MARKER} ${file}`);
    expect(Number(marker.stdout.trim()), 'provoked marker reached the file sink').to.be.greaterThan(0);

    const { stdout } = await execInContainer(client.container, `tail -n 30 ${file}`);
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines.length).to.be.greaterThan(10);
    // The final line may be a mid-write partial; every settled line must be
    // a complete NDJSON record.
    for (const line of lines.slice(0, -1)) {
      const record = JSON.parse(line);
      expect(record.level, line.slice(0, 120)).to.be.a('number');
      expect(record.time, line.slice(0, 120)).to.be.a('string').and.match(ISO_TIME);
    }
  });
});
