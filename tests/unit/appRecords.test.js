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
    expect(appRecords.STORES.installedLedgers).to.deep.equal({
      database: config.get('database.appslocal.database'),
      collection: config.get('database.appslocal.collections.installedLedgers'),
    });
  });

  it('builds the registry, the installed apps and the installed ledgers once each, over the storage adapter', () => {
    const { AppRegistry, InstalledApps, InstalledLedgers } = specLibrary.loaded();
    expect(appRecords.registry()).to.be.instanceOf(AppRegistry);
    expect(appRecords.registry()).to.equal(appRecords.registry());
    expect(appRecords.installed()).to.be.instanceOf(InstalledApps);
    expect(appRecords.installed()).to.equal(appRecords.installed());
    expect(appRecords.ledgers()).to.be.instanceOf(InstalledLedgers);
    expect(appRecords.ledgers()).to.equal(appRecords.ledgers());
  });

  it('keys an installed record and its ledger alike: by the name in any letter case and the replica', () => {
    expect(appRecords.instanceKey({ name: 'Consumer', replica: null })).to.equal(appRecords.instanceKey({ name: 'consumer' }));
    expect(appRecords.instanceKey({ name: 'consumer', replica: 'r1' })).to.not.equal(appRecords.instanceKey({ name: 'consumer', replica: null }));
    expect(appRecords.instanceKey({ name: 'consumer', replica: 'r1' })).to.not.equal(appRecords.instanceKey({ name: 'consumerr1', replica: null }));
  });
});
