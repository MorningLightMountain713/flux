process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const client = require('../../ZelBack/src/services/telemetryLogClient');
const {
  HEADER, fakeDaemon, control, chunk, trailer, answer,
} = require('./fixtures/telemetryDaemon');

chai.use(chaiAsPromised);
const { expect } = chai;

const ID = '46274c58c9a969e93c1f91a057f0a371c7b952e31a7aec73839afe1433fdee94';

describe('telemetryLogClient tests', () => {
  let daemon = null;

  afterEach(async () => {
    if (daemon) await daemon.close();
    daemon = null;
    client.useSocket(client.QUERY_SOCKET);
  });

  describe('the node reader', () => {
    it('is docker when the query socket does not exist', () => {
      client.useSocket(path.join(os.tmpdir(), 'no-such-dir', 'query.sock'));
      expect(client.readsThroughDaemon()).to.be.false;
    });

    it('is the daemon when the socket exists, and stays the daemon once chosen', async () => {
      daemon = await fakeDaemon(() => {});
      client.useSocket(daemon.socketPath);
      expect(client.readsThroughDaemon()).to.be.true;

      await daemon.close();
      daemon = null;
      expect(client.readsThroughDaemon(), 'chosen once, never switched').to.be.true;
    });
  });

  describe('readPolling', () => {
    it('asks for the newest lineCount lines and says when the log held more', async () => {
      daemon = await fakeDaemon((request, socket) => answer(socket, ['t1 a', 't2 b'], {
        position: {
          ms: 2, count: 1, ino: '7', first_ns: '1', off: 40,
        },
      }));
      client.useSocket(daemon.socketPath);

      const result = await client.readPolling(ID, { position: null, since: null, lineCount: 2 });

      expect(daemon.requests[0]).to.deep.equal({
        v: 1, op: 'read', container: ID, timestamps: true, tail: 2,
      });
      expect(result).to.deep.equal({
        lines: ['t1 a', 't2 b'],
        position: {
          ms: 2, count: 1, ino: '7', firstNs: '1', off: 40,
        },
        rolledOver: false,
        truncated: true,
        skipped: false,
      });
    });

    it('sends a since filter with its line limit, in whole milliseconds', async () => {
      daemon = await fakeDaemon((request, socket) => answer(socket, []));
      client.useSocket(daemon.socketPath);

      await client.readPolling(ID, { position: null, since: 1_788_784_181_000.7, lineCount: 50 });

      expect(daemon.requests[0]).to.deep.equal({
        v: 1, op: 'read', container: ID, timestamps: true, since_ms: 1_788_784_181_000, tail: 50,
      });
    });

    it('sends a position with its file identity as strings, and keeps them exact past 2^53', async () => {
      const position = {
        ms: 1_788_784_181_000, count: 3, ino: '18446744073709551615', firstNs: '1788784181123456789', off: 4096,
      };
      daemon = await fakeDaemon((request, socket) => answer(socket, ['t c'], {
        position: { ...request.position, count: 4, off: 4200 },
      }));
      client.useSocket(daemon.socketPath);

      const result = await client.readPolling(ID, { position, lineCount: 100, maxLines: 5000 });

      expect(daemon.requests[0]).to.deep.equal({
        v: 1,
        op: 'read',
        container: ID,
        timestamps: true,
        max_lines: 5000,
        position: {
          ms: 1_788_784_181_000, count: 3, ino: '18446744073709551615', first_ns: '1788784181123456789', off: 4096,
        },
      });
      expect(result.position).to.deep.equal({ ...position, count: 4, off: 4200 });
      expect(result.truncated, 'a positioned reader is never told what lies behind it').to.be.false;
    });

    it('reads lines from every chunk however the socket splits them', async () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `2026-09-07T12:29:41.000000000Z line ${i} ${'x'.repeat(60)}`);
      daemon = await fakeDaemon((request, socket) => {
        control(socket, HEADER);
        // Three chunks, written a few bytes at a time.
        const bodies = [lines.slice(0, 1000), lines.slice(1000, 2000), lines.slice(2000)];
        const bytes = Buffer.concat(bodies.flatMap((part) => {
          const body = Buffer.from(part.join('\n'));
          return [Buffer.from(`{"chunk":${body.length}}\n`), body];
        }));
        let at = 0;
        const drip = () => {
          if (at >= bytes.length) {
            socket.end(`${JSON.stringify(trailer(lines))}\n`);
            return;
          }
          socket.write(bytes.subarray(at, at + 7919));
          at += 7919;
          setImmediate(drip);
        };
        drip();
      });
      client.useSocket(daemon.socketPath);

      const result = await client.readPolling(ID, { lineCount: 'all' });

      expect(result.lines).to.deep.equal(lines);
    });

    ['not_found', 'unreadable', 'busy', 'timeout', 'bad_request'].forEach((code) => {
      it(`answers ${code} with an error and does not ask again`, async () => {
        daemon = await fakeDaemon((request, socket) => {
          socket.end(`${JSON.stringify({
            v: 1, ok: false, error: code, message: 'from the daemon',
          })}\n`);
        });
        client.useSocket(daemon.socketPath);

        const read = client.readPolling(ID, { lineCount: 100 });

        await expect(read).to.be.rejectedWith(client.TelemetryLogError).and.eventually.include({ code });
        expect(daemon.requests).to.have.length(1);
      });
    });

    it('answers an error in place of the trailer with that error', async () => {
      daemon = await fakeDaemon((request, socket) => {
        control(socket, HEADER);
        chunk(socket, ['t a', 't b']);
        socket.end(`${JSON.stringify({
          v: 1, ok: false, error: 'timeout', message: 'read exceeded its time',
        })}\n`);
      });
      client.useSocket(daemon.socketPath);

      await expect(client.readPolling(ID, { lineCount: 'all' }))
        .to.be.rejectedWith(client.TelemetryLogError).and.eventually.include({ code: 'timeout' });
      expect(daemon.requests).to.have.length(1);
    });

    it('asks once more when a response ends before its trailer, and answers with the second', async () => {
      daemon = await fakeDaemon((request, socket, n) => {
        if (n === 1) {
          control(socket, HEADER);
          chunk(socket, ['t partial']);
          socket.end();
          return;
        }
        answer(socket, ['t a', 't b']);
      });
      client.useSocket(daemon.socketPath);

      const result = await client.readPolling(ID, { lineCount: 'all' });

      expect(result.lines, 'nothing of the cut response survives').to.deep.equal(['t a', 't b']);
      expect(daemon.requests).to.have.length(2);
      expect(daemon.requests[1]).to.deep.equal(daemon.requests[0]);
    });

    it('answers a second cut response with an error, and stops asking', async () => {
      daemon = await fakeDaemon((request, socket) => {
        control(socket, HEADER);
        socket.end();
      });
      client.useSocket(daemon.socketPath);

      await expect(client.readPolling(ID, { lineCount: 'all' }))
        .to.be.rejectedWith(client.TelemetryLogError).and.eventually.include({ code: 'cut' });
      expect(daemon.requests).to.have.length(2);
    });

    it('answers a socket nobody listens on with an error, not a docker read and not a retry', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-log-'));
      const socketPath = path.join(dir, 'query.sock');
      fs.writeFileSync(socketPath, '');
      client.useSocket(socketPath);
      try {
        expect(client.readsThroughDaemon()).to.be.true;
        await expect(client.readPolling(ID, { lineCount: 'all' }))
          .to.be.rejectedWith(client.TelemetryLogError).and.eventually.include({ code: 'unreachable' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('readText', () => {
    it('gives docker\'s text without timestamps, blank entries included', async () => {
      daemon = await fakeDaemon((request, socket) => answer(socket, [
        '2026-09-07T12:29:41.000000000Z first',
        '2026-09-07T12:29:42.000000000Z ',
        '2026-09-07T12:29:43.000000000Z  indented third',
      ]));
      client.useSocket(daemon.socketPath);

      const text = await client.readText(ID, '10');

      expect(daemon.requests[0]).to.deep.equal({
        v: 1, op: 'read', container: ID, timestamps: true, tail: 10,
      });
      expect(text).to.equal('first\n\n indented third\n');
    });

    it('asks for the whole log for all, and refuses a count that is not a number', async () => {
      daemon = await fakeDaemon((request, socket) => answer(socket, []));
      client.useSocket(daemon.socketPath);

      expect(await client.readText(ID, 'all')).to.equal('');
      expect(daemon.requests[0]).to.not.have.property('tail');
      await expect(client.readText(ID, 'ten')).to.be.rejectedWith('not a whole number');
    });
  });
});
