'use strict';

const { expect } = require('chai');

const { isMarketplaceApp } = require('../../ZelBack/src/services/utils/marketplaceApps');

describe('marketplaceApps', () => {
  describe('isMarketplaceApp', () => {
    it('returns true for an app name containing a post-2020 epoch timestamp', () => {
      expect(isMarketplaceApp('wordpress1735018430692')).to.be.true;
    });

    it('returns false for a name containing only low integers', () => {
      expect(isMarketplaceApp('app42v2')).to.be.false;
    });

    it('returns false for a name with no digits at all', () => {
      expect(isMarketplaceApp('wordpress')).to.be.false;
    });

    it('returns false for undefined or empty input', () => {
      expect(isMarketplaceApp(null)).to.be.false;
      expect(isMarketplaceApp('')).to.be.false;
    });
  });
});
