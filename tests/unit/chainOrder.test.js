'use strict';

const { expect } = require('chai');

const { compareChainOrder, isPositioned } = require('../../ZelBack/src/services/utils/chainOrder');

describe('chainOrder', () => {
  it('orders by height, then position in the block, then output', () => {
    const entries = [
      { id: 'later block', height: 11, txIndex: 0 },
      { id: 'same tx, second output', height: 10, txIndex: 3, vout: 2 },
      { id: 'earlier in block', height: 10, txIndex: 1 },
      { id: 'same tx, first output', height: 10, txIndex: 3, vout: 1 },
    ];

    expect(entries.sort(compareChainOrder).map((entry) => entry.id)).to.deep.equal([
      'earlier in block', 'same tx, first output', 'same tx, second output', 'later block',
    ]);
  });

  it('ignores the sender timestamp', () => {
    const early = { height: 10, txIndex: 1, timestamp: 2000 };
    const late = { height: 10, txIndex: 2, timestamp: 1000 };

    expect(compareChainOrder(early, late)).to.be.below(0);
  });

  it('knows an entry without a position in its block is not positioned', () => {
    expect(isPositioned({ height: 10, txIndex: 0 })).to.equal(true);
    expect(isPositioned({ height: 10 })).to.equal(false);
    expect(isPositioned(null)).to.equal(false);
  });
});
