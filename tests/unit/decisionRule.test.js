'use strict';

const { expect } = require('chai');

const { decideName } = require('../../ZelBack/src/services/appDecisions/decisionRule');

const OWNER = '1OwnerAddress';
const BUYER = '1BuyerAddress';

// A legacy-shaped spec: its term is `lifetime` blocks from the height it stands at.
function legacySpec({ version = 8, owner = OWNER, lifetime = 1000 } = {}) {
  return {
    version,
    name: 'MyApp',
    owner,
    isExpired: (state, clock) => clock.currentHeight >= state.height + lifetime,
  };
}

// A v9-shaped spec: its term is `ttl` seconds from its term start, in block time.
function v9Spec({ owner = OWNER, ttl = 3600 } = {}) {
  return {
    version: 9,
    name: 'MyApp',
    owner,
    isExpired: (state, clock) => {
      if (!Number.isFinite(state.registeredAt) || !Number.isFinite(clock.tipBlockTime)) {
        throw new Error('a v9 term needs block times');
      }
      return state.registeredAt + ttl < clock.tipBlockTime;
    },
  };
}

let nextTimestamp = 1;
function entry({
  hash, type = 'registration', height, txIndex = 0, valueSat = 100, spec = legacySpec(),
  signers = [OWNER], blockTime = height * 10, timestamp = nextTimestamp++,
}) {
  return {
    hash,
    type,
    timestamp,
    record: {
      txid: `tx-${hash}`, height, txIndex, valueSat, blockTime,
    },
    spec,
    event: spec ? { hash } : null,
    contentHash: null,
    signers,
    decision: null,
  };
}

function makeJudge(overrides = {}) {
  const calls = { blockTime: [], updateFee: [], recentEvents: [] };
  const judge = {
    activationHeight: (version) => ({ 7: 0, 8: 0, 9: 0 })[version],
    registrationFee: async () => 10n,
    updateFee: async (spec, prevSpec, ctx) => {
      calls.updateFee.push(ctx);
      return 10n;
    },
    entitlementRefusal: async () => null,
    authorized: async (e, { previousState }) => e.signers.includes(previousState.owner),
    assertCompatible: (prevSpec, spec) => {
      if (spec.version < prevSpec.version) throw new Error('lower version');
    },
    mintUuid: (name, txid) => `uuid-${name}-${txid}`,
    identityFor: (spec, uuid) => (spec.version >= 9 ? uuid.slice(0, 12) : spec.name),
    blockTime: async (e) => {
      calls.blockTime.push(e.hash);
      return e.record.height * 10;
    },
    isValidationError: (error) => error.name === 'ValidationError',
    ...overrides,
  };
  return { judge, calls };
}

async function decide(entries, judge = makeJudge().judge, from = 0) {
  return decideName({
    name: 'myapp', entries, from, judge,
  });
}

const verdicts = (result) => result.decisions.map((d) => (d.decision === 'applied' ? 'applied' : d.reason));

