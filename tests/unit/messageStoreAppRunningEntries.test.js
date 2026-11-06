const { expect } = require('chai');
const { appRunningEntries } = require('../../ZelBack/src/services/utils/appRunningEntries');

// A version 2 apprunning message is judged entry by entry: one entry without a
// name and hash costs its sender that entry, never the rest of the message.
describe('apprunning entries are stored one at a time', () => {
  const weeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);

  describe('appRunningEntries', () => {
    it('keeps an entry with a string name and a string hash', () => {
      const app = { name: 'web', hash: 'h1', runningSince: weeksAgo.toISOString() };
      expect(appRunningEntries([app])).to.deep.equal({ stored: [app], refused: [] });
    });

    it('refuses each entry without a string name and hash, and only those', () => {
      const good = { name: 'web', hash: 'h1' };
      const bad = [
        { name: 'probe' },
        { name: 'probe', hash: null },
        { name: 'probe', hash: 7 },
        { hash: 'h2' },
        { name: 3, hash: 'h2' },
        null,
        'web',
        undefined,
      ];
      const { stored, refused } = appRunningEntries([bad[0], good, ...bad.slice(1)]);
      expect(stored).to.deep.equal([good]);
      expect(refused).to.deep.equal(bad);
    });

    it('answers an empty list with nothing either way', () => {
      expect(appRunningEntries([])).to.deep.equal({ stored: [], refused: [] });
    });
  });
});
