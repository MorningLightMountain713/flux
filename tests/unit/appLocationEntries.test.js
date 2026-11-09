const { expect } = require('chai');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const { instanceKey } = require('../../ZelBack/src/services/appDatabase/appRecords');
const { requireMongo } = require('./dbTestHelper');
const { NODE_DOWN_GRACE_MS } = require('../../ZelBack/src/services/utils/appConstants');

// The stored message keeps every entry its sender signed; a location is made only
// of an entry with a string name and a string hash.
describe('the locations an announcement makes', () => {
  before(requireMongo);

  const SENDER = '203.0.113.180:16127';
  const HASH = 'a'.repeat(64);
  let events;

  const announce = (apps) => {
    const broadcastedAt = Date.now() - 1000;
    return messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, {
      signedBroadcast: {
        version: 1,
        timestamp: broadcastedAt,
        pubKey: '02senderkey',
        signature: 'SIG',
        data: {
          type: 'fluxapprunning', version: 2, ip: SENDER, broadcastedAt, osUptime: 1, staticIp: false, apps,
        },
      },
    });
  };
  const since = new Date().toISOString();

  beforeEach(async () => {
    await dbHelper.initiateDB();
    events = dbHelper.databaseConnection().db(config.database.appsglobal.database)
      .collection(config.database.appsglobal.collections.appStateEvents);
    await events.deleteMany({ ip: SENDER });
  });

  afterEach(async () => {
    await events.deleteMany({ ip: SENDER });
  });

  it('are the entries with a name and hash, and not the others beside them', async () => {
    await announce([
      { name: 'kept', hash: HASH, runningSince: since },
      { name: 'unhashed', runningSince: since },
      { name: 7, hash: HASH, runningSince: since },
      null,
    ]);

    const rows = await appsRepository.appLocationFromEvents({ ip: SENDER });

    expect(rows.map((row) => row.name)).to.deep.equal(['kept']);
  });

  it('leave an app named only by an entry without a hash with no location', async () => {
    await announce([
      { name: 'kept', hash: HASH, runningSince: since },
      { name: 'unhashed', runningSince: since },
    ]);

    expect(await appsRepository.appLocationFromEvents({ appname: 'unhashed', excludeHashes: [] })).to.deep.equal([]);
    expect((await appsRepository.appLocationFromEvents({ appname: 'kept', excludeHashes: [] })).map((row) => row.ip)).to.deep.equal([SENDER]);
  });
});

// What a node itself announced, read from its own stored announcements: a
// certificate that it was down does not hide them, and an address it moved from
// still speaks for it.
describe('what a node itself announced', () => {
  before(requireMongo);

  const NODE = '203.0.113.190:16127';
  const MOVED_TO = '203.0.113.191:16127';
  const HASH = 'b'.repeat(64);
  let events;

  // Stored as a synced announcement is: how a node's own announcements come back
  // to it after it was away.
  const announce = (ip, broadcastedAt, apps) => messageStore.storeBatchAppRunningEvents([{
    version: 1,
    timestamp: broadcastedAt,
    pubKey: '02nodekey',
    signature: 'SIG',
    data: {
      type: 'fluxapprunning', version: 2, ip, broadcastedAt, osUptime: 1, staticIp: false, apps,
    },
  }]);
  const entry = (name, runningSince) => ({ name, hash: HASH, runningSince });
  const sinceOf = async (ip, name) => (await appsRepository.ownAnnouncedEntries(ip)).get(instanceKey({ name, replica: null }))?.runningSince ?? null;

  beforeEach(async () => {
    await dbHelper.initiateDB();
    events = dbHelper.databaseConnection().db(config.database.appsglobal.database)
      .collection(config.database.appsglobal.collections.appStateEvents);
    await events.deleteMany({ ip: { $in: [NODE, MOVED_TO] } });
  });

  afterEach(async () => {
    await events.deleteMany({ ip: { $in: [NODE, MOVED_TO] } });
  });

  it('stands past a certificate that the node was down', async () => {
    // Announced, then certified down, the grace since run out.
    const at = Date.now() - NODE_DOWN_GRACE_MS - 120_000;
    await announce(NODE, at, [entry('held', '2026-10-01T00:00:00.000Z')]);
    // The row the node-down store writes for that certificate.
    await events.insertOne({
      type: 'nodedown', ip: NODE, subject: 'cafe:0', dedupKey: 'nodedown:cafe:0:1', death: 1,
      broadcastedAt: new Date(at + 30_000), since: new Date(at + 30_000), expireAt: new Date(Date.now() + 3_600_000),
    });
    expect(await appsRepository.appLocationFromEvents({ ip: NODE }), 'fixture: the certificate overrules the announcement in the network\'s view').to.deep.equal([]);

    expect(await sinceOf(NODE, 'held')).to.equal('2026-10-01T00:00:00.000Z');
  });

  it('includes what the node announced at an address it moved from, the newest announcement answering', async () => {
    const at = Date.now() - 120_000;
    await announce(NODE, at, [entry('old', '2026-09-01T00:00:00.000Z'), entry('both', '2026-09-02T00:00:00.000Z')]);
    await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.IPCHANGED, {
      message: {
        type: 'fluxipchanged', version: 1, oldIP: NODE, newIP: MOVED_TO, broadcastedAt: at + 30_000,
      },
      envelope: {
        version: 1, timestamp: at + 30_000, pubKey: '02nodekey', signature: 'SIG',
      },
    });
    await announce(MOVED_TO, at + 60_000, [entry('both', '2026-09-03T00:00:00.000Z')]);

    expect(await sinceOf(MOVED_TO, 'old')).to.equal('2026-09-01T00:00:00.000Z');
    expect(await sinceOf(MOVED_TO, 'both')).to.equal('2026-09-03T00:00:00.000Z');
  });
});
