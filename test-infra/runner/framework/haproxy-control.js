import { GenericContainer } from 'testcontainers';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { getSubnetConfig } from './subnet-config.js';

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

  const container = await new GenericContainer(HAPROXY_IMAGE)
    .withBindMounts([
      { source: join(dir, 'haproxy.cfg'), target: '/usr/local/etc/haproxy/haproxy.cfg', mode: 'ro' },
      { source: caDir, target: CA_DIR, mode: 'ro' },
    ])
    .withNetworkMode(networkName)
    .withExposedPorts(FRONTEND_PORT)
    .start();

  const base = `http://${container.getHost()}:${container.getMappedPort(FRONTEND_PORT)}`;

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
