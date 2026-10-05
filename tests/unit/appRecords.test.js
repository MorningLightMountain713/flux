'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const config = require('config');

const appRecords = require('../../ZelBack/src/services/appDatabase/appRecords');
const specLibrary = require('../../ZelBack/src/services/utils/specLibrary');

describe('appRecords', () => {
  it('names each collection\'s store from the node\'s configuration', () => {
    expect(appRecords.STORES.appSpecs).to.deep.equal({
      database: config.get('database.appsglobal.database'),
      collection: config.get('database.appsglobal.collections.appsInformation'),
    });
    expect(appRecords.STORES.installedApps).to.deep.equal({
      database: config.get('database.appslocal.database'),
      collection: config.get('database.appslocal.collections.appsInformation'),
    });
  });

  it('builds the registry and the installed apps once each, over the storage adapter', () => {
    const { AppRegistry, InstalledApps } = specLibrary.loaded();
    expect(appRecords.registry()).to.be.instanceOf(AppRegistry);
    expect(appRecords.registry()).to.equal(appRecords.registry());
    expect(appRecords.installed()).to.be.instanceOf(InstalledApps);
    expect(appRecords.installed()).to.equal(appRecords.installed());
  });
});
