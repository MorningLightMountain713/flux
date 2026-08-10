'use strict';

const { expect } = require('chai');
const crypto = require('node:crypto');

const meshMembership = require('../../ZelBack/src/services/appMesh/meshMembership');
const meshVoucherModule = require('../../ZelBack/src/services/appMesh/meshVoucher');

// The accept path is the mesh's admission control, so these tests use real
// voucher cryptography (a locally minted stand-in for the mesh-purpose key)
// and drive every rejection reason — an accept-path bug is either a hole
// (admitting an impostor) or an outage (refusing every honest member).
describe('meshMembership', () => {
  const APP_UUID = '5db6f53acbbd9b38e949307e96601e573bd6437ddec08707e76a33f771b358ea';
  const APP_PREFIX = 'fdb2:8fa9:3450::/48';
  const OWN = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08:0';
  const PEER = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08:1';
  const ANCHOR_HASH = '7413fd279058ad2088b061d719fbf59d90cd5e509a08ab0d11746b91d7c01c4c';
  const TIP = 2843890;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const signVoucher = (fields) => crypto.sign(
    null,
    Buffer.from(meshVoucherModule.VOUCHER_DOMAIN + meshVoucherModule.buildVoucherMessage(fields)),
    privateKey,
  ).toString('base64');

  const pinnedCert = {
    name: 'flux-mesh-57eac747',
    issuer: '',
    fingerprint: 'fp-peer-ca',
    isCa: true,
    networks: [APP_PREFIX],
    unsafeNetworks: [APP_PREFIX],
    groups: ['flux-mesh'],
  };

  const candidateRow = (overrides = {}) => ({
    outpoint: PEER,
    ip: '203.0.113.7:16127',
    broadcastedAt: 1000,
    meshCa: 'PEER-CA-PEM',
    meshVoucher: signVoucher({
      meshCa: 'PEER-CA-PEM', appUuid: APP_UUID, outpoint: PEER, blockHash: ANCHOR_HASH,
    }),
    meshPort: 16230,
    meshAnchor: { height: TIP - 5, hash: ANCHOR_HASH },
    ...overrides,
  });

  const ctx = (overrides = {}) => ({
    appUuid: APP_UUID,
    ownOutpoint: OWN,
    rows: [candidateRow()],
    tipHeight: TIP,
    anchorHeights: new Map([[ANCHOR_HASH, TIP - 5]]),
    hostingOutpoints: null,
    refused: new Set(),
    meshPublicKey: publicKeyB64,
    parseBundle: async () => [pinnedCert],
    ...overrides,
  });

  it('admits a valid candidate with its derived identity', async () => {
    const { members, rejected } = await meshMembership.evaluateCandidates(ctx());
    expect(rejected).to.deep.equal([]);
    expect(members).to.have.lengthOf(1);
    expect(members[0]).to.deep.include({
      outpoint: PEER,
      nodeId: '57eac747',
      address: 'fdb2:8fa9:3450:98e6:a9ff:3df9::',
      block: 'fdb2:8fa9:3450:98e6:a9ff:3df9::/96',
      endpoint: '203.0.113.7:16230',
      caShas: ['fp-peer-ca'],
    });
  });

  it('never admits itself and keeps only the newest row per outpoint', async () => {
    const stale = candidateRow({ broadcastedAt: 1, meshPort: 1111 });
    const own = candidateRow({ outpoint: OWN });
    const { members } = await meshMembership.evaluateCandidates(
      ctx({ rows: [stale, own, candidateRow()] }),
    );
    expect(members).to.have.lengthOf(1);
    expect(members[0].endpoint).to.equal('203.0.113.7:16230');
  });

  it('rejects an entry with no mesh fields as incomplete', async () => {
    const { members, rejected } = await meshMembership.evaluateCandidates(
      ctx({ rows: [candidateRow({ meshCa: null, meshVoucher: null, meshPort: null, meshAnchor: null })] }),
    );
    expect(members).to.deep.equal([]);
    expect(rejected[0].reason).to.equal('incomplete');
  });

  it('rejects a refused outpoint whatever it broadcasts', async () => {
    const { rejected } = await meshMembership.evaluateCandidates(
      ctx({ refused: new Set([PEER]) }),
    );
    expect(rejected[0].reason).to.equal('refused');
  });

  it('rejects an outpoint outside the hosting set; null admits any', async () => {
    const { rejected } = await meshMembership.evaluateCandidates(
      ctx({ hostingOutpoints: new Set([OWN]) }),
    );
    expect(rejected[0].reason).to.equal('not-in-hosting-set');
    const { members } = await meshMembership.evaluateCandidates(
      ctx({ hostingOutpoints: new Set([OWN, PEER]) }),
    );
    expect(members).to.have.lengthOf(1);
  });

  it('trusts only its own chain for the anchor height', async () => {
    // The row CLAIMS a fresh height; my daemon does not know the hash at all.
    const { rejected } = await meshMembership.evaluateCandidates(
      ctx({ anchorHeights: new Map([[ANCHOR_HASH, null]]) }),
    );
    expect(rejected[0].reason).to.equal('unknown-anchor');
  });

  it('ages out anchors beyond 240 blocks, either side of the tip', async () => {
    const stale = await meshMembership.evaluateCandidates(
      ctx({ anchorHeights: new Map([[ANCHOR_HASH, TIP - 241]]) }),
    );
    expect(stale.rejected[0].reason).to.equal('stale-anchor');
    const edge = await meshMembership.evaluateCandidates(
      ctx({ anchorHeights: new Map([[ANCHOR_HASH, TIP - 240]]) }),
    );
    expect(edge.members).to.have.lengthOf(1);
  });

  it('rejects a voucher that does not cover these exact fields', async () => {
    // Signed for a DIFFERENT registration of the same name.
    const otherUuid = APP_UUID.replace('5', '6');
    const row = candidateRow({
      meshVoucher: signVoucher({
        meshCa: 'PEER-CA-PEM', appUuid: otherUuid, outpoint: PEER, blockHash: ANCHOR_HASH,
      }),
    });
    const { rejected } = await meshMembership.evaluateCandidates(ctx({ rows: [row] }));
    expect(rejected[0].reason).to.equal('bad-voucher');
  });

  it('rejects an unreadable or oversized authority bundle', async () => {
    const unreadable = await meshMembership.evaluateCandidates(
      ctx({ parseBundle: async () => null }),
    );
    expect(unreadable.rejected[0].reason).to.equal('unreadable-authority');
    const oversized = await meshMembership.evaluateCandidates(
      ctx({ parseBundle: async () => Array(5).fill(pinnedCert) }),
    );
    expect(oversized.rejected[0].reason).to.equal('unreadable-authority');
  });

  it('rejects an authority whose constraints are not pinned', async () => {
    const cases = [
      { ...pinnedCert, networks: ['::/0'] },
      { ...pinnedCert, unsafeNetworks: [] },
      { ...pinnedCert, groups: ['flux-mesh', 'extra'] },
      { ...pinnedCert, isCa: false },
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const cert of cases) {
      // eslint-disable-next-line no-await-in-loop
      const { rejected } = await meshMembership.evaluateCandidates(
        ctx({ parseBundle: async () => [cert] }),
      );
      expect(rejected[0].reason).to.equal('unpinned-authority');
    }
  });

  it('accepts a two-authority bundle during a rotation overlap', async () => {
    const successor = { ...pinnedCert, fingerprint: 'fp-peer-ca-2' };
    const { members } = await meshMembership.evaluateCandidates(
      ctx({ parseBundle: async () => [pinnedCert, successor] }),
    );
    expect(members[0].caShas).to.deep.equal(['fp-peer-ca', 'fp-peer-ca-2']);
  });
});
