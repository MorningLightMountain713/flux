const { expect } = require('chai');
const { appNameFromIdentifier, componentNameFromIdentifier } = require('../../ZelBack/src/services/utils/componentIdentifier');

describe('componentIdentifier', () => {
  describe('appNameFromIdentifier', () => {
    it('returns the app name from a v4+ component identifier', () => {
      expect(appNameFromIdentifier('web_myapp')).to.equal('myapp');
    });

    it('returns the identifier itself for a v1-3 flat app (no separator)', () => {
      expect(appNameFromIdentifier('myapp')).to.equal('myapp');
    });

    it('takes the LAST underscore, so a legacy underscored component name resolves correctly', () => {
      expect(appNameFromIdentifier('pg_main_myapp')).to.equal('myapp');
    });

    it('handles a hyphenated app name', () => {
      expect(appNameFromIdentifier('web_my-app')).to.equal('my-app');
    });
  });

  describe('componentNameFromIdentifier', () => {
    it('returns the component name from a v4+ component identifier', () => {
      expect(componentNameFromIdentifier('web_myapp')).to.equal('web');
    });

    it('returns the identifier itself for a v1-3 flat app (component is the app)', () => {
      expect(componentNameFromIdentifier('myapp')).to.equal('myapp');
    });

    it('keeps an underscored component name intact (everything before the last underscore)', () => {
      expect(componentNameFromIdentifier('pg_main_myapp')).to.equal('pg_main');
    });
  });
});
