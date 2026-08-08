const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const CONFIG = { fluxapps: { playgroundEgressKbit: 1000 } };

describe('playgroundEgress', () => {
  let runCommand;
  let egress;

  // Every iptables/tc invocation, as the argv actually handed to the binary.
  const calls = () => runCommand.getCalls().map((c) => [c.args[0], ...c.args[1].params]);
  const iptablesCalls = () => calls().filter((c) => c[0] === 'iptables').map((c) => c.slice(1));
  const tcCalls = () => calls().filter((c) => c[0] === 'tc').map((c) => c.slice(1));

  function load(behaviour = () => ({ error: null })) {
    runCommand = sinon.stub().callsFake(async (bin, opts) => behaviour(bin, opts.params));
    egress = proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundEgress', {
      config: CONFIG,
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
      },
      '../serviceHelper': { runCommand },
    });
    return egress;
  }

  beforeEach(() => { load(); });
  afterEach(() => { sinon.restore(); });

  describe('the chain', () => {
    it('creates the chain when it is absent', async () => {
      load((bin, params) => ({ error: params[0] === '-L' ? new Error('No chain') : null }));
      await egress.ensureEgressPolicy();
      expect(iptablesCalls()).to.deep.include(['-N', 'FLUX-PLAYGROUND']);
    });

    it('does not recreate a chain that already exists', async () => {
      await egress.ensureEgressPolicy();
      expect(iptablesCalls().some((c) => c[0] === '-N')).to.equal(false);
    });

    // Always flushed and rewritten, so a half-applied previous run cannot leave
    // a partial policy that looks like a whole one.
    it('flushes before rewriting, so a partial previous run cannot survive', async () => {
      await egress.ensureEgressPolicy();
      const flushAt = iptablesCalls().findIndex((c) => c[0] === '-F');
      const firstRuleAt = iptablesCalls().findIndex((c) => c[0] === '-A');
      expect(flushAt).to.be.greaterThan(-1);
      expect(flushAt).to.be.lessThan(firstRuleAt);
    });

    // This is a default-deny policy. The DROP is the rule; everything above it
    // is an exception. If it ever stops being last, the policy is inverted.
    it('ends with a DROP, after every accept', async () => {
      await egress.ensureEgressPolicy();
      const appended = iptablesCalls().filter((c) => c[0] === '-A' && c[1] === 'FLUX-PLAYGROUND');
      expect(appended[appended.length - 1]).to.include('DROP');
      expect(appended.slice(0, -1).every((c) => c.includes('ACCEPT'))).to.equal(true);
    });

    it('lets a session reach DNS on both transports', async () => {
      await egress.ensureEgressPolicy();
      const rules = iptablesCalls().map((c) => c.join(' '));
      expect(rules.some((r) => r.includes('udp') && r.includes('53'))).to.equal(true);
      expect(rules.some((r) => r.includes('tcp') && r.includes('53'))).to.equal(true);
    });

    it('lets a session reach http and https, and nothing else', async () => {
      await egress.ensureEgressPolicy();
      const accepted = iptablesCalls()
        .filter((c) => c.includes('ACCEPT') && c.includes('--dport'))
        .map((c) => c[c.indexOf('--dport') + 1]);
      expect(accepted.sort()).to.deep.equal(['443', '53', '53', '80']);
    });

    // A session's own components have to reach each other, or its database is
    // unreachable from its own web container.
    it('lets components of one session talk to each other', async () => {
      await egress.ensureEgressPolicy();
      const intra = iptablesCalls().find((c) => c.includes('-i') && c.includes('-o') && c.includes('ACCEPT'));
      expect(intra).to.not.equal(undefined);
    });

    // Interface, never source address: a container can spoof its source, and a
    // spoofed packet would miss a subnet-matched jump and fall through to the
    // ordinary app rules, which allow the internet.
    it('matches on the interface, never on a source subnet', async () => {
      await egress.ensureEgressPolicy();
      // Rule additions only — -N/-L/-F name the chain but carry no match.
      const rules = iptablesCalls().filter((c) => c[0] === '-A' && c[1] === 'FLUX-PLAYGROUND');
      expect(rules).to.not.be.empty;
      expect(rules.every((c) => c.includes('-i'))).to.equal(true);
      expect(rules.some((c) => c.includes('-s'))).to.equal(false);
    });

    it('reports failure rather than claiming a policy it did not apply', async () => {
      load((bin, params) => ({ error: params[0] === '-A' ? new Error('denied') : null }));
      expect(await egress.ensureEgressPolicy()).to.equal(false);
    });

    it('refuses to claim a policy when iptables is missing entirely', async () => {
      load(() => ({ error: new Error('not found') }));
      expect(await egress.ensureEgressPolicy()).to.equal(false);
    });
  });

  describe('the DOCKER-USER jump', () => {
    it('inserts at the head, so it is decided before the app rules', async () => {
      load((bin, params) => ({ error: params[0] === '-C' ? new Error('absent') : null }));
      await egress.ensureEgressJump();
      const jump = iptablesCalls().find((c) => c[0] === '-I');
      expect(jump).to.deep.equal(['-I', 'DOCKER-USER', '-i', 'flxpg+', '-j', 'FLUX-PLAYGROUND']);
    });

    // iptables adds a duplicate every time it is asked, so the check matters.
    it('does not duplicate a jump that is already there', async () => {
      await egress.ensureEgressJump();
      expect(iptablesCalls().some((c) => c[0] === '-I')).to.equal(false);
    });

    it('reports failure when the jump cannot be added', async () => {
      load((bin, params) => ({ error: params[0] === '-nL' ? null : new Error(params[0] === '-C' ? 'absent' : 'denied') }));
      expect(await egress.ensureEgressJump()).to.equal(false);
    });

    // A node that never ran the playground has no chain - and nothing to
    // confine, so the rebuild's restore is a no-op, not a failure.
    it('treats a missing chain as nothing to restore', async () => {
      load((bin, params) => ({ error: params[0] === '-nL' ? new Error('No chain/target/match by that name') : null }));
      expect(await egress.ensureEgressJump()).to.equal(true);
      expect(iptablesCalls().some((c) => c[0] === '-I')).to.equal(false);
    });
  });

  describe('shapeBridge', () => {
    it('caps egress with tbf and ingress with a policer', async () => {
      await egress.shapeBridge('flxpg0');
      const cmds = tcCalls().map((c) => c.join(' '));
      expect(cmds.some((c) => c.includes('root tbf') && c.includes('1000kbit'))).to.equal(true);
      expect(cmds.some((c) => c.includes('ingress'))).to.equal(true);
      expect(cmds.some((c) => c.includes('police') && c.includes('drop'))).to.equal(true);
    });

    // Policing needs no IFB device; shaping ingress would. For a cap meant to
    // make abuse unattractive, dropping is also the better behaviour.
    it('polices ingress rather than redirecting through an IFB device', async () => {
      await egress.shapeBridge('flxpg0');
      expect(tcCalls().map((c) => c.join(' ')).some((c) => c.includes('ifb'))).to.equal(false);
    });

    it('targets the named bridge it was given', async () => {
      await egress.shapeBridge('flxpg3');
      expect(tcCalls().every((c) => c.includes('flxpg3'))).to.equal(true);
    });

    it('reports failure rather than claiming a cap it did not set', async () => {
      load(() => ({ error: new Error('RTNETLINK') }));
      expect(await egress.shapeBridge('flxpg0')).to.equal(false);
    });
  });
});
