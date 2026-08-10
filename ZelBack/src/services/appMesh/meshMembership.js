'use strict';

// The accept path: which announced members enter this node's overlay for one
// app. Everything is checkable locally — the voucher against the pinned
// mesh-purpose key, the anchor against my own tip, the outpoint against the
// hosting set and my refuse set, the authority's constraints against the
// derivation — and failing any check means the candidate simply is not a
// member here. It is not refused, blocked or reported; its certificates fail
// with "could not find ca for the certificate".
//
// There is deliberately no ranking when more members appear than instances:
// the cap lives in the spec at registration, an excess is transient and
// honest (placement races, relocation), and an outpoint-ordered cut would
// hand any operator a lever to evict real members. The candidate ceiling
// below is a resource guard, far above any legitimate membership.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const log = require('../../lib/log');
const meshDerivation = require('./meshDerivation');
const meshVoucher = require('./meshVoucher');
const meshCertificates = require('./meshCertificates');

// The voucher freshness bound, in blocks (~2 hours): what ages out a
// reflashed node's stale broadcasts. Anchors ahead of my tip are tolerated to
// the same bound — a peer being better synced than me is not a fault.
const ANCHOR_MAX_AGE_BLOCKS = 240;
// Resource guard, not an admission decision: no legitimate app approaches it
// (instances cap at 20).
const MAX_CANDIDATES = 64;
const MAX_BUNDLE_CERTS = 4;
const MESH_GROUP = 'flux-mesh';

/**
 * Parse a received authority bundle PEM by round-tripping it through
 * nebula-cert via a throwaway file. Null when unreadable.
 * @param {string} bundlePem
 * @returns {Promise<Array<object>|null>}
 */
