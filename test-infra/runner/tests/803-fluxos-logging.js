// fleet: 1
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
  NDJSON_PREFIX, ISO_TIME, splitRecords, recordLabel, renderedHead, hasRecord, errorRecordFor, swapCase, firstLine,
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
// Suite 804 is the journald half.
//
// No assertion names a message the product logs. The debug download serves
// every record, so it is the reference the other endpoints are checked
// against; grep text is cut from a record the node wrote. The one record the
// suite causes is an error: a request that fails logs its Error, found by
// the message the route answered with.

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

  // The error record the suite's failing request produced, as the sink holds
  // it, and a token cut from its message for the grep and since filters.
  let provoked;
  let token;

  before(async function () {
    this.timeout(240000);
    env = await createTestEnv({ hookCtx: this, nodes: 1, tickerAutostart: false });
    client = env.clients[0];
    await client.waitForEvent('daemon:polled', () => true, 60000);
    ({ zelidauth } = await authenticate(client.url, fluxTeamKey()));

    // One failing request: an app nobody registered has no original owner.
    const askedAt = Date.now() - 1000;
    const res = await client.get(`/apps/apporiginalowner/e2elog${Date.now()}`, { noCache: true });
    expect(res.status).to.equal('error');
    const refusal = res.data.message;
    await waitFor(() => {
      provoked = errorRecordFor(parsedNdjson(), refusal, askedAt);
      return provoked !== null;
    }, { timeout: 15000, interval: 250, label: 'the refusal\'s error record on the stdout mirror' });
    // The stdout mirror and the rolling file are flushed independently; gate
    // the file through the endpoint that reads it.
    await waitFor(
      async () => hasRecord(splitRecords(await fetchText('/flux/debuglog')), provoked),
      { timeout: 15000, interval: 500, label: 'the error record readable through the log endpoint' },
    );
    token = provoked.msg.slice(-12);
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
      expect(record.msg, line.slice(0, 120)).to.be.a('string');
    }
  });

  it('honors logLevel debug and stamps exact numeric levels; errors carry err.stack on the line', function () {
    const levels = new Set(parsedNdjson().map((r) => r.level));
    // The harness runs logLevel 'debug': debug records exist beside info.
    expect(levels).to.include(20);
    expect(levels).to.include(30);

    expect(provoked.level).to.equal(50);
    expect(provoked.err, 'the err serializer keeps the Error structured').to.be.an('object');
    expect(provoked.err.stack, 'a stack with its frames').to.be.a('string').and.match(/\n\s+at /);
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
    for (const record of records) {
      expect(['ERROR', 'FATAL'], record.split('\n')[0]).to.include(recordLabel(record));
    }
    const rendered = records.find((r) => r.startsWith(renderedHead(provoked)));
    expect(rendered, 'the error record').to.exist;
    expect(rendered, 'stack rides the rendered record').to.match(/\n\s+at /);
  });

  it('serves the info download as only INFO records, every one the debug download holds', async function () {
    const reference = splitRecords(await fetchText('/flux/debuglog'));
    const records = splitRecords(await fetchText('/flux/infolog'));
    expect(records.length).to.be.greaterThan(0);
    for (const record of records) {
      expect(recordLabel(record), record.split('\n')[0]).to.equal('INFO');
    }
    const served = new Set(records.map(firstLine));
    for (const record of reference.filter((r) => recordLabel(r) === 'INFO')) {
      expect(served.has(firstLine(record)), `served by the info download: ${firstLine(record)}`).to.equal(true);
    }
    expect(hasRecord(records, provoked)).to.equal(false);
  });

  it('serves the warn download as only WARN records, every one the debug download holds', async function () {
    // A clean harness boot may warn zero times — the pin is exactness, not presence.
    const reference = splitRecords(await fetchText('/flux/debuglog'));
    const records = splitRecords(await fetchText('/flux/warnlog'));
    for (const record of records) {
      expect(recordLabel(record), record.split('\n')[0]).to.equal('WARN');
    }
    const served = new Set(records.map(firstLine));
    for (const record of reference.filter((r) => recordLabel(r) === 'WARN')) {
      expect(served.has(firstLine(record)), `served by the warn download: ${firstLine(record)}`).to.equal(true);
    }
    expect(hasRecord(records, provoked)).to.equal(false);
  });

  it('serves the debug download as everything — debug, info and error records together', async function () {
    const records = splitRecords(await fetchText('/flux/debuglog'));
    const labels = new Set(records.map((r) => recordLabel(r)));
    expect(labels).to.include('DEBUG');
    expect(labels).to.include('INFO');
    expect(labels).to.include('ERROR');
    expect(hasRecord(records, provoked)).to.equal(true);
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
    expect(hasRecord(splitRecords(errorTail.data.message), provoked)).to.equal(true);

    // Every record the info tail serves is an INFO record the info download holds.
    const infoTail = await client.getAuthed('/flux/tailinfolog', zelidauth);
    expect(infoTail.status).to.equal('success');
    const tailed = splitRecords(infoTail.data.message);
    expect(tailed.length).to.be.greaterThan(0).and.at.most(100);
    const infos = new Set(splitRecords(await fetchText('/flux/infolog')).map(firstLine));
    for (const record of tailed) {
      expect(recordLabel(record)).to.equal('INFO');
      expect(infos.has(firstLine(record)), firstLine(record)).to.equal(true);
    }
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
    const recent = splitRecords(await fetchText(`/flux/debuglog?since=2h&grep=${encodeURIComponent(token)}`));
    expect(hasRecord(recent, provoked)).to.equal(true);

    // Absolute ISO cutoff in the future: no record qualifies.
    const future = await fetchText('/flux/debuglog?since=2099-01-01T00:00:00.000Z');
    expect(future).to.equal('');
  });

  it('honors the grep filter case-insensitively over the rendered lines', async function () {
    const records = splitRecords(await fetchText(`/flux/debuglog?grep=${encodeURIComponent(swapCase(token))}`));
    expect(records.length).to.be.greaterThan(0);
    for (const record of records) {
      expect(record.toLowerCase()).to.include(token.toLowerCase());
    }
    // Matched case-insensitively, served verbatim.
    expect(hasRecord(records, provoked)).to.equal(true);
  });

  it('writes the same NDJSON to the rolling fluxos.N.log beside the checkout', async function () {
    const file = await newestLogFile();

    const held = await execInContainer(client.container, `grep -cF '"time":"${provoked.time}"' ${file}`);
    expect(Number(held.stdout.trim()), 'the error record reached the file sink').to.be.greaterThan(0);

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
