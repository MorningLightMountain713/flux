const { expect } = require('chai');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const { requireMongo } = require('./dbTestHelper');

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
