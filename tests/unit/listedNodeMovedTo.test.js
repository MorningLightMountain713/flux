const { expect } = require('chai');
const sinon = require('sinon');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const { requireMongo } = require('./dbTestHelper');

describe('registryManager listedNodeMovedTo tests', () => {
  before(requireMongo);

  const A = '203.0.113.170:16127';
  const B = '203.0.113.170:16157';
  const C = '203.0.113.171:16127';
  const OWN_KEY = '02ownkey';
  const OTHER_KEY = '02otherkey';
  const listed = { ip: A, pubkey: OWN_KEY };
  let events;

  async function move(oldIp, newIp, broadcastedAt, pubKey) {
    const message = {
      type: 'fluxipchanged', version: 1, oldIP: oldIp, newIP: newIp, broadcastedAt,
    };
    await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.IPCHANGED, {
      message,
      envelope: {
        version: 1, timestamp: broadcastedAt, pubKey, signature: 'SIG',
      },
    });
  }

  beforeEach(async () => {
    await dbHelper.initiateDB();
    events = dbHelper.databaseConnection().db(config.database.appsglobal.database)
      .collection(config.database.appsglobal.collections.appStateEvents);
    await events.deleteMany({ ip: { $in: [A, B, C] } });
  });

  afterEach(async () => {
    await events.deleteMany({ ip: { $in: [A, B, C] } });
  });

  it('finds the listed node at the address its own move leads to', async () => {
    await move(A, B, Date.now() - 60_000, OWN_KEY);

    expect(await registryManager.listedNodeMovedTo(B, [listed])).to.equal(listed);
  });

  it('does not follow a move another key signed', async () => {
    await move(A, B, Date.now() - 60_000, OTHER_KEY);

    expect(await registryManager.listedNodeMovedTo(B, [listed])).to.equal(null);
  });

  it('follows the node through each of its moves', async () => {
    await move(A, B, Date.now() - 120_000, OWN_KEY);
    await move(B, C, Date.now() - 60_000, OWN_KEY);

    expect(await registryManager.listedNodeMovedTo(C, [listed])).to.equal(listed);
  });

  it('does not take an address the node moved on from as the node', async () => {
    await move(A, B, Date.now() - 120_000, OWN_KEY);
    await move(B, C, Date.now() - 60_000, OWN_KEY);

    expect(await registryManager.listedNodeMovedTo(B, [listed])).to.equal(null);
  });

  it('does not follow a move older than the one before it', async () => {
    await move(A, B, Date.now() - 60_000, OWN_KEY);
    await move(B, C, Date.now() - 120_000, OWN_KEY);

    expect(await registryManager.listedNodeMovedTo(C, [listed])).to.equal(null);
  });

  it('answers null for an address no listed node moved to', async () => {
    await move(A, B, Date.now() - 60_000, OWN_KEY);

    expect(await registryManager.listedNodeMovedTo(C, [listed])).to.equal(null);
  });

  // A node asks where the network lists it right after it moves: what it announced
  // at the address it left is its until it announces again at the new one.
  describe('the rows of an address a move leads to', () => {
    const announce = (ip, broadcastedAt) => messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, {
      signedBroadcast: {
        version: 1,
        timestamp: broadcastedAt,
        pubKey: OWN_KEY,
        signature: 'SIG',
        data: JSON.stringify({
          type: 'fluxapprunning', version: 2, ip, broadcastedAt, osUptime: 1, staticIp: false, apps: [{ name: 'moved', hash: 'a'.repeat(64), runningSince: new Date(broadcastedAt).toISOString() }],
        }),
      },
    });

    it('holds what the node announced at the address it left', async () => {
      await announce(A, Date.now() - 120_000);
      await move(A, B, Date.now() - 60_000, OWN_KEY);

      const rows = await appsRepository.appLocationFromEvents({ ip: B });

      expect(rows.map((row) => [row.name, row.ip])).to.deep.equal([['moved', B]]);
    });

    // Canary: nothing moved to it, so nothing reads as at it.
    it('holds nothing at an address no move leads to', async () => {
      await announce(A, Date.now() - 120_000);
      await move(A, B, Date.now() - 60_000, OWN_KEY);

      expect(await appsRepository.appLocationFromEvents({ ip: C })).to.deep.equal([]);
    });
  });

  describe('appsListedAt', () => {
    afterEach(() => sinon.restore());

    it('names each app the network lists at the address once', async () => {
      const read = sinon.stub(appsRepository, 'appLocationFromEvents').resolves([{ name: 'one' }, { name: 'two' }, { name: 'one' }]);

      expect(await registryManager.appsListedAt('198.51.100.1')).to.deep.equal(['one', 'two']);

      sinon.assert.calledOnceWithExactly(read, { ip: '198.51.100.1:16127' });
    });

    it('lists nothing for no address', async () => {
      expect(await registryManager.appsListedAt(null)).to.deep.equal([]);
    });
  });
});
