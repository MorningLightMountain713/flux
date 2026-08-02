const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const CONFIG = {
  fluxapps: { playgroundMinerCpuBusyFraction: 0.9, playgroundMinerBlockMs: 86400000 },
};

describe('playgroundAbuse', () => {
  let abuse;
  let getSecret;

  function load(opts = {}) {
    getSecret = sinon.stub().callsFake(async (mint) => (
      'secret' in opts ? opts.secret : mint()
    ));
    abuse = proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundAbuse', {
      config: CONFIG,
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../appDatabase/nodeIdentityRepository': {
        getOrCreatePlaygroundFingerprintSecret: getSecret,
      },
    });
    abuse.reset();
    return abuse;
  }

  // The mining shape: pegged, never answered, ran to the deadline.
  const miner = (over = {}) => ({
    cpuBusyFraction: 0.98,
    everAcceptedConnection: false,
    ranToDeadline: true,
    ...over,
  });

  beforeEach(() => { load({ secret: 'node-secret' }); });
  afterEach(() => { sinon.restore(); });

  describe('looksLikeMining', () => {
    it('flags a session that pegged the cpu, answered nothing and ran to the deadline', () => {
      expect(abuse.looksLikeMining(miner())).to.equal(true);
    });

    // A transcoder or an image that compiles on first boot pegs a core too — but
    // it answers on its port. That is the whole discriminator.
    it('leaves a busy session that answered its probe alone', () => {
      expect(abuse.looksLikeMining(miner({ everAcceptedConnection: true }))).to.equal(false);
    });

    // A queue worker answers nothing and runs to the deadline too — but it is
    // not burning a core.
    it('leaves a quiet session that answered nothing alone', () => {
      expect(abuse.looksLikeMining(miner({ cpuBusyFraction: 0.2 }))).to.equal(false);
    });

    it('leaves a session that exited on its own alone', () => {
      expect(abuse.looksLikeMining(miner({ ranToDeadline: false }))).to.equal(false);
    });

    // Never measured is not the same as never busy. Judging on the other two
    // alone would describe an ordinary worker.
    it('does not flag when the cpu could not be sampled', () => {
      expect(abuse.looksLikeMining(miner({ cpuBusyFraction: null }))).to.equal(false);
    });

    it('does not flag an empty record', () => {
      expect(abuse.looksLikeMining(null)).to.equal(false);
      expect(abuse.looksLikeMining({})).to.equal(false);
    });

    it('treats the threshold as inclusive', () => {
      expect(abuse.looksLikeMining(miner({ cpuBusyFraction: 0.9 }))).to.equal(true);
      expect(abuse.looksLikeMining(miner({ cpuBusyFraction: 0.89 }))).to.equal(false);
    });
  });

  describe('fingerprint', () => {
    it('is stable for the same caller', async () => {
      const a = await abuse.fingerprint('zelid1', '1.2.3.4');
      const b = await abuse.fingerprint('zelid1', '1.2.3.4');
      expect(a).to.equal(b);
    });

    it('separates callers by FluxID and by address', async () => {
      const base = await abuse.fingerprint('zelid1', '1.2.3.4');
      expect(await abuse.fingerprint('zelid2', '1.2.3.4')).to.not.equal(base);
      expect(await abuse.fingerprint('zelid1', '5.6.7.8')).to.not.equal(base);
    });

    // One-way and node-local: the point is that the node can match a returning
    // caller without holding anything that says who they are.
    it('reveals neither the FluxID nor the address', async () => {
      const print = await abuse.fingerprint('zelid1', '1.2.3.4');
      expect(print).to.not.include('zelid1');
      expect(print).to.not.include('1.2.3.4');
      expect(print).to.match(/^[0-9a-f]{64}$/);
    });

    // Different secrets mean the same person fingerprints differently on
    // different nodes, so these cannot be pooled into a picture of who is
    // trying what across the fleet.
    it('does not compare across nodes', async () => {
      const here = await abuse.fingerprint('zelid1', '1.2.3.4');
      load({ secret: 'a-different-node' });
      expect(await abuse.fingerprint('zelid1', '1.2.3.4')).to.not.equal(here);
    });

    it('mints a secret when the node has none yet', async () => {
      load({});
      const print = await abuse.fingerprint('zelid1', '1.2.3.4');
      expect(print).to.match(/^[0-9a-f]{64}$/);
      expect(getSecret.calledOnce).to.equal(true);
    });

    // Asked for on every admission; it never changes for the life of the node.
    it('reads the secret once and caches it', async () => {
      await abuse.fingerprint('zelid1', '1.2.3.4');
      await abuse.fingerprint('zelid2', '5.6.7.8');
      expect(getSecret.calledOnce).to.equal(true);
    });

    it('cannot fingerprint when the secret is unavailable', async () => {
      load({ secret: null });
      expect(await abuse.fingerprint('zelid1', '1.2.3.4')).to.equal(null);
    });
  });

  describe('isBlocked', () => {
    it('refuses a caller flagged inside the window', async () => {
      const found = sinon.stub().resolves({ _id: 'x' });
      expect(await abuse.isBlocked('zelid1', '1.2.3.4', found)).to.equal(true);
    });

    it('admits a caller with no flagged record', async () => {
      const found = sinon.stub().resolves(null);
      expect(await abuse.isBlocked('zelid1', '1.2.3.4', found)).to.equal(false);
    });

    it('looks only as far back as the block window', async () => {
      const found = sinon.stub().resolves(null);
      const before = Date.now();
      await abuse.isBlocked('zelid1', '1.2.3.4', found);
      const [print, since] = found.firstCall.args;
      expect(print).to.match(/^[0-9a-f]{64}$/);
      expect(since).to.be.closeTo(before - abuse.blockMs(), 5000);
    });

    // Fails OPEN. Turning honest callers away on a storage blip is worse than
    // letting a flagged one through: the duty cycle still bounds them, and the
    // next session flags them again.
    it('admits rather than refuses when the lookup fails', async () => {
      const found = sinon.stub().rejects(new Error('mongo down'));
      expect(await abuse.isBlocked('zelid1', '1.2.3.4', found)).to.equal(false);
    });

    it('admits when the node cannot fingerprint at all', async () => {
      load({ secret: null });
      const found = sinon.stub().resolves({ _id: 'x' });
      expect(await abuse.isBlocked('zelid1', '1.2.3.4', found)).to.equal(false);
      expect(found.called).to.equal(false);
    });
  });
});
