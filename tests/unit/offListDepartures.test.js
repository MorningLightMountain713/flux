'use strict';

const { expect } = require('chai');

const {
  OffListDepartures, OFF_LIST_GRACE_MS, MASS_DEPARTURE_FRACTION,
} = require('../../ZelBack/src/services/appDatabase/offListDepartures');
const { RUNNING_EXPIRY_MS } = require('../../ZelBack/src/services/utils/appConstants');

const T0 = 1_700_000_000_000;
const list = (n, from = 1) => Array.from({ length: n }, (_, i) => `10.0.0.${from + i}:16127`);
const NONE = { absent: [], returned: [] };

describe('offListDepartures — rows of an address no longer on the node list are negated by local derivation (liveness layer 3)', () => {
  it('the grace and the guard are code constants: two minutes, and a tenth of the list', () => {
    expect(OFF_LIST_GRACE_MS).to.equal(2 * 60 * 1000);
    expect(MASS_DEPARTURE_FRACTION).to.equal(0.1);
  });

  it('an address that leaves the list is denied only once it has been gone for the grace', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000); // 10.0.0.20 gone
    expect(departures.denySet(T0 + 30_000)).to.deep.equal(NONE);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS)).to.deep.equal(NONE);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal({
      absent: ['10.0.0.20:16127', '10.0.0.20'], returned: [],
    });
  });

  it('the first observation of the absence starts the grace, not each refresh that repeats it', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    departures.noteList(list(19), T0 + 60_000);
    departures.noteList(list(19), T0 + 90_000);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1).absent).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
  });

  it('an address back on the list inside the grace never left, as far as this observer knows', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    departures.noteList(list(20), T0 + 60_000);
    expect(departures.denySet(T0 + 60_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal(NONE);
    expect(departures.departedSince('10.0.0.20:16127', T0 + 60_000 + OFF_LIST_GRACE_MS + 1)).to.equal(null);
  });

  it('an address back on the list after the grace stays negated for what it announced before it returned: a node that left the list removed its apps', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    const gone = T0 + 30_000 + OFF_LIST_GRACE_MS + 1;
    expect(departures.denySet(gone).absent).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
    const back = gone + 1000;
    departures.noteList(list(20), back);
    expect(departures.denySet(back + 2000)).to.deep.equal({
      absent: [],
      returned: [{ keys: ['10.0.0.20:16127', '10.0.0.20'], before: back }],
    });
    // the departure it answers with is the first observation, not the return
    expect(departures.departedSince('10.0.0.20:16127', back + 2000)).to.equal(T0 + 30_000);
    // a second absence after the return is the same departure, not a new one
    departures.noteList(list(19), back + 3000);
    expect(departures.denySet(back + 4000)).to.deep.equal({
      absent: [],
      returned: [{ keys: ['10.0.0.20:16127', '10.0.0.20'], before: back }],
    });
  });

  it('a departure ages out at the location TTL: an address gone that long has no rows left to negate', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    expect(departures.denySet(T0 + 30_000 + RUNNING_EXPIRY_MS).absent).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
    expect(departures.denySet(T0 + 30_000 + RUNNING_EXPIRY_MS + 1)).to.deep.equal(NONE);
    expect(departures.departedSince('10.0.0.20:16127', T0 + 30_000 + RUNNING_EXPIRY_MS + 1)).to.equal(null);
  });

  it('a register with no expiry keeps a departure for good: a write-once row never ages', () => {
    const departures = new OffListDepartures({ expiryMs: null });
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    const late = T0 + 30_000 + 10 * RUNNING_EXPIRY_MS;
    expect(departures.denySet(late).absent).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
    expect(departures.departedSince('10.0.0.20:16127', late)).to.equal(T0 + 30_000);
  });

  it('a refresh that removes more than the sanity fraction of the known addresses is the observer\'s own daemon lying: nothing is recorded, and the known list holds', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    const distrusted = departures.noteList(list(17), T0 + 30_000); // three of twenty gone at once
    expect(distrusted).to.deep.equal({ departed: 0, distrusted: true });
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal(NONE);
    // the next honest refresh diffs against the held list, not the truncated one
    const honest = departures.noteList(list(19), T0 + 60_000);
    expect(honest).to.deep.equal({ departed: 1, distrusted: false });
    expect(departures.denySet(T0 + 60_000 + OFF_LIST_GRACE_MS + 1).absent).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
  });

  it('exactly the sanity fraction is still trusted', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    expect(departures.noteList(list(18), T0 + 30_000)).to.deep.equal({ departed: 2, distrusted: false });
  });

  it('the first list seeds the known set and records no departures; a boot sweep of row addresses not on it starts their grace', () => {
    const departures = new OffListDepartures();
    expect(departures.noteList(list(20), T0)).to.deep.equal({ departed: 0, distrusted: false });
    expect(departures.denySet(T0 + RUNNING_EXPIRY_MS)).to.deep.equal(NONE);
    departures.seedFromRows(['10.0.0.5:16127', '10.0.0.99:16127', '10.0.0.98'], T0 + 1000);
    expect(departures.denySet(T0 + 1000 + OFF_LIST_GRACE_MS)).to.deep.equal(NONE);
    expect(departures.denySet(T0 + 1000 + OFF_LIST_GRACE_MS + 1).absent).to.deep.equal([
      '10.0.0.99:16127', '10.0.0.99', '10.0.0.98:16127', '10.0.0.98',
    ]);
  });

  it('an address on a non-default port is denied in its one form only: the bare host still names the default-port node', () => {
    const departures = new OffListDepartures();
    departures.noteList([...list(20), '10.0.0.1:16137'], T0);
    departures.noteList(list(20), T0 + 30_000);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1).absent).to.deep.equal(['10.0.0.1:16137']);
  });

  it('a bare address on the list is the default-port node', () => {
    const departures = new OffListDepartures();
    const bare = Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`);
    departures.noteList(bare, T0);
    departures.noteList(bare.slice(0, 19), T0 + 30_000);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1).absent).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
  });

  it('the key and form functions are the register\'s to choose: an outpoint register denies the one form and drops what is not an outpoint', () => {
    const keyOf = (raw) => (/^[0-9a-f]{64}:\d+$/.test(raw) ? raw : null);
    const departures = new OffListDepartures({ keyOf, forms: (key) => [key], expiryMs: null });
    const outpoints = Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(64, '0')}:0`);
    expect(departures.noteList([...outpoints, 'not-an-outpoint'], T0)).to.deep.equal({ departed: 0, distrusted: false });
    departures.noteList(outpoints.slice(0, 19), T0 + 30_000);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1).absent).to.deep.equal([outpoints[19]]);
    expect(departures.departedSince('not-an-outpoint', T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.equal(null);
  });

  it('resetForTests forgets everything', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    departures.resetForTests();
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal(NONE);
    expect(departures.noteList(list(19), T0 + 60_000)).to.deep.equal({ departed: 0, distrusted: false });
  });
});