async function parseAuthorityBundle(bundlePem) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flux-mesh-ca-'));
  try {
    const bundlePath = path.join(dir, 'bundle.pem');
    await fsp.writeFile(bundlePath, bundlePem);
    return await meshCertificates.certificateBundleDetails(bundlePath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function hostOf(socketAddr) {
  if (typeof socketAddr !== 'string' || socketAddr === '') return null;
  return socketAddr.includes(':') ? socketAddr.slice(0, socketAddr.indexOf(':')) : socketAddr;
}

const sameSet = (values, expected) => {
  if (!Array.isArray(values) || values.length !== expected.length) return false;
  return expected.every((entry) => values.includes(entry));
};

/**
 * Evaluate one app's announced candidates into accepted members.
 *
 * @param {{
 *   appUuid: string,
 *   ownOutpoint: string,
 *   rows: Array<{outpoint: string|null, ip: string, broadcastedAt: number,
 *     meshCa: string|null, meshVoucher: string|null, meshPort: number|null,
 *     meshAnchor: {height: number, hash: string}|null}>,
 *   tipHeight: number,
 *   anchorHeights: Map<string, number|null>, resolved from MY chain, by hash —
 *     announced heights are untrusted (the voucher covers only the hash)
 *   hostingOutpoints: Set<string>|null, null when placement is unrestricted
 *   refused: Set<string>,
 *   meshPublicKey: string|undefined, test override for the pinned key
 *   parseBundle: typeof parseAuthorityBundle|undefined, test seam
 * }} ctx
 * @returns {Promise<{members: Array<{outpoint: string, nodeId: string,
 *   address: string, block: string, endpoint: string, caShas: string[],
 *   meshCa: string}>, rejected: Array<{outpoint: string|null, reason: string}>}>}
 */
async function evaluateCandidates(ctx) {
  const {
    appUuid, ownOutpoint, rows, tipHeight, anchorHeights,
    hostingOutpoints, refused, meshPublicKey,
    parseBundle = parseAuthorityBundle,
  } = ctx;
  const appPrefix = meshDerivation.appPrefix(appUuid);
  const members = [];
  const rejected = [];

  // One candidate per outpoint, newest announcement wins.
  const byOutpoint = new Map();
  for (const row of rows) {
    if (!row.outpoint || row.outpoint === ownOutpoint) continue; // eslint-disable-line no-continue
    const held = byOutpoint.get(row.outpoint);
    if (!held || (row.broadcastedAt ?? 0) > (held.broadcastedAt ?? 0)) {
      byOutpoint.set(row.outpoint, row);
    }
  }
  const candidates = [...byOutpoint.values()].slice(0, MAX_CANDIDATES);
  if (byOutpoint.size > MAX_CANDIDATES) {
    log.error(`meshMembership - ${byOutpoint.size} candidates for one app exceeds the resource guard; the excess is ignored this pass`);
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const row of candidates) {
    const fail = (reason) => rejected.push({ outpoint: row.outpoint, reason });
    if (typeof row.meshCa !== 'string' || row.meshCa === ''
      || typeof row.meshVoucher !== 'string' || row.meshVoucher === ''
      || !Number.isInteger(row.meshPort)
      || !row.meshAnchor || typeof row.meshAnchor.hash !== 'string') {
      fail('incomplete');
      continue; // eslint-disable-line no-continue
    }
    if (refused.has(row.outpoint)) {
      fail('refused');
      continue; // eslint-disable-line no-continue
    }
    if (hostingOutpoints && !hostingOutpoints.has(row.outpoint)) {
      fail('not-in-hosting-set');
      continue; // eslint-disable-line no-continue
    }
    // The anchor's height comes from MY chain by its hash; a hash my daemon
    // does not know is not evidence of freshness, whatever height it claims.
    const anchorHeight = anchorHeights.get(row.meshAnchor.hash);
    if (!Number.isInteger(anchorHeight)) {
      fail('unknown-anchor');
      continue; // eslint-disable-line no-continue
    }
    if (Math.abs(tipHeight - anchorHeight) > ANCHOR_MAX_AGE_BLOCKS) {
      fail('stale-anchor');
      continue; // eslint-disable-line no-continue
    }
    const voucherOk = meshVoucher.verifyVoucher(row.meshVoucher, {
      meshCa: row.meshCa,
      appUuid,
      outpoint: row.outpoint,
      blockHash: row.meshAnchor.hash,
    }, ...(meshPublicKey ? [meshPublicKey] : []));
    if (!voucherOk) {
      fail('bad-voucher');
      continue; // eslint-disable-line no-continue
    }
    // eslint-disable-next-line no-await-in-loop
    const certs = await parseBundle(row.meshCa);
    if (!certs || certs.length === 0 || certs.length > MAX_BUNDLE_CERTS) {
      fail('unreadable-authority');
      continue; // eslint-disable-line no-continue
    }
    // Every authority in the bundle must be constraint-pinned: unset means
    // unconstrained, and an unpinned CA lets its holder mint a leaf claiming
    // routes over anything.
    const pinned = certs.every((cert) => cert.isCa
      && sameSet(cert.networks, [appPrefix])
      && sameSet(cert.unsafeNetworks, [appPrefix])
      && sameSet(cert.groups, [MESH_GROUP]));
    if (!pinned) {
      fail('unpinned-authority');
      continue; // eslint-disable-line no-continue
    }
    const host = hostOf(row.ip);
    if (!host) {
      fail('no-endpoint');
      continue; // eslint-disable-line no-continue
    }
    members.push({
      outpoint: row.outpoint,
      nodeId: meshDerivation.nodeId(row.outpoint),
      address: meshDerivation.nodeAddress(appUuid, row.outpoint),
      block: meshDerivation.nodeBlock(appUuid, row.outpoint),
      endpoint: `${host}:${row.meshPort}`,
      caShas: certs.map((cert) => cert.fingerprint),
      meshCa: row.meshCa,
    });
  }

  return { members, rejected };
}

module.exports = {
  ANCHOR_MAX_AGE_BLOCKS,
  evaluateCandidates,
  parseAuthorityBundle,
};
