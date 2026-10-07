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
  NDJSON_PREFIX, ISO_TIME, splitRecords, recordLabel, renderedHead, hasRecord, errorRecordFor, swapCase, firstLine, isLogged,
} from '../framework/log-records.js';

// FluxOS logging, journald half (suite 803 covers the file-sink half): the
// fleet boots in systemdMode — a real systemd runs as PID 1 in the node
// container, fluxos is a genuine `fluxos.service` unit with its stdout
// journal-connected, and systemd sets JOURNAL_STREAM, the structural trigger
// lib/log.js keys on. This is the Arcane sink mode: no rolling file exists,
// journald owns the lines, and the admin log endpoints read them back
// through `journalctl -u fluxos -o json` — including the server-side
// `--since @epoch` pushdown that file mode has no equivalent of.
//
// What this suite deliberately does NOT claim: the real ISO's unit file and
// environment (the harness unit is an adaptation — same name, same
// journal-connected stdout, different paths), journald persistence across
// boots, and the config-stack TUI journal panes. Those remain live-node
// validation on a real Arcane image.
//
// No assertion names a message the product logs, as in suite 803: the debug
// download is the reference the other endpoints are checked against, grep
// text is cut from a record the node wrote, and the one record the suite
// causes is the error a failing request logs, found by the message the route
// answered with.

