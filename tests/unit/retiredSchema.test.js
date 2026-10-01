'use strict';

const { expect } = require('chai');
const config = require('config');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');
const retiredSchema = require('../../ZelBack/src/services/migrations/retiredSchema');

const ERRORS_LOCATIONS = config.get('database.appsglobal.collections.appsInstallingErrorsLocations');
const ERRORS_BROADCASTS = config.get('database.appsglobal.collections.appsInstallingErrorsBroadcasts');
const CONTENT_MANIFESTS = config.get('database.appsglobal.collections.appContentManifests');
const TEMP_MESSAGES = config.get('database.appsglobal.collections.appsTemporaryMessages');

describe('retiredSchema', () => {
  let collectionsPresent;
  let indexesOf;
  let droppedCollections;
  let droppedIndexes;

  beforeEach(() => {
    collectionsPresent = new Set();
    indexesOf = {};
    droppedCollections = [];
    droppedIndexes = [];
    const dbFor = () => ({
      listCollections: ({ name }) => ({ toArray: async () => (collectionsPresent.has(name) ? [{ name }] : []) }),
      collection: (name) => ({
        collectionName: name,
        drop: async () => { droppedCollections.push(name); },
        indexes: async () => {
          if (!indexesOf[name]) {
            const error = new Error('ns does not exist');
            error.codeName = 'NamespaceNotFound';
            throw error;
          }
          return indexesOf[name];
        },
        dropIndex: async (index) => { droppedIndexes.push(`${name}.${index}`); },
      }),
    });
    sinon.stub(dbHelper, 'databaseConnection').returns({ db: dbFor });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('drops nothing on a node that holds none of the retired schema', async () => {
    indexesOf[ERRORS_BROADCASTS] = [{ name: '_id_' }, { name: 'broadcastedAt_1', key: { broadcastedAt: 1 } }];

    const dropped = await retiredSchema.dropRetiredSchema();

    expect(dropped).to.deep.equal({ collections: [], indexes: [] });
    expect(droppedCollections).to.deep.equal([]);
    expect(droppedIndexes).to.deep.equal([]);
  });

  it('drops a retired collection the node still holds, and only that one', async () => {
    collectionsPresent.add('zelappslocation');

    await retiredSchema.dropRetiredSchema();

    expect(droppedCollections).to.deep.equal(['zelappslocation']);
  });

  it('drops a retired expiry index, and keeps the current plain index of the same name', async () => {
    indexesOf[ERRORS_LOCATIONS] = [{ name: 'broadcastedAt_1', key: { broadcastedAt: 1 }, expireAfterSeconds: 3600 }];
    indexesOf[ERRORS_BROADCASTS] = [{ name: 'broadcastedAt_1', key: { broadcastedAt: 1 } }];

    await retiredSchema.dropRetiredSchema();

    expect(droppedIndexes).to.deep.equal([`${ERRORS_LOCATIONS}.broadcastedAt_1`]);
  });

  it('drops the temporary pool\'s expiry index, and keeps the plain arrival index of the same name', async () => {
    indexesOf[TEMP_MESSAGES] = [{ name: 'receivedAt_1', key: { receivedAt: 1 }, expireAfterSeconds: 3600 }];

    await retiredSchema.dropRetiredSchema();

    expect(droppedIndexes).to.deep.equal([`${TEMP_MESSAGES}.receivedAt_1`]);

    droppedIndexes.length = 0;
    indexesOf[TEMP_MESSAGES] = [{ name: 'receivedAt_1', key: { receivedAt: 1 } }];

    await retiredSchema.dropRetiredSchema();

    expect(droppedIndexes).to.deep.equal([]);
  });

  it('drops the content manifests\' index by app name, and keeps the one by identity', async () => {
    indexesOf[CONTENT_MANIFESTS] = [{ name: 'appName', key: { appName: 1 }, unique: true }, { name: 'identity', key: { identity: 1 }, unique: true }];

    await retiredSchema.dropRetiredSchema();

    expect(droppedIndexes).to.deep.equal([`${CONTENT_MANIFESTS}.appName`]);
  });
});
