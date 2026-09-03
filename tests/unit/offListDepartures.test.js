'use strict';

const { expect } = require('chai');

const {
  OffListDepartures, OFF_LIST_GRACE_MS, MASS_DEPARTURE_FRACTION,
} = require('../../ZelBack/src/services/appDatabase/offListDepartures');
const { RUNNING_EXPIRY_MS } = require('../../ZelBack/src/services/utils/appConstants');

const T0 = 1_700_000_000_000;
const list = (n, from = 1) => Array.from({ length: n }, (_, i) => `10.0.0.${from + i}:16127`);

describe('offListDepartures — rows of an address no longer on the node list are negated by local derivation (liveness layer 3)', () => {
  it('the grace and the guard are code constants: two minutes, and a tenth of the list', () => {
    expect(OFF_LIST_GRACE_MS).to.equal(2 * 60 * 1000);
    expect(MASS_DEPARTURE_FRACTION).to.equal(0.1);
  });

  it('an address that leaves the list is denied only once it has been gone for the grace', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000); // 10.0.0.20 gone
    expect(departures.denySet(T0 + 30_000)).to.deep.equal([]);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS)).to.deep.equal([]);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
  });

  it('the first observation of the absence starts the grace, not each refresh that repeats it', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    departures.noteList(list(19), T0 + 60_000);
    departures.noteList(list(19), T0 + 90_000);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
  });

  it('an address back on the list before the grace is never denied; back after it, it is denied no longer', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    departures.noteList(list(20), T0 + 60_000);
    expect(departures.denySet(T0 + 60_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal([]);
    departures.noteList(list(19), T0 + 90_000);
    const later = T0 + 90_000 + OFF_LIST_GRACE_MS + 1;
    expect(departures.denySet(later)).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
    departures.noteList(list(20), later + 1000);
    expect(departures.denySet(later + 2000)).to.deep.equal([]);
  });

  it('a departure ages out at the location TTL: an address gone that long has no rows left to negate', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    expect(departures.denySet(T0 + 30_000 + RUNNING_EXPIRY_MS)).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
    expect(departures.denySet(T0 + 30_000 + RUNNING_EXPIRY_MS + 1)).to.deep.equal([]);
  });

  it('a refresh that removes more than the sanity fraction of the known addresses is the observer\'s own daemon lying: nothing is recorded, and the known list holds', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    const distrusted = departures.noteList(list(17), T0 + 30_000); // three of twenty gone at once
    expect(distrusted).to.deep.equal({ departed: 0, distrusted: true });
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal([]);
    // the next honest refresh diffs against the held list, not the truncated one
    const honest = departures.noteList(list(19), T0 + 60_000);
    expect(honest).to.deep.equal({ departed: 1, distrusted: false });
    expect(departures.denySet(T0 + 60_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
  });

  it('exactly the sanity fraction is still trusted', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    expect(departures.noteList(list(18), T0 + 30_000)).to.deep.equal({ departed: 2, distrusted: false });
  });

  it('the first list seeds the known set and records no departures; a boot sweep of row addresses not on it starts their grace', () => {
    const departures = new OffListDepartures();
    expect(departures.noteList(list(20), T0)).to.deep.equal({ departed: 0, distrusted: false });
    expect(departures.denySet(T0 + RUNNING_EXPIRY_MS)).to.deep.equal([]);
    departures.seedFromRows(['10.0.0.5:16127', '10.0.0.99:16127', '10.0.0.98'], T0 + 1000);
    expect(departures.denySet(T0 + 1000 + OFF_LIST_GRACE_MS)).to.deep.equal([]);
    expect(departures.denySet(T0 + 1000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal([
      '10.0.0.99:16127', '10.0.0.99', '10.0.0.98:16127', '10.0.0.98',
    ]);
  });

  it('an address on a non-default port is denied in its one form only: the bare host still names the default-port node', () => {
    const departures = new OffListDepartures();
    departures.noteList([...list(20), '10.0.0.1:16137'], T0);
    departures.noteList(list(20), T0 + 30_000);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal(['10.0.0.1:16137']);
  });

  it('a bare address on the list is the default-port node', () => {
    const departures = new OffListDepartures();
    const bare = Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`);
    departures.noteList(bare, T0);
    departures.noteList(bare.slice(0, 19), T0 + 30_000);
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal(['10.0.0.20:16127', '10.0.0.20']);
  });

  it('resetForTests forgets everything', () => {
    const departures = new OffListDepartures();
    departures.noteList(list(20), T0);
    departures.noteList(list(19), T0 + 30_000);
    departures.resetForTests();
    expect(departures.denySet(T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.deep.equal([]);
    expect(departures.noteList(list(19), T0 + 60_000)).to.deep.equal({ departed: 0, distrusted: false });
  });
});
