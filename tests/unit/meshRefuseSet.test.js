'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const realFsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Real filesystem, rebased from the production /dat root into a per-run temp
// dir — the file discipline (atomic writes, idempotence) IS the behaviour.
const PROD_ROOT = '/dat/var/lib/flux-mesh';

describe('meshRefuseSet', () => {
  let tmpRoot;
  let meshRefuseSet;

  const INSTANCE = 'ab12cd34ef56';
  const OUTPOINT_A = `${'a'.repeat(64)}:0`;
  const OUTPOINT_B = `${'b'.repeat(64)}:1`;

  const rebase = (p) => (typeof p === 'string' && p.startsWith(PROD_ROOT)
    ? path.join(tmpRoot, p.slice(PROD_ROOT.length)) : p);

  beforeEach(async () => {
    tmpRoot = await realFsp.mkdtemp(path.join(os.tmpdir(), 'mesh-refuse-'));
    const fspShim = {};
    for (const method of ['readFile', 'writeFile', 'rm', 'mkdir', 'stat']) {
      fspShim[method] = (p, ...args) => realFsp[method](rebase(p), ...args);
    }
    fspShim.rename = (a, b) => realFsp.rename(rebase(a), rebase(b));
    meshRefuseSet = proxyquire('../../ZelBack/src/services/appMesh/meshRefuseSet', {
      'node:fs/promises': fspShim,
    });
  });

  afterEach(async () => {
    await realFsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it('starts empty and survives refusal round-trips', async () => {
    expect(await meshRefuseSet.refusedOutpoints(INSTANCE)).to.deep.equal(new Set());
    await meshRefuseSet.refuseOutpoint(INSTANCE, OUTPOINT_A);
    await meshRefuseSet.refuseOutpoint(INSTANCE, OUTPOINT_B);
    await meshRefuseSet.refuseOutpoint(INSTANCE, OUTPOINT_A);
    expect(await meshRefuseSet.refusedOutpoints(INSTANCE)).to.deep.equal(new Set([OUTPOINT_A, OUTPOINT_B]));
  });

  it('removeRefusedOutpoint erases exactly the named verdict, idempotently', async () => {
    await meshRefuseSet.refuseOutpoint(INSTANCE, OUTPOINT_A);
    await meshRefuseSet.refuseOutpoint(INSTANCE, OUTPOINT_B);
    await meshRefuseSet.removeRefusedOutpoint(INSTANCE, OUTPOINT_A);
    expect(await meshRefuseSet.refusedOutpoints(INSTANCE)).to.deep.equal(new Set([OUTPOINT_B]));
    await meshRefuseSet.removeRefusedOutpoint(INSTANCE, OUTPOINT_A);
    expect(await meshRefuseSet.refusedOutpoints(INSTANCE)).to.deep.equal(new Set([OUTPOINT_B]));
  });

  it('rejects malformed outpoints on both write paths', async () => {
    for (const fn of ['refuseOutpoint', 'removeRefusedOutpoint']) {
      try {
        await meshRefuseSet[fn](INSTANCE, 'not-an-outpoint'); // eslint-disable-line no-await-in-loop
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(TypeError);
      }
    }
  });
});
