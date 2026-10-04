'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();

describe('specLibrary', () => {
  // A fresh copy, so its state is its own: the suite's root hook has already
  // loaded the shared one.
  function fresh(namespace) {
    return proxyquire('../../ZelBack/src/services/utils/specLibrary', {
      '@runonflux/flux-spec-cjs': { load: async () => namespace },
    });
  }

  it('refuses to answer before the process has loaded flux-spec', () => {
    const specLibrary = fresh({ canonicalNodeAddress: () => 'x' });
    expect(() => specLibrary.loaded()).to.throw(/not loaded yet/);
  });

  it('answers synchronously, with what it loaded, once loaded', async () => {
    const namespace = Object.freeze({ canonicalNodeAddress: () => 'x' });
    const specLibrary = fresh(namespace);

    expect(await specLibrary.loadSpecLibrary()).to.equal(namespace);
    expect(specLibrary.loaded()).to.equal(namespace);
  });
});
