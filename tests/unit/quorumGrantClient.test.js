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
  let readCostMs; // what each record read costs this node on its OWN clock

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
      renew: () => registerCore.onRenew(record, request, Date.now(), REGISTER_TUNABLES),
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
    readCostMs = 0;

    sinon.stub(serviceHelper, 'axiosPost').callsFake(async (url, body) => fakePost(url, body));
    sinon.stub(serviceHelper, 'axiosGet').callsFake(async (url) => {
      const [, host] = url.match(/^http:\/\/([^:]+):/);
      if (unreachable.has(host) || dark.has(host)) throw new Error('unreachable');
      // the record read, served off this grantor's own register and THROUGH
      // its drain - a read contradicts nothing, which is the whole reason
      // re-learning works exactly when acquisition is refused. It answers a
      // DURATION on this grantor's clock, never its expiresAt.
      const [, path, query] = url.match(/^http:\/\/[^:]+:\d+([^?]+)\??(.*)$/);
      if (path === '/flux/quorumgrant/record') {
        clockNow += readCostMs;
        const key = new URLSearchParams(query).get('key');
        const stored = registers.get(host)?.get(key) ?? null;
        const expiresAt = stored?.accepted?.expiresAt;
        return {
          data: {
            status: 'success',
            data: {
              key,
              promisedEpoch: stored?.promisedEpoch ?? 0,
              accepted: stored?.accepted ?? null,
              remainingMs: Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : null,
              roster: stored?.roster ?? null,
            },
          },
        };
      }
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

    // D3, the other half. §7's alarm is STANDING - it fires ON the deadline
    // without waiting for a pass - and acquire() installs a Holder whose alarm
    // is armed only inside the first renewal pass, a jittered renewal interval
    // later. A fresh term has most of a TTL left so the window is harmless
    // today, but it is the same defect in the same shape as the restart case,
    // and the fix belongs in both places or it comes back.
    it('arms the standing alarm at acquisition, not at the first renewal pass', async () => {
      const scheduled = [];
      const outcome = await grantClient.acquire(KEY, {
        ...holderOptions(),
        schedule: (fn, ms) => { scheduled.push(ms); return null; },
      });
      expect(outcome.granted).to.equal(true);
      const deadlineInMs = outcome.holder.safeUntil() - clockNow;
      expect(
        scheduled.some((ms) => ms >= deadlineInMs),
        'nothing is scheduled as far out as the deadline - only the renewal loop armed',
      ).to.equal(true);
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
      // every cell lapsed AND a challenger's prepares landed while we slept:
      // revival yields to the in-flight takeover, so renewals come back
      // refused, each refusal deletes an ack, and safeUntil collapses to null
      committeeHosts.forEach((host) => {
        const record = registers.get(host).get(KEY);
        record.accepted.expiresAt = Date.now() - TTL;
        record.promisedEpoch = 6;
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

    it('a bare promise deposes nobody — only an accepted grant is a successor', async () => {
      // The 1205 fight: one cell carried a residue promise from the founding
      // scramble (promised high, accepted nothing) and its refusal deposed a
      // healthy master on its first renewal pass. A promise binds the CELL —
      // accept nothing lower — never the incumbent.
      const holder = await acquireHolder();
      const poisoned = committeeHosts[0];
      registers.get(poisoned).set(KEY, { promisedEpoch: 9, promisedAt: Date.now(), accepted: null });

      clockNow += 20_000;
      await holder.renewOnce();

      expect(holder.state).to.equal('held');
      expect(holder.safeUntil()).to.equal(clockNow + TTL);
    });

    it('its own newer grant is not a successor — a partial term refresh must not self-depose', async () => {
      const holder = await acquireHolder();
      const partial = committeeHosts[0];
      const record = registers.get(partial).get(KEY);
      registers.get(partial).set(KEY, {
        ...record,
        promisedEpoch: record.accepted.epoch + 3,
        accepted: { ...record.accepted, epoch: record.accepted.epoch + 3 },
      });

      clockNow += 20_000;
      await holder.renewOnce();

      expect(holder.state).to.equal('held');
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

  // A FluxOS restart wipes the in-memory holder while the container keeps
  // running. The node cannot count its way back - it knows the term ends no
  // LATER than when it lost track, but safety needs the EARLIEST possible end,
  // which is unbounded below - so it re-learns from the grantors, whose reads
  // are served THROUGH the rejoin drain. That is what makes this work at
  // exactly the moment acquisition is refused, which is the moment a real
  // fleet update wave produces.
  describe('re-learning a term across a FluxOS restart', () => {
    async function seatThenRestart() {
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      // the restart: the process forgets everything, the registers do not
      grantClient.resetForTests();
      return outcome;
    }

    it('re-learns the term from a quorum of registers and re-installs the holder', async () => {
      await seatThenRestart();
      clockNow += 5_000;

      const relearned = await grantClient.relearn(KEY, holderOptions());
      expect(relearned.recovered).to.equal(true);
      expect(grantClient.holderFor(KEY)).to.not.equal(null);
      expect(relearned.holder.state).to.equal('held');
    });

    // The recovered deadline is the grantors' remaining duration, never their
    // expiresAt, and it can only ever be EARLIER than the term this node
    // originally held - never later.
    it('the recovered term is a duration, and never longer than a full TTL', async () => {
      await seatThenRestart();
      clockNow += 5_000;

      const relearned = await grantClient.relearn(KEY, holderOptions());
      expect(relearned.recovered).to.equal(true);
      const recoveredForMs = relearned.holder.safeUntil() - clockNow;
      expect(recoveredForMs).to.be.above(0);
      expect(recoveredForMs).to.be.at.most(TTL);
    });

    // R1, and the reason local persistence is the wrong primitive: one record
    // is one record whether it came off a disk or off a wire.
    it('REFUSES to re-learn from fewer than a quorum of registers', async () => {
      await seatThenRestart();
      // leave exactly one grantor answering - below the quorum of five
      committeeHosts.slice(1).forEach((host) => unreachable.add(host));

      const relearned = await grantClient.relearn(KEY, holderOptions());
      expect(relearned.recovered).to.equal(false);
      expect(grantClient.holderFor(KEY)).to.equal(null);
    });

    it('REFUSES when the committee cannot be reached at all', async () => {
      await seatThenRestart();
      committeeHosts.forEach((host) => unreachable.add(host));

      const relearned = await grantClient.relearn(KEY, holderOptions());
      expect(relearned.recovered).to.equal(false);
      expect(grantClient.holderFor(KEY)).to.equal(null);
    });

    it('REFUSES when the term has lapsed on the grantors while this node was down', async () => {
      await seatThenRestart();
      registers.forEach((store) => {
        const row = store.get(KEY);
        if (row?.accepted) row.accepted.expiresAt = Date.now() - 1_000;
      });

      const relearned = await grantClient.relearn(KEY, holderOptions());
      expect(relearned.recovered).to.equal(false);
      expect(grantClient.holderFor(KEY)).to.equal(null);
    });

    // D4 through the wiring, not just the arithmetic. The grantors compute
    // remainingMs at an unknown instant inside the read window, so the whole
    // window is assumed spent. Without the discount a slow read hands this
    // node a deadline the grantors have already partly consumed - which is the
    // conversion defect, and it broke at every margin in the model.
    it('discounts the time the read itself took', async () => {
      await seatThenRestart();
      const fast = await grantClient.relearn(KEY, holderOptions());
      const fastRemaining = fast.holder.safeUntil() - clockNow;

      grantClient.resetForTests();
      readCostMs = 500; // nine members, so the batch costs this node 4.5s
      const slow = await grantClient.relearn(KEY, holderOptions());
      expect(slow.recovered).to.equal(true);
      const slowRemaining = slow.holder.safeUntil() - clockNow;
      expect(fastRemaining - slowRemaining).to.be.at.least(4_000);
    });

    // D3. §7's demotion alarm is STANDING - it fires ON the deadline without
    // waiting for a pass. A restart clears the belief that armed it, so a
    // re-learned holder that never arms one runs past its term with nothing
    // scheduled to stop it. This is the half of D3 that the acquire path also
    // gets wrong today.
    it('arms the demotion alarm at the moment it re-learns, not at the first renewal', async () => {
      await seatThenRestart();
      clockNow += 5_000;
      const scheduled = [];
      const relearned = await grantClient.relearn(KEY, {
        ...holderOptions(),
        schedule: (fn, ms) => { scheduled.push(ms); return null; },
      });
      expect(relearned.recovered).to.equal(true);
      const deadlineInMs = relearned.holder.safeUntil() - clockNow;
      expect(
        scheduled.some((ms) => ms >= deadlineInMs),
        'nothing is scheduled as far out as the deadline - only the renewal loop armed',
      ).to.equal(true);
    });
  });

  describe('the repair chore — an answering-empty cell is re-seated, never abandoned', () => {
    async function heldHolder() {
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      return outcome.holder;
    }

    async function passes(holder, count) {
      for (let i = 0; i < count; i += 1) {
        clockNow += 20_000;
        // eslint-disable-next-line no-await-in-loop -- renewal passes are serial by nature
        await holder.renewOnce();
      }
    }

    it('a cell refusing with an empty register is seeded back at the CURRENT epoch', async () => {
      const holder = await heldHolder();
      const wiped = committeeHosts[0];
      const epochBefore = holder.epoch;
      registers.get(wiped).delete(KEY); // the wiped-journal referee

      await passes(holder, 3);

      const reseated = registers.get(wiped).get(KEY);
      expect(reseated?.accepted?.grantee).to.equal(SELF);
      expect(reseated.accepted.epoch).to.equal(epochBefore);
      expect(holder.epoch).to.equal(epochBefore); // a seed moves no epoch
      expect(holder.state).to.equal('held');
    });

    it('a residue promise above the term escalates to one re-acquisition at a higher epoch', async () => {
      const holder = await heldHolder();
      const poisoned = committeeHosts[0];
      const epochBefore = holder.epoch;
      registers.get(poisoned).set(KEY, { promisedEpoch: 9, promisedAt: Date.now(), accepted: null });

      await passes(holder, 3);

      expect(holder.epoch).to.be.greaterThan(9); // cleared every promise
      expect(holder.state).to.equal('held');
      committeeHosts.forEach((host) => {
        const record = registers.get(host).get(KEY);
        expect(record.accepted.grantee).to.equal(SELF);
        expect(record.accepted.epoch).to.equal(holder.epoch);
      });
      expect(holder.epoch).to.not.equal(epochBefore);
    });

    it('a cell is re-seated only once it has REFUSED enough times, never on silence', async () => {
      const holder = await heldHolder();
      const [first, second] = committeeHosts;
      registers.get(first).delete(KEY);

      await passes(holder, 2); // refusing, but under the threshold
      expect(registers.get(first).get(KEY), 're-seated before it had refused enough').to.equal(undefined);

      await passes(holder, 1); // threshold reached
      expect(registers.get(first).get(KEY)?.accepted?.grantee).to.equal(SELF);

      // and a cell that is merely SILENT is the heal chore's business, never
      // this one - it refuses nothing, so it is never re-seated here
      registers.get(second).delete(KEY);
      unreachable.add(second);
      await passes(holder, 4);
      expect(registers.get(second).get(KEY), 'a silent cell was re-seated on no evidence').to.equal(undefined);
    });

    it('repair is a healthy holder\'s chore — jeopardy repairs nothing', async () => {
      const holder = await heldHolder();
      // five answering-empty cells: the renewal quorum itself is gone, and a
      // takeover may be legitimately winning — repair must not fight it
      committeeHosts.slice(0, 5).forEach((host) => registers.get(host).delete(KEY));
      witnessReplies.set(STANDBY_HOST, { quorumReachable: true, holding: false, acquiring: false });

      clockNow += 20_000;
      await holder.renewOnce();

      expect(holder.state).to.equal('jeopardy');
      committeeHosts.slice(0, 5).forEach((host) => {
        expect(registers.get(host).get(KEY)).to.equal(undefined);
      });
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
