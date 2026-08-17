'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const secp256k1 = require('secp256k1');
const bs58check = require('bs58check');

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const generalService = require('../../ZelBack/src/services/generalService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');

const FOUNDER_KEY = `myapp/founder-${foundingCommittee.founderToken('myapp', 'db')}@500000`;
const grantClient = require('../../ZelBack/src/services/quorumGrant/grantClient');
const registerCore = require('../../ZelBack/src/services/quorumGrant/grantRegisterCore');
const rosterOverlay = require('../../ZelBack/src/services/quorumGrant/rosterOverlay');
const signedEnvelope = require('../../ZelBack/src/services/quorumGrant/signedEnvelope');
const masterleasePublisher = require('../../ZelBack/src/services/quorumGrant/masterleasePublisher');
const { selectCommittee } = require('../../ZelBack/src/services/utils/committeeSelector');

// The client against a fake fleet whose grantors run the REAL register core —
// the protocol exercised end to end with only the network stubbed out. The
// clock and the renewal scheduler are injected, so every timing rule is
// driven by arithmetic, not by waiting. Every peer carries a real keypair:
// roster acceptances are signed and verified through the true crypto path,
// because the holder's quorum counting is exactly a security property.

const WIF = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
// chosen so the walk seats a full nine-committee that includes neither this
// node nor the standby — asserted below, never assumed
const SELF_TXHASH = 'e'.repeat(64);
const SELF = `${SELF_TXHASH}:0`;
const SELF_HOST = '203.0.113.5';
const KEY = 'myapp/master';
const TTL = 60_000;
const COMMITTEE_SIZE = 9;
const REGISTER_TUNABLES = { lockDelayMs: 30_000, maxTtlMs: 300_000 };

const peerKeypairs = new Map();

function keypairFor(index) {
  if (!peerKeypairs.has(index)) {
    const priv = Buffer.alloc(32);
    priv.writeUInt32BE(index + 1, 28);
    peerKeypairs.set(index, {
      wif: bs58check.encode(Buffer.concat([Buffer.from([0x80]), priv])),
      pubkey: Buffer.from(secp256k1.publicKeyCreate(priv, false)).toString('hex'),
    });
  }
  return peerKeypairs.get(index);
}

