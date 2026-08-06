const { expect } = require('chai');
const sinon = require('sinon');

const { NetworkStateManager } = require('../../ZelBack/src/services/utils/networkStateManager');

/**
 * Covers the incremental apply path only. The fetch/poll path has its own coverage in
 * networkStateManager.test.js.
 */

function rpcNode(overrides = {}) {
  return {
    collateral: 'COutPoint(aaaa, 0)',
    txhash: 'a'.repeat(64),
    outidx: 0,
    ip: '10.0.0.1',
    network: 'ipv4',
    added_height: 1000,
    confirmed_height: 1100,
    last_confirmed_height: 1100,
    last_paid_height: 1200,
    tier: 'CUMULUS',
    payment_address: 't1payment',
    pubkey: 'pub-a',
    ...overrides,
  };
}

function deltaNode(overrides = {}) {
  return {
    txhash: 'a'.repeat(64),
    outidx: 0,
    collateralPubkey: 'cpub',
    pubkey: 'pub-a',
    confirmedHeight: 1100,
    lastPaidHeight: 1200,
    tier: 'CUMULUS',
    status: 'CONFIRMED',
    ip: '10.0.0.1',
    ...overrides,
  };
}

function delta(overrides = {}) {
  return {
    fromHeight: 2000,
    toHeight: 2001,
    fromHash: 'f'.repeat(64),
    toHash: '2'.repeat(64),
    isReorg: false,
    added: [],
    removed: [],
    updated: [],
    ...overrides,
  };
}

