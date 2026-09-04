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
const downCertificates = require('../../ZelBack/src/services/quorumGrant/downCertificates');
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

  // a describe may widen the world (step-across needs committees that share
  // fewer than a quorum of cells); the fake and the stubs read the active one
  let activeMembership = membership;
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
  let refereeingAnswer; // record reads carry it when set; undefined = old node
  let servingAnswer; // record reads carry it when set; undefined = a node without the word
  let acceptanceOnAccept; // false = the referees withhold the term acceptance on accept (delivered on renew)
  let freshSeats; // true = the referees first served the re-rolled generation just now (a stranger waits); false = long ago
  let refuseAccept; // true = every referee answers accept with a refusal
  let teaching; // hosts refusing every ask under a newer world, and teaching it
  let taughtRecord; // the standing generation record those refusals and every record read carry
  let draining; // hosts refusing every ask under the standing generation as draining

  function clock() {
    return clockNow;
  }

  function dispatchToGrantor(host, type, ask) {
    if (!registers.has(host)) registers.set(host, new Map()); // a cell of a widened world
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

    // the term acceptance the controller signs on accept and renew
    // (STEP_ACROSS_DESIGN D1), with this grantor's own key
    const termAcceptance = (outcome) => {
      if (!outcome.reply.ok) return outcome;
      if (type === 'accept' && !acceptanceOnAccept) return outcome;
      const node = hostNodes.get(host);
      const fields = signedEnvelope.fieldsFor('termaccept', {
        key: ask.key, fingerprint: ask.fingerprint, generation: ask.generation, epoch: ask.epoch, grantee: ask.candidate,
      });
      const signed = signedEnvelope.sign('termaccept', fields, hostWifs.get(host));
      return {
        ...outcome,
        reply: { ...outcome.reply, acceptance: { grantor: `${node.txhash}:${node.outidx}`, signature: signed.signature } },
      };
    };
    // the controller's empty-seat rule for a re-rolled world (STEP_ACROSS_DESIGN
    // D2/D3): this cell first serves the new generation NOW, so a stranger waits
    // one lock-delay and only a candidate carrying the retired committee's
    // signed acceptances, verified here with real signatures, is let in at once
    const seatTunables = () => {
      if ((ask.generation ?? 0) < 1) return REGISTER_TUNABLES;
      const carriedIncumbent = ask.carried
        ? rosterOverlay.verifyTermCredential(activeMembership, ask.key, ask.carried, {
          committeeSize: COMMITTEE_SIZE, candidate: ask.candidate, standingGeneration: taughtRecord?.generation ?? 0,
        })
        : null;
      const servingSinceMs = freshSeats ? Date.now() : Date.now() - REGISTER_TUNABLES.lockDelayMs - 1;
      return { ...REGISTER_TUNABLES, servingSinceMs, carriedIncumbent };
    };
    const handlers = {
      probe: () => ({ reply: registerCore.onProbe(record, request, Date.now(), seatTunables()), record: null }),
      prepare: () => registerCore.onPrepare(record, request, Date.now(), seatTunables()),
      accept: () => (refuseAccept
        ? { reply: { ok: false, code: 'unavailable' }, record: null }
        : termAcceptance(registerCore.onAccept(record, request, Date.now(), seatTunables()))),
      renew: () => termAcceptance(registerCore.onRenew(record, request, Date.now(), REGISTER_TUNABLES)),
      // the controller's role rule: only an ordinal row may be given back
      release: () => registerCore.onRelease(record, {
        ...request, ...(/\/ordinal-\d+@/.test(ask.key) ? { allowOneshot: true } : {}),
      }, Date.now()),
      // the controller verifies the certificate through the node-down seam;
      // here a certificate whose token says so stands
      vacate: () => (ask.cert?.token === 'standing'
        ? registerCore.onVacate(record, { subject: ask.cert.subject }, Date.now())
        : { reply: { ok: false, code: 'bad_certificate' }, record: null }),
    };
    const outcome = handlers[type]();
    if (outcome.record) store.set(ask.key, outcome.record);
    return outcome.reply;
  }

  // A grantor refusing at its door, exactly as the controller answers it: an
  // HTTP 409 whose error payload carries the standing record.
  function doorRefusal(message) {
    const error = new Error('Request failed with status code 409');
    error.response = {
      status: 409,
      data: {
        status: 'error',
        data: {
          name: 'Error',
          message,
          generation: taughtRecord.generation,
          generationRecord: taughtRecord,
        },
      },
    };
    return error;
  }
  const taughtRefusal = () => doorRefusal(`ask names generation 0, current is ${taughtRecord.generation}`);
  const drainingRefusal = () => doorRefusal(`generation ${taughtRecord.generation} is draining until height ${(taughtRecord.height ?? 0) + 3}`);

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
      // a function fixture answers at the moment of the poll, so a test can
      // move the world between a pass's earlier asks and its witness poll
      const fixture = witnessReplies.get(host);
      const reply = typeof fixture === 'function' ? fixture() : fixture;
      if (!reply) throw new Error('no witness fixture');
      return { data: { status: 'success', data: reply } };
    }

    const type = path.split('/').pop();
    if (unreachable.has(host) || dark.has(host)) throw new Error('unreachable');
    // a teaching cell refuses only an ask naming a RETIRED generation (the
    // controller's "ask names generation X, current is Y"); the standing one
    // is served — a re-rolled committee shares cells with the old one
    if (teaching.has(host) && (body?.generation ?? 0) < (taughtRecord?.generation ?? 0)) throw taughtRefusal();
    // a draining cell refuses every ask under the standing generation until
    // the drain lifts (the controller's "generation X is draining until height Y")
    if (draining.has(host) && taughtRecord && (body?.generation ?? 0) >= taughtRecord.generation) throw drainingRefusal();
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
    refereeingAnswer = undefined;
    servingAnswer = undefined;
    acceptanceOnAccept = true;
    freshSeats = false;
    refuseAccept = false;
    activeMembership = membership;
    teaching = new Set();
    taughtRecord = null;
    draining = new Set();

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
              ...(refereeingAnswer !== undefined ? { refereeing: refereeingAnswer } : {}),
              ...(servingAnswer !== undefined ? { serving: servingAnswer } : {}),
              ...(taughtRecord ? { generation: taughtRecord.generation, generationRecord: taughtRecord } : {}),
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
    sinon.stub(networkStateService, 'membershipAt').callsFake(() => activeMembership);
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
    downCertificates.resetForTests();
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

    // The running node's attempt inside the activation window
    // (ACTIVATION_CROSSING_DESIGN.md §2.5): a probe that prepares only on an
    // open quorum, so a refused node burns no epoch against a committee that
    // could not have promised, and learns the figure a quorum opens at.
    it('prepareOnlyIfOpen: no open quorum means no prepare at all, and nothing taught means a re-probe', async () => {
      // five of nine dark: four answer, the quorum is five
      committeeHosts.slice(0, 5).forEach((host) => dark.add(host));
      const outcome = await grantClient.acquire(KEY, holderOptions({ prepareOnlyIfOpen: true }));
      expect(outcome.granted).to.equal(false);
      expect(outcome.reason).to.equal('no open quorum');
      expect(outcome.retryAfterMs).to.equal(0);
      const prepares = serviceHelper.axiosPost.getCalls().filter((c) => String(c.args[0]).endsWith('/prepare'));
      expect(prepares, 'no prepare went out').to.have.length(0);
      committeeHosts.forEach((host) => {
        expect(registers.get(host).get(KEY)?.promisedEpoch ?? 0, 'no epoch burnt').to.equal(0);
      });
    });

    it('prepareOnlyIfOpen: a lapsed record\'s lock-delay is the taught figure, and still no prepare', async () => {
      seedRecord({
        promisedEpoch: 4,
        accepted: {
          epoch: 4, grantee: 'other:0', mode: 'held', expiresAt: Date.now() - 1000, released: false,
        },
      });
      const outcome = await grantClient.acquire(KEY, holderOptions({ prepareOnlyIfOpen: true }));
      expect(outcome.granted).to.equal(false);
      expect(outcome.retryAfterMs).to.be.greaterThan(0);
      const prepares = serviceHelper.axiosPost.getCalls().filter((c) => String(c.args[0]).endsWith('/prepare'));
      expect(prepares).to.have.length(0);
    });

    it('prepareOnlyIfOpen: an open quorum acquires exactly as the built pursuit does', async () => {
      const outcome = await grantClient.acquire(KEY, holderOptions({ prepareOnlyIfOpen: true }));
      expect(outcome.granted).to.equal(true);
      expect(outcome.holder.state).to.equal('held');
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

    it('reports the term a quorum of registers names, recovered or not', async () => {
      const { holder } = await seatThenRestart();
      const other = `${'7'.repeat(64)}:0`;
      committeeHosts.forEach((host) => { registers.get(host).get(KEY).accepted.grantee = other; });
      clockNow += 5_000;
      const relearned = await grantClient.relearn(KEY, holderOptions());
      expect(relearned.recovered).to.equal(false);
      expect(relearned.term.grantee, 'the registers name another node').to.equal(other);
      expect(relearned.term.epoch).to.equal(holder.epoch);
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

    it('a committee that answers reads but is not refereeing counts as unreachable — a stale fleet must coast, not demote', async () => {
      await grantClient.acquire(KEY, holderOptions());
      // every grantor's record read says it would refuse asks (stale view or
      // mid-resync): no takeover is possible, whatever the reads say
      refereeingAnswer = false;
      const answer = await grantClient.witnessAnswer(KEY);
      expect(answer.quorumReachable).to.equal(false);
    });

    it('a committee that referees but is not SERVING counts as unreachable — a restart wave must coast, not demote', async () => {
      await grantClient.acquire(KEY, holderOptions());
      // every grantor referees (the drains are not in that word) but is in a
      // drain: no takeover is possible until the drains lift, so the witness
      // must not talk the incumbent out of the coast (formal/quiet-window rows 29–31)
      refereeingAnswer = true;
      servingAnswer = false;
      const answer = await grantClient.witnessAnswer(KEY);
      expect(answer.quorumReachable).to.equal(false);
    });

    it('a node without the serving word counts as it always did', async () => {
      await grantClient.acquire(KEY, holderOptions());
      refereeingAnswer = true;
      servingAnswer = undefined;
      const answer = await grantClient.witnessAnswer(KEY);
      expect(answer.quorumReachable).to.equal(true);
    });

    // The credential (STEP_ACROSS_DESIGN D1): the holder keeps each referee's
    // latest signed acceptance for its epoch; a quorum of them is what it
    // carries to a re-rolled committee. They belong to the epoch — a re-acquire
    // under a new epoch starts an empty bundle.
    it('the holder keeps a quorum of signed acceptances for its epoch, each verifying against its referee', async () => {
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      const holder = grantClient.holderFor(KEY);
      const credential = holder.credential();
      expect(credential.epoch).to.equal(holder.epoch);
      expect(credential.fingerprint).to.equal(fingerprint);
      expect(credential.generation).to.equal(0);
      expect(credential.acceptances.length).to.be.at.least(committee.quorum);
      credential.acceptances.forEach(({ grantor, signature }) => {
        const node = committee.members.find((m) => `${m.txhash}:${m.outidx}` === grantor);
        expect(node, `acceptance from a committee member: ${grantor}`).to.be.an('object');
        const fields = signedEnvelope.fieldsFor('termaccept', {
          key: KEY, fingerprint, generation: 0, epoch: holder.epoch, grantee: SELF,
        });
        expect(signedEnvelope.verify('termaccept', fields, signature, node.pubkey)).to.equal(true);
      });
    });

    it('a renewal records the acceptance too, and below a quorum there is no credential; an acceptance naming another grantor is ignored', async () => {
      acceptanceOnAccept = false;
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      const holder = grantClient.holderFor(KEY);
      expect(holder.credential(), 'nothing signed yet: no credential').to.equal(null);
      await holder.renewOnce();
      expect(holder.credential().acceptances.length).to.equal(committee.members.length);
      holder.recordAcceptance('x:0', { grantor: 'y:0', signature: 'forged' });
      expect(holder.credential().acceptances.some((a) => a.grantor === 'x:0' || a.signature === 'forged')).to.equal(false);
    });

    it('fewer acceptances than a quorum is no credential at all', async () => {
      acceptanceOnAccept = false;
      await grantClient.acquire(KEY, holderOptions());
      const holder = grantClient.holderFor(KEY);
      const hosts = committee.members.map((m) => m.ip.split(':')[0]);
      // leave quorum − 1 referees answering the renewal — dark, so no carrier
      // relays it to them either
      hosts.slice(committee.quorum - 1).forEach((h) => dark.add(h));
      await holder.renewOnce();
      expect(holder.credential(), `${committee.quorum - 1} acceptances are below the quorum of ${committee.quorum}`).to.equal(null);
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

  describe('the ordinal plane — probe as a quorum verdict, release, vacate', () => {
    const ORDINAL = 'myapp/ordinal-0@500';
    // the founding committee as the founding service hands it in: basis pair included
    const founding = () => ({ ...committee, fingerprint, generation: 0 });

    it('an unfounded ordinal probes decided with no holder; a founded one names its holder', async () => {
      let verdict = await grantClient.probeOneshot(ORDINAL, founding());
      expect(verdict).to.deep.equal({ decided: true, holder: null, epoch: 0 });
      const outcome = await grantClient.acquire(ORDINAL, { mode: 'oneshot', committee: founding() });
      expect(outcome.granted).to.equal(true);
      verdict = await grantClient.probeOneshot(ORDINAL, founding());
      expect(verdict.holder).to.equal(SELF);
      expect(verdict.decided).to.equal(true);
      expect(verdict.epoch).to.be.at.least(1);
    });

    it('a holder is a QUORUM verdict: one cell naming it is not enough, and released rows do not count', () => {
      const row = (grantee, released = false) => ({ ok: true, accepted: { epoch: 1, grantee, mode: 'oneshot', released } });
      expect(grantClient.oneshotQuorumFold([row('a:0'), row('b:0'), row('b:0')], 2).holder).to.equal('b:0');
      expect(grantClient.oneshotQuorumFold([row('a:0'), { ok: true, accepted: null }, { ok: true, accepted: null }], 2).holder).to.equal(null);
      expect(grantClient.oneshotQuorumFold([row('a:0', true), row('a:0', true), row('a:0')], 2).holder).to.equal(null);
      expect(grantClient.oneshotQuorumFold([row('a:0')], 2).decided).to.equal(false);
    });

    it('a probe that cannot reach a quorum is undecided, never free', async () => {
      committeeHosts.slice(0, 6).forEach((host) => dark.add(host));
      const verdict = await grantClient.probeOneshot(ORDINAL, founding());
      expect(verdict.decided).to.equal(false);
      expect(verdict.holder).to.equal(null);
    });

    it('release gives the row back on a quorum, and the next probe reads it free', async () => {
      const outcome = await grantClient.acquire(ORDINAL, { mode: 'oneshot', committee: founding() });
      expect(outcome.granted).to.equal(true);
      const { epoch } = await grantClient.probeOneshot(ORDINAL, founding());
      expect(await grantClient.releaseOneshot(ORDINAL, founding(), epoch)).to.equal(true);
      const verdict = await grantClient.probeOneshot(ORDINAL, founding());
      expect(verdict).to.deep.include({ decided: true, holder: null });
      const again = await grantClient.acquire(ORDINAL, { mode: 'oneshot', committee: founding() });
      expect(again.granted).to.equal(true);
    });

    it('vacate reclaims the row on a standing certificate about the holder, and nothing on any other', async () => {
      await grantClient.acquire(ORDINAL, { mode: 'oneshot', committee: founding() });
      expect(await grantClient.vacateOneshot(ORDINAL, founding(), { token: 'forged', subject: SELF })).to.equal(false);
      expect((await grantClient.probeOneshot(ORDINAL, founding())).holder).to.equal(SELF);
      expect(await grantClient.vacateOneshot(ORDINAL, founding(), { token: 'standing', subject: SELF })).to.equal(true);
      expect((await grantClient.probeOneshot(ORDINAL, founding())).holder).to.equal(null);
    });
  });

  describe('the committee heal', function healSuite() {
    // These tests do real secp256k1 work: every heal signs and verifies eight
    // acceptances, and a carried chain is verified link by link by each referee
    // that has not journaled it. Measured: one heal 0.5 s, two heals 3.5 s on a
    // box whose sixteen cores were saturated, under nyc instrumentation (the
    // full-suite path runs mocha without --timeout, so its 2 s default was the
    // bound that tripped). CPU-bound work, no timer and no race: the budget
    // must exceed the saturated-box cost, and a genuine hang still fails.
    this.timeout(30_000);
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

  describe('the cancel overlay — a certificate cancels a seat without any committee quorum', () => {
    const outpoint = (node) => `${node.txhash}:${node.outidx}`;

    const certified = committee.members[0];
    const CERTIFIED_HOST = certified.ip.split(':')[0];
    const survivors = committee.members.filter((node) => node !== certified);
    const replacement = rosterOverlay.nextReplacement(
      membership, rosterOverlay.walkKeyFor(KEY, 0), survivors, new Set([outpoint(certified)]),
    );

    function providerWith({ standing = new Map(), refutations = new Map() } = {}) {
      return {
        standingCertificateFor: async (o) => standing.get(o) ?? null,
        refutationFor: async (o) => refutations.get(o) ?? null,
        verifyCertificate: (cert) => ({ valid: cert?.token === 'standing', subject: cert?.subject ?? null }),
        verifyRefutation: (refutation, cert) => Boolean(
          refutation?.token === 'alive' && refutation.subject === cert.subject,
        ),
      };
    }

    function askedHosts(type) {
      return serviceHelper.axiosPost.getCalls()
        .filter((call) => call.args[0].endsWith(`/flux/quorumgrant/${type}`))
        .map((call) => call.args[0].match(/^http:\/\/([^:]+):/)[1]);
    }

    it('fixture: the walk can seat a replacement for the certified referee', () => {
      expect(replacement).to.not.equal(null);
      expect(committeeHosts).to.not.include(replacement.ip.split(':')[0]);
    });

    it('a standing certificate on a seat makes acquisition ask the healed committee — the certified seat is never asked', async () => {
      const standing = new Map([[outpoint(certified), { subject: outpoint(certified), token: 'standing' }]]);
      downCertificates.registerProvider(providerWith({ standing }));

      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);

      expect(askedHosts('accept')).to.not.include(CERTIFIED_HOST);
      expect(askedHosts('accept')).to.include(replacement.ip.split(':')[0]);
      expect(registers.get(replacement.ip.split(':')[0]).get(KEY).accepted.grantee).to.equal(SELF);
      expect(registers.get(CERTIFIED_HOST).get(KEY)).to.equal(undefined);

      // the asks named the cancellation they applied, certificate riding along
      const acceptBody = serviceHelper.axiosPost.getCalls()
        .find((call) => call.args[0].endsWith('/flux/quorumgrant/accept')).args[1];
      expect(acceptBody.cancels).to.have.length(1);
      expect(acceptBody.cancels[0].cancel).to.equal(outpoint(certified));
      expect(acceptBody.cancels[0].cert.token).to.equal('standing');

      // the published record carries the cancel chain beside the roster
      const published = masterleasePublisher.publishMasterlease.lastCall.args[0];
      expect(published.cancels.chain).to.have.length(1);

      // renewals keep carrying it
      await outcome.holder.renewOnce();
      const renewBody = serviceHelper.axiosPost.getCalls()
        .find((call) => call.args[0].endsWith('/flux/quorumgrant/renew')).args[1];
      expect(renewBody.cancels).to.have.length(1);
    });

    it('the published record teaches the cancellation — a reader with no store of its own applies it as published state', async () => {
      messageStore.getMasterleaseRecord.resolves({
        data: {
          fingerprint,
          cancels: {
            chain: [{
              seq: 1, cancel: outpoint(certified), cert: { subject: outpoint(certified), token: 'standing' }, at: 900,
            }],
          },
        },
      });

      // no provider registered: the store answers nothing, and adoption of
      // the published set must not depend on it
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      expect(askedHosts('accept')).to.not.include(CERTIFIED_HOST);
      expect(registers.get(replacement.ip.split(':')[0]).get(KEY).accepted.grantee).to.equal(SELF);
    });

    it('a refutation reinstates the seat — the roster re-derives with the returned referee', async () => {
      messageStore.getMasterleaseRecord.resolves({
        data: {
          fingerprint,
          cancels: {
            chain: [{
              seq: 1, cancel: outpoint(certified), cert: { subject: outpoint(certified), token: 'standing' }, at: 900,
            }],
          },
        },
      });
      const refutations = new Map([[outpoint(certified), { subject: outpoint(certified), token: 'alive' }]]);
      downCertificates.registerProvider(providerWith({ refutations }));

      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);

      // the base committee is whole again: the certified seat is asked, the
      // one-time replacement is not
      expect(askedHosts('accept')).to.include(CERTIFIED_HOST);
      expect(askedHosts('accept')).to.not.include(replacement.ip.split(':')[0]);

      // the chain records the lift rather than forgetting the cancellation
      const acceptBody = serviceHelper.axiosPost.getCalls()
        .find((call) => call.args[0].endsWith('/flux/quorumgrant/accept')).args[1];
      expect(acceptBody.cancels).to.have.length(2);
      expect(acceptBody.cancels[1].reinstate).to.equal(outpoint(certified));
    });

    it('a lapsed certificate reinstates nothing — without a refutation the cancellation stands', async () => {
      messageStore.getMasterleaseRecord.resolves({
        data: {
          fingerprint,
          cancels: {
            chain: [{
              seq: 1, cancel: outpoint(certified), cert: { subject: outpoint(certified), token: 'standing' }, at: 900,
            }],
          },
        },
      });
      // store empty both ways: no standing certificate, no refutation
      downCertificates.registerProvider(providerWith());

      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);
      expect(askedHosts('accept')).to.not.include(CERTIFIED_HOST);
    });

    it('tier-1 heal never proposes removing a cancel-seated member — its darkness is the cancel plane\'s business', async () => {
      const standing = new Map([[outpoint(certified), { subject: outpoint(certified), token: 'standing' }]]);
      downCertificates.registerProvider(providerWith({ standing }));
      const outcome = await grantClient.acquire(KEY, holderOptions());
      expect(outcome.granted).to.equal(true);

      // the replacement goes dark for over a full term: heal must not fire a
      // roster proposal at it, because the grantors judge tier-1 entries
      // against the base-plus-chain roster the replacement is not on
      dark.add(replacement.ip.split(':')[0]);
      clockNow += TTL + 1_000;
      await outcome.holder.renewOnce();
      expect(askedHosts('roster')).to.have.length(0);
      expect(outcome.holder.state).to.equal('held');
    });
  });

  // The teach, consumed: a newer generation record learned from any answer
  // enters this node's store through the same owner-verified path a
  // broadcast takes, so every reader of the store — committee resolution,
  // the witness poll, the holder — sees one fact from one place.
  describe('the teach — learning a newer generation from whatever answers', () => {
    const RECORD = {
      type: 'fluxgrantgeneration',
      version: 1,
      ip: '10.1.0.1:16127',
      appName: 'myapp',
      role: 'master',
      generation: 2,
      height: 90,
      at: 1_750_000_000_000,
      signature: 'ownersig',
      broadcastedAt: 1_750_000_000_500,
    };
    const rolledHosts = selectCommittee(membership, rosterOverlay.walkKeyFor(KEY, 2), { size: COMMITTEE_SIZE })
      .members.map((node) => node.ip.split(':')[0]);

    async function acquireHolder(overrides = {}) {
      const outcome = await grantClient.acquire(KEY, holderOptions(overrides));
      expect(outcome.granted).to.equal(true);
      return outcome.holder;
    }

    beforeEach(() => {
      sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      taughtRecord = RECORD;
    });

    it('a refused renewal naming a newer record stores it through the verified path — once per key, however many cells teach it', async () => {
      const holder = await acquireHolder();
      committeeHosts.forEach((host) => teaching.add(host));
      clockNow += 20_000;
      await holder.renewOnce();
      expect(messageStore.storeAppStateEvent.callCount).to.equal(1);
      expect(messageStore.storeAppStateEvent.firstCall.args).to.deep.equal([
        messageStore.APP_STATE_EVENT_TYPES.GRANTGENERATION, { message: RECORD, envelope: null },
      ]);
    });

    it('a taught record no newer than the world this node asked under is not news', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      const holder = await acquireHolder();
      rolledHosts.forEach((host) => teaching.add(host));
      clockNow += 20_000;
      await holder.renewOnce();
      expect(messageStore.storeAppStateEvent.called).to.equal(false);
    });

    it('a record about some other key is not this answer\'s to teach', async () => {
      taughtRecord = { ...RECORD, appName: 'otherapp' };
      const holder = await acquireHolder();
      committeeHosts.forEach((host) => teaching.add(host));
      clockNow += 20_000;
      await holder.renewOnce();
      expect(messageStore.storeAppStateEvent.called).to.equal(false);
    });

    it('a record that does not carry a generation, or carries a malformed one, teaches nothing', async () => {
      taughtRecord = { ...RECORD, generation: 'two' };
      const holder = await acquireHolder();
      committeeHosts.forEach((host) => teaching.add(host));
      clockNow += 20_000;
      await holder.renewOnce();
      expect(messageStore.storeAppStateEvent.called).to.equal(false);
    });

    it('the witness poll learns from the committee it reads', async () => {
      await grantClient.witnessAnswer(KEY);
      expect(messageStore.storeAppStateEvent.callCount).to.equal(1);
      expect(messageStore.storeAppStateEvent.firstCall.args[1].message).to.deep.equal(RECORD);
    });

    it('the witness answer carries what this node knows, so a polling master learns from its witnesses', async () => {
      messageStore.getGrantGenerationRecord.resolves({ data: RECORD });
      const answer = await grantClient.witnessAnswer(KEY);
      expect(answer.generation).to.equal(2);
      expect(answer.generationRecord).to.deep.equal(RECORD);
    });

    it('a master polling its witnesses learns what they know', async () => {
      taughtRecord = null; // the committee knows nothing of the new world; the witness does
      const holder = await acquireHolder();
      committeeHosts.forEach((host) => unreachable.add(host));
      relayDelivers = false;
      witnessReplies.set(STANDBY_HOST, {
        quorumReachable: false, holding: false, acquiring: false, generation: 2, generationRecord: RECORD,
      });
      clockNow += TTL + 30_000;
      await holder.renewOnce();
      expect(messageStore.storeAppStateEvent.callCount).to.equal(1);
      expect(messageStore.storeAppStateEvent.firstCall.args[1].message).to.deep.equal(RECORD);
    });

    it('re-learning a term after a restart learns from the record reads too', async () => {
      const holder = await acquireHolder();
      holder.stop();
      await grantClient.relearn(KEY, holderOptions());
      expect(messageStore.storeAppStateEvent.callCount).to.equal(1);
      expect(messageStore.storeAppStateEvent.firstCall.args[1].message).to.deep.equal(RECORD);
    });

    it('a standing record for a held key brings the holder\'s next contact forward to now', async () => {
      taughtRecord = null;
      const handles = [];
      const cancelled = [];
      const holder = await acquireHolder({
        schedule: (fn, ms) => {
          const handle = { fn, ms };
          handles.push(handle);
          return handle;
        },
        cancel: (handle) => cancelled.push(handle),
      });
      // the renewal loop's own timer: the one armed short of the term
      const loop = handles.find((handle) => handle.ms < TTL);
      expect(loop, 'the loop is armed at acquisition').to.not.equal(undefined);

      grantClient.noteGenerationRecord({ appName: 'myapp', role: 'master', generation: 2 });
      expect(cancelled).to.include(loop);
      expect(handles[handles.length - 1].ms).to.equal(0);
      expect(holder.state).to.equal('held');
    });

    // Step-across (STEP_ACROSS_DESIGN.md D4): on learning that a newer
    // generation stands, the holder takes its seat on the re-rolled committee
    // with its credential — the retired committee's signed acceptances — and
    // its container never stops. Without the credential the fresh seats hold
    // it like any stranger and it falls back to today's path.
    describe('step-across', () => {
      // A WIDE world: with 13 peers and committees of nine, any two committees
      // share at least a quorum of cells, and on a shared cell the master is
      // exempt by its own row — the credential would never be needed (the
      // four-node model world's lesson, quiet-window row 24). Forty peers with
      // real keys: two hash-drawn committees share a few cells, below quorum,
      // so the step-across must convince cells that never held the master.
      const wide = [
        ...Array.from({ length: 40 }, (unused, i) => ({
          txhash: String(i + 1).padStart(2, '0').repeat(32),
          outidx: 0,
          pubkey: keypairFor(i + 1).pubkey,
          ip: `10.${i + 1}.0.1:16127`,
        })),
        membership.find((node) => node.txhash === SELF_TXHASH),
      ];
      wide.forEach((node, i) => {
        const host = node.ip.split(':')[0];
        if (!hostNodes.has(host)) {
          hostNodes.set(host, node);
          hostWifs.set(host, keypairFor(i + 1).wif);
        }
      });
      const oldCommittee = selectCommittee(wide, rosterOverlay.walkKeyFor(KEY, 0), { size: COMMITTEE_SIZE });
      const newCommittee = selectCommittee(wide, rosterOverlay.walkKeyFor(KEY, 1), { size: COMMITTEE_SIZE });
      const hostsOf = (c) => c.members.map((node) => node.ip.split(':')[0]);
      const oldHosts = hostsOf(oldCommittee);
      const nextHosts = hostsOf(newCommittee);
      // generations are consecutive (the owner controller refuses a skip), so
      // the world the holder steps into is the one right above its own
      const NEXT = { ...RECORD, generation: 1 };
      beforeEach(() => {
        activeMembership = wide;
      });
      const reroll = (holder) => {
        // the owner re-rolls: the record stands at generation 1, the old cells
        // refuse under it and teach it, the new cells have just started serving
        taughtRecord = NEXT;
        messageStore.getGrantGenerationRecord.resolves({ data: NEXT });
        oldHosts.forEach((host) => teaching.add(host));
        freshSeats = true;
        grantClient.noteGenerationRecord({ appName: 'myapp', role: 'master', generation: 1 });
        return holder;
      };

      it('fixture: the two committees share fewer than a quorum of cells, and neither seats this node', () => {
        const shared = nextHosts.filter((host) => oldHosts.includes(host));
        expect(shared.length, `shared cells ${shared.length} < quorum ${newCommittee.quorum}`).to.be.below(newCommittee.quorum);
        expect(oldHosts).to.not.include(SELF_HOST);
        expect(nextHosts).to.not.include(SELF_HOST);
      });

      it('the accept quorum decides: with every accept refused the holder keeps its old world', async () => {
        taughtRecord = null;
        const holder = reroll(await acquireHolder());
        refuseAccept = true;
        clockNow += 1_000;
        await holder.renewOnce();
        expect(holder.generation).to.equal(0);
      });

      it('steps across to the re-rolled committee with its credential, holds the new term, publishes it, and is never demoted', async () => {
        taughtRecord = null;
        const demoted = [];
        const holder = reroll(await acquireHolder({ onDemoted: (reason) => demoted.push(reason) }));
        const publishedBefore = masterleasePublisher.publishMasterlease.callCount;
        clockNow += 1_000;
        await holder.renewOnce();
        expect(holder.state).to.equal('held');
        expect(holder.generation, 'the holder now holds under the new generation').to.equal(1);
        expect(demoted).to.deep.equal([]);
        const seated = nextHosts.filter((host) => {
          const row = registers.get(host)?.get(KEY);
          return row?.accepted?.grantee === SELF && row.accepted.generation === 1 && row.accepted.released === false;
        });
        expect(seated.length, 'a quorum of the re-rolled committee accepted the incumbent').to.be.at.least(committee.quorum);
        expect(masterleasePublisher.publishMasterlease.callCount).to.equal(publishedBefore + 1);
        expect(masterleasePublisher.publishMasterlease.lastCall.args[0]).to.deep.include({ key: KEY, grantee: SELF, generation: 1 });
        // and it renews there from now on
        clockNow += 1_000;
        await holder.renewOnce();
        expect(holder.state).to.equal('held');
        expect(holder.generation).to.equal(1);
      });

      it('without a credential every fresh seat holds it like a stranger: no seat is taken and the world is not changed', async () => {
        taughtRecord = null;
        acceptanceOnAccept = false;
        const holder = await acquireHolder();
        expect(holder.credential()).to.equal(null);
        reroll(holder);
        clockNow += 1_000;
        await holder.renewOnce();
        expect(holder.generation).to.equal(0);
        // the old world's rows on the cells the two committees share are not a seat in the new one
        const seated = nextHosts.filter((host) => {
          const row = registers.get(host)?.get(KEY);
          return row?.accepted?.grantee === SELF && row.accepted.generation === 1;
        });
        expect(seated).to.deep.equal([]);
      });

      it('the published record carries the committee\'s signed acceptances: the granting committee\'s at the grant, the re-rolled committee\'s after the step-across', async () => {
        taughtRecord = null;
        const outpointsOf = (c) => c.members.map((node) => `${node.txhash}:${node.outidx}`);
        const holder = await acquireHolder();
        const granted = masterleasePublisher.publishMasterlease.lastCall.args[0];
        expect(granted.acceptances.length, 'a quorum of the granting committee').to.be.at.least(oldCommittee.quorum);
        granted.acceptances.forEach((a) => expect(outpointsOf(oldCommittee)).to.include(a.grantor));
        reroll(holder);
        clockNow += 1_000;
        await holder.renewOnce();
        const stepped = masterleasePublisher.publishMasterlease.lastCall.args[0];
        expect(stepped.generation).to.equal(1);
        expect(stepped.acceptances.length, 'a quorum of the re-rolled committee').to.be.at.least(newCommittee.quorum);
        stepped.acceptances.forEach((a) => expect(outpointsOf(newCommittee)).to.include(a.grantor));
      });

      it('a plain renewal under an unchanged world never steps across or republishes', async () => {
        taughtRecord = null;
        const holder = await acquireHolder();
        const publishedBefore = masterleasePublisher.publishMasterlease.callCount;
        clockNow += 20_000;
        await holder.renewOnce();
        expect(holder.generation).to.equal(0);
        expect(masterleasePublisher.publishMasterlease.callCount).to.equal(publishedBefore);
      });

      // The block that lifts the drain lands inside one pass, between the
      // step-across probe (every new cell refuses it as draining) and the
      // witness poll (the new cells serve, a takeover is possible). The old
      // lease ran out long ago, so the pass would demote; the holder asks the
      // referees once more and decides on one reading.
      const drainLiftsAtTheWitnessPoll = (extra = {}) => {
        nextHosts.forEach((host) => draining.add(host));
        witnessReplies.set(STANDBY_HOST, () => {
          draining.clear();
          if (extra.beforeAnswering) extra.beforeAnswering();
          return { quorumReachable: true, holding: false, acquiring: false };
        });
      };

      it('the coast ends on a reading the referees had not yet given: the holder asks once more and steps across instead of demoting', async () => {
        taughtRecord = null;
        const demoted = [];
        const holder = reroll(await acquireHolder({ onDemoted: (reason) => demoted.push(reason) }));
        drainLiftsAtTheWitnessPoll();
        clockNow += TTL + 30_000;
        await holder.renewOnce();
        expect(demoted).to.deep.equal([]);
        expect(holder.state).to.equal('held');
        expect(holder.generation, 'the holder holds under the new generation').to.equal(1);
      });

      it('with no lock-delay budget left after the pass, the holder demotes without asking again', async () => {
        taughtRecord = null;
        const demoted = [];
        const holder = reroll(await acquireHolder({ onDemoted: (reason) => demoted.push(reason) }));
        // the pass's own reads ran past the lock-delay: a stranger's seat may
        // already be open, and a demotion must not wait on three more rounds
        drainLiftsAtTheWitnessPoll({ beforeAnswering: () => { clockNow += REGISTER_TUNABLES.lockDelayMs + 10_000; } });
        clockNow += TTL + 30_000;
        await holder.renewOnce();
        expect(demoted).to.have.lengthOf(1);
        expect(holder.state).to.equal('lost');
        expect(holder.generation).to.equal(0);
      });

      it('a new committee cell silent at the drain lift costs no restart: the holder steps across on the reachable quorum', async () => {
        taughtRecord = null;
        const demoted = [];
        const holder = reroll(await acquireHolder({ onDemoted: (reason) => demoted.push(reason) }));
        drainLiftsAtTheWitnessPoll();
        unreachable.add(nextHosts[0]); // one new cell cannot be reached at the lift
        clockNow += TTL + 30_000;
        await holder.renewOnce();
        expect(demoted, 'a silent cell no longer forces a demotion').to.deep.equal([]);
        expect(holder.state).to.equal('held');
        expect(holder.generation, 'the holder stepped across on the other cells').to.equal(1);
      });

      it('a rival already granted on a quorum of the new committee: the register refuses the carrier and the holder demotes', async () => {
        taughtRecord = null;
        const demoted = [];
        const holder = reroll(await acquireHolder({ onDemoted: (reason) => demoted.push(reason) }));
        drainLiftsAtTheWitnessPoll();
        // a rival holds a live term on a quorum of the new committee: those
        // cells shield it and refuse the carrier's prepare, so the attempt
        // fails and demotion is correct — the register, not this side, decided
        const rival = `${'7'.repeat(64)}:0`;
        newCommittee.members.slice(0, newCommittee.quorum).forEach((node) => {
          const host = node.ip.split(':')[0];
          if (!registers.has(host)) registers.set(host, new Map());
          registers.get(host).set(KEY, {
            promisedEpoch: 9,
            accepted: {
              grantee: rival, epoch: 9, mode: 'held', generation: 1, released: false, expiresAt: Date.now() + 300_000,
            },
          });
        });
        clockNow += TTL + 30_000;
        await holder.renewOnce();
        expect(demoted, 'a genuinely chosen rival demotes the holder').to.have.lengthOf(1);
        expect(holder.state).to.equal('lost');
        expect(holder.generation).to.equal(0);
      });
    });

    it('a generation no newer than the held world, or a key nobody here holds, moves nothing', async () => {
      taughtRecord = null;
      const handles = [];
      await acquireHolder({
        schedule: (fn, ms) => {
          const handle = { fn, ms };
          handles.push(handle);
          return handle;
        },
      });
      const armed = handles.length;
      grantClient.noteGenerationRecord({ appName: 'myapp', role: 'master', generation: 0 });
      grantClient.noteGenerationRecord({ appName: 'otherapp', role: 'master', generation: 7 });
      expect(handles).to.have.length(armed);
    });
  });

});
