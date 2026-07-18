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

// FluxOS logging, journald half (suite 71 covers the file-sink half): the
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
// Provocations are identical to suite 71 (they are sink-agnostic):
// adjustblockedports yields a unique info marker plus a stack-carrying
// error; tailbenchmarkdebug yields a guaranteed `Run Cmd:` debug line.

const MARKER = 'E2E-72-LOG-GREP-MARKER';
const PROVOKED_ERROR = 'Blocked Ports is not a valid array';

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

  before(async function () {
    this.timeout(240000);
    // shutdowndMock explicitly off: the mock is started by the default
    // entrypoint path, which systemd mode replaces; nothing here stops apps.
    env = await createTestEnv({
      hookCtx: this, nodes: 1, tickerAutostart: false, systemdMode: true, shutdowndMock: false,
    });
    client = env.clients[0];
    ({ zelidauth } = await authenticate(client.url, fluxTeamKey()));

    // Provocations (see the header).
    await client.getAuthed('/flux/tailbenchmarkdebug', zelidauth);
    const res = await client.post('/flux/adjustblockedports', { blockedPorts: MARKER }, { zelidauth });
    expect(res.status).to.equal('error');
    expect(res.data.message).to.equal(PROVOKED_ERROR);

    // De-race: gate on the journal itself AND on the endpoint that reads it.
    await waitFor(async () => {
      const { stdout } = await execInContainer(
        client.container,
        `journalctl -u fluxos -o cat --no-pager | grep -c ${MARKER} || true`,
      );
      return Number(stdout.trim()) > 0;
    }, { timeout: 15000, interval: 500, label: 'provoked marker reached the journal' });
    await waitFor(
      async () => (await fetchText(`/flux/debuglog?grep=${MARKER.toLowerCase()}`)).includes(MARKER),
      { timeout: 15000, interval: 500, label: 'provoked marker readable through the log endpoint' },
    );
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
    }

    const msgs = (await journalNdjson()).map((r) => r.msg);
    expect(msgs.some((m) => typeof m === 'string' && m.includes('Local database prepared'))).to.equal(true);
    expect(msgs.some((m) => typeof m === 'string' && m.includes('Daemon Sync status'))).to.equal(true);
  });

  it('honors logLevel debug and stamps exact numeric levels; errors carry err.stack', async function () {
    const records = await journalNdjson();

    const info = records.find((r) => r.msg === `blockedPorts: ${JSON.stringify(MARKER)}`);
    expect(info, 'provoked info marker line').to.exist;
    expect(info.level).to.equal(30);

    const error = records.find((r) => r.msg === PROVOKED_ERROR);
    expect(error, 'provoked error line').to.exist;
    expect(error.level).to.equal(50);
    expect(error.err, 'the err serializer keeps the Error structured').to.be.an('object');
    expect(error.err.stack).to.be.a('string').and.include('adjustBlockedPorts');

    const debug = records.find((r) => typeof r.msg === 'string' && r.msg.startsWith('Run Cmd: tail -n 100'));
    expect(debug, 'provoked debug line').to.exist;
    expect(debug.level).to.equal(20);
  });

  it('serves the level downloads from the journal with the file-mode semantics', async function () {
    const res = await fetchRaw('/flux/errorlog');
    expect(res.status).to.equal(200);
    expect(res.headers.get('content-disposition')).to.include('attachment').and.include('error.log');
    const errors = splitRecords(await res.text());
    expect(errors.length).to.be.greaterThan(0);
    for (const record of errors) {
      expect(['ERROR', 'FATAL'], record.split('\n')[0]).to.include(recordLabel(record));
    }
    const provoked = errors.find((r) => r.includes(PROVOKED_ERROR));
    expect(provoked, 'provoked error record').to.exist;
    expect(provoked, 'stack rides the rendered record').to.match(/\n\s+at /);

    const infos = splitRecords(await fetchText('/flux/infolog'));
    expect(infos.length).to.be.greaterThan(0);
    expect(infos.some((r) => r.includes(MARKER))).to.equal(true);
    expect(infos.some((r) => r.includes(PROVOKED_ERROR))).to.equal(false);
    expect(infos.some((r) => r.includes('Run Cmd: tail -n 100'))).to.equal(false);

    const warns = splitRecords(await fetchText('/flux/warnlog'));
    for (const record of warns) {
      expect(recordLabel(record), record.split('\n')[0]).to.equal('WARN');
    }
    expect(warns.some((r) => r.includes(MARKER))).to.equal(false);

    const debugs = splitRecords(await fetchText('/flux/debuglog'));
    expect(debugs.some((r) => r.includes(MARKER))).to.equal(true);
    expect(debugs.some((r) => r.includes(PROVOKED_ERROR))).to.equal(true);
    expect(debugs.some((r) => r.includes('Run Cmd: tail -n 100'))).to.equal(true);
  });

  it('tails return the last 100 records as a JSON success message', async function () {
    this.timeout(180000);
    // Make the 100-record cap the binding constraint before asserting it.
    await waitFor(async () => (await journalLines()).length >= 120,
      { timeout: 120000, interval: 2000, label: 'journal holds >= 120 lines' });

    // Journal entries are atomic (no mid-write partials), but a non-NDJSON
    // stray inside the last 100 renders raw and folds into the record above
    // it — retry until the window is stray-free, as suite 71 does for the
    // file sink's flush boundary.
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

  it('honors lines and grep filters through the journald read path', async function () {
    await waitFor(async () => {
      const one = splitRecords(await fetchText('/flux/infolog?lines=1'));
      return one.length === 1 && recordLabel(one[0]) === 'INFO';
    }, { timeout: 30000, interval: 1000, label: 'infolog?lines=1 serves exactly one INFO record' });

    const records = splitRecords(await fetchText(`/flux/debuglog?grep=${MARKER.toLowerCase()}`));
    expect(records.length).to.be.greaterThan(0);
    for (const record of records) {
      expect(record.toLowerCase()).to.include(MARKER.toLowerCase());
    }
    expect(records.some((r) => r.includes(MARKER))).to.equal(true);
  });

  it('pushes since down to journalctl as an epoch bound', async function () {
    // Relative window spanning the whole (young) journal: the marker rides
    // through, composed with grep.
    const recent = await fetchText(`/flux/debuglog?since=2h&grep=${MARKER.toLowerCase()}`);
    expect(recent).to.include(MARKER);

    // Future ISO cutoff: nothing qualifies. In journald mode this filter is
    // ALSO pushed into the journalctl invocation server-side...
    const future = await fetchText('/flux/debuglog?since=2099-01-01T00:00:00.000Z');
    expect(future).to.equal('');

    // ...which is observable: readFluxLog shells out via runCommand, and
    // runCommand debug-logs its own command line. The journal must now hold
    // a journalctl invocation carrying `--since @<epoch>` — proof the bound
    // reached the journal read, not just the in-process filter.
    await waitFor(async () => {
      const { stdout } = await execInContainer(
        client.container,
        'journalctl -u fluxos -o cat --no-pager | grep -c -- "--since @" || true',
      );
      return Number(stdout.trim()) > 0;
    }, { timeout: 15000, interval: 500, label: 'journalctl --since pushdown visible in the debug stream' });
  });
});