describe('networkStateManager applyDelta tests', () => {
  let manager;
  let fetcher;

  async function seed(nodes) {
    fetcher = sinon.stub().resolves(nodes);
    manager = new NetworkStateManager(fetcher, { intervalMs: 3_600_000 });
    await manager.fetchNetworkState();
    manager.setChainAnchor(2000, 'f'.repeat(64));
  }

  afterEach(() => {
    if (manager) manager.reset();
    sinon.restore();
  });

  describe('chain anchoring tests', () => {
    it('should refuse a delta when the state is not anchored', async () => {
      await seed([rpcNode()]);
      manager.setChainAnchor(0, null);

      const result = await manager.applyDelta(delta(), sinon.stub());

      expect(result.applied).to.equal(false);
      expect(result.reason).to.match(/not anchored/);
    });

    it('should refuse a delta that does not chain onto the held state', async () => {
      await seed([rpcNode()]);

      const result = await manager.applyDelta(delta({ fromHash: '9'.repeat(64) }), sinon.stub());

      expect(result.applied).to.equal(false);
      expect(result.reason).to.match(/but state is at/);
    });

    it('should advance the anchor to the delta destination', async () => {
      await seed([rpcNode()]);

      await manager.applyDelta(delta(), sinon.stub());

      expect(manager.chainAnchor).to.eql({ height: 2001, hash: '2'.repeat(64) });
    });

    it('should accept a transition whose height goes backwards after a reorg', async () => {
      await seed([rpcNode()]);

      const result = await manager.applyDelta(
        delta({ fromHeight: 2000, toHeight: 1998, isReorg: true }),
        sinon.stub(),
      );

      expect(result.applied).to.equal(true);
      expect(manager.chainAnchor.height).to.equal(1998);
    });

    it('should accept the same height with a different hash', async () => {
      await seed([rpcNode()]);

      const result = await manager.applyDelta(
        delta({ toHeight: 2000, toHash: '7'.repeat(64), isReorg: true }),
        sinon.stub(),
      );

      expect(result.applied).to.equal(true);
      expect(manager.chainAnchor.hash).to.equal('7'.repeat(64));
    });

    it('should chain one delta onto the next', async () => {
      await seed([rpcNode()]);

      await manager.applyDelta(delta(), sinon.stub());
      const second = await manager.applyDelta(
        delta({ fromHeight: 2001, toHeight: 2002, fromHash: '2'.repeat(64), toHash: '3'.repeat(64) }),
        sinon.stub(),
      );

      expect(second.applied).to.equal(true);
    });
  });

  describe('removal tests', () => {
    it('should drop a removed node from the state and every index', async () => {
      await seed([rpcNode(), rpcNode({ txhash: 'b'.repeat(64), ip: '10.0.0.2', pubkey: 'pub-b' })]);

      await manager.applyDelta(
        delta({ removed: [{ txid: 'a'.repeat(64), index: 0 }] }),
        sinon.stub(),
      );

      expect(manager.nodeCount).to.equal(1);
      expect(await manager.search('10.0.0.1', 'socketAddress')).to.equal(null);
      expect(await manager.search('pub-a', 'pubkey')).to.equal(null);
    });

    it('should tolerate a removal for a node it does not hold', async () => {
      await seed([rpcNode()]);

      const result = await manager.applyDelta(
        delta({ removed: [{ txid: 'z'.repeat(64), index: 3 }] }),
        sinon.stub(),
      );

      expect(result.applied).to.equal(true);
      expect(manager.nodeCount).to.equal(1);
    });

    it('should distinguish two nodes sharing a txhash by outidx', async () => {
      await seed([
        rpcNode({ outidx: 0, ip: '10.0.0.1', pubkey: 'pub-a' }),
        rpcNode({ outidx: 1, ip: '10.0.0.2', pubkey: 'pub-b' }),
      ]);

      await manager.applyDelta(
        delta({ removed: [{ txid: 'a'.repeat(64), index: 1 }] }),
        sinon.stub(),
      );

      expect(manager.nodeCount).to.equal(1);
      expect(await manager.search('10.0.0.1', 'socketAddress')).to.not.equal(null);
    });
  });

  describe('update tests', () => {
    it('should merge delta fields onto the held node', async () => {
      await seed([rpcNode()]);

      await manager.applyDelta(
        delta({ updated: [deltaNode({ lastPaidHeight: 2001, tier: 'NIMBUS' })] }),
        sinon.stub(),
      );

      const node = await manager.search('10.0.0.1', 'socketAddress');
      expect(node.last_paid_height).to.equal(2001);
      expect(node.tier).to.equal('NIMBUS');
    });

    it('should keep the fields the delta cannot carry', async () => {
      await seed([rpcNode()]);

      await manager.applyDelta(
        delta({ updated: [deltaNode({ lastPaidHeight: 2001 })] }),
        sinon.stub(),
      );

      const node = await manager.search('10.0.0.1', 'socketAddress');
      expect(node.added_height).to.equal(1000);
      expect(node.payment_address).to.equal('t1payment');
    });

    it('should re-key both indexes when a node changes ip', async () => {
      await seed([rpcNode()]);

      await manager.applyDelta(
        delta({ updated: [deltaNode({ ip: '10.9.9.9' })] }),
        sinon.stub(),
      );

      expect(await manager.search('10.0.0.1', 'socketAddress')).to.equal(null);
      expect((await manager.search('10.9.9.9', 'socketAddress')).ip).to.equal('10.9.9.9');
      expect((await manager.search('pub-a', 'pubkey')).get('10.9.9.9').ip).to.equal('10.9.9.9');
    });

    it('should not resurrect a node it does not hold', async () => {
      await seed([rpcNode()]);

      await manager.applyDelta(
        delta({ updated: [deltaNode({ txhash: 'c'.repeat(64), ip: '10.0.0.3' })] }),
        sinon.stub(),
      );

      expect(manager.nodeCount).to.equal(1);
    });
  });

  describe('add tests', () => {
    it('should resolve added nodes to full records before inserting', async () => {
      await seed([rpcNode()]);
      const full = rpcNode({
        txhash: 'd'.repeat(64), ip: '10.0.0.4', pubkey: 'pub-d', added_height: 1500, payment_address: 't1d',
      });
      const resolveAdded = sinon.stub().resolves([full]);

      await manager.applyDelta(
        delta({ added: [deltaNode({ txhash: 'd'.repeat(64), ip: '10.0.0.4', pubkey: 'pub-d' })] }),
        resolveAdded,
      );

      const node = await manager.search('10.0.0.4', 'socketAddress');
      expect(node.added_height).to.equal(1500);
      expect(node.payment_address).to.equal('t1d');
      expect(manager.nodeCount).to.equal(2);
    });

    it('should not call the resolver when there is nothing to add', async () => {
      await seed([rpcNode()]);
      const resolveAdded = sinon.stub().resolves([]);

      await manager.applyDelta(delta({ updated: [deltaNode()] }), resolveAdded);

      sinon.assert.notCalled(resolveAdded);
    });

    it('should refuse the whole delta when an added node cannot be resolved', async () => {
      await seed([rpcNode()]);
      const resolveAdded = sinon.stub().resolves([]);

      const result = await manager.applyDelta(
        delta({
          added: [deltaNode({ txhash: 'd'.repeat(64) })],
          removed: [{ txid: 'a'.repeat(64), index: 0 }],
        }),
        resolveAdded,
      );

      expect(result.applied).to.equal(false);
      expect(result.reason).to.match(/resolved 0 of 1/);
      // and nothing was half applied
      expect(manager.nodeCount).to.equal(1);
      expect(manager.chainAnchor.height).to.equal(2000);
    });

    it('should not double insert a node it already holds', async () => {
      await seed([rpcNode()]);
      const resolveAdded = sinon.stub().resolves([rpcNode()]);

      await manager.applyDelta(delta({ added: [deltaNode()] }), resolveAdded);

      expect(manager.nodeCount).to.equal(1);
    });
  });

  describe('combined application tests', () => {
    it('should apply removals, updates and adds in one delta', async () => {
      await seed([
        rpcNode(),
        rpcNode({ txhash: 'b'.repeat(64), ip: '10.0.0.2', pubkey: 'pub-b' }),
      ]);
      const resolveAdded = sinon.stub().resolves([
        rpcNode({ txhash: 'e'.repeat(64), ip: '10.0.0.5', pubkey: 'pub-e' }),
      ]);

      const result = await manager.applyDelta(
        delta({
          removed: [{ txid: 'a'.repeat(64), index: 0 }],
          updated: [deltaNode({ txhash: 'b'.repeat(64), ip: '10.0.0.2', pubkey: 'pub-b', lastPaidHeight: 2001 })],
          added: [deltaNode({ txhash: 'e'.repeat(64), ip: '10.0.0.5', pubkey: 'pub-e' })],
        }),
        resolveAdded,
      );

      expect(result.applied).to.equal(true);
      expect(manager.nodeCount).to.equal(2);
      expect(await manager.search('10.0.0.1', 'socketAddress')).to.equal(null);
      expect((await manager.search('10.0.0.2', 'socketAddress')).last_paid_height).to.equal(2001);
      expect(await manager.search('10.0.0.5', 'socketAddress')).to.not.equal(null);
    });

    it('should emit updated so subscribers refresh', async () => {
      await seed([rpcNode()]);
      const listener = sinon.stub();
      manager.on('updated', listener);

      await manager.applyDelta(delta({ updated: [deltaNode()] }), sinon.stub());

      sinon.assert.calledOnce(listener);
    });

    it('should leave the node count consistent with the index after many deltas', async () => {
      await seed([rpcNode()]);
      let fromHash = 'f'.repeat(64);

      for (let i = 1; i <= 20; i += 1) {
        const txhash = String(i).padStart(64, '0');
        const toHash = String(i).padStart(64, 'c');
        const resolveAdded = sinon.stub().resolves([
          rpcNode({ txhash, ip: `10.1.0.${i}`, pubkey: `pub-${i}` }),
        ]);

        // eslint-disable-next-line no-await-in-loop
        await manager.applyDelta(
          delta({
            fromHeight: 2000 + i - 1,
            toHeight: 2000 + i,
            fromHash,
            toHash,
            added: [deltaNode({ txhash, ip: `10.1.0.${i}`, pubkey: `pub-${i}` })],
          }),
          resolveAdded,
        );

        fromHash = toHash;
      }

      expect(manager.nodeCount).to.equal(21);
      expect(await manager.search('10.1.0.20', 'socketAddress')).to.not.equal(null);
      expect(await manager.search('pub-20', 'pubkey')).to.not.equal(null);
    });
  });
});