describe('fluxos logging: journald sink under a real systemd unit', function () {
  let env;
  let client;
  let zelidauth;

  const fetchRaw = (path) => fetch(`${client.url}${path}`, { headers: { zelidauth } });
  const fetchText = async (path) => (await fetchRaw(path)).text();

  // The unit's journal MESSAGEs, newest last. -o cat strips journal
  // metadata down to the raw payload — the same field the endpoints parse.
  async function journalLines(args = '') {
    const { stdout } = await execInContainer(
      client.container,
      `journalctl -u fluxos -o cat --no-pager ${args}`,
    );
    return stdout.split('\n').filter(Boolean);
  }

  const journalNdjson = async (args) => (await journalLines(args))
    .filter((line) => line.startsWith(NDJSON_PREFIX))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

  // The error record the suite's failing request produced, as the journal
  // holds it, and a token cut from its message for the grep and since filters.
  let provoked;
  let token;

  before(async function () {
    this.timeout(240000);
    // shutdownd explicitly 'none': the stub is started by the default
    // entrypoint path, which systemd mode replaces; nothing here stops apps.
    env = await createTestEnv({
      hookCtx: this, nodes: 1, tickerAutostart: false, systemdMode: true, shutdownd: 'none',
    });
    client = env.clients[0];
    ({ zelidauth } = await authenticate(client.url, fluxTeamKey()));

    // One failing request: an app nobody registered has no original owner.
    const askedAt = Date.now() - 1000;
    const res = await client.get(`/apps/apporiginalowner/e2elog${Date.now()}`, { noCache: true });
    expect(res.status).to.equal('error');
    const refusal = res.data.message;
    await waitFor(async () => {
      provoked = errorRecordFor(await journalNdjson(), refusal, askedAt);
      return provoked !== null;
    }, { timeout: 15000, interval: 500, label: 'the refusal\'s error record in the journal' });
    await waitFor(
      async () => hasRecord(splitRecords(await fetchText('/flux/debuglog')), provoked),
      { timeout: 15000, interval: 500, label: 'the error record readable through the log endpoint' },
    );
    token = provoked.msg.slice(-12);
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('selects the journald sink: journal carries the lines and no rolling file exists', async function () {
    const lines = await journalLines('-n 500');
    expect(lines.length, 'journal holds the fluxos stream').to.be.greaterThan(50);

    // JOURNAL_STREAM detection picked journald mode, so the pino-roll file
    // half must be entirely absent — this is the mode-selection proof.
    const ls = await execInContainer(client.container, 'ls /flux/fluxos.*.log 2>/dev/null || true');
    expect(ls.stdout.trim()).to.equal('');
  });

  it('journals NDJSON: every fluxos line parses with numeric level and iso time', async function () {
    const raw = (await journalLines('-n 500')).filter((line) => line.startsWith(NDJSON_PREFIX));
    expect(raw.length).to.be.greaterThan(50);
    for (const line of raw) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error(`unparseable NDJSON line in the journal: ${line.slice(0, 200)}`);
      }
      expect(record.level, line.slice(0, 120)).to.be.a('number');
      expect(record.level, line.slice(0, 120)).to.be.oneOf([10, 20, 30, 40, 50, 60]);
      expect(record.time, line.slice(0, 120)).to.be.a('string').and.match(ISO_TIME);
      expect(record.msg, line.slice(0, 120)).to.be.a('string');
    }
  });

  it('honors logLevel debug and stamps exact numeric levels; errors carry err.stack', async function () {
    const levels = new Set((await journalNdjson()).map((r) => r.level));
    // The harness runs logLevel 'debug': debug records exist beside info.
    expect(levels).to.include(20);
    expect(levels).to.include(30);

    expect(provoked.level).to.equal(50);
    expect(provoked.err, 'the err serializer keeps the Error structured').to.be.an('object');
    expect(provoked.err.stack, 'a stack with its frames').to.be.a('string').and.match(/\n\s+at /);
  });

  it('serves the level downloads from the journal with the file-mode semantics', async function () {
    const res = await fetchRaw('/flux/errorlog');
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-disposition')).to.include('attachment').and.include('error.log');
    const errors = splitRecords(await res.text());
    for (const record of errors) {
      expect(['ERROR', 'FATAL'], record.split('\n')[0]).to.include(recordLabel(record));
    }
    const rendered = errors.find((r) => r.startsWith(renderedHead(provoked)));
    expect(rendered, 'the error record').to.exist;
    expect(rendered, 'stack rides the rendered record').to.match(/\n\s+at /);

    const reference = splitRecords(await fetchText('/flux/debuglog'));
    const labels = new Set(reference.map((r) => recordLabel(r)));
    expect(labels).to.include('DEBUG');
    expect(labels).to.include('INFO');
    expect(labels).to.include('ERROR');
    expect(hasRecord(reference, provoked)).to.equal(true);

    for (const [path, label] of [['/flux/infolog', 'INFO'], ['/flux/warnlog', 'WARN']]) {
      // eslint-disable-next-line no-await-in-loop
      const records = splitRecords(await fetchText(path));
      for (const record of records) {
        // the unit's raw stdout rides the info download unlabelled; warn serves none
        if (label === 'INFO' && !isLogged(record)) continue; // eslint-disable-line no-continue
        expect(recordLabel(record), `${path}: ${firstLine(record)}`).to.equal(label);
      }
      const served = new Set(records.map(firstLine));
      for (const record of reference.filter((r) => recordLabel(r) === label)) {
        expect(served.has(firstLine(record)), `served by ${path}: ${firstLine(record)}`).to.equal(true);
      }
      expect(hasRecord(records, provoked)).to.equal(false);
    }
  });

  it('tails return the last 100 records as a JSON success message', async function () {
    this.timeout(180000);
    // Make the 100-record cap the binding constraint before asserting it.
    await waitFor(async () => (await journalLines()).length >= 120,
      { timeout: 120000, interval: 2000, label: 'journal holds >= 120 lines' });

    // Journal entries are atomic (no mid-write partials), but a non-NDJSON
    // stray inside the last 100 renders raw and folds into the record above
    // it — retry until the window is stray-free, as suite 803 does for the
    // file sink's flush boundary.
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
      if (isLogged(record)) expect(recordLabel(record)).to.equal('INFO');
      expect(infos.has(firstLine(record)), firstLine(record)).to.equal(true);
    }
  });

  it('honors lines and grep filters through the journald read path', async function () {
    await waitFor(async () => {
      const one = splitRecords(await fetchText('/flux/infolog?lines=1'));
      return one.length === 1 && recordLabel(one[0]) === 'INFO';
    }, { timeout: 30000, interval: 1000, label: 'infolog?lines=1 serves exactly one INFO record' });

    const records = splitRecords(await fetchText(`/flux/debuglog?grep=${encodeURIComponent(swapCase(token))}`));
    expect(records.length).to.be.greaterThan(0);
    for (const record of records) {
      expect(record.toLowerCase()).to.include(token.toLowerCase());
    }
    expect(hasRecord(records, provoked)).to.equal(true);
  });

  it('pushes since down to journalctl as an epoch bound', async function () {
    // Relative window spanning the whole (young) journal: the error record
    // rides through, composed with grep.
    const recent = splitRecords(await fetchText(`/flux/debuglog?since=2h&grep=${encodeURIComponent(token)}`));
    expect(hasRecord(recent, provoked)).to.equal(true);

    // Future ISO cutoff: nothing qualifies. In journald mode the bound is
    // ALSO handed to the journalctl read itself, which the endpoint counts
    // by branch — the bound reached the journal read, not just the
    // in-process filter.
    const bounded = await client.getDecisionCount('log:journalRead', 'journalctl', 'sinceBound');
    const future = await fetchText('/flux/debuglog?since=2099-01-01T00:00:00.000Z');
    expect(future).to.equal('');
    expect(await client.getDecisionCount('log:journalRead', 'journalctl', 'sinceBound')).to.equal(bounded + 1);
  });
});
