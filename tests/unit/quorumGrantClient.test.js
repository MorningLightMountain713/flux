'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const generalService = require('../../ZelBack/src/services/generalService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const grantClient = require('../../ZelBack/src/services/quorumGrant/grantClient');
const registerCore = require('../../ZelBack/src/services/quorumGrant/grantRegisterCore');
const { selectCommittee } = require('../../ZelBack/src/services/utils/committeeSelector');

// The client against a fake fleet whose grantors run the REAL register core —
// the protocol exercised end to end with only the network stubbed out. The
// clock and the renewal scheduler are injected, so every timing rule is
// driven by arithmetic, not by waiting.

const WIF = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
const SELF_TXHASH = 'a'.repeat(64);
const SELF = `${SELF_TXHASH}:0`;
const SELF_HOST = '203.0.113.5';
const KEY = 'myapp/master';
const TTL = 60_000;
const REGISTER_TUNABLES = { lockDelayMs: 30_000, maxTtlMs: 300_000 };

function membershipFixture() {
  const peers = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
    txhash: String(i).repeat(64).slice(0, 64),
    outidx: 0,
    pubkey: `owner-${i}`,
    ip: `10.${i}.0.1:16127`,
  }));
  const self = {
    txhash: SELF_TXHASH, outidx: 0, pubkey: 'owner-self', ip: `${SELF_HOST}:16127`,
  };
  return [...peers, self];
}

