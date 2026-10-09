process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const logCursor = require('../../ZelBack/src/services/utils/logCursor');

describe('logCursor tests', () => {
  it('round-trips a position', () => {
    const token = logCursor.encode({ ms: 1_788_508_223_926, count: 4 });

    expect(logCursor.decode(token)).to.deep.equal({ ms: 1_788_508_223_926, count: 4 });
  });

  it('is opaque, so the shape can change without every reader changing', () => {
    const token = logCursor.encode({ ms: 1_788_508_223_926, count: 4 });

    expect(token, 'a reader that parses this becomes a compatibility constraint').to.not.include('1788508223926');
  });

  // A reader with no usable position is a reader at the start, which is answered
  // the same as a first request. Refusing would take a log view down over a
  // cursor a browser kept from an older node.
  it('treats anything it did not issue as no position at all', () => {
    ['', null, undefined, 'not-base64!!', Buffer.from('{}').toString('base64url'),
      Buffer.from('{"v":2,"ms":1,"count":0}').toString('base64url'),
      Buffer.from('{"v":1,"ms":-1,"count":0}').toString('base64url'),
      Buffer.from('{"v":1,"ms":1,"count":1.5}').toString('base64url'),
    ].forEach((token) => {
      expect(logCursor.decode(token), `${token} should not decode`).to.equal(null);
    });
  });

  it('carries a daemon reader\'s file position, exactly, past 2^53', () => {
    const position = {
      ms: 1_788_508_223_926, count: 4, ino: '18446744073709551615', firstNs: '1788508223000123456', off: 10_629_356,
    };

    expect(logCursor.decode(logCursor.encode(position))).to.deep.equal(position);
  });

  it('decodes a token a node issued before file positions existed as it always did', () => {
    const token = Buffer.from('{"v":1,"ms":1788508223926,"count":4}').toString('base64url');

    expect(logCursor.decode(token)).to.deep.equal({ ms: 1_788_508_223_926, count: 4 });
  });

  it('keeps the position and drops a file position that is not whole and well formed', () => {
    [
      { ino: '12', firstNs: '5' },
      { ino: 12, firstNs: '5', off: 0 },
      { ino: '12', firstNs: 5, off: 0 },
      { ino: '12', firstNs: '5', off: -1 },
      { ino: '18446744073709551616', firstNs: '5', off: 0 },
      { ino: '12', firstNs: '9223372036854775808', off: 0 },
      { ino: '1e3', firstNs: '5', off: 0 },
    ].forEach((file) => {
      const token = Buffer.from(JSON.stringify({
        v: 1, ms: 7, count: 1, ...file,
      })).toString('base64url');
      expect(logCursor.decode(token), JSON.stringify(file)).to.deep.equal({ ms: 7, count: 1 });
    });
  });
});
