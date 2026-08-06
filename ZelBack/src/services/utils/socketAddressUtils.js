// Socket address utility functions for consistent ip:port handling.
//
// TODO: Once all nodes run fluxbench with always-attached port,
// normalizeSocketAddress becomes a no-op and socketAddressesMatch
// becomes ===. At that point simplify or remove this module.

const DEFAULT_API_PORT = 16127;

function normalizeSocketAddress(address) {
  if (!address) return null;
  if (address.includes(':')) return address;
  return `${address}:${DEFAULT_API_PORT}`;
}

function extractIp(address) {
  if (!address) return null;
  return address.split(':')[0];
}

function extractPort(address) {
  if (!address) return DEFAULT_API_PORT;
  const parts = address.split(':');
  return parts.length > 1 && +parts[1] ? +parts[1] : DEFAULT_API_PORT;
}

const ipPattern = /^(?!0)(?!.*\.$)(?:(?:1?\d?\d|25[0-5]|2[0-4]\d)(?:\.|$)){4}$/;
const portPattern = /^([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/;

function parseSocketAddress(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(':');
  if (parts.length > 2) return null;
  const ip = parts[0];
  const portStr = parts[1] || String(DEFAULT_API_PORT);
  if (!ipPattern.test(ip) || !portPattern.test(portStr)) return null;
  return { ip, port: +portStr };
}

function socketAddressesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const normalA = normalizeSocketAddress(a);
  const normalB = normalizeSocketAddress(b);
  return normalA === normalB;
}

// Compare two addresses at IP granularity, ignoring the port entirely.
//
// Use this - not socketAddressesMatch - whenever one operand comes from FDM's
// /appips endpoint. FDM tracks an app's master per IP (a node can only run one
// instance of an app on a given IP, enforced by host port mapping) and returns a
// bare IP. socketAddressesMatch would normalize that bare IP to the default API
// port (16127), so it never matches a UPnP master on a non-default port (e.g.
// :16157) - the node fails to recognize itself as primary and stops its own
// container. Matching on IP alone is correct here because the IP uniquely
// identifies the instance.
function ipsMatch(a, b) {
  if (!a || !b) return false;
  return extractIp(a) === extractIp(b);
}

// The DNS name that reaches ONE node's API through the load balancer. A bare
// ip:port does not: nodes serve their API over TLS on a certificate issued for
// this name, so an absolute URL built from the raw address fails to verify.
const NODE_API_DOMAIN = 'node.api.runonflux.io';

/**
 * The public base URL of the node at a socket address.
 *
 * `185.209.30.228:16127` becomes
 * `https://185-209-30-228-16127.node.api.runonflux.io` — the form the frontend
 * already builds to pin a session to one backend.
 *
 * @param {string} address ip or ip:port
 * @returns {string|null} base URL, or null when the address is not resolvable
 */
function nodeApiUrl(address) {
  const parsed = parseSocketAddress(address);
  if (!parsed) return null;
  return `https://${parsed.ip.replace(/\./g, '-')}-${parsed.port}.${NODE_API_DOMAIN}`;
}

module.exports = {
  DEFAULT_API_PORT,
  NODE_API_DOMAIN,
  nodeApiUrl,
  normalizeSocketAddress,
  extractIp,
  extractPort,
  parseSocketAddress,
  socketAddressesMatch,
  ipsMatch,
};