describe('quorumGrant grantClient', () => {
  const membership = membershipFixture();
  const fingerprint = 'd'.repeat(64);

  // the same walk the client runs, so the test always knows who the referees
  // are — and the standby is picked OFF the committee by construction, so
  // "the committee is unreachable" never silently cuts the standby too
  const committee = selectCommittee(membership, `quorumgrant|${KEY}`, { size: 5 });
  const committeeHosts = committee.members.map((node) => node.ip.split(':')[0]);
  const standbyNode = membership.find(
    (node) => !committeeHosts.includes(node.ip.split(':')[0]) && node.txhash !== SELF_TXHASH,
  );
  const STANDBY_HOST = standbyNode.ip.split(':')[0];

  let registers; // host -> Map<key, record> — each fake grantor's disk
  let unreachable; // hosts that direct asks cannot reach
  let relayDelivers; // whether a reachable carrier can itself reach the committee
  let witnessReplies; // host -> reply for /witness
  let clockNow;

  function clock() {
    return clockNow;
  }

  function dispatchToGrantor(host, type, ask) {
    const store = registers.get(host);
    const record = store.get(ask.key) ?? null;
    const request = {
      epoch: ask.epoch,
      candidate: ask.candidate,
      grantee: ask.candidate,
      mode: ask.mode,
      ttlMs: ask.ttlMs,
      fingerprint: ask.fingerprint,
    };
    const handlers = {
      probe: () => ({ reply: registerCore.onProbe(record, request, Date.now(), REGISTER_TUNABLES), record: null }),
      prepare: () => registerCore.onPrepare(record, request, Date.now(), REGISTER_TUNABLES),
      accept: () => registerCore.onAccept(record, request, Date.now(), REGISTER_TUNABLES),
      renew: () => registerCore.onRenew(record, request, Date.now()),
      release: () => registerCore.onRelease(record, request, Date.now()),
    };
    const outcome = handlers[type]();
    if (outcome.record) store.set(ask.key, outcome.record);
    return outcome.reply;
  }

  function fakePost(url, body) {
    const [, host, path] = url.match(/^http:\/\/([^:]+):\d+(\/.*)$/);

    if (path === '/flux/quorumgrant/relay') {
      if (unreachable.has(host)) throw new Error('unreachable');
      if (!relayDelivers) {
        // the carrier answered but could not reach the committee either —
        // the honest shape of a partition that isolates the whole app side
        return { data: { status: 'success', data: { replies: [] } } };
      }
      const replies = committee.members.map((member) => ({
        member: `${member.txhash}:${member.outidx}`,
        reply: dispatchToGrantor(member.ip.split(':')[0], body.type, body.ask),
      }));
      return { data: { status: 'success', data: { replies } } };
    }

    if (path === '/flux/quorumgrant/witness') {
      if (unreachable.has(host)) throw new Error('unreachable');
      const reply = witnessReplies.get(host);
      if (!reply) throw new Error('no witness fixture');
      return { data: { status: 'success', data: reply } };
    }

    const type = path.split('/').pop();
    if (unreachable.has(host)) throw new Error('unreachable');
    return { data: { status: 'success', data: dispatchToGrantor(host, type, body) } };
  }

  beforeEach(() => {
    grantClient.resetForTests();
    registers = new Map(membership.map((node) => [node.ip.split(':')[0], new Map()]));
    unreachable = new Set();
    relayDelivers = true;
    witnessReplies = new Map();
    clockNow = 1_000_000;

    sinon.stub(serviceHelper, 'axiosPost').callsFake(async (url, body) => fakePost(url, body));
    sinon.stub(serviceHelper, 'axiosGet').callsFake(async (url) => {
      const [, host] = url.match(/^http:\/\/([^:]+):/);
      if (unreachable.has(host)) throw new Error('unreachable');
      return { data: { status: 'success', data: {} } };
    });
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
      txhash: SELF_TXHASH, txindex: 0,
    });
    sinon.stub(fluxNetworkHelper, 'getFluxNodePrivateKey').resolves(WIF);
    sinon.stub(networkStateService, 'membershipFingerprint').returns(fingerprint);
    sinon.stub(networkStateService, 'membershipAt').returns(membership);
    sinon.stub(registryManager, 'appLocation').resolves([
      { ip: `${SELF_HOST}:16127` },
      { ip: `${STANDBY_HOST}:16127` },
    ]);
  });

  afterEach(() => {
    grantClient.resetForTests();
    sinon.restore();
  });

  function holderOptions(overrides = {}) {
    return {
      mode: 'held',
      ttlMs: TTL,
      clock,
      schedule: () => null,
      cancel: () => {},
      ...overrides,
    };
  }

  function seedRecord(record) {
    committeeHosts.forEach((host) => {
      registers.get(host).set(KEY, JSON.parse(JSON.stringify(record)));
    });
  }

  describe('acquisition', () => {
    it('acquires a held grant: probe, prepare, accept, quorum recorded on the registers', async () => {
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      expect(outcome.holder.state).to.equal('held');

      const recorded = committeeHosts
        .map((host) => registers.get(host).get(KEY))
        .filter((record) => record?.accepted?.grantee === SELF);
      expect(recorded.length).to.equal(5);
      expect(outcome.holder.safeUntil()).to.equal(clockNow + TTL);
    });

    it('walks away from a live incumbent without burning an epoch', async () => {
      seedRecord({
        promisedEpoch: 4,
        accepted: {
          epoch: 4, grantee: 'other:0', mode: 'held', expiresAt: Date.now() + TTL, released: false,
        },
      });
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(false);
      expect(outcome.incumbent.grantee).to.equal('other:0');
      committeeHosts.forEach((host) => {
        expect(registers.get(host).get(KEY).promisedEpoch).to.equal(4);
      });
    });

    it('reports the lock-delay a lapsed record still carries', async () => {
      seedRecord({
        promisedEpoch: 4,
        accepted: {
          epoch: 4, grantee: 'other:0', mode: 'held', expiresAt: Date.now() - 1000, released: false,
        },
      });
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(false);
      expect(outcome.retryAfterMs).to.be.greaterThan(0);
    });

    it('founds once, and the second founder learns who was first', async () => {
      const founding = await grantClient.acquire('myapp/founder', holderOptions({ mode: 'oneshot' }));
      expect(founding.granted).to.equal(true);
      expect(founding.founder).to.equal(SELF);

      // the same node re-asking converges on its own record
      const again = await grantClient.acquire('myapp/founder', holderOptions({ mode: 'oneshot' }));
      expect(again.granted).to.equal(true);
      expect(again.founder).to.equal(SELF);
    });

    it('adopts a foreign founding record instead of contesting it', async () => {
      const foreignCommittee = selectCommittee(membership, 'quorumgrant|myapp/founder', { size: 5 });
      foreignCommittee.members.forEach((member) => {
        registers.get(member.ip.split(':')[0]).set('myapp/founder', {
          promisedEpoch: 1,
          accepted: {
            epoch: 1, grantee: 'other:0', mode: 'oneshot', expiresAt: null, released: false,
          },
        });
      });
      const outcome = await grantClient.acquire('myapp/founder', holderOptions({ mode: 'oneshot' }));
      expect(outcome.granted).to.equal(false);
      expect(outcome.founder).to.equal('other:0');
    });
  });

  describe('the holder', () => {
    async function acquireHolder() {
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      return outcome.holder;
    }

    it('renewal extends safety from the send instant', async () => {
      const holder = await acquireHolder();
      clockNow += 20_000;
      await holder.renewOnce();
      expect(holder.state).to.equal('held');
      expect(holder.safeUntil()).to.equal(clockNow + TTL);
    });

    it('renews THROUGH a standby when the committee is unreachable directly', async () => {
      const holder = await acquireHolder();
      committeeHosts.forEach((host) => unreachable.add(host));

      clockNow += 20_000;
      await holder.renewOnce();
      expect(holder.state).to.equal('held');
      expect(holder.safeUntil()).to.equal(clockNow + TTL);
    });

    it('coasts on unanimous witnesses when no renewal path exists at all', async () => {
      const holder = await acquireHolder();
      committeeHosts.forEach((host) => unreachable.add(host));
      relayDelivers = false; // the standby answers, but cannot reach quorum either
      witnessReplies.set(STANDBY_HOST, { quorumReachable: false, holding: false, acquiring: false });

      clockNow += TTL + 30_000; // well past safety
      await holder.renewOnce();

      expect(holder.state).to.equal('jeopardy');
      expect(holder.coasting).to.equal(true);
    });

    it('demotes past the deadline when a witness breaks unanimity', async () => {
      let demotedReason = null;
      const outcome = await grantClient.acquire(KEY, holderOptions({
        onDemoted: (reason) => { demotedReason = reason; },
      }));
      const {holder} = outcome;
      committeeHosts.forEach((host) => unreachable.add(host));
      relayDelivers = false;
      witnessReplies.set(STANDBY_HOST, { quorumReachable: true, holding: false, acquiring: false });

      clockNow += TTL + 30_000;
      await holder.renewOnce();

      expect(holder.state).to.equal('lost');
      expect(demotedReason).to.contain('can reach quorum');
    });

    it('a higher epoch in any reply is a deposition, not a jeopardy', async () => {
      let demotedReason = null;
      const outcome = await grantClient.acquire(KEY, holderOptions({
        onDemoted: (reason) => { demotedReason = reason; },
      }));
      const {holder} = outcome;

      // a successor was seated at a higher epoch behind our back
      seedRecord({
        promisedEpoch: 9,
        accepted: {
          epoch: 9, grantee: 'other:0', mode: 'held', expiresAt: Date.now() + TTL, released: false,
        },
      });
      clockNow += 20_000;
      await holder.renewOnce();

      expect(holder.state).to.equal('lost');
      expect(demotedReason).to.contain('epoch 9');
    });

    it('release ends the term on the registers and locally', async () => {
      const holder = await acquireHolder();
      await holder.release();
      expect(holder.state).to.equal('lost');
      committeeHosts.forEach((host) => {
        expect(registers.get(host).get(KEY).accepted.released).to.equal(true);
      });
      const witness = await grantClient.witnessAnswer(KEY);
      expect(witness.holding).to.equal(false);
    });
  });

  describe('what this node answers its peers', () => {
    it('the witness answer reflects holding and committee reachability', async () => {
      await grantClient.acquire(KEY, holderOptions());
      const answer = await grantClient.witnessAnswer(KEY);
      expect(answer.holding).to.equal(true);
      expect(answer.quorumReachable).to.equal(true);

      committeeHosts.forEach((host) => unreachable.add(host));
      const cut = await grantClient.witnessAnswer(KEY);
      expect(cut.quorumReachable).to.equal(false);
    });

    it('carryAsk computes the committee itself and carries verbatim', async () => {
      const carried = await grantClient.carryAsk('probe', {
        key: KEY, mode: 'held', epoch: 1, candidate: SELF, fingerprint, at: Date.now(),
      }, 'sig');
      expect(carried.replies.length).to.equal(5);
      const members = carried.replies.map((entry) => entry.member).sort();
      const expected = committee.members.map((node) => `${node.txhash}:${node.outidx}`).sort();
      expect(members).to.deep.equal(expected);
    });
  });
});
