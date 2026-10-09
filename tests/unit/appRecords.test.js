'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const config = require('config');

const appRecords = require('../../ZelBack/src/services/appDatabase/appRecords');
const specLibrary = require('../../ZelBack/src/services/utils/specLibrary');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { requireMongo } = require('./dbTestHelper');
const { v9Spec, instantiatedSpec } = require('./fixtures/fluxSpec');

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
    expect(appRecords.STORES.contentManifests).to.deep.equal({
      database: config.get('database.appsglobal.database'),
      collection: config.get('database.appsglobal.collections.appContentManifests'),
    });
  });

  it('builds the registry, the installed apps, the installed ledgers and the content manifests once each, over the storage adapter', () => {
    const {
      AppRegistry, InstalledApps, InstalledLedgers, ContentManifests,
    } = specLibrary.loaded();
    expect(appRecords.registry()).to.be.instanceOf(AppRegistry);
    expect(appRecords.registry()).to.equal(appRecords.registry());
    expect(appRecords.installed()).to.be.instanceOf(InstalledApps);
    expect(appRecords.installed()).to.equal(appRecords.installed());
    expect(appRecords.ledgers()).to.be.instanceOf(InstalledLedgers);
    expect(appRecords.ledgers()).to.equal(appRecords.ledgers());
    expect(appRecords.manifests()).to.be.instanceOf(ContentManifests);
    expect(appRecords.manifests()).to.equal(appRecords.manifests());
  });

  // Over the unit Mongo: the join reads both collections through their own
  // operations, so a stub on the module's exports cannot stand in for it.
  describe('the installed record of a container', () => {
    before(requireMongo);

    beforeEach(async () => {
      await dbHelper.initiateDB();
      const db = dbHelper.databaseConnection().db(config.get('database.appslocal.database'));
      for (const store of ['installedApps', 'installedLedgers']) {
        // eslint-disable-next-line no-await-in-loop
        await db.collection(appRecords.STORES[store].collection).deleteMany({});
      }
    });

    it('is found through the ledger that names the container, owed or not, and is null when no ledger names it', async () => {
      const { InstalledSpec, InstalledLedger } = specLibrary.loaded();
      const record = await instantiatedSpec(await v9Spec({ name: 'joined' }), { identity: 'idjoined' });
      await appRecords.installed().put(new InstalledSpec({ record, replica: 'r1' }));
      await appRecords.ledgers().put(new InstalledLedger({
        name: 'joined', replica: 'r1', components: { web: InstalledLedger.newBlock({ identifier: 'web_idjoined_r1', image: 'nginx' }) },
      }));

      // A record whose name is a container's identifier is not that container's.
      await appRecords.installed().put(new InstalledSpec({ record: await instantiatedSpec(await v9Spec({ name: 'nobodyx' })) }));

      const found = await appRecords.installedByIdentifier('web_idjoined_r1');
      expect(found.name).to.equal('joined');
      expect(found.replica).to.equal('r1');
      expect(await appRecords.installedByIdentifier('nobodyx')).to.equal(null);

      await appRecords.installed().markOwed('joined', 'r1', { since: 1, reason: 'expired', force: false, broadcast: true });
      expect((await appRecords.installedByIdentifier('web_idjoined_r1')).owed.reason, 'a container being removed still has its record').to.equal('expired');
    });
  });

  it('keys an installed record and its ledger alike: by the name in any letter case and the replica', () => {
    expect(appRecords.instanceKey({ name: 'Consumer', replica: null })).to.equal(appRecords.instanceKey({ name: 'consumer' }));
    expect(appRecords.instanceKey({ name: 'consumer', replica: 'r1' })).to.not.equal(appRecords.instanceKey({ name: 'consumer', replica: null }));
    expect(appRecords.instanceKey({ name: 'consumer', replica: 'r1' })).to.not.equal(appRecords.instanceKey({ name: 'consumerr1', replica: null }));
  });
});
