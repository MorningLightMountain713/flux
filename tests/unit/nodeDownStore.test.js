'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const secp256k1 = require('secp256k1');
const bs58check = require('bs58check');
const config = require('config');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const downCertificates = require('../../ZelBack/src/services/quorumGrant/downCertificates');
const { MembershipHistory } = require('../../ZelBack/src/services/utils/membershipHistory');
const { NodeDownTopology } = require('../../ZelBack/src/services/utils/nodeDownTopology');
const {
  verdictPayload,
  RECORD_LIFETIME_MS,
} = require('../../ZelBack/src/services/utils/nodeDownCertificates');
const { globalAppStateEvents } = require('../../ZelBack/src/services/utils/appConstants');

const T0 = 1_700_000_000_000;
const S = 's'.repeat(64).slice(0, 64).concat(':0'); // distinctive test subject

// Real keys, real signatures, real mongo: the only fakes here are the
// network-state singletons, replaced by this world's topology and height.
const keypairs = new Map();
function keypairFor(name) {
  if (!keypairs.has(name)) {
    const priv = Buffer.alloc(32);
    Buffer.from(name).copy(priv, 20);
    keypairs.set(name, {
      wif: bs58check.encode(Buffer.concat([Buffer.from([0x80]), priv])),
      pubkey: Buffer.from(secp256k1.publicKeyCreate(priv, false)).toString('hex'),
    });
  }
  return keypairs.get(name);
}

function makeWorld() {
  const history = new MembershipHistory();
  const jurors = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
  const nodes = [
    ...jurors.map((name, i) => ({
      txhash: `nd${name}`.padEnd(10, 'x'),
      outidx: 0,
      pubkey: keypairFor(name).pubkey,
      ip: `10.9.0.${i + 11}:16127`,
      added_height: 1,
    })),
    {
      txhash: S.split(':')[0], outidx: 0, pubkey: keypairFor('subject').pubkey, ip: '10.9.0.20:16127', added_height: 1,
    },
  ];
  const world = { nodes, history, height: 1000 };
  world.fp = history.record(nodes, { height: 999, hash: 'nh999' }, T0);
  world.topology = new NodeDownTopology({
    nodes: () => world.nodes,
    membershipHistory: history,
  });
  world.jurorOutpoint = (name) => `${`nd${name}`.padEnd(10, 'x')}:0`;
  world.signedVerdict = (name, over = {}) => {
    const verdict = {
      subject: S,
      juror: world.jurorOutpoint(name),
      judgement: 'unreachable',
      height: world.height,
      fingerprint: world.fp,
      ...over,
    };
    const payload = verdictPayload(verdict);
    verdict.signature = verificationHelper.signMessage(payload.toString(), keypairFor(name).wif);
    return verdict;
  };
  world.certificate = (names, over = {}) => ({
    subject: S,
    assembler: world.jurorOutpoint(names[0]),
    height: world.height,
    fingerprint: world.fp,
    verdicts: names.map((name) => world.signedVerdict(name)),
    ...over,
  });
  return world;
}

