'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const realSpecLibs = require('../../ZelBack/src/services/utils/specLibs');
const { asConfig } = require('./fixtures/config');
const {
  loadSpecLibrary, v8Spec, v9Spec, sealedV8Spec, sealedV9Spec, instantiatedSpec, assertAnswers,
} = require('./fixtures/fluxSpec');

// The spec library is real here, not stubbed — see tests/unit/fixtures/fluxSpec.js
// for why. What stays stubbed is I/O and FluxOS policy: mongo, the daemon RPCs,
// the benchmark channel, and the fork-activation height gate.
let flux;

describe('messageStore tests', () => {
  // Mirrors config.fluxapps.clockSkewAllowanceMs. Declared once so the stub and the
  // boundary assertions cannot drift apart.
  const STUB_CLOCK_SKEW_ALLOWANCE_MS = 120 * 1000;

  let messageStore;
  let dbHelperStub;
  let appsRepositoryStub;
  let messagesStub;
  let confirmedStoreStub;
  let registryStub;
  let appEventVerifierStub;
  let logStub;
  let configStub;
  let registryManagerStub;
  let assertVersionActivatedStub;
  // What the registry's byName / getStateBeforeHeight really return: an InstantiatedSpec,
  // a stored spec plus its chain state. messageStore reads .owner and .spec off it.
  let priorState;

  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  // A signature of the length a v9 message hash reads: 65 bytes.
  const SIGNATURE = Buffer.alloc(65, 7).toString('base64');

  /**
   * The event class deserializeTempMessage really returns for an envelope
   * version 1 message. Legacy events never require an arcane attestation, and
   * that is a property of the class rather than of a flag a double can set.
   * It states the hash its contents make, as a genuine message does, unless a
   * test names another.
   */
  function legacyEvent(message, spec, { hash } = {}) {
    const [signedForm] = spec.allSerializations?.() ?? [spec.toCanonical()];
    return new flux.AppEventLegacy({
      originalType: message.type,
      spec,
      version: message.version,
      hash: hash ?? flux.computeMessageHash(message.type, message.version, signedForm, message.timestamp, message.signature),
      timestamp: message.timestamp,
      signature: message.signature,
    });
  }

  /**
   * The event class deserializeTempMessage really returns for an envelope
   * version 2 message. A cleartext spec is reconciled against the signed
   * contentHash by the constructor; a sealed one carries the hash of the
   * cleartext that was sealed, and is reconciled only on decrypt. It states
   * the hash its contents make, as a genuine message does, unless a test names
   * another.
   */
  function signedEvent(message, spec, { contentHash, arcaneAttestation, hash } = {}) {
    const signedContentHash = contentHash ?? spec.contentHash();
    // registration always buys TTL; the class refuses anything else
    const extend = message.type === 'fluxappregister' ? true : (message.extend ?? false);
    return new flux.SignedAppEvent({
      type: message.type,
      spec,
      version: message.version,
      contentHash: signedContentHash,
      timestamp: message.timestamp,
      extend,
      signature: message.signature,
      hash: hash ?? flux.computeMessageHashV2(
        message.type, message.version, signedContentHash, message.timestamp, extend, message.signature,
      ),
      arcaneAttestation,
      contentManifest: message.contentManifest ?? null,
    });
  }

  // The manifest a spec update carries, as it travels: slots sealed.
  const CARRIED_MANIFEST = {
    appName: 'test',
    identity: `b${'a'.repeat(52)}`,
    version: 2,
    ownedFrom: 2_400_000,
    slots: { sealed: { algorithm: 'aes-256-gcm', ciphertext: 'c', nonce: 'n', tag: 't' } },
    rollout: { strategy: 'immediate' },
    timestamp: 1_700_000_000_000,
    ownerSignature: 'owner-sig',
  };

  /** The real event for an ordinary cleartext message. */
  async function realAppEvent(message) {
    const specs = message.appSpecifications || {};
    if (message.version === 2) {
      return signedEvent(message, await v9Spec({ name: specs.name }));
    }
    return legacyEvent(message, await v8Spec({ name: specs.name }));
  }

  function buildProxyquireStubs(overrides = {}) {
    return {
      config: asConfig(configStub),
      '../dbHelper': dbHelperStub,
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../appDatabase/appRecords': { registry: () => registryStub, messages: () => messagesStub },
      './confirmedMessageStore': confirmedStoreStub,
      './appEventVerifier': appEventVerifierStub,
      './messageVerifier': { checkAndRequestApp: sinon.stub().resolves() },
      '../utils/specCutover': { ensureProvidersRegistered: sinon.stub().resolves() },
      '../../lib/log': logStub,
      '../fluxService': { isSystemSecure: sinon.stub().resolves(false) },
      '../daemonService/daemonStatus': {
        isDaemonSynced: sinon.stub().returns({ data: { height: 1000 } }),
      },
      '../appDatabase/registryManager': registryManagerStub,
      '../appDatabase/appSpecHistory': {
        latestAppliedState: sinon.stub().resolves(null),
      },
      '../utils/specLibs': {
        // The real library behind FluxOS's own accessor — UpdatePolicy.assertCompatible
        // runs for real against both specs. assertVersionActivated stays stubbed:
        // it is FluxOS policy about fork heights, not spec shape.
        getSpec: sinon.stub().callsFake(async () => flux),
        assertVersionActivated: assertVersionActivatedStub,
      },
      '../utils/globalState': {
        queuePendingUpdate: sinon.stub(),
      },
      '../utils/appSyncEvents': {
        appSyncEvents: { emit: sinon.stub(), on: sinon.stub(), removeListener: sinon.stub() },
        EVENTS: { HASH_RESPONSE_RECEIVED: 'hashResponseReceived' },
      },
      '../utils/appConstants': {
        globalAppsInstallingLocations: 'appsInstallingLocations',
        globalAppsInstallingErrorsLocations: 'appsInstallingErrorsLocations',
        globalAppsInstallingErrorsBroadcasts: 'appsInstallingErrorsBroadcasts',
        globalAppStateEvents: 'appStateEvents',
        GOSSIP_VALIDITY_MS: 5 * 60 * 1000,
        RUNNING_EXPIRY_MS: 125 * 60 * 1000,
        INSTALLING_EXPIRY_MS: 15 * 60 * 1000,
        INSTALLING_ERRORS_EXPIRY_MS: 24 * 60 * 60 * 1000,
        CLOCK_SKEW_ALLOWANCE_MS: STUB_CLOCK_SKEW_ALLOWANCE_MS,
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    // The app that holds the name now, as the registry really answers it.
    priorState = await instantiatedSpec(await v8Spec({ name: 'test' }), { height: 400 });

    // Stubs
    dbHelperStub = {
      databaseConnection: sinon.stub(),
      findInDatabase: sinon.stub(),
      findOneInDatabase: sinon.stub(),
      insertOneToDatabase: sinon.stub(),
      updateOneInDatabase: sinon.stub(),
      updateInDatabase: sinon.stub(),
      removeDocumentsFromCollection: sinon.stub(),
      findOneAndDeleteInDatabase: sinon.stub(),
      findOneAndUpdateInDatabase: sinon.stub().resolves(null),
      countInDatabase: sinon.stub(),
    };

    registryStub = { byName: sinon.stub().resolves(priorState), byIdentity: sinon.stub().resolves(null) };
    appsRepositoryStub = {
      getPermanentMessage: sinon.stub(),
      getTempMessage: sinon.stub(),
    };
    // The app messages: a record held when the repository stubs answer a
    // message, paid when the payment lookup answers a payment; contents stored
    // into the pool go through insertOneToDatabase as the stored form.
    messagesStub = {
      byHash: sinon.stub().callsFake(async (hash) => {
        const permanent = await appsRepositoryStub.getPermanentMessage(hash);
        const temp = await appsRepositoryStub.getTempMessage(hash);
        const payment = await dbHelperStub.findOneInDatabase();
        const held = Boolean(permanent || temp);
        const paid = Boolean(payment && payment.txid);
        if (!held && !paid) return null;
        return {
          hash, isHeld: held, isPaid: paid, payment: paid ? payment : null,
        };
      }),
      storeContents: sinon.stub().callsFake(async (contents, pool) => dbHelperStub.insertOneToDatabase('database', 'appsTempMessages', { ...contents, ...pool })),
    };
    confirmedStoreStub = {
      storeConfirmedMessages: sinon.stub().resolves({
        stored: [], alreadyStored: [], unpaid: [], refused: [],
      }),
    };

    appEventVerifierStub = {
      deserializeTempMessage: sinon.stub().callsFake((msg) => realAppEvent(msg)),
      deserializeMessage: sinon.stub().resolves({}),
      authorize: sinon.stub().resolves(),
      verifyAttestation: sinon.stub().resolves(true),
    };

    registryManagerStub = {
      checkApplicationRegistrationNameConflicts: sinon.stub().resolves(),
    };
    assertVersionActivatedStub = sinon.stub();

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    configStub = {
      database: {
        daemon: {
          database: 'daemondb',
        },
        appsglobal: {
          database: 'appsdb',
          collections: {
            appStateEvents: 'appStateEvents',
            appsInstallingBroadcasts: 'appsInstallingBroadcasts',
            appsInstallingErrorsBroadcasts: 'appsInstallingErrorsBroadcasts',
          },
        },
      },
      fluxapps: {
        maxAppsPerNode: 200,
        appSpecsEnforcementHeights: {},
      },
    };

    // Proxy require
    messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', buildProxyquireStubs());
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('storeAppTemporaryMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'test' };

      const result = await messageStore.storeAppTemporaryMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App message');
    });

    it('should return false if message already exists in permanent storage', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves({ hash: 'hash123' });
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);

      const result = await messageStore.storeAppTemporaryMessage(message);

      expect(result).to.equal(false);
      expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
    });

    it('should return false if message already exists in temporary storage', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves({ hash: 'hash123' });
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);

      const result = await messageStore.storeAppTemporaryMessage(message);

      expect(result).to.equal(false);
      expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
    });

    it('should store new temporary message and return rebroadcast true', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase.resolves();

      const result = await messageStore.storeAppTemporaryMessage(message, { furtherVerification: false });

      expect(result).to.deep.equal({ rebroadcast: true });
      expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
    });

    it('keeps the manifest an update carries on the row, and no field for one that carries none', async () => {
      const update = {
        type: 'fluxappupdate',
        version: 2,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: SIGNATURE,
      };
      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      dbHelperStub.databaseConnection.returns({ db: sinon.stub().returns('database') });
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase.resolves();

      await messageStore.storeAppTemporaryMessage({ ...update, contentManifest: CARRIED_MANIFEST }, { furtherVerification: false });
      expect(dbHelperStub.insertOneToDatabase.firstCall.args[2].contentManifest).to.deep.equal(CARRIED_MANIFEST);

      await messageStore.storeAppTemporaryMessage(update, { furtherVerification: false });
      expect(dbHelperStub.insertOneToDatabase.secondCall.args[2]).to.not.have.property('contentManifest');
    });

    it('stamps the row with the last block stamp a payment can carry, by the signed timestamp', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: 1_700_000_000_000,
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase.resolves();

      await messageStore.storeAppTemporaryMessage(message, { furtherVerification: false });

      const [, , stored] = dbHelperStub.insertOneToDatabase.firstCall.args;
      expect(stored.payableUntil).to.deep.equal(new Date(1_700_000_000_000 + 60 * 60 * 1000));
      expect(stored).to.not.have.property('expireAt');
      expect(stored.receivedAt).to.be.instanceOf(Date);
    });

    it('should return promotion info when hash is already on chain', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves({
        height: 500, txid: 'txid123', value: 10_000, blockTime: 1_750_000_000,
      });
      dbHelperStub.insertOneToDatabase.resolves();

      const result = await messageStore.storeAppTemporaryMessage(message, { furtherVerification: false });

      const event = await appEventVerifierStub.deserializeTempMessage.firstCall.returnValue;
      expect(result.rebroadcast).to.equal(false);
      expect(result.promotion).to.deep.equal({
        hash: event.hash,
        txid: 'txid123',
        height: 500,
        value: 10_000,
        blockTime: 1_750_000_000,
      });
    });

    it('should handle database errors gracefully', async () => {
      const message = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'test' },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };
      const error = new Error('Database error');

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase.rejects(error);

      try {
        await messageStore.storeAppTemporaryMessage(message, { furtherVerification: false });
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err).to.equal(error);
        expect(logStub.error.calledWith(error)).to.be.true;
      }
    });

    describe('who an update is judged against', () => {
      function updateMessage() {
        return {
          type: 'fluxappupdate',
          version: 1,
          appSpecifications: { name: 'test', owner: 'owner1', version: 6 },
          hash: 'hash123',
          timestamp: Date.now(),
          signature: 'sig123',
        };
      }

      function registrationMessage() {
        return { ...updateMessage(), type: 'fluxappregister' };
      }

      beforeEach(() => {
        appsRepositoryStub.getPermanentMessage.resolves(null);
        appsRepositoryStub.getTempMessage.resolves(null);
        dbHelperStub.databaseConnection.returns({ db: sinon.stub().returns('database') });
        dbHelperStub.insertOneToDatabase.resolves();
      });

      // A live message is judged against the app that holds the name now. The
      // name's message history spans every app that has ever held it, so an
      // expired app's owner would otherwise authorize an update to whoever
      // holds the name today.
      it('reads the active registry row for a message not yet on chain', async () => {
        const stubs = buildProxyquireStubs();
        dbHelperStub.findOneInDatabase.resolves(null);
        messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', stubs);

        await messageStore.storeAppTemporaryMessage(updateMessage());

        sinon.assert.calledOnceWithExactly(registryStub.byName, 'test');

        // The authorization gate stays stubbed, so nothing here exercises what it
        // does with what it is handed. The real one reads the renewal off the
        // event and the prior owner off the state, so check both can answer — a
        // delegation could otherwise disappear with this suite still green. The
        // intake has checked the hash by then, and says so.
        const [handed] = stubs['./appEventVerifier'].authorize.firstCall.args;
        assertAnswers(handed.appEvent, ['assessRenewal']);
        expect(handed.verifyHash, 'the gate is told the hash is checked').to.equal(false);
        expect(handed.previousState.owner, 'the owner the update is judged against')
          .to.equal(priorState.spec.owner);
      });

      // A message already on chain is stored on the confirmed store's rules
      // and the decider judges it: nothing here asks who may sign it.
      it('judges nothing about a message already on chain, and stores it on the confirmed store\'s rules', async () => {
        const stubs = buildProxyquireStubs();
        dbHelperStub.findOneInDatabase.resolves({
          height: 500, txid: 'txid123', value: 10_000, blockTime: 1_750_000_000,
        });
        messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', stubs);
        const message = updateMessage();

        const result = await messageStore.storeAppTemporaryMessage(message);

        expect(result).to.not.be.instanceOf(Error);
        sinon.assert.notCalled(registryStub.byName);
        sinon.assert.notCalled(stubs['../appDatabase/appSpecHistory'].latestAppliedState);
        sinon.assert.notCalled(stubs['./appEventVerifier'].authorize);
        sinon.assert.calledOnce(confirmedStoreStub.storeConfirmedMessages);
        expect(confirmedStoreStub.storeConfirmedMessages.firstCall.args[0][0]).to.deep.include({ type: message.type });
      });

      it('stores a registration already on chain whose name the registry holds', async () => {
        const stubs = buildProxyquireStubs();
        dbHelperStub.findOneInDatabase.resolves({
          height: 500, txid: 'txid123', value: 10_000, blockTime: 1_750_000_000,
        });
        registryManagerStub.checkApplicationRegistrationNameConflicts = sinon.stub().rejects(new Error('already registered'));
        messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', stubs);

        const result = await messageStore.storeAppTemporaryMessage(registrationMessage());

        expect(result).to.not.be.instanceOf(Error);
        sinon.assert.notCalled(registryManagerStub.checkApplicationRegistrationNameConflicts);
        sinon.assert.calledOnce(confirmedStoreStub.storeConfirmedMessages);
      });

      // A name the list no longer carries is judged against the app that last
      // held it, so a renewal of an expired app is taken and relayed by every
      // node, not only the one that took it.
      it('reads the app that last held the name when the list carries none, and takes the renewal', async () => {
        const stubs = buildProxyquireStubs();
        dbHelperStub.findOneInDatabase.resolves(null);
        registryStub.byName.resolves(null);
        stubs['../appDatabase/appSpecHistory'].latestAppliedState.resolves(priorState);
        messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', stubs);

        const result = await messageStore.storeAppTemporaryMessage(updateMessage());

        expect(result).to.deep.equal({ rebroadcast: true });
        sinon.assert.calledOnceWithExactly(stubs['../appDatabase/appSpecHistory'].latestAppliedState, 'test');
        sinon.assert.notCalled(stubs['../utils/globalState'].queuePendingUpdate);
        const [handed] = stubs['./appEventVerifier'].authorize.firstCall.args;
        expect(handed.previousState.owner, 'the owner who last held the name').to.equal(priorState.spec.owner);
      });

      it('queues the update when no app of that name is listed or was ever applied', async () => {
        const stubs = buildProxyquireStubs();
        dbHelperStub.findOneInDatabase.resolves(null);
        registryStub.byName.resolves(null);
        messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', stubs);

        const result = await messageStore.storeAppTemporaryMessage(updateMessage());

        expect(result).to.equal(false);
        sinon.assert.calledOnceWithExactly(stubs['../appDatabase/appSpecHistory'].latestAppliedState, 'test');
        sinon.assert.calledOnce(stubs['../utils/globalState'].queuePendingUpdate);
        sinon.assert.notCalled(stubs['./appEventVerifier'].authorize);
      });
    });

    it('should not enforce version upgrade policy (enforced at API layer)', async () => {
      const message = {
        type: 'fluxappupdate',
        version: 1,
        appSpecifications: { name: 'test', version: 6 },
        hash: 'hash123',
        timestamp: Date.now(),
        signature: 'sig123',
      };

      appsRepositoryStub.getPermanentMessage.resolves(null);
      appsRepositoryStub.getTempMessage.resolves(null);
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.insertOneToDatabase.resolves();

      messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', buildProxyquireStubs());

      const result = await messageStore.storeAppTemporaryMessage(message);

      expect(result).to.deep.equal({ rebroadcast: true });
      expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
    });

    describe('arcane attestation gate', () => {
      // A real v9 (envelope version 2) encrypted event: a node-sealed
      // EncryptedSpecV9 inside a real SignedAppEvent, whose isEncrypted and
      // requiresArcaneAttestation() follow from the spec class rather than from
      // a flag. The decrypt branch downstream is short-circuited by
      // isSystemSecure resolving false, so these tests isolate the gate itself.
      async function encryptedV9Event({ attestation = 'att-sig' } = {}) {
        const sealed = await sealedV9Spec({ name: 'enc-app' });
        const cleartext = await v9Spec({ name: 'enc-app' });
        return signedEvent({ ...encryptedMessage, version: 2 }, sealed, {
          contentHash: cleartext.contentHash(),
          arcaneAttestation: attestation,
        });
      }

      // The v8 enterprise equivalent. An envelope version 1 message deserializes
      // to AppEventLegacy, and that class answers requiresArcaneAttestation()
      // false by construction — which is the thing under test.
      async function encryptedV8Event() {
        return legacyEvent(
          { ...encryptedMessage, version: 1 }, await sealedV8Spec({ name: 'enc-app' }),
        );
      }

      const encryptedMessage = {
        type: 'fluxappregister',
        version: 2,
        appSpecifications: { name: 'enc-app', cipher: 'xxx' },
        hash: 'enchash',
        timestamp: Date.now(),
        signature: SIGNATURE,
      };

      function buildWithSystemSecure(secure) {
        return proxyquire(
          '../../ZelBack/src/services/appMessaging/messageStore',
          buildProxyquireStubs({
            '../benchmarkService': { isSystemSecure: sinon.stub().resolves(secure) },
          }),
        );
      }

      beforeEach(() => {
        appsRepositoryStub.getPermanentMessage.resolves(null);
        appsRepositoryStub.getTempMessage.resolves(null);
        const mockDb = { db: sinon.stub().returns('database') };
        dbHelperStub.databaseConnection.returns(mockDb);
        dbHelperStub.findOneInDatabase.resolves(null);
        dbHelperStub.insertOneToDatabase.resolves();
      });

      it('rejects an encrypted v9 message with a missing or invalid attestation', async () => {
        appEventVerifierStub.deserializeTempMessage.resolves(await encryptedV9Event());
        appEventVerifierStub.verifyAttestation.resolves(false);
        messageStore = buildWithSystemSecure(false);

        const result = await messageStore.storeAppTemporaryMessage(encryptedMessage);

        expect(result).to.be.instanceOf(Error);
        expect(result.message).to.include('arcane attestation');
        expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
      });

      // verifyAttestation answers with a Promise now, and a Promise is truthy
      // however it resolves. Drop the await at the gate and `!verifyAttestation()`
      // is false for every message, so an unattested encrypted message is stored
      // and relayed. The stub resolving false rather than returning it is what
      // makes this test able to tell the two apart: a `returns(false)` stub would
      // pass whether or not the caller awaited.
      it('refuses a refusal that arrives asynchronously, not just a synchronous one', async () => {
        appEventVerifierStub.deserializeTempMessage.resolves(await encryptedV9Event());
        appEventVerifierStub.verifyAttestation.callsFake(async () => false);
        messageStore = buildWithSystemSecure(false);

        const result = await messageStore.storeAppTemporaryMessage(encryptedMessage);

        expect(result, 'an unattested message was stored').to.be.instanceOf(Error);
        expect(result.message).to.include('arcane attestation');
        expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
      });

      it('stores an encrypted v9 message carrying a valid attestation', async () => {
        appEventVerifierStub.deserializeTempMessage.resolves(await encryptedV9Event());
        appEventVerifierStub.verifyAttestation.resolves(true);
        messageStore = buildWithSystemSecure(false);

        const result = await messageStore.storeAppTemporaryMessage(encryptedMessage);

        expect(result).to.deep.equal({ rebroadcast: true });
        expect(appEventVerifierStub.verifyAttestation.calledOnce).to.be.true;
        const stored = dbHelperStub.insertOneToDatabase.firstCall.args[2];
        expect(stored.arcaneAttestation).to.equal('att-sig');

        // verifyAttestation stays stubbed, so nothing here exercises what it does
        // with the event. The real one rebuilds the signed message from the
        // event's own contentHash AND a hash of the sealed envelope — the second
        // half needs the spec to answer serialize() — so hand it a verifier and
        // check it got that far.
        const [attested] = appEventVerifierStub.verifyAttestation.firstCall.args;
        let signedOver = null;
        expect(await attested.verifyArcaneAttestation((msg) => { signedOver = msg; return true; }, 'pk'))
          .to.be.true;
        expect(signedOver, 'the attest message is built from the envelope').to.be.a('string').and.not.equal('');
      });

      it('does not subject a v8 (envelope version 1) encrypted message to the gate', async () => {
        // Legacy enterprise apps predate attestation and aren't born attested;
        // AppEventLegacy has no verifyArcaneAttestation, so the gate must skip them.
        appEventVerifierStub.deserializeTempMessage.resolves(await encryptedV8Event());
        appEventVerifierStub.verifyAttestation.resolves(false);
        messageStore = buildWithSystemSecure(false);

        const result = await messageStore.storeAppTemporaryMessage({ ...encryptedMessage, version: 1 });

        expect(result).to.deep.equal({ rebroadcast: true });
        expect(appEventVerifierStub.verifyAttestation.called).to.be.false;
        expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
      });
    });

    // The spec arrives already validated — deserializeTempMessage builds the
    // event, and constructing a spec class runs the whole chain. What used to
    // re-validate it here added exactly one thing: the activation height.
    describe('a validated spec is not validated a second time', () => {
      const cleartextMessage = {
        type: 'fluxappregister',
        version: 2,
        appSpecifications: { name: 'clear-app', owner: 'owner1', version: 9 },
        hash: 'clearhash',
        timestamp: Date.now(),
        signature: SIGNATURE,
      };

      beforeEach(() => {
        appsRepositoryStub.getPermanentMessage.resolves(null);
        appsRepositoryStub.getTempMessage.resolves(null);
        dbHelperStub.databaseConnection.returns({ db: sinon.stub().returns('database') });
        dbHelperStub.findOneInDatabase.resolves(null);
        dbHelperStub.insertOneToDatabase.resolves();
      });

      it('still refuses a spec whose version is not active at that height', () => {
        assertVersionActivatedStub.throws(new Error('v9 is not active until height 2000000'));

        return messageStore.storeAppTemporaryMessage(cleartextMessage).then(
          () => expect.fail('an inactive version must not be stored'),
          (err) => {
            expect(err.message).to.match(/not active/);
            expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
          },
        );
      });

      it('checks the activation height against the version it already parsed', async () => {
        await messageStore.storeAppTemporaryMessage(cleartextMessage);

        expect(assertVersionActivatedStub.calledOnce).to.be.true;
        expect(assertVersionActivatedStub.firstCall.args[0], 'the spec version, not the document')
          .to.equal(9);
      });

      it('runs the registration name-conflict check on a readable spec', async () => {
        await messageStore.storeAppTemporaryMessage(cleartextMessage);
        expect(registryManagerStub.checkApplicationRegistrationNameConflicts.calledOnce).to.be.true;
        // The conflict check stays stubbed, and the real one reads the app name
        // straight off the spec it is handed — so that is what is checked here.
        const [handed] = registryManagerStub.checkApplicationRegistrationNameConflicts.firstCall.args;
        expect(handed.name).to.equal('clear-app');
      });

      // The reading checks need the spec's contents, and a node that cannot open
      // a sealed one has none. The activation gate needs only the version, which
      // a sealed spec states in the clear, so it still runs.
      it('skips them for a sealed spec this node cannot open, and still gates its version', async () => {
        const sealed = await sealedV9Spec({ name: 'sealed-app' });
        const cleartext = await v9Spec({ name: 'sealed-app' });
        appEventVerifierStub.deserializeTempMessage.resolves(signedEvent(
          {
            type: 'fluxappregister', version: 2, hash: 'sealedhash', timestamp: Date.now(), signature: SIGNATURE,
          },
          sealed,
          { contentHash: cleartext.contentHash(), arcaneAttestation: 'att-sig' },
        ));
        appEventVerifierStub.verifyAttestation.resolves(true);
        // A node that cannot open it — benchmarkService must be stubbed or the
        // real one dials 127.0.0.1:26224 and the harness fails the run.
        messageStore = proxyquire(
          '../../ZelBack/src/services/appMessaging/messageStore',
          buildProxyquireStubs({
            '../benchmarkService': { isSystemSecure: sinon.stub().resolves(false) },
          }),
        );

        await messageStore.storeAppTemporaryMessage({ ...cleartextMessage, hash: 'sealedhash' });

        expect(registryManagerStub.checkApplicationRegistrationNameConflicts.called).to.be.false;
        sinon.assert.calledOnceWithExactly(assertVersionActivatedStub, 9, 1000);
      });

      // The real gate, below v9's activation height (2,791,000 in the unit
      // config; the daemon stub answers 1000), on a node that cannot open the
      // spec: refused, and nothing stored.
      it('refuses a sealed spec whose version is not active, on a node that cannot open it', async () => {
        const sealed = await sealedV9Spec({ name: 'sealed-app' });
        const cleartext = await v9Spec({ name: 'sealed-app' });
        appEventVerifierStub.deserializeTempMessage.resolves(signedEvent(
          {
            type: 'fluxappregister', version: 2, hash: 'sealedhash', timestamp: Date.now(), signature: SIGNATURE,
          },
          sealed,
          { contentHash: cleartext.contentHash(), arcaneAttestation: 'att-sig' },
        ));
        appEventVerifierStub.verifyAttestation.resolves(true);
        const stubs = buildProxyquireStubs({
          '../benchmarkService': { isSystemSecure: sinon.stub().resolves(false) },
        });
        stubs['../utils/specLibs'] = {
          ...stubs['../utils/specLibs'],
          assertVersionActivated: realSpecLibs.assertVersionActivated,
        };
        messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', stubs);

        let refusal = null;
        try {
          await messageStore.storeAppTemporaryMessage({ ...cleartextMessage, hash: 'sealedhash' });
        } catch (err) {
          refusal = err;
        }

        expect(refusal, 'an inactive version must not be stored').to.be.an('error');
        expect(refusal.message).to.match(/version 9 not yet supported/);
        expect(dbHelperStub.insertOneToDatabase.called).to.be.false;
      });
    });

    // A v9 signature commits to a contentHash, not to a spec, so decrypting an
    // envelope says nothing about whether what came out is what the owner
    // signed for. These run with isSystemSecure true, so they go THROUGH the
    // decrypt branch the attestation tests above deliberately skip.
    describe('decrypted content is reconciled against the signed contentHash', () => {
      // A real sealed event. spec.decrypt() resolves either way and only
      // decryptAndVerify() reconciles, so a caller using the wrong one stores the
      // mismatching message and fails these tests. That is the whole point: the
      // two are indistinguishable unless the content differs — and here the
      // difference is real, produced by the real classes rather than declared.
      async function secureEvent({ reconciles }) {
        const sealed = await sealedV9Spec({ name: 'enc-app' });
        const cleartext = await v9Spec({ name: 'enc-app' });
        return signedEvent(secureMessage, sealed, {
          // The signature commits to a contentHash, never to the envelope: sign
          // over what was actually sealed, or over something else entirely.
          contentHash: reconciles ? cleartext.contentHash() : 'f'.repeat(64),
          arcaneAttestation: 'att-sig',
        });
      }

      const secureMessage = {
        type: 'fluxappregister',
        version: 2,
        appSpecifications: { name: 'enc-app', cipher: 'xxx' },
        hash: 'enchash',
        timestamp: Date.now(),
        signature: SIGNATURE,
      };

      function buildSecure() {
        return proxyquire(
          '../../ZelBack/src/services/appMessaging/messageStore',
          buildProxyquireStubs({
            '../benchmarkService': { isSystemSecure: sinon.stub().resolves(true) },
            '../utils/specLibs': {
              getSpec: sinon.stub().callsFake(async () => flux),
              assertVersionActivated: sinon.stub(),
            },
          }),
        );
      }

      beforeEach(() => {
        appsRepositoryStub.getPermanentMessage.resolves(null);
        appsRepositoryStub.getTempMessage.resolves(null);
        dbHelperStub.databaseConnection.returns({ db: sinon.stub().returns('database') });
        dbHelperStub.findOneInDatabase.resolves(null);
        dbHelperStub.insertOneToDatabase.resolves();
        appEventVerifierStub.verifyAttestation.resolves(true);
      });

      it('rejects a message whose decrypted content is not what was signed', async () => {
        // Spied, not replaced: the reconciliation that decides this test is the
        // real one, and the spy only records that the node went through it.
        const decryptAndVerify = sinon.spy(flux.SignedAppEvent.prototype, 'decryptAndVerify');
        appEventVerifierStub.deserializeTempMessage.resolves(await secureEvent({ reconciles: false }));
        messageStore = buildSecure();

        const result = await messageStore.storeAppTemporaryMessage(secureMessage);

        expect(result, 'a mismatch must be a returned rejection, not a throw').to.be.instanceOf(Error);
        expect(result.message).to.include('contentHash');
        expect(dbHelperStub.insertOneToDatabase.called, 'must not be stored').to.be.false;
        expect(decryptAndVerify.calledOnce, 'must go through decryptAndVerify').to.be.true;
      });

      it('stores a message whose decrypted content matches', async () => {
        const decryptAndVerify = sinon.spy(flux.SignedAppEvent.prototype, 'decryptAndVerify');
        // The decrypted spec is validated for real on the way in — a
        // DecryptedCanonicalSpec has no wire form, so validateContents is the
        // only way to ask it the gossip question.
        const validateContents = sinon.spy(flux.DecryptedCanonicalSpec.prototype, 'validateContents');
        appEventVerifierStub.deserializeTempMessage.resolves(await secureEvent({ reconciles: true }));
        messageStore = buildSecure();

        const result = await messageStore.storeAppTemporaryMessage(secureMessage);

        expect(result, `unexpected: ${result && result.message}`).to.deep.equal({ rebroadcast: true });
        expect(decryptAndVerify.calledOnce).to.be.true;
        sinon.assert.calledWith(validateContents, { purpose: 'gossip' });
        expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
      });

      // A legacy signature commits to the ciphertext itself, so a sealed v8
      // message is opened and stored on a secure node; there is no separate
      // reconciliation, and the class has none.
      it('stores a sealed v8 (envelope version 1) message on a secure node', async () => {
        const decrypt = sinon.spy(flux.EncryptedSpecV8.prototype, 'decrypt');
        const legacyMessage = { ...secureMessage, version: 1 };
        appEventVerifierStub.deserializeTempMessage.resolves(
          legacyEvent(legacyMessage, await sealedV8Spec({ name: 'enc-app' })),
        );
        messageStore = buildSecure();

        const result = await messageStore.storeAppTemporaryMessage(legacyMessage);

        expect(result, `unexpected: ${result && result.message}`).to.deep.equal({ rebroadcast: true });
        expect(decrypt.calledOnce, 'the envelope is opened').to.be.true;
        expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
      });

      // The providers are registered lazily, by the first local spec
      // resolution; a node whose first sealed message arrives before that has
      // none. The relay path needs one, so it asks for the registration.
      it('registers the crypto providers itself when nothing else has yet', async () => {
        const legacyMessage = { ...secureMessage, version: 1 };
        const event = legacyEvent(legacyMessage, await sealedV8Spec({ name: 'enc-app' }));
        appEventVerifierStub.deserializeTempMessage.resolves(event);
        const registration = sinon.stub().callsFake(async () => loadSpecLibrary());
        messageStore = proxyquire(
          '../../ZelBack/src/services/appMessaging/messageStore',
          buildProxyquireStubs({
            '../benchmarkService': { isSystemSecure: sinon.stub().resolves(true) },
            '../utils/specLibs': {
              getSpec: sinon.stub().callsFake(async () => flux),
              assertVersionActivated: sinon.stub(),
            },
            '../utils/specCutover': { ensureProvidersRegistered: registration },
          }),
        );
        flux.EncryptedSpecV8.registerProvider(null);
        try {
          const result = await messageStore.storeAppTemporaryMessage(legacyMessage);

          expect(result, `unexpected: ${result && result.message}`).to.deep.equal({ rebroadcast: true });
          expect(registration.calledOnce, 'the registration is asked for').to.be.true;
          expect(dbHelperStub.insertOneToDatabase.calledOnce).to.be.true;
        } finally {
          await loadSpecLibrary();
        }
      });

      // A bad message is a rejection; a TypeError in this block is our own bug.
      // Returning it would report a defect as a stream of peer rejections and
      // hide it — which is exactly what happened while writing these tests, when
      // a missing stub surfaced as "Invalid encrypted Flux App message".
      it('lets a programming error escape rather than reporting it as a bad message', async () => {
        // A real SignedAppEvent is frozen, so the outcome is controlled on the
        // class rather than by swapping the object for a literal.
        sinon.stub(flux.SignedAppEvent.prototype, 'decryptAndVerify')
          .rejects(new TypeError('someFn is not a function'));
        appEventVerifierStub.deserializeTempMessage.resolves(await secureEvent({ reconciles: true }));
        messageStore = buildSecure();

        try {
          await messageStore.storeAppTemporaryMessage(secureMessage);
          expect.fail('a TypeError must not be swallowed into a returned Error');
        } catch (err) {
          expect(err).to.be.instanceOf(TypeError);
          expect(err.message).to.include('is not a function');
        }
      });
    });

    // A message is the contents that hash to the hash it states. For anything
    // else the intake reads nothing, opens nothing and judges nothing.
    describe('the contents are checked against the stated hash first', () => {
      const ANOTHER_HASH = 'f'.repeat(64);
      const sealedMessage = {
        type: 'fluxappregister',
        version: 1,
        appSpecifications: { name: 'enc-app', cipher: 'xxx' },
        hash: 'enchash',
        timestamp: Date.now(),
        signature: 'sig',
      };
      let stubs;
      let decrypt;

      beforeEach(() => {
        appsRepositoryStub.getPermanentMessage.resolves(null);
        appsRepositoryStub.getTempMessage.resolves(null);
        dbHelperStub.databaseConnection.returns({ db: sinon.stub().returns('database') });
        dbHelperStub.findOneInDatabase.resolves(null);
        dbHelperStub.insertOneToDatabase.resolves();
        decrypt = sinon.spy(flux.EncryptedSpecV8.prototype, 'decrypt');
        // A node that can open a sealed spec.
        stubs = buildProxyquireStubs({
          '../benchmarkService': { isSystemSecure: sinon.stub().resolves(true) },
          '../utils/specLibs': {
            getSpec: sinon.stub().callsFake(async () => flux),
            assertVersionActivated: sinon.stub(),
          },
        });
        messageStore = proxyquire('../../ZelBack/src/services/appMessaging/messageStore', stubs);
      });

      it('reads, opens and judges a sealed message that hashes to it', async () => {
        appEventVerifierStub.deserializeTempMessage.resolves(
          legacyEvent(sealedMessage, await sealedV8Spec({ name: 'enc-app' })),
        );

        const result = await messageStore.storeAppTemporaryMessage(sealedMessage);

        expect(result, `unexpected: ${result && result.message}`).to.deep.equal({ rebroadcast: true });
        sinon.assert.calledOnce(appsRepositoryStub.getPermanentMessage);
        sinon.assert.calledOnce(appsRepositoryStub.getTempMessage);
        sinon.assert.calledOnce(dbHelperStub.findOneInDatabase);
        sinon.assert.calledOnce(decrypt);
        sinon.assert.calledOnce(appEventVerifierStub.authorize);
        sinon.assert.calledOnce(dbHelperStub.insertOneToDatabase);
      });

      it('refuses a sealed message that does not, having read and opened nothing', async () => {
        appEventVerifierStub.deserializeTempMessage.resolves(
          legacyEvent(sealedMessage, await sealedV8Spec({ name: 'enc-app' }), { hash: ANOTHER_HASH }),
        );

        const result = await messageStore.storeAppTemporaryMessage(sealedMessage);

        expect(result).to.be.instanceOf(Error);
        expect(result.message).to.equal('Invalid Flux App hash received');
        sinon.assert.notCalled(appsRepositoryStub.getPermanentMessage);
        sinon.assert.notCalled(appsRepositoryStub.getTempMessage);
        sinon.assert.notCalled(dbHelperStub.findOneInDatabase);
        sinon.assert.notCalled(decrypt);
        sinon.assert.notCalled(appEventVerifierStub.authorize);
        sinon.assert.notCalled(dbHelperStub.insertOneToDatabase);
      });

      it('refuses a v9 message that does not, before its version, its name or its signer is judged', async () => {
        const message = {
          type: 'fluxappregister',
          version: 2,
          appSpecifications: { name: 'clear-app', owner: 'owner1', version: 9 },
          hash: 'clearhash',
          timestamp: Date.now(),
          signature: SIGNATURE,
        };
        appEventVerifierStub.deserializeTempMessage.resolves(
          signedEvent(message, await v9Spec({ name: 'clear-app' }), { hash: ANOTHER_HASH }),
        );

        const result = await messageStore.storeAppTemporaryMessage(message);

        expect(result).to.be.instanceOf(Error);
        expect(result.message).to.equal('Invalid Flux App hash received');
        sinon.assert.notCalled(stubs['../utils/specLibs'].assertVersionActivated);
        sinon.assert.notCalled(registryManagerStub.checkApplicationRegistrationNameConflicts);
        sinon.assert.notCalled(appEventVerifierStub.authorize);
        sinon.assert.notCalled(dbHelperStub.insertOneToDatabase);
      });

      it('holds no update that does not, for an app this node has yet to list', async () => {
        const update = {
          type: 'fluxappupdate',
          version: 1,
          appSpecifications: { name: 'test', owner: 'owner1', version: 6 },
          hash: 'hash123',
          timestamp: Date.now(),
          signature: 'sig123',
        };
        registryStub.byName.resolves(null);
        appEventVerifierStub.deserializeTempMessage.resolves(
          legacyEvent(update, await v8Spec({ name: 'test' }), { hash: ANOTHER_HASH }),
        );

        const result = await messageStore.storeAppTemporaryMessage(update);

        expect(result).to.be.instanceOf(Error);
        expect(result.message).to.equal('Invalid Flux App hash received');
        sinon.assert.notCalled(stubs['../utils/globalState'].queuePendingUpdate);
      });
    });
  });

  describe('releaseInstallingClaims', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxapprunning' };

      const result = await messageStore.releaseInstallingClaims(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App Running message');
    });

    it('should return error for unsupported version', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 99,
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.releaseInstallingClaims(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('version 99 not supported');
    });

    it('should return false for expired message', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 1,
        name: 'testapp',
        hash: 'hash123',
        broadcastedAt: Date.now() - (200 * 60 * 1000), // 200 minutes ago
        ip: '192.168.1.1',
      };

      const result = await messageStore.releaseInstallingClaims(message);

      expect(result).to.deep.equal({ released: 0 });
      expect(logStub.warn.called).to.be.true;
    });

    it('releases the claim for a version 1 announcement, storing nothing', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 1,
        name: 'testapp',
        hash: 'hash123',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.releaseInstallingClaims(message);

      expect(result).to.deep.equal({ released: 1 });
      // the announcement itself is recorded by storeAppStateEvent, not here
      expect(dbHelperStub.updateOneInDatabase.called).to.be.false;
    });

    it('releases a claim per app in a version 2 announcement', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 2,
        apps: [
          { name: 'app1', hash: 'hash1' },
          { name: 'app2', hash: 'hash2' },
        ],
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves({ modifiedCount: 0, upsertedCount: 1 });
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.releaseInstallingClaims(message);

      expect(result).to.deep.equal({ released: 2 });
      // nothing is stored here - the claim row and its archived announce per app
      expect(dbHelperStub.updateOneInDatabase.called).to.be.false;
      expect(dbHelperStub.removeDocumentsFromCollection.callCount).to.equal(4);
    });

    it('a replica-tagged running entry releases only its own claim row and archived announce', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 2,
        apps: [{ name: 'app1', hash: 'hash1', replica: 's1' }],
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves({ modifiedCount: 0, upsertedCount: 1 });
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.releaseInstallingClaims(message);

      expect(result.released).to.be.a('number');
      // The sibling replica's claim (location row AND archived announce) must survive
      // s1 starting to run, or message sync would strip its seat mid-install.
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({
        name: 'app1', ip: '192.168.1.1', replica: 's1',
      });
      expect(dbHelperStub.removeDocumentsFromCollection.secondCall.args[2]).to.deep.equal({
        'data.name': 'app1', 'data.ip': '192.168.1.1', 'data.replica': 's1',
      });
    });

    it('releases every claim the node held when a v2 announcement carries no apps', async () => {
      const message = {
        type: 'fluxapprunning',
        version: 2,
        apps: [],
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([{ name: 'app1' }]);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.releaseInstallingClaims(message);

      expect(result).to.deep.equal({ released: 0 });
      // the node holds nothing: its installing claims and their archived announces go
      expect(dbHelperStub.removeDocumentsFromCollection.callCount).to.equal(2);
    });
  });

  describe('storeAppInstallingMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxappinstalling' };

      const result = await messageStore.storeAppInstallingMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App Installing message');
    });

    it('should return error for unsupported version', async () => {
      const message = {
        type: 'fluxappinstalling',
        version: 3,
        name: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('version 3 not supported');
    });

    it('should return error for version 2 without announcedAt', async () => {
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('announcedAt required for version 2');
    });

    it('should store valid installing message', async () => {
      const message = {
        type: 'fluxappinstalling',
        version: 1,
        name: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.calledOnce).to.be.true;
    });

    it('should store version 2 message with announcedAt on the row', async () => {
      const broadcastedAt = Date.now();
      const announcedAt = broadcastedAt - 1000;
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        announcedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      const setDoc = dbHelperStub.updateOneInDatabase.firstCall.args[3].$set;
      expect(setDoc.announcedAt).to.deep.equal(new Date(announcedAt));
      expect(setDoc.broadcastedAt).to.deep.equal(new Date(broadcastedAt));
      expect(setDoc.expireAt).to.deep.equal(new Date(broadcastedAt + 15 * 60 * 1000));
    });

    it('keys the claim row by replica: a tagged claim upserts (name, ip, replica)', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        replica: 's1',
        announcedAt: broadcastedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.findOneInDatabase.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', replica: 's1' });
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', replica: 's1' });
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[3].$set.replica).to.equal('s1');
    });

    it('an untagged claim keys replica null (matches legacy rows without the field)', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        announcedAt: broadcastedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', replica: null });
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[3].$set.replica).to.equal(null);
    });

    it('should refresh the row on a renewal (newer broadcastedAt, same announcedAt)', async () => {
      const announcedAt = Date.now() - 10 * 60 * 1000;
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        announcedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'testapp', ip: '192.168.1.1', announcedAt: new Date(announcedAt), broadcastedAt: new Date(announcedAt),
      });
      dbHelperStub.updateOneInDatabase.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      const setDoc = dbHelperStub.updateOneInDatabase.firstCall.args[3].$set;
      expect(setDoc.announcedAt).to.deep.equal(new Date(announcedAt));
      expect(setDoc.expireAt).to.deep.equal(new Date(broadcastedAt + 15 * 60 * 1000));
    });

    it('should reject a duplicate or older message than the stored row', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        announcedAt: broadcastedAt,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'testapp', ip: '192.168.1.1', broadcastedAt: new Date(broadcastedAt + 5000),
      });

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.false;
      expect(dbHelperStub.updateOneInDatabase.called).to.be.false;
    });

    it('should delete the row and archived broadcast on a withdrawal', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        withdrawn: true,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([{ broadcastedAt: new Date(broadcastedAt - 60 * 1000) }]);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.called).to.be.false;
      expect(dbHelperStub.removeDocumentsFromCollection.calledTwice).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[1]).to.equal('appsInstallingLocations');
      // An untagged clear releases EVERY (name, ip) row - the v1/loose whole-app semantics.
      // Both deletes carry the not-newer-than-the-clear guard: the read proved the stored
      // claim was not newer a moment ago, the guard proves it at the moment of deletion.
      const clearGuard = { broadcastedAt: { $lte: new Date(broadcastedAt) } };
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', ...clearGuard });
      expect(dbHelperStub.removeDocumentsFromCollection.secondCall.args[2]).to.deep.equal({ 'data.name': 'testapp', 'data.ip': '192.168.1.1', ...clearGuard });
    });

    it('a tagged clear releases exactly its replica row and archived announce', async () => {
      const broadcastedAt = Date.now();
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        replica: 's1',
        withdrawn: true,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([]);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      const clearGuard = { broadcastedAt: { $lte: new Date(broadcastedAt) } };
      expect(dbHelperStub.removeDocumentsFromCollection.firstCall.args[2]).to.deep.equal({ name: 'testapp', ip: '192.168.1.1', replica: 's1', ...clearGuard });
      expect(dbHelperStub.removeDocumentsFromCollection.secondCall.args[2]).to.deep.equal({ 'data.name': 'testapp', 'data.ip': '192.168.1.1', 'data.replica': 's1', ...clearGuard });
    });

    it('should ignore a stale withdrawal that arrives after a newer announce', async () => {
      const broadcastedAt = Date.now() - 60 * 1000;
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        withdrawn: true,
        broadcastedAt,
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([{ broadcastedAt: new Date(broadcastedAt + 30 * 1000) }]);

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.false;
      expect(dbHelperStub.removeDocumentsFromCollection.called).to.be.false;
    });

    it('should relay a withdrawal with no stored row (peers may still hold one)', async () => {
      const message = {
        type: 'fluxappinstalling',
        version: 2,
        name: 'testapp',
        withdrawn: true,
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findInDatabase.resolves([]);
      dbHelperStub.removeDocumentsFromCollection.resolves();

      const result = await messageStore.storeAppInstallingMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.calledTwice).to.be.true;
    });
  });

  describe('storeSignedAppInstallingBroadcast', () => {
    it('should archive a normal installing broadcast', async () => {
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves();

      await messageStore.storeSignedAppInstallingBroadcast({
        version: 1,
        timestamp: Date.now(),
        pubKey: 'pub',
        signature: 'sig',
        data: { name: 'testapp', ip: '192.168.1.1', broadcastedAt: Date.now() },
      });

      expect(dbHelperStub.updateOneInDatabase.calledOnce).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.firstCall.args[2]).to.deep.equal({
        'data.name': 'testapp', 'data.ip': '192.168.1.1', 'data.replica': null,
      });
    });

    it('archives one announce per claim identity (data.replica in the key)', async () => {
      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.updateOneInDatabase.resolves();

      await messageStore.storeSignedAppInstallingBroadcast({
        version: 1,
        timestamp: Date.now(),
        pubKey: 'pub',
        signature: 'sig',
        data: { name: 'testapp', ip: '192.168.1.1', replica: 's2', broadcastedAt: Date.now() },
      });

      expect(dbHelperStub.updateOneInDatabase.firstCall.args[2]).to.deep.equal({
        'data.name': 'testapp', 'data.ip': '192.168.1.1', 'data.replica': 's2',
      });
    });

    it('should not archive a withdrawn broadcast', async () => {
      await messageStore.storeSignedAppInstallingBroadcast({
        version: 1,
        timestamp: Date.now(),
        pubKey: 'pub',
        signature: 'sig',
        data: { name: 'testapp', ip: '192.168.1.1', broadcastedAt: Date.now(), withdrawn: true },
      });

      expect(dbHelperStub.updateOneInDatabase.called).to.be.false;
    });
  });

  describe('storeBatchAppInstallingMessages', () => {
    it('hash-sync intake keys archive and location rows per claim identity', async () => {
      const broadcastedAt = Date.now();
      const bulkWriteStub = sinon.stub().resolves();
      const mockDatabase = { collection: sinon.stub().returns({ bulkWrite: bulkWriteStub }) };
      const mockDb = { db: sinon.stub().returns(mockDatabase) };
      dbHelperStub.databaseConnection.returns(mockDb);

      const result = await messageStore.storeBatchAppInstallingMessages([{
        version: 1,
        timestamp: broadcastedAt,
        pubKey: 'pub',
        signature: 'sig',
        receivedAt: broadcastedAt,
        data: {
          name: 'testapp', ip: '192.168.1.1', replica: 's1', announcedAt: broadcastedAt, broadcastedAt,
        },
      }]);

      expect(result).to.deep.equal({ stored: 1 });
      const signedOps = bulkWriteStub.firstCall.args[0];
      expect(signedOps[0].updateOne.filter).to.deep.equal({
        'data.name': 'testapp', 'data.ip': '192.168.1.1', 'data.replica': 's1',
      });
      const locationOps = bulkWriteStub.secondCall.args[0];
      expect(locationOps[0].updateOne.filter).to.deep.equal({
        name: 'testapp', ip: '192.168.1.1', replica: 's1',
      });
      expect(locationOps[0].updateOne.update[0].$set.replica).to.equal('s1');
      // Elections rank on announcedAt; a sync intake that dropped it would
      // silently reorder contenders on freshly synced nodes.
      expect(locationOps[0].updateOne.update[0].$set.announcedAt).to.exist;
      // The identity is written flat (it is what the filter matched), but every
      // recency-bearing field goes through the newer-wins guard - a late-arriving
      // older claim must not roll the row's timestamps backwards.
      expect(locationOps[0].updateOne.update[0].$set.broadcastedAt).to.have.property('$cond');
      expect(locationOps[0].updateOne.update[0].$set.expireAt).to.have.property('$cond');
      expect(locationOps[0].updateOne.update[0].$set.announcedAt).to.have.property('$cond');
    });

    // The batch path's retraction handling had NO test, which is how a skip line
    // above it - left by the side of the merge that had no retraction handling at
    // all - shadowed it unnoticed for one spelling. Nothing constructed a batch
    // retraction, so nothing could see that it was dropped.
    it('a withdrawal in a batch deletes the claim rather than archiving it', async () => {
      const broadcastedAt = Date.now();
      const bulkWriteStub = sinon.stub().resolves();
      const mockDatabase = { collection: sinon.stub().returns({ bulkWrite: bulkWriteStub }) };
      const mockDb = { db: sinon.stub().returns(mockDatabase) };
      dbHelperStub.databaseConnection.returns(mockDb);

      const result = await messageStore.storeBatchAppInstallingMessages([{
        version: 2,
        timestamp: broadcastedAt,
        pubKey: 'pub',
        signature: 'sig',
        receivedAt: broadcastedAt,
        // version 2 on the DATA, not only the envelope: the envelope's version is
        // the broadcast format and the message's own is what says claim vs
        // retraction. No announcedAt - a retraction asserts no claim.
        data: {
          version: 2,
          name: 'testapp',
          ip: '192.168.1.1',
          replica: 's1',
          broadcastedAt,
          withdrawn: true,
        },
      }]);

      // `stored` counts what was APPLIED, claims stored and withdrawals applied
      // alike - so a retraction that reached the delete counts, and one skipped
      // before it would not.
      expect(result).to.deep.equal({ stored: 1 });

      const calls = bulkWriteStub.getCalls().map((c) => c.args[0]);
      const deletes = calls.flat().filter((op) => op.deleteMany);
      expect(deletes, 'the retraction must reach the delete, not be skipped').to.not.be.empty;
      // Its own replica's seat, and only a claim older than the retraction - one
      // arriving after the sender claimed again must not erase the newer claim.
      expect(deletes[0].deleteMany.filter).to.include({
        name: 'testapp', ip: '192.168.1.1', replica: 's1',
      });
      expect(deletes[0].deleteMany.filter.broadcastedAt).to.have.property('$lt');
      // And nothing archived it: archiving a retraction re-serves a dead claim.
      const upserts = calls.flat().filter((op) => op.updateOne);
      expect(upserts, 'a retraction is not a claim to store').to.be.empty;
    });
  });

  describe('storeAppRemovedMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxappremoved' };

      const result = await messageStore.storeAppRemovedMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App Removed message');
    });

    it('should return error for empty appName', async () => {
      const message = {
        type: 'fluxappremoved',
        version: 1,
        appName: '',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const result = await messageStore.storeAppRemovedMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('appName cannot be empty');
    });

    it('accepts a removal for relay without deleting any row', async () => {
      const message = {
        type: 'fluxappremoved',
        version: 1,
        appName: 'testapp',
        broadcastedAt: Date.now(),
        ip: '192.168.1.1',
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);

      const result = await messageStore.storeAppRemovedMessage(message);

      expect(result).to.be.true;
      // The removal is recorded in the event log; the derivation drops the app from
      // the node's running set off that event, so there is nothing to delete here.
      expect(dbHelperStub.removeDocumentsFromCollection.called).to.be.false;
    });
  });

  describe('storeAppInstallingErrorMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxappinstallingerror' };

      const result = await messageStore.storeAppInstallingErrorMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux App Installing Error message');
    });

    it('should store valid error message and clean up installing record', async () => {
      const message = {
        type: 'fluxappinstallingerror',
        version: 1,
        name: 'testapp',
        hash: 'hash123',
        ip: '192.168.1.1',
        error: 'Installation failed',
        broadcastedAt: Date.now(),
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();
      dbHelperStub.removeDocumentsFromCollection.resolves();
      dbHelperStub.countInDatabase.resolves(1);

      const result = await messageStore.storeAppInstallingErrorMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.updateOneInDatabase.calledOnce).to.be.true;
      // Should clean up installing record since installation failed (location + broadcast)
      expect(dbHelperStub.removeDocumentsFromCollection.callCount).to.equal(2);
      expect(dbHelperStub.removeDocumentsFromCollection.calledWith(
        'database',
        'appsInstallingLocations',
        { name: 'testapp', ip: '192.168.1.1' },
      )).to.be.true;
    });

    it('should update cache settings when error count reaches threshold', async () => {
      const message = {
        type: 'fluxappinstallingerror',
        version: 1,
        name: 'testapp',
        hash: 'hash123',
        ip: '192.168.1.1',
        error: 'Installation failed',
        broadcastedAt: Date.now(),
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);
      dbHelperStub.findOneInDatabase.resolves(null);
      dbHelperStub.updateOneInDatabase.resolves();
      dbHelperStub.removeDocumentsFromCollection.resolves();
      dbHelperStub.countInDatabase.resolves(5);
      dbHelperStub.updateInDatabase.resolves();

      const result = await messageStore.storeAppInstallingErrorMessage(message);

      expect(result).to.be.true;
      expect(dbHelperStub.removeDocumentsFromCollection.callCount).to.equal(2);
    });
  });

  describe('storeIPChangedMessage', () => {
    it('should return error for invalid message structure', async () => {
      const invalidMessage = { type: 'fluxipchanged' };

      const result = await messageStore.storeIPChangedMessage(invalidMessage);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('Invalid Flux IP Changed message');
    });

    it('should return error for empty IPs', async () => {
      const message = {
        type: 'fluxipchanged',
        version: 1,
        oldIP: '',
        newIP: '',
        broadcastedAt: Date.now(),
      };

      const result = await messageStore.storeIPChangedMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('oldIP and newIP cannot be empty');
    });

    it('should return error when oldIP equals newIP', async () => {
      const message = {
        type: 'fluxipchanged',
        version: 1,
        oldIP: '192.168.1.1',
        newIP: '192.168.1.1',
        broadcastedAt: Date.now(),
      };

      const result = await messageStore.storeIPChangedMessage(message);

      expect(result).to.be.instanceOf(Error);
      expect(result.message).to.include('oldIP and newIP are the same');
    });

    it('accepts an address move for relay without rewriting any row', async () => {
      const message = {
        type: 'fluxipchanged',
        version: 1,
        oldIP: '192.168.1.1',
        newIP: '192.168.1.2',
        broadcastedAt: Date.now(),
      };

      const mockDb = { db: sinon.stub().returns('database') };
      dbHelperStub.databaseConnection.returns(mockDb);

      const result = await messageStore.storeIPChangedMessage(message);

      expect(result).to.be.true;
      // The move is recorded in the event log; the derivation re-addresses the
      // node's announcements off it rather than mutating stored rows.
      expect(dbHelperStub.updateInDatabase.called).to.be.false;
    });
  });

  describe('appRunningBroadcastOf', () => {
    function databaseAnswering(findOne) {
      dbHelperStub.databaseConnection.returns({
        db: sinon.stub().returns({ collection: sinon.stub().returns({ findOne }) }),
      });
      return findOne;
    }

    it('reassembles this node\'s latest announcement as it was broadcast', async () => {
      const envelope = {
        version: 1, timestamp: 5, pubKey: 'pk', signature: 'sig',
      };
      const data = { type: 'fluxapprunning', version: 2, ip: '1.2.3.4:16127', broadcastedAt: 5, apps: [] };
      const findOne = databaseAnswering(sinon.stub().resolves({ envelope, data }));
      const got = await messageStore.appRunningBroadcastOf('1.2.3.4:16127');
      expect(got).to.deep.equal({ ...envelope, data });
      expect(findOne.firstCall.args[0]).to.deep.equal({ ip: '1.2.3.4:16127', type: 'apprunning', dedupKey: 'v2' });
    });

    it('answers null before the first announcement', async () => {
      databaseAnswering(sinon.stub().resolves(null));
      expect(await messageStore.appRunningBroadcastOf('1.2.3.4:16127')).to.equal(null);
    });

    it('answers null for an event stored without its envelope — nothing a peer could verify', async () => {
      databaseAnswering(sinon.stub().resolves({ data: { type: 'fluxapprunning', ip: '1.2.3.4:16127' } }));
      expect(await messageStore.appRunningBroadcastOf('1.2.3.4:16127')).to.equal(null);
    });
  });

  describe('storeAppStateEvent', () => {
    let collectionStub;

    beforeEach(() => {
      collectionStub = {
        updateOne: sinon.stub().resolves({ modifiedCount: 1 }),
        bulkWrite: sinon.stub().resolves({}),
      };
      const mockDb = { db: sinon.stub().returns({ collection: sinon.stub().returns(collectionStub) }) };
      dbHelperStub.databaseConnection.returns(mockDb);
    });

    describe('a node\'s alive record', () => {
      const alive = (broadcastedAt, announcer) => ({
        message: { type: 'fluxnodealive', version: 1, ip: '1.2.3.4:16127', broadcastedAt },
        envelope: { version: 1, timestamp: broadcastedAt, pubKey: 'pk', signature: 'sig' },
        announcer,
      });

      it('is one row per node, keyed on the announcer\'s outpoint, newest wins', async () => {
        dbHelperStub.findOneAndUpdateInDatabase.resolves(null);
        const now = Date.now();
        const result = await messageStore.storeAppStateEvent(
          messageStore.APP_STATE_EVENT_TYPES.NODEALIVE, alive(now, { txhash: 'tx', outidx: 1 }),
        );
        expect(result).to.deep.equal({ isNewer: true });
        const [, , filter, update] = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args;
        expect(filter).to.deep.equal({ type: 'nodealive', dedupKey: 'nodealive:tx:1' });
        const written = JSON.stringify(update);
        expect(written).to.include('"outpoint":');
        expect(written).to.include('"tx:1"');
      });

      it('refutes nobody when its announcer is unresolved', async () => {
        const result = await messageStore.storeAppStateEvent(
          messageStore.APP_STATE_EVENT_TYPES.NODEALIVE, alive(Date.now(), null),
        );
        expect(result).to.deep.equal({ isNewer: false });
        expect(dbHelperStub.findOneAndUpdateInDatabase.called).to.equal(false);
      });
    });

    // What damps the gossip: an announcement that advances nothing is not passed on,
    // so it dies here instead of circulating. Derived from the stored broadcast
    // timestamp, NOT from whether the write modified anything - receivedAt is written
    // unconditionally, so a modified count is true even for a stale echo.
    describe('gossip damping', () => {
      const announcement = (broadcastedAt) => ({
        signedBroadcast: {
          version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
          data: { ip: '1.2.3.4', broadcastedAt, apps: [{ name: 'a', hash: 'h' }] },
        },
      });

      it('is news when we held nothing for the node', async () => {
        dbHelperStub.findOneAndUpdateInDatabase.resolves(null);

        const result = await messageStore.storeAppStateEvent(
          messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, announcement(Date.now()),
        );

        expect(result).to.deep.equal({ isNewer: true });
      });

      it('is news when it advances the stored announcement', async () => {
        const now = Date.now();
        dbHelperStub.findOneAndUpdateInDatabase.resolves({ broadcastedAt: new Date(now - 60_000) });

        const result = await messageStore.storeAppStateEvent(
          messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, announcement(now),
        );

        expect(result).to.deep.equal({ isNewer: true });
      });

      it('is NOT news when an older announcement arrives late', async () => {
        const now = Date.now();
        dbHelperStub.findOneAndUpdateInDatabase.resolves({ broadcastedAt: new Date(now) });

        const result = await messageStore.storeAppStateEvent(
          messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, announcement(now - 60_000),
        );

        expect(result).to.deep.equal({ isNewer: false });
      });

      it('is NOT news when the same announcement is seen again', async () => {
        const now = Date.now();
        dbHelperStub.findOneAndUpdateInDatabase.resolves({ broadcastedAt: new Date(now) });

        const result = await messageStore.storeAppStateEvent(
          messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, announcement(now),
        );

        expect(result).to.deep.equal({ isNewer: false });
      });
    });

    it('should store apprunning v2 event with correct dedupKey', async () => {
      const payload = {
        signedBroadcast: {
          version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
          data: { ip: '1.2.3.4', broadcastedAt: Date.now(), apps: [{ name: 'a', hash: 'h' }] },
        },
      };
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, payload);
      expect(dbHelperStub.findOneAndUpdateInDatabase.calledOnce).to.be.true;
      const filter = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args[2];
      expect(filter.ip).to.equal('1.2.3.4');
      expect(filter.type).to.equal('apprunning');
      expect(filter.dedupKey).to.equal('v2');
    });

    it('records the announcer chain identity the verification layer resolved', async () => {
      const payload = {
        signedBroadcast: {
          version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
          data: { ip: '1.2.3.4', broadcastedAt: Date.now(), apps: [{ name: 'a', hash: 'h' }] },
        },
        announcer: { txhash: 'd3ffeeb8b470', outidx: '0', pubkey: 'pk' },
      };
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, payload);
      const [{ $set: set }] = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args[3];
      // conditional fields are [isNewer, valueWhenNewer, keepWhatIsStored]
      expect(set.outpoint.$cond[1]).to.equal('d3ffeeb8b470:0');
    });

    it('leaves the outpoint null when no announcer was resolved', async () => {
      // Sync-delivered rows arrive without one; null means unknown rather than absent,
      // and the node's next direct announcement fills it in.
      const payload = {
        signedBroadcast: {
          version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
          data: { ip: '1.2.3.4', broadcastedAt: Date.now(), apps: [{ name: 'a', hash: 'h' }] },
        },
      };
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, payload);
      const [{ $set: set }] = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args[3];
      expect(set.outpoint.$cond[1]).to.equal(null);
    });

    it('records the announcer identity on sync-delivered rows too, keyed per broadcast', async () => {
      // Sync catch-up must attribute rows the same way live gossip does, or the two
      // delivery routes disagree about who a row belongs to.
      const broadcastFor = (ip) => ({
        version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
        data: { ip, broadcastedAt: Date.now(), apps: [{ name: 'a', hash: 'h' }] },
      });
      const first = broadcastFor('1.2.3.4:16127');
      const second = broadcastFor('5.6.7.8:16127');
      const announcers = new Map([
        [first, { txhash: 'aaa', outidx: '0' }],
        [second, { txhash: 'bbb', outidx: '2' }],
      ]);

      const { stored } = await messageStore.storeBatchAppRunningEvents([first, second], announcers);

      expect(stored).to.equal(2);
      const ops = collectionStub.bulkWrite.firstCall.args[0];
      const outpointIn = (op) => op.updateOne.update[0].$set.outpoint.$cond[1];
      expect(ops.map(outpointIn)).to.deep.equal(['aaa:0', 'bbb:2']);
    });

    it('should store apprunning v1 event with name in dedupKey', async () => {
      const payload = {
        signedBroadcast: {
          version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
          data: { ip: '1.2.3.4', broadcastedAt: Date.now(), name: 'myapp', hash: 'h' },
        },
      };
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPRUNNING, payload);
      expect(dbHelperStub.findOneAndUpdateInDatabase.calledOnce).to.be.true;
      const filter = dbHelperStub.findOneAndUpdateInDatabase.firstCall.args[2];
      expect(filter.dedupKey).to.equal('v1:myapp');
    });

    it('should store appremoved event', async () => {
      await messageStore.storeAppStateEvent(messageStore.APP_STATE_EVENT_TYPES.APPREMOVED, {
        message: { ip: '1.2.3.4', appName: 'myapp', broadcastedAt: Date.now() },
        envelope: { version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig' },
      });
      expect(collectionStub.updateOne.calledOnce).to.be.true;
      const filter = collectionStub.updateOne.firstCall.args[0];
      expect(filter.type).to.equal('appremoved');
      expect(filter.dedupKey).to.equal('appremoved:myapp');
    });

    const apprunningPayload = (broadcastedAt) => ({
      signedBroadcast: {
        version: 1, timestamp: Date.now(), pubKey: 'pk', signature: 'sig',
        data: { ip: '1.2.3.4', broadcastedAt, apps: [{ name: 'a', hash: 'h' }] },
      },
    });

    // Assert on findOneAndUpdateInDatabase: the apprunning path never calls
    // collectionStub.updateOne, so asserting that stub proves nothing either way.
    // Count deltas rather than the sticky `called` flag, so the assertion holds
    // regardless of what earlier suites left on the shared stub.
    const storeApprunning = async (broadcastedAt) => {
      const before = dbHelperStub.findOneAndUpdateInDatabase.callCount;
      await messageStore.storeAppStateEvent(
        messageStore.APP_STATE_EVENT_TYPES.APPRUNNING,
        apprunningPayload(broadcastedAt),
      );
      return dbHelperStub.findOneAndUpdateInDatabase.callCount - before;
    };

    it('should reject expired apprunning events', async () => {
      expect(await storeApprunning(Date.now() - (130 * 60 * 1000))).to.equal(0);
    });

    // broadcastedAt is both the newer-wins ordering key and the source of expireAt, so a
    // future-dated value would win every comparison indefinitely AND set a TTL that never
    // fires. The staleness check above is one-sided and does not catch it.
    it('should reject future-dated apprunning events beyond the clock-skew allowance', async () => {
      expect(await storeApprunning(Date.now() + (365 * 24 * 60 * 60 * 1000))).to.equal(0);
    });

    it('should accept an apprunning event inside the clock-skew allowance', async () => {
      expect(await storeApprunning(Date.now() + 30_000)).to.equal(1);
    });

    // Pin the boundary relative to the configured allowance, not to a fixed offset:
    // +30s and +1yr above hold for almost any allowance, so on their own they leave the
    // actual value unguarded.
    it('should accept right up to the clock-skew allowance and reject just past it', async () => {
      const allowance = STUB_CLOCK_SKEW_ALLOWANCE_MS;
      expect(await storeApprunning(Date.now() + allowance - 1000)).to.equal(1);
      expect(await storeApprunning(Date.now() + allowance + 1000)).to.equal(0);
    });
  });
});
