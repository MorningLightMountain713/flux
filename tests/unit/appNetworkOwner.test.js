'use strict';

const { expect } = require('chai');
const { appNetworkOwner } = require('../../ZelBack/src/services/utils/appNetworkOwner');

describe('appNetworkOwner tests', () => {
  describe('appNetworkOwner', () => {
    // The schema is the caller's to resolve, so the function stays pure and
    // synchronously testable rather than reaching for it.
    const labelKeys = { APP_NETWORK: 'io.runonflux.app-network' };

    it('reads the ownership label when one is stamped', () => {
      const owner = appNetworkOwner({
        Name: 'fluxDockerNetwork_myapp', Labels: { 'io.runonflux.app-network': 'myapp' },
      }, labelKeys);

      expect(owner).to.equal('myapp');
    });

    it('falls back to the name for a pre-label network', () => {
      // The whole estate is unlabelled until each network is recreated, so the
      // name convention has to carry ownership for them.
      const owner = appNetworkOwner({ Name: 'fluxDockerNetwork_legacyapp' }, labelKeys);

      expect(owner).to.equal('legacyapp');
    });

    it('prefers the label over the name when they disagree', () => {
      const owner = appNetworkOwner({
        Name: 'fluxDockerNetwork_stalename', Labels: { 'io.runonflux.app-network': 'realowner' },
      }, labelKeys);

      expect(owner).to.equal('realowner');
    });

    it('returns null for a network it cannot attribute', () => {
      expect(appNetworkOwner({ Name: 'bridge' }, labelKeys)).to.equal(null);
      expect(appNetworkOwner({ Name: 'fluxDockerNetwork_' }, labelKeys)).to.equal(null);
    });
  });
});