describe('decisionRule', () => {
  describe('a registration', () => {
    it('is applied with a uuid minted from its name and transaction, and its term starting at its block', async () => {
      const result = await decide([entry({ hash: 'r', height: 100 })]);
      const [d] = result.decisions;
      expect(d).to.include({
        hash: 'r', name: 'myapp', decision: 'applied', uuid: 'uuid-MyApp-tx-r', identity: 'MyApp', termStart: 1000, fee: '10', ruleVersion: 1,
      });
      expect(result.blocked).to.equal(null);
    });

    it('takes a v9 identity from its uuid', async () => {
      const [d] = (await decide([entry({ hash: 'r', height: 100, spec: v9Spec() })])).decisions;
      expect(d.identity).to.equal('uuid-MyApp-t');
    });

    it('is refused while the name is held by a live app, and applied once that app has expired', async () => {
      const result = await decide([
        entry({ hash: 'first', height: 100 }),
        entry({ hash: 'held', height: 500 }),
        entry({ hash: 'after', height: 1100 }),
      ]);
      expect(verdicts(result)).to.deep.equal(['applied', 'name-held', 'applied']);
      expect(result.decisions[2].uuid).to.equal('uuid-MyApp-tx-after');
    });

    it('is refused when it pays less than the fee, or no fee is in force', async () => {
      expect(verdicts(await decide([entry({ hash: 'r', height: 100, valueSat: 9 })]))).to.deep.equal(['underpaid']);
      const { judge } = makeJudge({ registrationFee: async () => 0n });
      expect(verdicts(await decide([entry({ hash: 'r', height: 100 })], judge))).to.deep.equal(['pricing-unavailable']);
    });

    it('is refused when its owner is not entitled to its features', async () => {
      const { judge } = makeJudge({ entitlementRefusal: async () => 'fluxid not entitled to use: mesh' });
      expect(verdicts(await decide([entry({ hash: 'r', height: 100 })], judge))).to.deep.equal(['not-entitled']);
    });

    it('is refused when its spec does not parse, or its version is not active at its height', async () => {
      expect(verdicts(await decide([entry({ hash: 'r', height: 100, spec: null })]))).to.deep.equal(['invalid']);
      const { judge } = makeJudge({ activationHeight: () => 200 });
      expect(verdicts(await decide([entry({ hash: 'r', height: 100 })], judge))).to.deep.equal(['not-activated']);
    });
  });

  describe('an update', () => {
    it('carries its registration\'s uuid and identity, and starts a new term when it paid for one', async () => {
      const result = await decide([
        entry({ hash: 'r', height: 100 }),
        entry({ hash: 'u', type: 'update', height: 200 }),
      ]);
      const [, d] = result.decisions;
      expect(d).to.include({
        decision: 'applied', uuid: 'uuid-MyApp-tx-r', identity: 'MyApp', termStart: 2000,
      });
    });

    it('keeps the term it supersedes when it was free', async () => {
      const { judge } = makeJudge({ updateFee: async () => 0n });
      const result = await decide([
        entry({ hash: 'r', height: 100, spec: v9Spec() }),
        entry({ hash: 'u', type: 'update', height: 200, spec: v9Spec() }),
      ], judge);
      expect(result.decisions[1]).to.include({ decision: 'applied', termStart: 1000, fee: '0' });
    });

    it('is refused with nothing to update when it comes before its registration, in the same block', async () => {
      const result = await decide([
        entry({ hash: 'u', type: 'update', height: 100, txIndex: 1 }),
        entry({ hash: 'r', height: 100, txIndex: 2 }),
      ]);
      expect(verdicts(result)).to.deep.equal(['nothing-to-update', 'applied']);
    });

    it('is judged against the owner its predecessor names, so a transfer binds the updates after it', async () => {
      // Two updates in one block: the first hands the app to BUYER, the second is
      // signed by the old owner. In chain order the second is unauthorized.
      const result = await decide([
        entry({ hash: 'r', height: 100 }),
        entry({
          hash: 'transfer', type: 'update', height: 200, txIndex: 1, spec: legacySpec({ owner: BUYER }),
        }),
        entry({
          hash: 'late', type: 'update', height: 200, txIndex: 2, spec: legacySpec({ owner: OWNER }), signers: [OWNER],
        }),
      ]);
      expect(verdicts(result)).to.deep.equal(['applied', 'applied', 'unauthorized']);
    });

    it('is judged against an expired predecessor, so a renewal after expiry is decided and not dropped', async () => {
      const result = await decide([
        entry({ hash: 'r', height: 100 }),
        entry({ hash: 'renewal', type: 'update', height: 5000 }),
      ]);
      expect(verdicts(result)).to.deep.equal(['applied', 'applied']);
    });

    it('is refused when it is not compatible with its predecessor', async () => {
      const result = await decide([
        entry({ hash: 'r', height: 100 }),
        entry({
          hash: 'down', type: 'update', height: 200, spec: legacySpec({ version: 7 }),
        }),
      ]);
      expect(verdicts(result)).to.deep.equal(['applied', 'incompatible']);
    });

    it('is refused when it underpays, or asks for nothing with its free updates spent', async () => {
      expect(verdicts(await decide([
        entry({ hash: 'r', height: 100 }),
        entry({ hash: 'u', type: 'update', height: 200, valueSat: 9 }),
      ]))).to.deep.equal(['applied', 'underpaid']);

      const { judge } = makeJudge({ updateFee: async () => null });
      expect(verdicts(await decide([
        entry({ hash: 'r', height: 100 }),
        entry({ hash: 'u', type: 'update', height: 200 }),
      ], judge))).to.deep.equal(['applied', 'free-allowance-spent']);
    });

    it('is priced against its predecessor\'s position and term start, at its own block', async () => {
      const { judge, calls } = makeJudge();
      await decide([
        entry({ hash: 'r', height: 100, spec: v9Spec() }),
        entry({ hash: 'u', type: 'update', height: 200, spec: v9Spec() }),
      ], judge);
      expect(calls.updateFee[0]).to.include({
        height: 200, prevHeight: 100, prevRegisteredAt: 1000, nowBlockTime: 2000,
      });
    });

    it('counts only the applied updates before it for the free-update limit, at their block times', async () => {
      let events = null;
      const { judge } = makeJudge({
        updateFee: async (spec, prevSpec, ctx) => {
          if (ctx.height === 400) events = await ctx.recentEvents();
          return ctx.height === 300 ? null : 10n;
        },
      });
      await decide([
        entry({ hash: 'r', height: 100 }),
        entry({ hash: 'u1', type: 'update', height: 200 }),
        entry({ hash: 'refusedU', type: 'update', height: 300 }),
        entry({ hash: 'u2', type: 'update', height: 400 }),
        entry({ hash: 'later', type: 'update', height: 500 }),
      ], judge);
      expect(events).to.deep.equal([{ type: 'fluxappupdate', timestamp: 2_000_000 }]);
    });
  });

  it('refuses a message carrying the signed timestamp of an earlier one for the name as a replay', async () => {
    const result = await decide([
      entry({ hash: 'r', height: 100, timestamp: 7 }),
      entry({ hash: 'u', type: 'update', height: 200, timestamp: 8 }),
      entry({
        hash: 'replay', type: 'update', height: 300, timestamp: 7,
      }),
    ]);
    expect(verdicts(result)).to.deep.equal(['applied', 'applied', 'replayed']);
  });

  it('refuses a replay of a refused message too', async () => {
    const result = await decide([
      entry({ hash: 'u', type: 'update', height: 50, timestamp: 9 }),
      entry({ hash: 'r', height: 100 }),
      entry({ hash: 'replay', type: 'update', height: 200, timestamp: 9 }),
    ]);
    expect(verdicts(result)).to.deep.equal(['nothing-to-update', 'applied', 'replayed']);
  });

  describe('a rule this node cannot evaluate', () => {
    it('stops the walk before the message, leaving it and every later one undecided', async () => {
      const failure = new Error('price history not in force');
      const { judge } = makeJudge({
        updateFee: async (spec, prevSpec, ctx) => {
          if (ctx.height === 200) throw failure;
          return 10n;
        },
      });
      const result = await decide([
        entry({ hash: 'r', height: 100 }),
        entry({ hash: 'u', type: 'update', height: 200 }),
        entry({ hash: 'later', type: 'update', height: 300 }),
      ], judge);
      expect(verdicts(result)).to.deep.equal(['applied']);
      expect(result.blocked).to.deep.equal({ hash: 'u', error: failure });
    });

    it('is not a spec the pricer rejects, which is refused as invalid and the walk goes on', async () => {
      const invalid = Object.assign(new Error('bad spec'), { name: 'ValidationError' });
      const { judge } = makeJudge({
        updateFee: async (spec, prevSpec, ctx) => {
          if (ctx.height === 200) throw invalid;
          return 10n;
        },
      });
      const result = await decide([
        entry({ hash: 'r', height: 100 }),
        entry({ hash: 'u', type: 'update', height: 200 }),
        entry({ hash: 'next', type: 'update', height: 300 }),
      ], judge);
      expect(verdicts(result)).to.deep.equal(['applied', 'invalid', 'applied']);
    });
  });

  it('decides from a position using the decisions before it, and rewrites none of them', async () => {
    const earlier = { ...entry({ hash: 'r', height: 100 }) };
    earlier.decision = {
      decision: 'applied', uuid: 'kept-uuid', identity: 'MyApp', termStart: 1000,
    };
    const result = await decide([earlier, entry({ hash: 'u', type: 'update', height: 200 })], makeJudge().judge, 1);
    expect(result.decisions.map((d) => d.hash)).to.deep.equal(['u']);
    expect(result.decisions[0].uuid).to.equal('kept-uuid');
  });

  describe('block times', () => {
    it('asks for none on a legacy term: a record without one decides by height', async () => {
      const { judge, calls } = makeJudge();
      const result = await decide([
        entry({ hash: 'r', height: 100, blockTime: null }),
        entry({
          hash: 'u', type: 'update', height: 200, blockTime: null,
        }),
        entry({ hash: 'held', height: 300, blockTime: null }),
      ], judge);
      expect(verdicts(result)).to.deep.equal(['applied', 'applied', 'name-held']);
      expect(result.decisions[0].termStart).to.equal(null);
      expect(calls.blockTime).to.deep.equal([]);
    });

    it('asks for one where a v9 term is measured against a record without it', async () => {
      const { judge, calls } = makeJudge();
      const result = await decide([
        entry({ hash: 'r', height: 100, spec: v9Spec({ ttl: 5000 }) }),
        entry({ hash: 'held', height: 200, blockTime: null }),
      ], judge);
      expect(verdicts(result)).to.deep.equal(['applied', 'name-held']);
      expect(calls.blockTime).to.deep.equal(['held']);
    });
  });
});