describe('nodeDownStore', () => {
  let world;
  let store;
  let collection;

  before(async function bootstrap() {
    this.timeout(30000);
    await dbHelper.initiateDB();
    collection = dbHelper.databaseConnection()
      .db(config.database.appsglobal.database)
      .collection(globalAppStateEvents);
  });

  beforeEach(async () => {
    world = makeWorld();
    store = proxyquire('../../ZelBack/src/services/appMessaging/nodeDownStore', {
      '../networkStateService': {
        nodeDownTopology: () => world.topology,
        chainHeight: () => world.height,
        networkState: () => world.nodes,
      },
    });
    await collection.deleteMany({ subject: S });
    await collection.deleteMany({ outpoint: S });
    downCertificates.resetForTests();
  });

  after(async () => {
    await collection.deleteMany({ subject: S });
    await collection.deleteMany({ outpoint: S });
  });

  describe('verifyNodeDownCertificate — cold, synchronous, real signatures', () => {
    it('accepts a quorum of real signatures and refuses one short', () => {
      // jury of 6 → H = 4
      const good = store.verifyNodeDownCertificate(world.certificate(['j1', 'j2', 'j3', 'j4']));
      expect(good).to.include({ valid: true, subject: S, counted: 4, needed: 4 });

      const short = store.verifyNodeDownCertificate(world.certificate(['j1', 'j2', 'j3']));
      expect(short).to.include({ valid: false, reason: 'sub_quorum' });
    });

    it('a tampered verdict fails its signature and costs the quorum', () => {
      const certificate = world.certificate(['j1', 'j2', 'j3', 'j4']);
      certificate.verdicts[0].height += 1; // signed bytes no longer match
      const result = store.verifyNodeDownCertificate(certificate);
      expect(result.valid).to.equal(false);
      expect(result.discarded.bad_signature).to.equal(1);
    });

    it('an unrebuildable fingerprint refuses whole', () => {
      const certificate = world.certificate(['j1', 'j2', 'j3', 'j4'], { fingerprint: 'f'.repeat(64) });
      expect(store.verifyNodeDownCertificate(certificate).reason).to.equal('unknown_fingerprint');
    });

    it('a late reader verifies verdict freshness at the certificate, not at itself', () => {
      // The fleet-run shape: certificate formed at height 1000, reader syncs
      // it 13 blocks later. The record stands for six hours; a reader
      // measuring verdict age against its own height can never restore a
      // certificate older than the verdict lifetime, which unsyncs the
      // record for almost all of its life.
      const certificate = world.certificate(['j1', 'j2', 'j3', 'j4']);
      world.height = 1013;
      const result = store.verifyNodeDownCertificate(certificate);
      expect(result).to.include({ valid: true, subject: S, counted: 4 });
    });

    it('formation freshness still binds: verdicts stale against the certificate height stay dead', () => {
      world.height = 1015; // reader well past both heights
      const certificate = world.certificate(['j1', 'j2', 'j3', 'j4'], { height: 1011 });
      // verdicts signed at 1000 under a certificate claiming 1011 — outside
      // the lifetime window AT FORMATION, whenever the reader looks.
      const result = store.verifyNodeDownCertificate(certificate);
      expect(result.valid).to.equal(false);
      expect(result.discarded.stale).to.equal(4);
    });

    it('a certificate from the reader\'s future is refused whole', () => {
      const certificate = world.certificate(['j1', 'j2', 'j3', 'j4'], { height: world.height + 2 });
      expect(store.verifyNodeDownCertificate(certificate).reason).to.equal('future_height');
    });

    it('a certificate without a numeric height is malformed', () => {
      const certificate = world.certificate(['j1', 'j2', 'j3', 'j4'], { height: 'soon' });
      expect(store.verifyNodeDownCertificate(certificate).reason).to.equal('malformed');
    });
  });

  describe('intake — verified, stored per certification, duplicates absorbed', () => {
    it('stores a valid certificate and asks for the relay', async () => {
      const result = await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j1', 'j2', 'j3', 'j4']), broadcastedAt: Date.now() },
      });
      expect(result).to.deep.equal({ accepted: true, rebroadcast: true, reason: 'stored' });

      const row = await collection.findOne({ type: 'nodedown', subject: S });
      expect(row.dedupKey).to.equal(`nodedown:${S}:1000`);
      expect(row.ip).to.equal('10.9.0.20:16127');
      expect(new Date(row.expireAt).getTime() - new Date(row.broadcastedAt).getTime())
        .to.equal(RECORD_LIFETIME_MS);
    });

    it('a second copy while one stands is dropped without relay — one flood per death', async () => {
      const at = Date.now();
      await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j1', 'j2', 'j3', 'j4']), broadcastedAt: at },
      });
      const copy = await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j2', 'j3', 'j4', 'j5']), broadcastedAt: at + 50 },
      });
      expect(copy).to.include({ accepted: false, rebroadcast: false, reason: 'already_standing' });
      expect(await collection.countDocuments({ type: 'nodedown', subject: S })).to.equal(1);
    });

    it('an invalid certificate is never stored and never relayed', async () => {
      const result = await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j1', 'j2', 'j3']), broadcastedAt: Date.now() },
      });
      expect(result.rebroadcast).to.equal(false);
      expect(await collection.countDocuments({ type: 'nodedown', subject: S })).to.equal(0);
    });
  });

  describe('record semantics — standing, refuted, lapsed', () => {
    it('standingCertificateFor answers while unrefuted, and the announcement clears it', async () => {
      const at = Date.now() - 60_000;
      await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j1', 'j2', 'j3', 'j4']), broadcastedAt: at },
      });
      const standing = await store.standingCertificateFor(S);
      expect(standing.subject).to.equal(S);
      expect(standing.broadcastedAt).to.equal(at);
      expect(await store.refutationFor(S)).to.equal(null);

      // the subject announces: the pipeline's own apprunning row, $gte wins
      await collection.insertOne({
        type: 'apprunning', outpoint: S, ip: '10.9.0.20:16127', dedupKey: 'v2', broadcastedAt: new Date(at), expireAt: new Date(Date.now() + 60_000), data: { note: 'alive' },
      });
      expect(await store.standingCertificateFor(S)).to.equal(null);
      const refutation = await store.refutationFor(S);
      expect(refutation.broadcastedAt).to.equal(at); // tie goes to the announcement
    });

    it('a new death after a refutation stores a new row and stands again', async () => {
      const at = Date.now() - 120_000;
      await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j1', 'j2', 'j3', 'j4']), broadcastedAt: at },
      });
      await collection.insertOne({
        type: 'apprunning', outpoint: S, ip: '10.9.0.20:16127', dedupKey: 'v2', broadcastedAt: new Date(at + 10_000), expireAt: new Date(Date.now() + 60_000), data: {},
      });

      world.height = 1005;
      const second = await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j2', 'j3', 'j4', 'j5'], { height: 1005 }), broadcastedAt: at + 60_000 },
      });
      expect(second.accepted).to.equal(true);
      expect(await collection.countDocuments({ type: 'nodedown', subject: S })).to.equal(2);
      const standing = await store.standingCertificateFor(S);
      expect(standing.height).to.equal(1005);
    });

    it('verifyRefutation is the $gte rule exactly', () => {
      expect(store.verifyRefutation({ broadcastedAt: 100 }, { broadcastedAt: 100 })).to.equal(true);
      expect(store.verifyRefutation({ broadcastedAt: 99 }, { broadcastedAt: 100 })).to.equal(false);
      expect(store.verifyRefutation({}, { broadcastedAt: 100 })).to.equal(false);
    });
  });

  describe('the two rungs — placement freeze and lockout, counted from the certification rows', () => {
    const SUBJECT_ADDRESS = '10.9.0.20:16127';

    async function certify(height, at) {
      world.height = height;
      const result = await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j1', 'j2', 'j3', 'j4'], { height }), broadcastedAt: at },
      });
      expect(result.accepted).to.equal(true);
    }

    async function announce(at, dedupKey) {
      await collection.insertOne({
        type: 'apprunning', outpoint: S, ip: SUBJECT_ADDRESS, dedupKey, broadcastedAt: new Date(at), expireAt: new Date(Date.now() + 60_000), data: {},
      });
    }

    // Deaths, each refuted before the next, so each certification lands its own row.
    async function certifyTimes(n) {
      const first = Date.now() - 600_000;
      for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await certify(1001 + i, first + i * 60_000);
        // eslint-disable-next-line no-await-in-loop
        if (i < n - 1) await announce(first + i * 60_000 + 10_000, `v${i + 1}`);
      }
      return first;
    }

    it('nothing certified: no rung, no record', async () => {
      expect(await store.placementFreezeFor(S)).to.deep.equal({ frozen: false, count: 0, liftsAt: null });
      expect(await store.lockoutFor(S)).to.deep.equal({ lockedOut: false, count: 0, liftsAt: null });
      expect(await store.recordStateFor(S)).to.deep.equal({ state: 'none', key: null });
    });

    it('one certification holds nothing', async () => {
      await certifyTimes(1);
      expect((await store.placementFreezeFor(S)).frozen).to.equal(false);
      expect((await store.lockoutFor(S)).lockedOut).to.equal(false);
    });

    it('the second certification freezes placement and nothing more; refuted rows count as deaths; the lift is the first row\'s expiry', async () => {
      const first = await certifyTimes(2);
      expect(await store.placementFreezeFor(S)).to.deep.equal({ frozen: true, count: 2, liftsAt: first + RECORD_LIFETIME_MS });
      expect(await store.lockoutFor(S)).to.deep.equal({ lockedOut: false, count: 2, liftsAt: null });
      expect(await store.recordStateFor(S)).to.deep.equal({ state: 'standing', key: `nodedown:${S}:1002` });
    });

    it('the third holds nothing more; the fourth locks the subject out until the count falls under four', async () => {
      const first = await certifyTimes(3);
      expect((await store.lockoutFor(S)).lockedOut).to.equal(false);
      await announce(first + 130_000, 'v3');
      await certify(1004, first + 180_000);
      expect(await store.lockoutFor(S)).to.deep.equal({ lockedOut: true, count: 4, liftsAt: first + RECORD_LIFETIME_MS });
      expect((await store.placementFreezeFor(S))).to.deep.equal({ frozen: true, count: 4, liftsAt: first + 120_000 + RECORD_LIFETIME_MS });
    });

    it('recordStateFor names the record while it stands and after the announcement refutes it', async () => {
      const at = Date.now() - 60_000;
      await certify(1001, at);
      expect(await store.recordStateFor(S)).to.deep.equal({ state: 'standing', key: `nodedown:${S}:1001` });
      await announce(at + 10_000, 'v1');
      expect(await store.recordStateFor(S)).to.deep.equal({ state: 'refuted', key: `nodedown:${S}:1001` });
    });

    it('the address forms resolve the listed subject, with or without its port, and hold nothing for an unlisted address', async () => {
      await certifyTimes(4);
      expect((await store.lockoutForAddress(SUBJECT_ADDRESS)).lockedOut).to.equal(true);
      expect((await store.placementFreezeForAddress('10.9.0.20')).count).to.equal(4);
      expect(await store.lockoutForAddress('10.9.0.99:16127')).to.deep.equal({ lockedOut: false, count: 0, liftsAt: null });
      expect(await store.placementFreezeForAddress('10.9.0.99:16127')).to.deep.equal({ frozen: false, count: 0, liftsAt: null });
    });

    it('a lapsed row the TTL sweep has not deleted yet is not counted', async () => {
      await collection.insertOne({
        type: 'nodedown',
        subject: S,
        dedupKey: `nodedown:${S}:900`,
        broadcastedAt: new Date(Date.now() - RECORD_LIFETIME_MS - 1000),
        expireAt: new Date(Date.now() - 1000),
        data: { certificate: {} },
      });
      await certifyTimes(1);
      expect(await store.placementFreezeFor(S)).to.deep.equal({ frozen: false, count: 1, liftsAt: null });
    });
  });

  describe('sync intake — the same verifier as gossip, real signatures', () => {
    // The sync stream serves stored rows whole; the service adapts each row
    // back to the intake shape and the store verifies the certificate inside
    // exactly as it would off the wire — a forged row a peer slips into a
    // solicited sync response dies here.
    function syncService() {
      return proxyquire('../../ZelBack/src/services/nodeDownService', {
        './appMessaging/nodeDownStore': store,
        './networkStateService': {
          membershipFingerprint: () => world.fp,
          networkState: () => world.nodes,
          nodeDownTopology: () => null,
          chainHeight: () => world.height,
        },
      });
    }

    function servedRow(certificate, at) {
      // the stored doc as the wire delivers it: dates JSON-serialized
      return JSON.parse(JSON.stringify({
        type: 'nodedown',
        dedupKey: `nodedown:${certificate.subject}:${certificate.height}`,
        subject: certificate.subject,
        ip: '10.9.0.20:16127',
        broadcastedAt: new Date(at),
        data: { certificate },
        envelope: null,
        receivedAt: new Date(),
      }));
    }

    it('stores a served certificate and keeps the originator timestamp', async () => {
      // hours past the gossip freshness window, well within the record lifetime
      const at = Date.now() - (3 * 60 * 60 * 1000);
      const result = await syncService().onCertificateSyncEvent(
        servedRow(world.certificate(['j1', 'j2', 'j3', 'j4']), at),
      );
      expect(result.accepted).to.equal(true);
      const row = await collection.findOne({ type: 'nodedown', subject: S });
      expect(new Date(row.broadcastedAt).getTime()).to.equal(at);
    });

    it('a tampered certificate off the sync stream is never stored', async () => {
      const certificate = world.certificate(['j1', 'j2', 'j3', 'j4']);
      certificate.verdicts[0].height += 1; // signed bytes no longer match
      const result = await syncService().onCertificateSyncEvent(
        servedRow(certificate, Date.now()),
      );
      expect(result.accepted).to.equal(false);
      expect(await collection.countDocuments({ type: 'nodedown', subject: S })).to.equal(0);
    });

    it('a lapsed row the TTL sweep has not deleted yet dies at intake', async () => {
      const at = Date.now() - RECORD_LIFETIME_MS - 1000;
      const result = await syncService().onCertificateSyncEvent(
        servedRow(world.certificate(['j1', 'j2', 'j3', 'j4']), at),
      );
      expect(result).to.include({ accepted: false, reason: 'expired' });
      expect(await collection.countDocuments({ type: 'nodedown', subject: S })).to.equal(0);
    });
  });

  describe('the grant-plane provider', () => {
    it('registers the full contract and answers through it', async () => {
      store.registerWithGrantPlane();
      const at = Date.now() - 30_000;
      await store.handleNodeDownEvent({
        message: { certificate: world.certificate(['j1', 'j2', 'j3', 'j4']), broadcastedAt: at },
      });
      const standing = await downCertificates.standingCertificateFor(S);
      expect(standing.subject).to.equal(S);
      const { certificate: verify } = downCertificates.verifiers();
      expect(verify(standing).valid).to.equal(true);
    });
  });
});

