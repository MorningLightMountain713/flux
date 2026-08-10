'use strict';

const net = require('net');
const dns = require('dns');

/**
 * Unit tests must not do real network I/O.
 *
 * --- Why ---
 * Unstubbed code paths dial fixed localhost ports (the benchmark and daemon
 * RPC ports, and whatever IP a fixture happens to carry). Nothing usually
 * listens there, so the connection is refused and the test passes anyway —
 * which means the suite silently depends on what else is running on the
 * machine. Let something answer on one of those ports and the same code reads
 * a stranger's bytes; because that surfaces asynchronously, mocha attributes
 * it to whichever test is running, so the report accuses an innocent test and
 * the real caller stays invisible.
 *
 * A refused connection is not a passing test, it is an unstubbed dependency
 * that got lucky.
 *
 * --- The rule ---
 * A test may talk to a server THIS process started (supertest's ephemeral
 * apps, the WebSocket servers the communication tests spin up) and to the
 * declared external fixtures below. Everything else is blocked and recorded.
 *
 * --- Why it reports at the end rather than throwing at the caller ---
 * Every one of these call paths already has a `.catch()`, so a throw here is
 * swallowed exactly like the ECONNREFUSED it replaces and the run stays green.
 * The connection is refused immediately (so no test depends on the network),
 * and the violations fail the run afterwards, each naming its caller.
 *
 * --- No opt-out ---
 * There is deliberately no env switch to disable this. The one tier that
 * genuinely used the network (tests/ZelBack: a live Docker Hub lookup and a
 * call to api.runonflux.io) has been retired, so nothing legitimately needs
 * one — and an override that nothing uses is only ever a way to make a real
 * finding go quiet. A false positive here is a bug in this file: fix it, or
 * add the destination to the fixtures below.
 */

// External fixtures the unit tier legitimately uses: mongo (tests/init's db
// config). The docker daemon is a unix socket, matched separately.
const ALLOWED_PORTS = new Set([27017]);

// Ports this process is listening on — its own test servers.
const ownPorts = new Set();

const violations = [];
let currentTest = '(outside a test)';

function setCurrentTest(title) {
  currentTest = title;
}

const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function listen(...args) {
  const record = () => {
    const addr = this.address();
    if (addr && typeof addr === 'object') ownPorts.add(addr.port);
  };
  // Recorded synchronously as well as on the event: supertest calls listen(0),
  // reads address().port and connects in the same tick, so waiting for
  // 'listening' would let the request reach the guard before its own server is
  // known and get blocked as foreign.
  this.on('listening', record);
  const result = origListen.apply(this, args);
  record();
  return result;
};

function targetOf(opts) {
  if (opts.path) return `unix:${opts.path}`;
  return `${opts.host || opts.hostname || 'localhost'}:${opts.port}`;
}

// Only a loopback destination can be one of this process's own servers. Port
// alone is not enough: the communication tests listen on 127.0.0.2:16127, and
// matching on 16127 would have authorised a real connection to any peer on the
// standard Flux port.
function isLoopback(host) {
  if (!host) return true; // net defaults to localhost
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

// The frames worth reading: this repo's own, minus the guard itself.
function stackFrames() {
  return (new Error('opened here').stack || '')
    .split('\n')
    .filter((l) => (l.includes('/ZelBack/') || l.includes('/tests/')) && !l.includes('noRealNetwork.js'))
    .slice(0, 7)
    .map((l) => l.trim())
    .join('\n      ');
}

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = typeof first === 'object' && first !== null
    ? first
    : { port: args[0], host: args[1] };

  // Unix sockets are the docker daemon; no port to reason about.
  if (opts.path) return origConnect.apply(this, args);

  const port = Number(opts.port);
  const host = opts.host || opts.hostname;
  if (isLoopback(host) && (ownPorts.has(port) || ALLOWED_PORTS.has(port))) {
    return origConnect.apply(this, args);
  }

  violations.push({ test: currentTest, target: targetOf(opts), stack: stackFrames() });

  // Fail this connection the way an unreachable host would, so the caller's
  // existing error handling runs and no test hangs waiting on a real socket.
  process.nextTick(() => this.destroy(new Error(`ECONNREFUSED ${targetOf(opts)} (blocked: unit tests must not use the network)`)));
  return this;
};

// DNS never reaches net.Socket.connect, so a resolver query is network I/O the
// socket hook cannot see — and a lookup for a hostname that fails to resolve
// leaves no other trace. Localhost is answered from the hosts file and is the
// only name the unit tier legitimately asks about.
function guardDns(module, names) {
  for (const name of names) {
    if (typeof module[name] !== 'function') continue;
    const orig = module[name].bind(module);
    // eslint-disable-next-line no-param-reassign
    module[name] = function guarded(hostname, ...rest) {
      // An IP literal is answered without asking a resolver anything, so it is
      // not network I/O — dns.lookup is routinely used to normalise addresses.
      if (isLoopback(hostname) || net.isIP(hostname)) {
        return orig(hostname, ...rest);
      }
      violations.push({ test: currentTest, target: `dns:${name}(${hostname})`, stack: stackFrames() });
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname} (blocked: unit tests must not use the network)`);
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') return process.nextTick(() => cb(err));
      return Promise.reject(err);
    };
  }
}

guardDns(dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveSrv', 'resolveTxt']);
guardDns(dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveSrv', 'resolveTxt']);

function report() {
  if (!violations.length) return 0;
  // Grouped by target AND caller: one target is often dialled from several
  // unrelated tests, and reporting only the first hides the others until it is
  // fixed and the next one appears.
  const groups = new Map();
  for (const v of violations) {
    const key = `${v.target} ${v.stack}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  process.stderr.write(`\n${'='.repeat(70)}\nREAL NETWORK I/O FROM UNIT TESTS (${violations.length} attempts, ${groups.size} call site(s))\n${'='.repeat(70)}\n`);
  for (const list of groups.values()) {
    process.stderr.write(`\n  ${list[0].target} — ${list.length} attempt(s), first from "${list[0].test}"\n      ${list[0].stack}\n`);
  }
  process.stderr.write('\nStub these calls in their tests. A refused connection is not a passing test.\n');
  return violations.length;
}

module.exports = { setCurrentTest, report, violations };
