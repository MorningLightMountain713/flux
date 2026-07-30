const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const openpgp = require('openpgp');

// The keypair is the operator's: it is the one that enterprise app registry credentials
// are encrypted to, so losing it is unrecoverable. These tests cover the boots where the
// database and config/userconfig.js disagree about whether an identity exists.
describe('node identity adoption', () => {
  const IDENTITY_COLLECTION = 'nodeidentity';

  const logStub = {
    info: () => { }, warn: () => { }, error: () => { }, debug: () => { },
  };

  let store;
  let dbHelperStub;
  let configStub;
  let repository;
  let migration;
  let originalUserconfig;
  let operatorKeypair;

  // The boot fallback configManager publishes when config/userconfig.js is unreadable
  // or fails validation. It carries no keypair, and no marker distinguishes it from a
  // genuinely key-less node.
  const FALLBACK_CONFIG = {
    initial: {
      ipaddress: '127.0.0.1',
      zelid: null,
      testnet: false,
      development: false,
      apiport: 16127,
      routerIP: '',
    },
  };

  before(async function generateOperatorKey() {
    this.timeout(30000);
    operatorKeypair = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519',
      userIDs: [{ name: 'operator', email: 'operator@runonflux.io' }],
      passphrase: '',
      format: 'armored',
    });
    originalUserconfig = globalThis.userconfig;
  });

  after(() => {
    globalThis.userconfig = originalUserconfig;
  });

  beforeEach(() => {
    store = new Map();
    dbHelperStub = {
      databaseConnection: sinon.stub().returns({ db: sinon.stub().returns({ name: 'mockdb' }) }),
      findOneInDatabase: sinon.stub().callsFake(async (db, collection, query) => store.get(query._id) || null),
      findOneAndUpdateInDatabase: sinon.stub().callsFake(async (db, collection, query, update) => {
        const existing = store.get(query._id) || { _id: query._id };
        store.set(query._id, { ...existing, ...update.$set });
        return store.get(query._id);
      }),
    };
    configStub = {
      database: {
        local: {
          database: 'zelfluxlocal',
          collections: { nodeIdentity: IDENTITY_COLLECTION },
        },
      },
    };
    repository = proxyquire('../../ZelBack/src/services/appDatabase/nodeIdentityRepository', {
      config: configStub,
      '../dbHelper': dbHelperStub,
    });
    migration = proxyquire('../../ZelBack/src/services/appDatabase/nodeIdentityMigration', {
      config: configStub,
      '../dbHelper': dbHelperStub,
      './nodeIdentityRepository': repository,
      '../../lib/log': logStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  function loadPgpService() {
    return proxyquire('../../ZelBack/src/services/pgpService', {
      './appDatabase/nodeIdentityRepository': repository,
      './generalService': {
        obtainNodeCollateralInformation: async () => ({ txhash: 'a'.repeat(64), txindex: 0 }),
      },
      '../lib/log': logStub,
    });
  }

  function configWithOperatorKey() {
    return {
      initial: {
        ipaddress: '1.2.3.4',
        zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
        testnet: false,
        development: false,
        apiport: 16127,
        routerIP: '',
        pgpPrivateKey: operatorKeypair.privateKey,
        pgpPublicKey: operatorKeypair.publicKey,
      },
    };
  }

  describe('generateIdentity', () => {
    it('adopts the keypair still held in the config file rather than generating a new one', async function adopt() {
      this.timeout(30000);
      globalThis.userconfig = configWithOperatorKey();

      await loadPgpService().generateIdentity();

      const stored = await repository.getPgpIdentity();
      expect(stored).to.not.equal(null);
      expect(stored.publicKey).to.equal(operatorKeypair.publicKey);
      expect(stored.privateKey).to.equal(operatorKeypair.privateKey);
    });

    it('generates when the config file holds no keypair', async function fresh() {
      this.timeout(30000);
      globalThis.userconfig = FALLBACK_CONFIG;

      await loadPgpService().generateIdentity();

      const stored = await repository.getPgpIdentity();
      expect(stored).to.not.equal(null);
      expect(stored.publicKey).to.not.equal(operatorKeypair.publicKey);
    });

    it('leaves an identity already in the database alone', async function dbWins() {
      this.timeout(30000);
      await repository.setPgpIdentity({
        privateKey: operatorKeypair.privateKey,
        publicKey: operatorKeypair.publicKey,
      });
      // configd blanks the keypair whenever it re-renders the file, so the database wins
      globalThis.userconfig = FALLBACK_CONFIG;

      await loadPgpService().generateIdentity();

      const stored = await repository.getPgpIdentity();
      expect(stored.publicKey).to.equal(operatorKeypair.publicKey);
    });
  });

  describe('migrateNodeIdentity', () => {
    it('adopts the keypair from the config file into an empty database', async () => {
      globalThis.userconfig = configWithOperatorKey();

      const { migrated } = await migration.migrateNodeIdentity();

      expect(migrated).to.include('pgpIdentity');
      const stored = await repository.getPgpIdentity();
      expect(stored.publicKey).to.equal(operatorKeypair.publicKey);
    });

    it('does not record itself as complete before an identity is settled', async () => {
      // The config read on this boot may be the fallback rather than the operator's file.
      // Recording the migration as done here retires it permanently, so a later boot that
      // reads the real file would never adopt the keypair sitting in it.
      globalThis.userconfig = FALLBACK_CONFIG;

      await migration.migrateNodeIdentity();

      expect(store.get(migration.MIGRATION_KEY)).to.equal(undefined);
    });

    it('records itself as complete once an identity exists', async () => {
      globalThis.userconfig = configWithOperatorKey();

      await migration.migrateNodeIdentity();

      const marker = store.get(migration.MIGRATION_KEY);
      expect(marker).to.not.equal(undefined);
      expect(marker.version).to.equal(migration.MIGRATION_VERSION);
    });

    it('adopts on a later boot when an earlier boot read the fallback config', async () => {
      globalThis.userconfig = FALLBACK_CONFIG;
      await migration.migrateNodeIdentity();

      globalThis.userconfig = configWithOperatorKey();
      await migration.migrateNodeIdentity();

      const stored = await repository.getPgpIdentity();
      expect(stored).to.not.equal(null);
      expect(stored.publicKey).to.equal(operatorKeypair.publicKey);
    });
  });
});