function membershipFixture() {
  const peers = Array.from({ length: 13 }, (unused, i) => ({
    // zero-padded so every outpoint is distinct — repeat-and-slice spells
    // the same txhash for peers 1 and 11, and two seats sharing an outpoint
    // collapse into one reply
    txhash: String(i + 1).padStart(2, '0').repeat(32),
    outidx: 0,
    pubkey: keypairFor(i + 1).pubkey,
    ip: `10.${i + 1}.0.1:16127`,
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
  const committee = selectCommittee(membership, rosterOverlay.walkKeyFor(KEY, 0), { size: COMMITTEE_SIZE });
  const committeeHosts = committee.members.map((node) => node.ip.split(':')[0]);
  const founderCommittee = selectCommittee(membership, 'quorumgrant|myapp/founder', { size: COMMITTEE_SIZE });
  const standbyNode = membership.find(
    (node) => !committeeHosts.includes(node.ip.split(':')[0]) && node.txhash !== SELF_TXHASH,
  );
  const STANDBY_HOST = standbyNode.ip.split(':')[0];

  const hostNodes = new Map(membership.map((node) => [node.ip.split(':')[0], node]));
  const hostWifs = new Map(membership.map((node, i) => [
    node.ip.split(':')[0],
    node.txhash === SELF_TXHASH ? WIF : keypairFor(i + 1).wif,
  ]));

  it('fixture: a full nine-committee seats, and neither this node nor the standby is on it', () => {
    expect(committee.members).to.have.length(COMMITTEE_SIZE);
    expect(committee.quorum).to.equal(5);
    expect(committeeHosts).to.not.include(SELF_HOST);
    expect(committeeHosts).to.not.include(STANDBY_HOST);
  });

  let registers; // host -> Map<key, record> — each fake grantor's disk
  let unreachable; // hosts that direct asks from this node cannot reach
  let dark; // hosts that answer nobody at all — not even a carrier
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
      generation: ask.generation,
      fingerprint: ask.fingerprint,
    };

    if (type === 'roster') {
      // the grantor half of a heal, exactly as the controller runs it:
      // verify any carried chain, let the real core judge, sign the
      // acceptance with this grantor's own key. Driven by the injected
      // clock so the rate window is test arithmetic, not wall time.
      let verifiedCarriedChain;
      if (Array.isArray(ask.chain) && ask.chain.length) {
        const verified = rosterOverlay.verifyChain(
          membership, ask.key, ask.fingerprint, ask.generation, COMMITTEE_SIZE, ask.chain,
        );
        if (!verified) return { ok: false, code: 'bad_chain' };
        verifiedCarriedChain = ask.chain;
      }
      const outcome = registerCore.onRoster(record, {
        epoch: ask.epoch,
        candidate: ask.candidate,
        remove: ask.remove,
        add: ask.add,
        seq: ask.seq,
        generation: ask.generation,
        fingerprint: ask.fingerprint,
        at: ask.at,
      }, clockNow, REGISTER_TUNABLES, {
        key: ask.key, membership, committeeSize: COMMITTEE_SIZE, verifiedCarriedChain,
      });
      if (outcome.record) store.set(ask.key, outcome.record);
      if (!outcome.reply.ok) return outcome.reply;
      const node = hostNodes.get(host);
      const fields = signedEnvelope.fieldsFor('rosteraccept', {
        key: ask.key,
        fingerprint: ask.fingerprint,
        generation: ask.generation,
        seq: ask.seq,
        remove: ask.remove,
        add: ask.add,
      });
      const signed = signedEnvelope.sign('rosteraccept', fields, hostWifs.get(host));
      return {
        ...outcome.reply,
        acceptance: { grantor: `${node.txhash}:${node.outidx}`, signature: signed.signature },
      };
    }

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
      if (unreachable.has(host) || dark.has(host)) throw new Error('unreachable');
      if (!relayDelivers) {
        // the carrier answered but could not reach the committee either —
        // the honest shape of a partition that isolates the whole app side
        return { data: { status: 'success', data: { replies: [] } } };
      }
      const replies = committee.members
        .filter((member) => !dark.has(member.ip.split(':')[0]))
        .map((member) => ({
          member: `${member.txhash}:${member.outidx}`,
          reply: dispatchToGrantor(member.ip.split(':')[0], body.type, body.ask),
        }));
      return { data: { status: 'success', data: { replies } } };
    }

    if (path === '/flux/quorumgrant/witness') {
      if (unreachable.has(host) || dark.has(host)) throw new Error('unreachable');
      const reply = witnessReplies.get(host);
      if (!reply) throw new Error('no witness fixture');
      return { data: { status: 'success', data: reply } };
    }

    const type = path.split('/').pop();
    if (unreachable.has(host) || dark.has(host)) throw new Error('unreachable');
    return { data: { status: 'success', data: dispatchToGrantor(host, type, body) } };
  }

  beforeEach(() => {
    grantClient.resetForTests();
    registers = new Map(membership.map((node) => [node.ip.split(':')[0], new Map()]));
    unreachable = new Set();
    dark = new Set();
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
    sinon.stub(masterleasePublisher, 'publishMasterlease').resolves(true);
    sinon.stub(messageStore, 'getMasterleaseRecord').resolves(null);
    sinon.stub(messageStore, 'getGrantGenerationRecord').resolves(null);
    // the founding record's committee happens to sit at the current basis in
    // this fixture; the basis-divergence case asserts its own fingerprint
    sinon.stub(foundingCommittee, 'refereeCommittee').resolves({
      repinned: false,
      generation: 0,
      anchor: 500000,
      fingerprint,
      quorum: founderCommittee.quorum,
      members: founderCommittee.members,
    });
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

  describe('the rest check', () => {
    it('a live incumbent anywhere keeps the rest', async () => {
      seedRecord({
        promisedEpoch: 2,
        accepted: {
          epoch: 2, grantee: 'other:0', mode: 'held', expiresAt: Date.now() + TTL, released: false,
        },
      });
      expect(await grantClient.termLapsed(KEY)).to.equal(false);
    });

    it('a provably lapsed term opens the pursuit', async () => {
      seedRecord({
        promisedEpoch: 2,
        accepted: {
          epoch: 2, grantee: 'other:0', mode: 'held', expiresAt: Date.now() - TTL, released: false,
        },
      });
      expect(await grantClient.termLapsed(KEY)).to.equal(true);
    });

    it('total silence keeps the rest — pursuing on silence is what broke the coast vouch', async () => {
      committeeHosts.forEach((host) => unreachable.add(host));
      expect(await grantClient.termLapsed(KEY)).to.equal(false);
    });
  });

  describe('acquisition', () => {
    it('acquires a held grant: probe, prepare, accept, quorum recorded on the registers', async () => {
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      expect(outcome.holder.state).to.equal('held');

      const recorded = committeeHosts
        .map((host) => registers.get(host).get(KEY))
        .filter((record) => record?.accepted?.grantee === SELF);
      expect(recorded.length).to.equal(COMMITTEE_SIZE);
      expect(outcome.holder.safeUntil()).to.equal(clockNow + TTL);

      // §4 step 4: the winner published
      expect(masterleasePublisher.publishMasterlease.calledOnce).to.equal(true);
      const published = masterleasePublisher.publishMasterlease.firstCall.args[0];
      expect(published.key).to.equal(KEY);
      expect(published.grantee).to.equal(SELF);
      expect(published.mode).to.equal('held');
      expect(published.ttlMs).to.equal(TTL);
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
      const founding = await grantClient.acquire(FOUNDER_KEY, holderOptions({ mode: 'oneshot' }));
      expect(founding.granted).to.equal(true);
      expect(founding.founder).to.equal(SELF);
      const published = masterleasePublisher.publishMasterlease.firstCall.args[0];
      expect(published.mode).to.equal('oneshot');
      expect(published.ttlMs).to.equal(undefined);

      // the same node re-asking converges on its own record
      const again = await grantClient.acquire(FOUNDER_KEY, holderOptions({ mode: 'oneshot' }));
      expect(again.granted).to.equal(true);
      expect(again.founder).to.equal(SELF);
    });

    it('adopts a foreign founding record instead of contesting it', async () => {
      const foreignCommittee = selectCommittee(membership, 'quorumgrant|myapp/founder', { size: 9 });
      foreignCommittee.members.forEach((member) => {
        registers.get(member.ip.split(':')[0]).set(FOUNDER_KEY, {
          promisedEpoch: 1,
          accepted: {
            epoch: 1, grantee: 'other:0', mode: 'oneshot', expiresAt: null, released: false,
          },
        });
      });
      const outcome = await grantClient.acquire(FOUNDER_KEY, holderOptions({ mode: 'oneshot' }));
      expect(outcome.granted).to.equal(false);
      expect(outcome.founder).to.equal('other:0');
    });

    it('oneshot asks carry the founding record basis, not the current list', async () => {
      const photoFp = 'a'.repeat(64);
      foundingCommittee.refereeCommittee.resolves({
        repinned: false,
        generation: 2,
        anchor: 500000,
        fingerprint: photoFp,
        quorum: founderCommittee.quorum,
        members: founderCommittee.members,
      });
      const outcome = await grantClient.acquire(FOUNDER_KEY, holderOptions({ mode: 'oneshot' }));
      expect(outcome.granted).to.equal(true);
      expect(foundingCommittee.refereeCommittee.calledWith('myapp', 500000)).to.equal(true);
      const published = masterleasePublisher.publishMasterlease.firstCall.args[0];
      expect(published.fingerprint).to.equal(photoFp);
      expect(published.generation).to.equal(2);
    });

    it('no founding record means no committee — wait, never a minted basis', async () => {
      foundingCommittee.refereeCommittee.resolves(null);
      const outcome = await grantClient.acquire(FOUNDER_KEY, holderOptions({ mode: 'oneshot' }));
      expect(outcome.granted).to.equal(false);
      expect(outcome.reason).to.contain('committee unavailable');
    });

    it('an already-resolved committee is used as given, and its basis rides the asks', async () => {
      const override = {
        members: founderCommittee.members,
        quorum: founderCommittee.quorum,
        fingerprint: 'f'.repeat(64),
        generation: 3,
      };
      const outcome = await grantClient.acquire(FOUNDER_KEY, holderOptions({ mode: 'oneshot', committee: override }));
      expect(outcome.granted).to.equal(true);
      expect(foundingCommittee.refereeCommittee.called).to.equal(false);
      const published = masterleasePublisher.publishMasterlease.firstCall.args[0];
      expect(published.fingerprint).to.equal('f'.repeat(64));
      expect(published.generation).to.equal(3);
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

    it('publishes the record on acquisition only — no timer ever republishes it', async () => {
      const holder = await acquireHolder();
      expect(masterleasePublisher.publishMasterlease.callCount).to.equal(1);

      clockNow += 20_000;
      await holder.renewOnce();
      clockNow += 60_000; // far past what the old half-term cadence would republish at
      await holder.renewOnce();
      expect(masterleasePublisher.publishMasterlease.callCount).to.equal(1);
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

    it('the demotion deadline is anchored — a collapsed ack set cannot slide it forever', async () => {
      let demotedReason = null;
      const outcome = await grantClient.acquire(KEY, holderOptions({
        onDemoted: (reason) => { demotedReason = reason; },
      }));
      const { holder } = outcome;
      // every grantor's term has lapsed: renewals come back refused, each
      // refusal deletes an ack, and safeUntil collapses to null
      committeeHosts.forEach((host) => {
        const record = registers.get(host).get(KEY);
        record.accepted.expiresAt = Date.now() - TTL;
      });
      witnessReplies.set(STANDBY_HOST, { quorumReachable: true, holding: false, acquiring: false });

      clockNow += TTL + 30_000;
      await holder.renewOnce();
      clockNow += 30_000; // far past any slack measured from the first unsafe pass
      await holder.renewOnce();

      expect(holder.state).to.equal('lost');
      expect(demotedReason).to.not.equal(null);
    });

    it('an empty witness set never coasts — no resolvable witnesses is doubt, and doubt demotes', async () => {
      let demotedReason = null;
      const outcome = await grantClient.acquire(KEY, holderOptions({
        onDemoted: (reason) => { demotedReason = reason; },
      }));
      const { holder } = outcome;
      committeeHosts.forEach((host) => unreachable.add(host));
      relayDelivers = false;
      // every standby's location row is gone: nobody resolves as a witness,
      // so nobody can vouch that no takeover is possible
      registryManager.appLocation.resolves([{ ip: `${SELF_HOST}:16127` }]);

      clockNow += TTL + 30_000;
      await holder.renewOnce();

      expect(holder.state).to.equal('lost');
      expect(demotedReason).to.contain('witness');
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
      expect(carried.replies.length).to.equal(COMMITTEE_SIZE);
      const members = carried.replies.map((entry) => entry.member).sort();
      const expected = committee.members.map((node) => `${node.txhash}:${node.outidx}`).sort();
      expect(members).to.deep.equal(expected);
    });
  });

  describe('the committee heal', () => {
    const outpoint = (node) => `${node.txhash}:${node.outidx}`;

    // the walk's forced replacement for the first heal, derived with the
    // same arithmetic the holder and every grantor run
    const darkMember = committee.members[0];
    const DARK_HOST = darkMember.ip.split(':')[0];
    const survivors = committee.members.filter((node) => node !== darkMember);
    const replacement = rosterOverlay.nextReplacement(
      membership, rosterOverlay.walkKeyFor(KEY, 0), survivors, new Set([outpoint(darkMember)]),
    );

    it('fixture: the walk can seat a replacement for the first dark referee', () => {
      expect(replacement).to.not.equal(null);
      expect(committeeHosts).to.not.include(replacement.ip.split(':')[0]);
    });

    async function acquireThenDarken() {
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      dark.add(DARK_HOST);
      return outcome.holder;
    }

    it('a referee silent for a full term is replaced by the walk\'s forced seat, quorum-signed', async () => {
      const holder = await acquireThenDarken();

      // silent, but not yet for a full term: no heal
      clockNow += TTL - 1_000;
      await holder.renewOnce();
      expect(masterleasePublisher.publishMasterlease.lastCall.args[0].roster).to.equal(undefined);

      clockNow += 2_000;
      await holder.renewOnce();

      // the record now carries the healed roster, every acceptance from the
      // eight surviving referees, each verified against its registered key
      const published = masterleasePublisher.publishMasterlease.lastCall.args[0];
      expect(published.roster.chain).to.have.length(1);
      const entry = published.roster.chain[0];
      expect(entry.remove).to.equal(outpoint(darkMember));
      expect(entry.add).to.equal(outpoint(replacement));
      expect(entry.acceptances).to.have.length(COMMITTEE_SIZE - 1);

      // the surviving registers journaled the chain; the dark one never heard
      expect(registers.get(committeeHosts[1]).get(KEY).roster.chain).to.have.length(1);
      expect(registers.get(DARK_HOST).get(KEY).roster).to.equal(undefined);

      // the fresh seat was handed the grant it now referees
      const seeded = registers.get(replacement.ip.split(':')[0]).get(KEY);
      expect(seeded.accepted.grantee).to.equal(SELF);

      // and the next renewal round holds on the healed committee
      clockNow += 20_000;
      await holder.renewOnce();
      expect(holder.state).to.equal('held');
      expect(holder.safeUntil()).to.equal(clockNow + TTL);
    });

    it('one seat per rate window — the second dark referee waits it out, then heals too', async () => {
      const holder = await acquireThenDarken();
      clockNow += TTL + 1_000;
      await holder.renewOnce();
      expect(masterleasePublisher.publishMasterlease.lastCall.args[0].roster.chain).to.have.length(1);

      // a second referee goes dark immediately after the first heal
      const secondDark = committee.members[1];
      dark.add(secondDark.ip.split(':')[0]);

      clockNow += TTL + 1_000; // dark long enough, but inside the rate window
      await holder.renewOnce();
      expect(masterleasePublisher.publishMasterlease.lastCall.args[0].roster.chain).to.have.length(1);

      clockNow += REGISTER_TUNABLES.maxTtlMs; // the window has run
      await holder.renewOnce();
      const published = masterleasePublisher.publishMasterlease.lastCall.args[0];
      expect(published.roster.chain).to.have.length(2);
      expect(published.roster.chain[1].remove).to.equal(outpoint(secondDark));
      expect(holder.state).to.equal('held');

      // the second link was judged by the healed committee: the first
      // replacement's register — seeded, then back-filled by the carried
      // chain — journaled both links
      const firstReplacementStore = registers.get(replacement.ip.split(':')[0]).get(KEY);
      expect(firstReplacementStore.roster.chain).to.have.length(2);
    });

    it('below an acceptance quorum nothing changes — tier one needs the committee alive', async () => {
      const holder = await acquireThenDarken();
      // five of nine dark: renewals lose quorum before any heal could run
      committee.members.slice(1, 5).forEach((member) => dark.add(member.ip.split(':')[0]));
      witnessReplies.set(STANDBY_HOST, { quorumReachable: false, holding: false, acquiring: false });

      clockNow += TTL + 30_000;
      await holder.renewOnce();

      expect(holder.state).to.not.equal('held');
      const published = masterleasePublisher.publishMasterlease.lastCall.args[0];
      expect(published.roster).to.equal(undefined);
      expect(registers.get(committeeHosts[5]).get(KEY).roster).to.equal(undefined);
    });

    it('a newer owner generation deals a fresh committee, and the grant is written by it', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: { generation: 2 } });
      const rolled = selectCommittee(membership, rosterOverlay.walkKeyFor(KEY, 2), { size: COMMITTEE_SIZE });
      const rolledHosts = rolled.members.map((node) => node.ip.split(':')[0]);
      expect([...rolledHosts].sort()).to.not.deep.equal([...committeeHosts].sort());
      expect(rolledHosts).to.not.include(SELF_HOST);

      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);

      const written = rolledHosts.filter(
        (host) => registers.get(host).get(KEY)?.accepted?.grantee === SELF,
      );
      expect(written).to.have.length(COMMITTEE_SIZE);
      expect(registers.get(rolledHosts[0]).get(KEY).accepted.generation).to.equal(2);
      expect(masterleasePublisher.publishMasterlease.lastCall.args[0].generation).to.equal(2);

      // the retired deal's seats that lost their chair heard nothing at all
      const retiredOnly = committeeHosts.filter((host) => !rolledHosts.includes(host));
      retiredOnly.forEach((host) => expect(registers.get(host).get(KEY)).to.equal(undefined));
    });

    it('a challenger acquires from the healed committee through the published record', async () => {
      const holder = await acquireThenDarken();
      clockNow += TTL + 1_000;
      await holder.renewOnce();
      const published = masterleasePublisher.publishMasterlease.lastCall.args[0];
      expect(published.roster.chain).to.have.length(1);

      // the incumbent stops; the published record is what survives it
      holder.stop();
      messageStore.getMasterleaseRecord.resolves({
        data: { fingerprint, roster: published.roster },
      });

      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);

      // the fresh term was written by the healed committee — including the
      // replacement seat, never the dark one it displaced
      const replacementRecord = registers.get(replacement.ip.split(':')[0]).get(KEY);
      expect(replacementRecord.accepted.epoch).to.equal(outcome.holder.epoch);
      const darkRecord = registers.get(DARK_HOST).get(KEY);
      expect(darkRecord.accepted.epoch).to.not.equal(outcome.holder.epoch);
    });
  });
});
