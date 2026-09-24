'use strict';

const { expect } = require('chai');
const { inChainOrder } = require('../../ZelBack/src/services/utils/softForkRows');

describe('softForkRows.inChainOrder', () => {
  const row = (txid, height, txIndex, vout) => ({ txid, height, txIndex, vout });

  it('orders by height, then the transaction in its block, then the output in its transaction', () => {
    const rows = [
      row('c', 10, 0, 2),
      row('d', 11, 0, 1),
      row('a', 10, 0, 1),
      row('b', 10, 3, 1),
      row('z', 9, 5, 1),
    ];

    expect(inChainOrder(rows, 'pricemessages').map((r) => `${r.txid}${r.vout}`))
      .to.deep.equal(['z1', 'a1', 'c2', 'b1', 'd1']);
  });

  it('refuses a row with no output position, naming the collection to drop', () => {
    expect(() => inChainOrder([{ txid: 'old', height: 10, txIndex: 0 }], 'pricemessages'))
      .to.throw(/pricemessages: row old carries no vout/);
  });

  it('refuses a row with no transaction position', () => {
    expect(() => inChainOrder([{ txid: 'old', height: 10, vout: 1 }], 'pricemessages'))
      .to.throw(/pricemessages: row old carries no txIndex/);
  });
});
