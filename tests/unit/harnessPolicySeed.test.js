'use strict';

const { expect } = require('chai');
const { inChainOrder } = require('../../ZelBack/src/services/utils/softForkRows');

// The harness seeds a group-0 policy grant straight into each node's policy
// collection before boot (test-infra/runner/framework/policy-helper.js); the
// node replays that row through the same rule as a row the chain scan wrote.
// From 2026-09-03 (9b0498338: a fork history is ordered by the transaction's
// position in its block, and a row without one is refused) to 2026-09-07 the
// seed carried no position, every Arcane-env node refused it, and every gated
// feature was denied — the whole mesh, content and telemetry blocks red on the
// first v9 gate to run them since. This pins the seed's shape to the product's
// rule, so the next field the rule grows fails here instead of in a gate.
describe('the harness policy seed', () => {
  let doc;

  before(async () => {
    // eslint-disable-next-line import/extensions -- an ESM module needs its extension
    const helper = await import('../../test-infra/runner/framework/policy-helper.js');
    doc = helper.defaultGroupGrantDoc();
  });

  it('is a row the node accepts into its fork history: in chain order, with its position in the block', () => {
    expect(() => inChainOrder([doc], 'policygroupmessages')).to.not.throw();
    expect(doc.height).to.equal(1);
    expect(doc.txIndex).to.equal(0);
    expect(doc.txid).to.be.a('string');
  });

  it('is a group-0 definition, parsed as the chain ingest would store it', () => {
    expect(doc.message.subtype).to.equal('definition');
    expect(doc.message.groupId).to.equal(0);
    expect(doc.message.action).to.equal('upsert');
    expect(doc.message.bitmap, 'opens at least one feature').to.be.above(0);
  });
});
