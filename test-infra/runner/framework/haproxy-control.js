import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { getContainerRuntimeClient } from 'testcontainers';
import { getSubnetConfig } from './subnet-config.js';
import { StaticIpContainer } from './test-env.js';

// A real HAProxy in front of app backends, for the suites that need to prove the
// verified hop rather than assume it.
//
// Every unit test for backend TLS on either side stops at "the node wrote a file"
// or "the renderer emitted a string". Neither says whether a load balancer
// configured that way will complete a handshake with a backend serving that
// certificate — and the failure modes that matter (wrong EKU, missing SAN,
// key/cert mismatch, an unusable chain) all pass those tests and fail here.
//
// Suite-scoped rather than part of the base fleet: only the load-balancing suites
// want it, and every other suite would pay the container for nothing.

const subnet = getSubnetConfig();
const HAPROXY_IMAGE = 'haproxy:2.9';
const FRONTEND_PORT = 8080;

// The trust anchor path FDM writes to and names in the config. Kept identical to
// FDM's BACKEND_CA_DIR / backendCaFile.
const CA_DIR = '/etc/haproxy/ca';
export const caFileName = (appName) => `flux-ca-${appName}.pem`;

/**
 * Render a minimal config carrying the ONE directive under test.
 *
 * The `server ... ssl verify required ca-file ...` form is duplicated from FDM's
 * resolveBackendConfig.js, because the harness lives in a different repo and
 * cannot import it. Deliberately not asserted as a literal anywhere in the
 * suites: FDM's own unit tests pin the exact string, and pinning it here too
 * would only mean two places to update and a cross-repo string comparison that
 * proves nothing about behaviour. What the suites assert is that the hop carries
 * traffic and that verification is enforced — so if FDM's form ever drifts into
 * something haproxy will not accept, it surfaces as a dead backend rather than
 * as a matching-string test that passes while production breaks.
 *
 * @param {Array<{name: string, host: string, target: string, verify?: string}>} backends
 *   name   - routing key, matched on the Host header
 *   host   - Host header that selects this backend
 *   target - ip:port of the app container (the node's IP and hostPort, which is
 *            the same topology production uses: haproxy dials the node)
 *   verify - 'required' (default) names the app's CA; 'none' skips verification
 */
export function renderConfig(backends) {
  const lines = [
    'global',
    '    log stdout format raw local0',
    'defaults',
    '    mode http',
    '    timeout connect 5s',
    '    timeout client 30s',
    '    timeout server 30s',
    '    option httpchk GET /',
    'frontend fe',
    `    bind *:${FRONTEND_PORT}`,
  ];
  for (const b of backends) {
    lines.push(`    acl is_${b.name} hdr(host) -i ${b.host}`);
    lines.push(`    use_backend ${b.name} if is_${b.name}`);
  }
  for (const b of backends) {
    const ssl = (b.verify ?? 'required') === 'required'
      ? `ssl verify required ca-file ${CA_DIR}/${caFileName(b.name)}`
      : 'ssl verify none';
    lines.push(`backend ${b.name}`);
    lines.push(`    server app ${b.target} check maxconn 2000 ${ssl}`);
  }
  return `${lines.join('\n')}\n`;
}

// Whether the container has SETTLED into a non-running state, and why — with its
// logs, because for haproxy the reason is a config error printed at exit and the
// record dies with the container. Returns null for anything still running, still
// being created, or an inspect that failed transiently: only a settled container is
// death, and a false positive here would fail a fleet that was merely slow.
async function settledContainerReason(container) {
  let state;
  try {
    // Liveness is the one thing StartedTestContainer cannot answer: its interface
    // (testcontainers 11.14) offers logs, exec, ports and ids, and nothing that
    // reports State or an exit code. getContainerRuntimeClient is the package's own
    // sanctioned route to dockerode and already how this framework reaches networks
    // and volumes — so this is the supported escape hatch, not a bypass of it.
    const client = await getContainerRuntimeClient();
    ({ State: state } = await client.container.dockerode.getContainer(container.getId()).inspect());
  } catch {
    return null; // transient — the deadline stays the backstop
  }
  if (!state || state.Running || state.Status === 'created') return null;

  let tail = '(no logs)';
  try {
    // testcontainers' own logs(), not dockerode's: it already demuxes docker's
    // 8-byte non-TTY frame headers (docker-container-client demuxStream), so the
    // stream is text and there is nothing here to hand-decode.
    const stream = await container.logs({ tail: 40 });
    const chunks = [];
    // eslint-disable-next-line no-restricted-syntax
    for await (const chunk of stream) chunks.push(chunk);
    const text = chunks.join('').trim();
    if (text) tail = text.split('\n').slice(-20).join('\n');
  } catch {
    // keep '(no logs)' — the exit code alone is still worth reporting
  }

  const parts = [`status=${state.Status}`, `exitCode=${state.ExitCode}`];
  if (state.OOMKilled) parts.push('OOMKilled=true');
  if (state.Error) parts.push(`error=${state.Error}`);
  return `${parts.join(' ')}\n--- haproxy container logs ---\n${tail}`;
}

