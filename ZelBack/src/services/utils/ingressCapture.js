const net = require('net');
const config = require('config');
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
 * intact.
 */
function normalizeIp(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  return raw.replace(/^::ffff:/, '');
}

/**
 * Who called, as opposed to who connected.
 *
 * A node behind a balancer sees the balancer as its socket peer, so the caller's
 * address exists only in a header — and a header is only worth reading when the
 * peer that wrote it is one we recognise. Every node is also reachable directly
 * on its public port, so a forwarding header from an unknown peer was chosen by
 * the caller and means nothing.
 *
 * Reads the LAST entry. The balancer appends its own view of the connection
 * after whatever the caller sent, and a caller cannot write past that, so the
 * final entry is the only one written by something we trust. Anything to its
 * left came from the caller: a request arriving as
 * `X-Forwarded-For: 203.0.113.99, 198.51.100.25` is one where 203.0.113.99 is
 * the caller's invention and 198.51.100.25 is what the balancer saw.
 *
 * Node joins repeated headers with ", ", so one split covers both a single
 * header and the several a chain of proxies produces.
 *
 * This is a conclusion, not an observation, and deliberately not part of
 * captureIngress' record: that record is sealed, signed and gossiped, and it
 * must carry only what the node saw. Two nodes with different `fdmAddresses`
 * would otherwise sign different answers for the same request.
 *
 * @param {string|null|undefined} connectingIp the raw socket peer
 * @param {object|undefined} headers the request headers
 * @returns {{ip: string|null, source: 'socket'|'forwarded'}}
 */
function resolveClientIp(connectingIp, headers) {
  const peer = normalizeIp(connectingIp);
  const socketAnswer = { ip: peer, source: 'socket' };

  if (!peer) return socketAnswer;

  const trusted = config.fdmAddresses || [];
  if (!trusted.includes(peer)) return socketAnswer;

  const raw = headers && headers['x-forwarded-for'];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof joined !== 'string' || !joined) return socketAnswer;

  const entries = joined.split(',');
  const candidate = normalizeIp(entries[entries.length - 1].trim());

  // A malformed final entry means the chain cannot be read, which is not a
  // licence to read a different part of it — fall back to what we saw ourselves.
  if (!candidate || net.isIP(candidate) === 0) return socketAnswer;

  return { ip: candidate, source: 'forwarded' };
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
  resolveClientIp,
};