describe('nodeDownStore — the record carries since and reason (R4)', () => {
  const { NODE_DOWN_GRACE_MS, CLOCK_SKEW_ALLOWANCE_MS } = require('../../ZelBack/src/services/utils/appConstants');
  let world;
  let store;
  let collection;

  before(async function bootstrap() {
    this.timeout(30000);
    await dbHelper.initiateDB();
    collection = dbHelper.databaseConnection()
      .db(config.database.appsglobal.database)
      .collection(globalAppStateEvents);
  });

  beforeEach(async () => {
    world = makeWorld();
    store = proxyquire('../../ZelBack/src/services/appMessaging/nodeDownStore', {
      '../networkStateService': {
        nodeDownTopology: () => world.topology,
        chainHeight: () => world.height,
        networkState: () => world.nodes,
      },
    });
    await collection.deleteMany({ subject: S });
    await collection.deleteMany({ outpoint: S });
    downCertificates.resetForTests();
  });

  after(async () => {
    await collection.deleteMany({ subject: S });
    await collection.deleteMany({ outpoint: S });
  });

  function certificateSince(since, reason) {
    const names = ['j1', 'j2', 'j3', 'j4'];
    return {
      subject: S,
      assembler: world.jurorOutpoint('j1'),
      height: world.height,
      fingerprint: world.fp,
      verdicts: names.map((name) => world.signedVerdict(name, { droppedAt: since, reason })),
      since,
      reason,
    };
  }

  it('stores since and reason on the row, and answers them from standingCertificateFor', async () => {
    const at = Date.now();
    const since = at - 30_000;
    const result = await store.handleNodeDownEvent({ message: { certificate: certificateSince(since, 'shutdown'), broadcastedAt: at } });
    expect(result.accepted).to.equal(true);
    const row = await collection.findOne({ type: 'nodedown', subject: S });
    expect(new Date(row.since).getTime()).to.equal(since);
    expect(row.reason).to.equal('shutdown');
    const standing = await store.standingCertificateFor(S);
    expect(standing).to.include({ since, reason: 'shutdown' });
  });

  it('a certificate with no drop in it is stored with since = its broadcast time and reason unannounced', async () => {
    const at = Date.now();
    await store.handleNodeDownEvent({ message: { certificate: world.certificate(['j1', 'j2', 'j3', 'j4']), broadcastedAt: at } });
    const row = await collection.findOne({ type: 'nodedown', subject: S });
    expect(new Date(row.since).getTime()).to.equal(at);
    expect(row.reason).to.equal('unannounced');
  });

  it('refuses a since after the broadcast beyond the skew allowance, or older than two graces', async () => {
    const at = Date.now();
    const future = await store.handleNodeDownEvent({ message: { certificate: certificateSince(at + CLOCK_SKEW_ALLOWANCE_MS + 1000, 'unannounced'), broadcastedAt: at } });
    expect(future).to.include({ accepted: false, reason: 'since_out_of_range' });
    const ancient = await store.handleNodeDownEvent({ message: { certificate: certificateSince(at - 2 * NODE_DOWN_GRACE_MS - 1000, 'shutdown'), broadcastedAt: at } });
    expect(ancient).to.include({ accepted: false, reason: 'since_out_of_range' });
    expect(await collection.countDocuments({ type: 'nodedown', subject: S })).to.equal(0);
    const edge = await store.handleNodeDownEvent({ message: { certificate: certificateSince(at - 2 * NODE_DOWN_GRACE_MS, 'shutdown'), broadcastedAt: at } });
    expect(edge.accepted).to.equal(true);
  });

  it('a certificate whose since disagrees with its verdicts is refused at intake', async () => {
    const at = Date.now();
    const certificate = certificateSince(at - 30_000, 'shutdown');
    certificate.since = at - 1000;
    const result = await store.handleNodeDownEvent({ message: { certificate, broadcastedAt: at } });
    expect(result).to.include({ accepted: false, reason: 'since_mismatch' });
  });
});