/**
 * Start HAProxy on the run's network with the given backends and CA files.
 *
 * @param {string} networkName env.networkName
 * @param {object} opts
 * @param {Array} opts.backends see renderConfig
 * @param {Record<string,string>} opts.cas appName -> CA certificate PEM. Written
 *   to the path the config names, mirroring what provisionBackendCas puts on a
 *   director's disk.
 */
export async function startHaproxy(networkName, { backends, cas = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-haproxy-'));
  const caDir = join(dir, 'ca');
  mkdirSync(caDir);
  writeFileSync(join(dir, 'haproxy.cfg'), renderConfig(backends));
  for (const [appName, pem] of Object.entries(cas)) {
    writeFileSync(join(caDir, caFileName(appName)), pem);
  }

  // Static IP on the test network, not a published host port: the runner reaches
  // every service in this harness by subnet IP (see fdm-control, daemon-control),
  // and asking testcontainers to bind a host port instead times out waiting for a
  // mapping that never appears.
  const container = await new StaticIpContainer(HAPROXY_IMAGE)
    .withStaticIp(networkName, subnet.haproxy)
    .withBindMounts([
      { source: join(dir, 'haproxy.cfg'), target: '/usr/local/etc/haproxy/haproxy.cfg', mode: 'ro' },
      { source: caDir, target: CA_DIR, mode: 'ro' },
    ])
    .start();

  const base = `http://${subnet.haproxy}:${FRONTEND_PORT}`;

  // haproxy binds a moment after the container starts. Any HTTP answer means the
  // frontend is up — a 503 is a perfectly good sign of life here, since it is
  // also what a backend that failed verification produces.
  //
  // The poll also asks whether the container is still ALIVE, for the reason the node
  // boot wait does (http-wait-strategy): haproxy VALIDATES ITS CONFIG AT STARTUP and
  // exits non-zero on a bad one, so a dead haproxy is otherwise polled for the full
  // allowance and then reported as a timeout — the message naming the last 2s probe
  // rather than the exit that made every probe pointless. Its logs carry the config
  // error verbatim, which is the whole diagnosis, and they die with the container.
  // Checked AFTER the probe, so a frontend that answered and then exited on its own
  // teardown still counts as ready; only a SETTLED container is death, since
  // `created` is the pre-start moment and inspect can fail transiently.
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await axios.get(base, { validateStatus: () => true, timeout: 2000 });
      break;
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      const dead = await settledContainerReason(container);
      // URL first: the reason ends in multi-line container logs, and a trailing
      // clause after them reads as part of haproxy's own output.
      if (dead) throw new Error(`haproxy at ${base} died before answering: ${dead}`);
      if (Date.now() > deadline) throw new Error(`haproxy did not answer on ${base} within 30000ms (last probe: ${error.message})`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
  }

  return {
    container,
    ip: subnet.haproxy,
    url: base,

    /**
     * Drive one request through the front door. Returns the status and the
     * serving certificate's fingerprint (tls-echo answers with it), so a caller
     * can tell WHICH certificate answered without inspecting the handshake.
     * 503 means haproxy has no healthy server — which is what a refused
     * verification looks like from the outside.
     */
    async request(host, path = '/') {
      const res = await axios.get(`${base}${path}`, {
        headers: { Host: host },
        validateStatus: () => true,
        timeout: 10000,
      });
      return { status: res.status, servedCert: res.headers['x-tls-echo'] || null };
    },

    async logs() {
      const stream = await container.logs();
      return new Promise((resolve) => {
        let out = '';
        stream.on('data', (c) => { out += c.toString(); });
        stream.on('end', () => resolve(out));
        setTimeout(() => resolve(out), 2000);
      });
    },

    async stop() {
      await container.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
