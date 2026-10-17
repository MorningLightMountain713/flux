'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const config = require('config');

const appRecords = require('../../ZelBack/src/services/appDatabase/appRecords');
const specLibrary = require('../../ZelBack/src/services/utils/specLibrary');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { requireMongo } = require('./dbTestHelper');
const { v9Spec, registeredSpec } = require('./fixtures/fluxSpec');

describe('appRecords', () => {
  it('names each collection\'s store from the node\'s configuration', () => {
    expect(appRecords.STORES.appSpecs).to.deep.equal({
      database: config.get('database.appsglobal.database'),
      collection: config.get('database.appsglobal.collections.appsInformation'),
    });
    expect(appRecords.STORES.hostedInstances).to.deep.equal({
      database: config.get('database.appslocal.database'),
      collection: config.get('database.appslocal.collections.appsInformation'),
    });
    expect(appRecords.STORES.instanceResources).to.deep.equal({
      database: config.get('database.appslocal.database'),
      collection: config.get('database.appslocal.collections.instanceResources'),
    });
    expect(appRecords.STORES.contentManifests).to.deep.equal({
      database: config.get('database.appsglobal.database'),
      collection: config.get('database.appsglobal.collections.appContentManifests'),
    });
  });

  it('builds the registry, the installed apps, the installed instanceResources and the content manifests once each, over the storage adapter', () => {
    const {
      AppRegistry, HostedInstances, InstanceResourceStore, ContentManifests,
    } = specLibrary.loaded();
    expect(appRecords.registry()).to.be.instanceOf(AppRegistry);
    expect(appRecords.registry()).to.equal(appRecords.registry());
    expect(appRecords.hostedInstances()).to.be.instanceOf(HostedInstances);
    expect(appRecords.hostedInstances()).to.equal(appRecords.hostedInstances());
    expect(appRecords.instanceResources()).to.be.instanceOf(InstanceResourceStore);
    expect(appRecords.instanceResources()).to.equal(appRecords.instanceResources());
    expect(appRecords.manifests()).to.be.instanceOf(ContentManifests);
    expect(appRecords.manifests()).to.equal(appRecords.manifests());
  });

  // Over the unit Mongo: the join reads both collections through their own
  // operations, so a stub on the module's exports cannot stand in for it.
  describe('the hosted instance of a container', () => {
    before(requireMongo);

    beforeEach(async () => {
      await dbHelper.initiateDB();
      const db = dbHelper.databaseConnection().db(config.get('database.appslocal.database'));
      for (const store of ['hostedInstances', 'instanceResources']) {
        // eslint-disable-next-line no-await-in-loop
        await db.collection(appRecords.STORES[store].collection).deleteMany({});
      }
    });

    it('is found through the resources that name the container, owed or not, and is null when no resources name it', async () => {
      const { HostedInstance, InstanceResources } = specLibrary.loaded();
      const record = await registeredSpec(await v9Spec({ name: 'joined' }), { identity: 'idjoined' });
      await appRecords.hostedInstances().put(new HostedInstance({ record, replica: 'r1' }));
      await appRecords.instanceResources().put(new InstanceResources({
        name: 'joined', replica: 'r1', components: { web: InstanceResources.newBlock({ identifier: 'web_idjoined_r1', image: 'nginx' }) },
      }));

      // A record whose name is a container's identifier is not that container's.
      await appRecords.hostedInstances().put(new HostedInstance({ record: await registeredSpec(await v9Spec({ name: 'nobodyx' })) }));

      const found = await appRecords.hostedInstanceByIdentifier('web_idjoined_r1');
      expect(found.name).to.equal('joined');
      expect(found.replica).to.equal('r1');
      expect(await appRecords.hostedInstanceByIdentifier('nobodyx')).to.equal(null);

      await appRecords.hostedInstances().markOwed('joined', 'r1', { since: 1, reason: 'expired', force: false, broadcast: true });
      expect((await appRecords.hostedInstanceByIdentifier('web_idjoined_r1')).owed.reason, 'a container being removed still has its record').to.equal('expired');
    });
  });

  it('keys a hosted instance and its resources alike: by the name in any letter case and the replica', () => {
    expect(appRecords.instanceKey({ name: 'Consumer', replica: null })).to.equal(appRecords.instanceKey({ name: 'consumer' }));
    expect(appRecords.instanceKey({ name: 'consumer', replica: 'r1' })).to.not.equal(appRecords.instanceKey({ name: 'consumer', replica: null }));
    expect(appRecords.instanceKey({ name: 'consumer', replica: 'r1' })).to.not.equal(appRecords.instanceKey({ name: 'consumerr1', replica: null }));
  });
});
