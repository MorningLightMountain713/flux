'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');

const seam = require('../../ZelBack/src/services/appMesh/ordinalRegisterSeam');

// The mesh's window onto the ordinal registers: the grant plane registers
// its provider at wiring; until then every answer is the fail-closed one,
// so the mesh can never found, release or name on an unwired plane.
describe('ordinalRegisterSeam', () => {
  afterEach(() => {
    seam.resetForTests();
    sinon.restore();
  });

  it('unwired, every answer is the closed one: probe undecided, ask waits, release refused, no holders', async () => {
    expect(await seam.probeOrdinal('app', 0)).to.deep.equal({ decided: false, holder: null });
    expect(await seam.askOrdinal('app', 0)).to.deep.equal({ answer: 'wait', reason: 'unwired' });
    expect(await seam.releaseOrdinal('app', 0)).to.deep.equal({ released: false, reason: 'unwired' });
    expect(await seam.ordinalHolders('app')).to.deep.equal(new Map());
    expect(await seam.vacateOrdinal('app', 0, 'x:0')).to.deep.equal({ vacated: false, reason: 'unwired' });
  });

  it('a registered provider answers through the seam, argument for argument', async () => {
    const provider = {
      probeOrdinal: sinon.stub().resolves({ decided: true, holder: 'x:0' }),
      askOrdinal: sinon.stub().resolves({ answer: 'no', holder: 'x:0' }),
      releaseOrdinal: sinon.stub().resolves({ released: true }),
      ordinalHolders: sinon.stub().resolves(new Map([[0, 'x:0']])),
      vacateOrdinal: sinon.stub().resolves({ vacated: true }),
    };
    seam.registerProvider(provider);
    expect(await seam.probeOrdinal('app', 2)).to.deep.equal({ decided: true, holder: 'x:0' });
    expect(await seam.askOrdinal('app', 2)).to.deep.equal({ answer: 'no', holder: 'x:0' });
    expect(await seam.releaseOrdinal('app', 2)).to.deep.equal({ released: true });
    expect(await seam.ordinalHolders('app')).to.deep.equal(new Map([[0, 'x:0']]));
    expect(provider.probeOrdinal.args).to.deep.equal([['app', 2]]);
    expect(provider.askOrdinal.args).to.deep.equal([['app', 2]]);
    expect(provider.releaseOrdinal.args).to.deep.equal([['app', 2]]);
    expect(provider.ordinalHolders.args).to.deep.equal([['app']]);
    expect(await seam.vacateOrdinal('app', 2, 'x:0')).to.deep.equal({ vacated: true });
    expect(provider.vacateOrdinal.args).to.deep.equal([['app', 2, 'x:0']]);
  });

  it('a partial provider is refused whole — it would fail open at the call it lacks', () => {
    expect(() => seam.registerProvider({ probeOrdinal: async () => ({}) }))
      .to.throw(/missing askOrdinal/);
    expect(seam.registered()).to.equal(false);
    const fourOfFive = {
      probeOrdinal: async () => ({}), askOrdinal: async () => ({}), releaseOrdinal: async () => ({}), ordinalHolders: async () => new Map(),
    };
    expect(() => seam.registerProvider(fourOfFive)).to.throw(/missing vacateOrdinal/);
    expect(seam.registered()).to.equal(false);
  });
});
