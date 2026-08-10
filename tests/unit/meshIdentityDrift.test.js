'use strict';

const { expect } = require('chai');
const meshIdentityDrift = require('../../ZelBack/src/services/appMesh/meshIdentityDrift');

describe('meshIdentityDrift', () => {
  afterEach(() => meshIdentityDrift.reset());

  const drift = (wants = 'web-1') => ({ component: 'web', is: 'web-aaaa1111', wants });

  it('serves a drift only after two consecutive passes agree', () => {
    const first = meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift()]]));
    expect(first).to.deep.equal([]);
    expect(meshIdentityDrift.driftFor('web_app')).to.equal(null);

    const second = meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift()]]));
    expect(second).to.deep.equal(['web_app']);
    expect(meshIdentityDrift.driftFor('web_app')).to.deep.include({ wants: 'web-1' });
  });

  it('reports an identifier as newly stable exactly once', () => {
    meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift()]]));
    meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift()]]));
    const third = meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift()]]));
    expect(third).to.deep.equal([]);
    expect(meshIdentityDrift.driftFor('web_app')).to.not.equal(null);
  });

  it('a drift that changes its mind restarts confirmation', () => {
    meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift('web-1')]]));
    meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift('web-2')]]));
    expect(meshIdentityDrift.driftFor('web_app')).to.equal(null);
    const confirm = meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift('web-2')]]));
    expect(confirm).to.deep.equal(['web_app']);
  });

  it('a resolved or departed drift drops out on the next pass', () => {
    meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift()]]));
    meshIdentityDrift.recordPassDrifts(new Map([['web_app', drift()]]));
    meshIdentityDrift.recordPassDrifts(new Map());
    expect(meshIdentityDrift.driftFor('web_app')).to.equal(null);
  });
});
