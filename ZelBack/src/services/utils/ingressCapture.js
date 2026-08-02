const { getSpecBackend } = require('./specLibs');

// What a node can honestly say about where a request came from, in one place
// because more than one plane needs it and they must not drift: an app
// registration's gossiped attestation and a playground session's node-local
// record are different products of the same observation.
//
// The split between `observed` and `asserted` is the whole point. The socket
// peer is what this node saw with its own connection; the headers are what the
// client said about itself. Both are worth keeping and only one is evidence, so
// they are never merged into a single "source" field that later readers would
// have to know the provenance of.

/**
 * IPv4-mapped IPv6 (::ffff:1.2.3.4) → 1.2.3.4; a genuine IPv6 address is left
 * intact. Uses the raw socket peer, never x-forwarded-for — no trust proxy is
 * configured, so the header is client-controlled and unsafe for attribution.
 */
function normalizeIp(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  return raw.replace(/^::ffff:/, '');
}

function truncate(value, max) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

/**
 * The observed and asserted view of one request.
 *
 * The asserted fields are truncated to flux-spec's caps because they are
 * attacker-controlled strings that end up in a stored record: without a bound, a
 * caller chooses how much of this node's disk one request consumes.
 *
 * @param {import('express').Request} req
 * @returns {Promise<{observed: {ip: string|null, port: number|null},
 *   asserted: {userAgent: string|null, forwardedFor: string|null}}>}
 */
async function captureIngress(req) {
  const { USER_AGENT_MAX, FORWARDED_FOR_MAX } = await getSpecBackend();

  return {
    observed: {
      ip: normalizeIp(req.socket && req.socket.remoteAddress),
      port: (req.socket && req.socket.remotePort) ?? null,
    },
    asserted: {
      userAgent: truncate(req.headers && req.headers['user-agent'], USER_AGENT_MAX),
      forwardedFor: truncate(req.headers && req.headers['x-forwarded-for'], FORWARDED_FOR_MAX),
    },
  };
}

module.exports = {
  normalizeIp,
  truncate,
  captureIngress,
};
