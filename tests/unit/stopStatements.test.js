'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const { getFluxMessageSignature } = require('../../ZelBack/src/services/utils/fluxBroadcastHelper');
const {
  verifyStop, isLie, lieCertificate, verifyLieCertificate,
} = require('../../ZelBack/src/services/utils/stopStatements');

const privKey = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
const pubKey = '0474eb4690689bb408139249eda7f361b7881c4254ccbe303d3b4d58c2b48897d0f070b44944941998551f9ea0e1befd96f13adf171c07c885e62d0c2af56d3dab';
const NODE = '192.168.1.100:16127';
const PROCESS = 'ab'.repeat(16);
const NOW = Date.now();
const AGE = 5 * 60 * 1000;

async function statement(over = {}, timestamp = NOW) {
  const data = {
    type: 'fluxprocessstop', version: 1, ip: NODE, processId: PROCESS, reason: 'restart', ...over,
  };
  const signature = await getFluxMessageSignature(1 + JSON.stringify(data) + timestamp, privKey);
  return {
    version: 1, pubKey, timestamp, data, signature,
  };
}

describe('stopStatements', () => {
  beforeEach(() => {
    sinon.stub(networkStateService, 'getFluxnodeBySocketAddress')
      .withArgs(NODE).resolves({ ip: NODE, pubkey: pubKey });
  });

  afterEach(() => sinon.restore());

  describe('verifyStop', () => {
    it('accepts the listed node\'s signed stop and reads it', async () => {
      const stop = await verifyStop(await statement(), {
        now: NOW, maxAgeMs: AGE, socketAddress: NODE, reason: 'restart',
      });
      expect(stop).to.deep.equal({
        ok: true, ip: NODE, processId: PROCESS, reason: 'restart', stoppedAt: NOW,
      });
    });

    [
      ['another type', { type: 'fluxnodealive' }],
      ['another version', { version: 2 }],
      ['a process id that is not 32 hex', { processId: 'xyz' }],
      ['a reason that is not a stop', { reason: 'unannounced' }],
      ['no address', { ip: 7 }],
    ].forEach(([what, over]) => {
      it(`refuses ${what} as malformed`, async () => {
        const stop = await verifyStop(await statement(over), { now: NOW, maxAgeMs: AGE });
        expect(stop).to.deep.equal({ ok: false, why: 'malformed' });
      });
    });

    it('refuses a statement with no timestamp as malformed', async () => {
      const unstamped = await statement();
      delete unstamped.timestamp;
      expect(await verifyStop(unstamped, { now: NOW, maxAgeMs: AGE })).to.deep.equal({ ok: false, why: 'malformed' });
    });

    it('refuses another node\'s stop on this connection', async () => {
      const stop = await verifyStop(await statement(), { now: NOW, maxAgeMs: AGE, socketAddress: '192.168.1.101:16127' });
      expect(stop).to.deep.equal({ ok: false, why: 'other_node' });
    });

    it('refuses a stop naming another reason than the close', async () => {
      const stop = await verifyStop(await statement(), { now: NOW, maxAgeMs: AGE, reason: 'shutdown' });
      expect(stop).to.deep.equal({ ok: false, why: 'other_reason' });
    });

    it('accepts a stop signed up to the age either side of now, and refuses one beyond it', async () => {
      const early = await statement({}, NOW - AGE);
      const late = await statement({}, NOW + AGE);
      expect((await verifyStop(early, { now: NOW, maxAgeMs: AGE })).ok).to.equal(true);
      expect((await verifyStop(late, { now: NOW - 1000, maxAgeMs: AGE + 1000 })).ok).to.equal(true);
      expect(await verifyStop(early, { now: NOW + 1, maxAgeMs: AGE })).to.deep.equal({ ok: false, why: 'age' });
      expect(await verifyStop(await statement({}, NOW + AGE + 1), { now: NOW, maxAgeMs: AGE }))
        .to.deep.equal({ ok: false, why: 'age' });
    });

    it('refuses a stop of a node the list does not hold at its address', async () => {
      const stop = await verifyStop(await statement({ ip: '192.168.1.102:16127' }), { now: NOW, maxAgeMs: AGE });
      expect(stop.ok).to.equal(false);
      expect(stop.why).to.equal('nodeNotFound');
    });

    it('refuses a stop signed by another key than the listed node\'s', async () => {
      networkStateService.getFluxnodeBySocketAddress.withArgs(NODE).resolves({ ip: NODE, pubkey: 'another' });
      const stop = await verifyStop(await statement(), { now: NOW, maxAgeMs: AGE });
      expect(stop).to.deep.equal({ ok: false, why: 'pubkeyMismatch' });
    });

    it('refuses an envelope without its key or signature, or of another version, as malformed', async () => {
      const unsigned = await statement();
      delete unsigned.signature;
      const keyless = await statement();
      delete keyless.pubKey;
      const other = { ...(await statement()), version: 2 };
      await Promise.all([unsigned, keyless, other].map(async (envelope) => {
        expect(await verifyStop(envelope, { now: NOW, maxAgeMs: AGE })).to.deep.equal({ ok: false, why: 'malformed' });
      }));
    });

    it('refuses a statement whose signature is not the listed node\'s', async () => {
      const forged = await statement();
      forged.data = { ...forged.data, reason: 'shutdown' };
      const stop = await verifyStop(forged, { now: NOW, maxAgeMs: AGE });
      expect(stop).to.deep.equal({ ok: false, why: 'badSignature' });
    });
  });

  describe('isLie', () => {
    it('two stops of one process at different times are a lie', async () => {
      expect(isLie(await statement(), await statement({}, NOW + 1))).to.equal(true);
    });

    it('two stops of one process for different reasons are a lie', async () => {
      expect(isLie(await statement(), await statement({ reason: 'shutdown' }))).to.equal(true);
    });

    it('the same stop twice is not', async () => {
      expect(isLie(await statement(), await statement())).to.equal(false);
    });

    it('stops of two processes are not', async () => {
      expect(isLie(await statement(), await statement({ processId: 'cd'.repeat(16) }, NOW + 1))).to.equal(false);
    });

    it('stops of two nodes are not', async () => {
      expect(isLie(await statement(), await statement({ ip: '192.168.1.101:16127' }, NOW + 1))).to.equal(false);
    });
  });

  describe('a lie certificate', () => {
    const LISTED = { ip: NODE, pubkey: pubKey };

    it('carries both statements, and since is the later one\'s time', async () => {
      const a = await statement({}, NOW - 5000);
      const b = await statement({}, NOW);
      expect(lieCertificate('s:0', a, b)).to.deep.equal({
        subject: 's:0', reason: 'lie', since: NOW, proof: [a, b],
      });
      expect(lieCertificate('s:0', b, a).since).to.equal(NOW);
    });

    it('verifies against the listed subject', async () => {
      const certificate = lieCertificate('s:0', await statement({}, NOW - 5000), await statement());
      expect(verifyLieCertificate(certificate, LISTED)).to.deep.equal({ valid: true, reason: 'accepted' });
    });

    it('refuses a proof that is not two well-formed statements', async () => {
      const a = await statement({}, NOW - 5000);
      expect(verifyLieCertificate({ proof: [a] }, LISTED).reason).to.equal('malformed');
      expect(verifyLieCertificate({ proof: [a, { data: {} }] }, LISTED).reason).to.equal('malformed');
      expect(verifyLieCertificate({}, LISTED).reason).to.equal('malformed');
    });

    it('refuses a subject the list does not hold', async () => {
      const certificate = lieCertificate('s:0', await statement({}, NOW - 5000), await statement());
      expect(verifyLieCertificate(certificate, null).reason).to.equal('not_listed');
    });

    it('refuses the same stop twice: no lie', async () => {
      const a = await statement();
      expect(verifyLieCertificate(lieCertificate('s:0', a, a), LISTED).reason).to.equal('no_lie');
    });

    it('refuses a since that is not the later statement\'s time', async () => {
      const certificate = lieCertificate('s:0', await statement({}, NOW - 5000), await statement());
      expect(verifyLieCertificate({ ...certificate, since: NOW - 5000 }, LISTED).reason).to.equal('since');
    });

    it('refuses a statement whose signature does not hold', async () => {
      const a = await statement({}, NOW - 5000);
      const b = { ...(await statement()), signature: a.signature };
      expect(verifyLieCertificate(lieCertificate('s:0', a, b), LISTED).reason).to.equal('bad_signature');
    });
  });
});
