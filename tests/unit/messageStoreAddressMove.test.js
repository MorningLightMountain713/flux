const { expect } = require('chai');
const config = require('config');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const { addressMoveEvents, EVENTS: ADDRESS_MOVE_EVENTS } = require('../../ZelBack/src/services/utils/addressMoveEvents');
const { requireMongo } = require('./dbTestHelper');

describe('messageStore address move tests', () => {
  before(requireMongo);

  const OLD = '72.89.45.236:16137';
  const NEW = '108.6.236.4:16137';
  const FURTHER = '203.0.113.9:16137';
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;

  const move = (oldIP, newIP, broadcastedAt) => ({
    type: 'fluxipchanged', version: 1, oldIP, newIP, broadcastedAt,
  });
  // Every path records the move's event, then stores the move.
  const arrives = async (message) => {
    await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.IPCHANGED, { message, envelope: null });
    return messageStore.storeIPChangedMessage(message);
  };

  let heard;
  const listener = (told) => heard.push(told);

  beforeEach(async () => {
    await dbHelper.initiateDB();
    await dbHelper.databaseConnection().db(config.database.appsglobal.database)
      .collection(config.database.appsglobal.collections.appStateEvents)
      .deleteMany({ type: 'ipchanged' });
    heard = [];
    addressMoveEvents.on(ADDRESS_MOVE_EVENTS.APPLIED, listener);
  });

  afterEach(() => {
    addressMoveEvents.off(ADDRESS_MOVE_EVENTS.APPLIED, listener);
  });

  describe('how long after it was made a move is accepted', () => {
    it('accepts a move as long as an announcement it speaks for can stand', async () => {
      expect(await arrives(move(OLD, NEW, Date.now() - 100 * MINUTE))).to.equal(true);
    });

    it('refuses a move older than any announcement it could speak for', async () => {
      expect(await arrives(move(OLD, NEW, Date.now() - 126 * MINUTE))).to.equal(false);
    });
  });

  describe('what it tells addressMoveEvents', () => {
    it('tells each move, with where the node is and when it moved', async () => {
      const broadcastedAt = Date.now();

      await arrives(move(OLD, NEW, broadcastedAt));

      expect(heard).to.deep.equal([{ from: OLD, to: NEW, broadcastedAt }]);
    });

    it('tells a move of the port alone', async () => {
      const broadcastedAt = Date.now();

      await arrives(move('198.51.100.40:16127', '198.51.100.40:16157', broadcastedAt));

      expect(heard).to.deep.equal([{ from: '198.51.100.40:16127', to: '198.51.100.40:16157', broadcastedAt }]);
    });

    it('tells where the node went next, when it has moved on since', async () => {
      const broadcastedAt = Date.now() - MINUTE;
      await arrives(move(NEW, FURTHER, Date.now()));
      heard.length = 0;

      await arrives(move(OLD, NEW, broadcastedAt));

      expect(heard).to.deep.equal([{ from: OLD, to: FURTHER, broadcastedAt }]);
    });

    it('tells the address it moved to, though the node left that address once before', async () => {
      const broadcastedAt = Date.now();
      await arrives(move(NEW, FURTHER, broadcastedAt - 5 * MINUTE));
      heard.length = 0;

      await arrives(move(OLD, NEW, broadcastedAt));

      expect(heard).to.deep.equal([{ from: OLD, to: NEW, broadcastedAt }]);
    });

    it('tells nothing for a move the node has since undone', async () => {
      await arrives(move(NEW, OLD, Date.now()));
      heard.length = 0;

      expect(await arrives(move(OLD, NEW, Date.now() - MINUTE))).to.equal(true);

      expect(heard).to.deep.equal([]);
    });

    it('tells nothing for a move it refuses or finds too old', async () => {
      await messageStore.storeIPChangedMessage({
        type: 'fluxipchanged', version: 2, oldIP: OLD, newIP: NEW, broadcastedAt: Date.now(),
      });
      await messageStore.storeIPChangedMessage(move(OLD, NEW, Date.now() - 3 * HOUR));

      expect(heard).to.deep.equal([]);
    });
  });
});
