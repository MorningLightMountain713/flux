'use strict';

const { expect } = require('chai');

const delistedHolders = require('../../ZelBack/src/services/quorumGrant/delistedHolders');
const { OFF_LIST_GRACE_MS } = require('../../ZelBack/src/services/appDatabase/offListDepartures');
const { RUNNING_EXPIRY_MS } = require('../../ZelBack/src/services/utils/appConstants');

const T0 = 1_700_000_000_000;
const tx = (i) => String(i).padStart(64, '0');
const fleet = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ txhash: tx(from + i), outidx: 0, ip: `10.0.0.${from + i}:16127` }));
const outpoint = (i) => `${tx(i)}:0`;

describe('delistedHolders — a delisted holder resolves to nobody: a seat whose holder left the node list reads as free at the cells', () => {
  beforeEach(() => delistedHolders.resetForTests());

  it('a holder off the list past the grace is delisted for the seats granted before it left, and not for one granted after it came back', () => {
    delistedHolders.noteList(fleet(20), T0);
    delistedHolders.noteList(fleet(19), T0 + 30_000); // node 20 leaves
    const grantedBefore = T0 - 60_000;
    expect(delistedHolders.isDelistedHolder(outpoint(20), grantedBefore, T0 + 30_000 + OFF_LIST_GRACE_MS)).to.equal(false);
    const gone = T0 + 30_000 + OFF_LIST_GRACE_MS + 1;
    expect(delistedHolders.isDelistedHolder(outpoint(20), grantedBefore, gone)).to.equal(true);
    // a row from before the stamp existed is older than any departure
    expect(delistedHolders.isDelistedHolder(outpoint(20), 0, gone)).to.equal(true);
    expect(delistedHolders.isDelistedHolder(outpoint(20), undefined, gone)).to.equal(true);
    // back on the list: the old seat stays free (it is not handed back), a seat founded after the return is held
    const back = gone + 1000;
    delistedHolders.noteList(fleet(20), back);
    expect(delistedHolders.isDelistedHolder(outpoint(20), grantedBefore, back + 1)).to.equal(true);
    expect(delistedHolders.isDelistedHolder(outpoint(20), back + 500, back + 1000)).to.equal(false);
  });

  it('a listed holder is never delisted, and a holder back inside the grace never left', () => {
    delistedHolders.noteList(fleet(20), T0);
    expect(delistedHolders.isDelistedHolder(outpoint(7), 0, T0 + 10 * OFF_LIST_GRACE_MS)).to.equal(false);
    delistedHolders.noteList(fleet(19), T0 + 30_000);
    delistedHolders.noteList(fleet(20), T0 + 60_000);
    expect(delistedHolders.isDelistedHolder(outpoint(20), 0, T0 + 60_000 + OFF_LIST_GRACE_MS + 1)).to.equal(false);
  });

  it('a departure never ages out: a seat is write-once, and only a founding ends what a delisting freed', () => {
    delistedHolders.noteList(fleet(20), T0);
    delistedHolders.noteList(fleet(19), T0 + 30_000);
    expect(delistedHolders.isDelistedHolder(outpoint(20), 0, T0 + 30_000 + 10 * RUNNING_EXPIRY_MS)).to.equal(true);
  });

  it('the mass-disappearance halt is shared: a refresh that empties more than a tenth of the list records nothing', () => {
    delistedHolders.noteList(fleet(20), T0);
    expect(delistedHolders.noteList(fleet(17), T0 + 30_000)).to.deep.equal({ departed: 0, distrusted: true });
    expect(delistedHolders.isDelistedHolder(outpoint(20), 0, T0 + 30_000 + OFF_LIST_GRACE_MS + 1)).to.equal(false);
  });

  it('the boot sweep: seat holders not on the current list start their grace at the sweep', () => {
    delistedHolders.noteList(fleet(20), T0);
    delistedHolders.seedFromRows([outpoint(3), outpoint(40), outpoint(41)], T0 + 1000);
    const t = T0 + 1000 + OFF_LIST_GRACE_MS + 1;
    expect(delistedHolders.isDelistedHolder(outpoint(3), 0, t)).to.equal(false);
    expect(delistedHolders.isDelistedHolder(outpoint(40), 0, t)).to.equal(true);
    expect(delistedHolders.isDelistedHolder(outpoint(41), T0 + 2000, t)).to.equal(false); // granted after the sweep
    expect(delistedHolders.isDelistedHolder(outpoint(40), 0, t - 2)).to.equal(false);
  });

  it('list entries without a usable outpoint are ignored, and outpoint keys normalize the index', () => {
    delistedHolders.noteList([...fleet(20), { ip: '10.0.0.99:16127' }, { txhash: 'nope', outidx: 0 }], T0);
    delistedHolders.noteList(fleet(19), T0 + 30_000);
    const t = T0 + 30_000 + OFF_LIST_GRACE_MS + 1;
    expect(delistedHolders.isDelistedHolder(`${tx(20)}:00`, 0, t)).to.equal(true);
    expect(delistedHolders.outpointKey(`${tx(20)}:007`)).to.equal(`${tx(20)}:7`);
    expect(delistedHolders.outpointKey('nope:0')).to.equal(null);
    expect(delistedHolders.isDelistedHolder('nope:0', 0, t)).to.equal(false);
  });
});
