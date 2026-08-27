'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const domain = require('./fixtures/appDomain');

chai.use(chaiAsPromised);
const { expect } = chai;

describe('appEventVerifier', () => {
  let specLibsStub;
  let signatureVerifierStub;
  let chainUtilitiesStub;
  let configStub;
  let benchmarkServiceStub;
  let arcaneAttestationStub;
  let appEventVerifier;
  let realBackend;

  before(async () => {
    realBackend = await require('@runonflux/flux-spec-cjs').load();
  });

  // Minimal AppEvent class double — just enough surface for authorize() to
  // exercise the FluxOS authority logic without needing a real spec class.
  class FakeAppEvent {
    constructor({
      spec, hashValid = true, isUpdate = false,
      validSignersByIteration = [], renewalVerdict = 'changed',
      hash = 'not-a-grandfathered-hash',
    }) {
      this.spec = spec;
      this.hash = hash;
      this.isUpdate = isUpdate;
      this.isRegistration = !isUpdate;
      this._hashValid = hashValid;
      this._validSignersByIteration = validSignersByIteration;
      this._iteration = 0;
      this._renewalVerdict = renewalVerdict;
    }

    verifyHash() {
      return { valid: this._hashValid };
    }

    async assessRenewal() {
      return this._renewalVerdict;
    }

    async verifySignature(verifyFn, signers) {
      const validSet = this._validSignersByIteration[this._iteration] || new Set();
      this._iteration += 1;
      for (const signer of signers) {
        if (validSet.has(signer)) {
          return { valid: true, signer };
        }
      }
      return { valid: false, signer: null };
    }
  }


  // Minimal spec-backend registry double. Supports getVersionClass lookups.
  const registeredVersionClasses = {};
  class FakeFluxAppSpecBase {
    static getVersionClass(v) { return registeredVersionClasses[v]; }
  }
  class FakeFluxAppSpecV8 {
    static deserialize(blob) { return { ...blob, _kind: 'v8' }; }
  }

  const fakeUpdatePolicy = {
    extensionSignerPermitted: (verdict) => verdict === 'unchanged' || verdict === 'unverifiable',
  };

  beforeEach(() => {
    registeredVersionClasses[8] = FakeFluxAppSpecV8;

    specLibsStub = {
      getSpec: sinon.stub().resolves({
        FluxAppSpecBase: FakeFluxAppSpecBase,
        UpdatePolicy: fakeUpdatePolicy,
      }),
      // The real event classes, because which one a message is dispatched to is
      // only worth asserting on a message that class would actually accept — a
      // marker double accepts anything, including documents neither class could
      // ever deserialize. Hashing and attestation stay stubbed: those reach the
      // crypto and benchmark surfaces, which do leave the process.
      getSpecBackend: sinon.stub().resolves({
        AppEventLegacy: realBackend.AppEventLegacy,
        ConfirmedAppEvent: realBackend.ConfirmedAppEvent,
        computeMessageHash: sinon.stub().returns('v1-hash-abc'),
        computeMessageHashV2: sinon.stub().returns('v2-hash-xyz'),
        // The payload the node sends to be signed: both hashes, no domain — the
        // secure backend prefixes that itself under the `app` purpose.
        buildArcaneAttestPayload: sinon.stub().callsFake((h, e) => `${h}${e}`),
        envelopeHash: sinon.stub().callsFake(() => 'e'.repeat(64)),
        ARCANE_ATTEST_PURPOSE: 'app',
      }),
    };

    benchmarkServiceStub = {
      attest: sinon.stub(),
    };

    arcaneAttestationStub = {
      ARCANE_APP_ATTESTATION_PUBKEY: 'test-app-attestation-pubkey',
      verifyAttestationSignature: sinon.stub(),
    };

    signatureVerifierStub = {
      verifySignature: sinon.stub().returns(false),
    };

    chainUtilitiesStub = {
      getChainTeamSupportAddressUpdates: sinon.stub().returns([]),
    };

    configStub = {
      fluxapps: {
        usersToExtend: ['extender1'],
      },
    };

    appEventVerifier = proxyquire(
      '../../ZelBack/src/services/appMessaging/appEventVerifier',
      {
        config: configStub,
        '../utils/specLibs': specLibsStub,
        '../signatureVerifier': signatureVerifierStub,
        '../benchmarkService': benchmarkServiceStub,
        '../utils/arcaneAttestation': arcaneAttestationStub,
        '../utils/chainUtilities': chainUtilitiesStub,
      },
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('deserializeMessage', () => {
    // Asserted on the type that comes back rather than on a marker, and over
    // messages each class will really accept: a v1 envelope carries a v8 spec,
    // a v2 envelope a v9 one. A marker double answers for any document at all,
    // so it can show a message routed somewhere that would have refused it.
    it('dispatches envelope version 1 to AppEventLegacy', async () => {
      const msg = await domain.tempMessage({ version: 1 });
      const result = await appEventVerifier.deserializeMessage(msg);
      expect(result).to.be.instanceOf(realBackend.AppEventLegacy);
    });

    it('dispatches envelope version 2 to ConfirmedAppEvent', async () => {
      const msg = await domain.tempMessage({ version: 2 });
      const result = await appEventVerifier.deserializeMessage(msg);
      expect(result).to.be.instanceOf(realBackend.ConfirmedAppEvent);
    });

    it('falls back to AppEventLegacy for any other/legacy envelope version', async () => {
      // Wire history has some zel*register messages with non-integer version
      // fields. AppEventLegacy is the compatibility path.
      const msg = await domain.tempMessage({ version: 0, type: 'zelappregister' });
      const result = await appEventVerifier.deserializeMessage(msg);
      expect(result).to.be.instanceOf(realBackend.AppEventLegacy);
    });
  });

  describe('isMarketplaceApp', () => {
    const { isMarketplaceApp } = require('../../ZelBack/src/services/appMessaging/appEventVerifier')._internal;

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

  describe('resolveTeamSupportAddress', () => {
    it('returns null when no forks are active at the given height', () => {
      chainUtilitiesStub.getChainTeamSupportAddressUpdates.returns([
        { address: 'teamA', height: 2000000 },
      ]);
      const { resolveTeamSupportAddress } = proxyquire(
        '../../ZelBack/src/services/appMessaging/appEventVerifier',
        {
          config: configStub,
          '../utils/specLibs': specLibsStub,
          '../signatureVerifier': signatureVerifierStub,
          '../utils/chainUtilities': chainUtilitiesStub,
        },
      )._internal;
      expect(resolveTeamSupportAddress(1000000)).to.be.null;
    });

    it('returns the most recent fork at or below the given height', () => {
      chainUtilitiesStub.getChainTeamSupportAddressUpdates.returns([
        { address: 'teamA', height: 1000000 },
        { address: 'teamB', height: 2000000 },
      ]);
      const { resolveTeamSupportAddress } = proxyquire(
        '../../ZelBack/src/services/appMessaging/appEventVerifier',
        {
          config: configStub,
          '../utils/specLibs': specLibsStub,
          '../signatureVerifier': signatureVerifierStub,
          '../utils/chainUtilities': chainUtilitiesStub,
        },
      )._internal;
      expect(resolveTeamSupportAddress(1500000)).to.equal('teamA');
      expect(resolveTeamSupportAddress(2500000)).to.equal('teamB');
    });
  });

  describe('authorize', () => {
    it('throws if verifyHash reports invalid', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'myapp' },
        hashValid: false,
      });

      await expect(
        appEventVerifier.authorize({ appEvent, daemonHeight: 1000 }),
      ).to.be.rejectedWith(/Invalid Flux App hash/);
    });

    it('accepts a registration signed by the spec owner', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'myapp' },
        isUpdate: false,
        validSignersByIteration: [new Set(['ownerA'])],
      });
      const result = await appEventVerifier.authorize({ appEvent, daemonHeight: 1000 });
      expect(result).to.deep.equal({ valid: true, signer: 'ownerA' });
    });

    it('accepts an update signed by the previous owner (ownership transfer)', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'newOwner', name: 'myapp' },
        isUpdate: true,
        validSignersByIteration: [new Set(['oldOwner'])],
      });
      const previousState = { owner: 'oldOwner' };
      const result = await appEventVerifier.authorize({
        appEvent, previousState, daemonHeight: 1000,
      });
      expect(result.signer).to.equal('oldOwner');
    });

    // The owner named in an incoming update is a claim, not an authority. If it
    // were a signer, anyone could take an app over by naming themselves in an
    // update and signing it with their own key.
    it('refuses an update signed by the owner it names rather than the owner it has', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'attacker', name: 'myapp' },
        isUpdate: true,
        validSignersByIteration: [new Set(['attacker']), new Set(['attacker'])],
      });

      await expect(appEventVerifier.authorize({
        appEvent,
        previousState: { owner: 'realOwner' },
        daemonHeight: 1000,
      })).to.be.rejectedWith(/does not correspond with Flux App owner/);
    });

    it('refuses an update with no app to update, however it is signed', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'anyone', name: 'myapp' },
        isUpdate: true,
        validSignersByIteration: [new Set(['anyone'])],
      });

      await expect(appEventVerifier.authorize({
        appEvent, previousState: null, daemonHeight: 1000,
      })).to.be.rejectedWith(/no registration to update/);
    });

    it('adds the team-support address as an allowed signer for marketplace apps', async () => {
      chainUtilitiesStub.getChainTeamSupportAddressUpdates.returns([
        { address: 'teamSupport', height: 1000000 },
      ]);
      appEventVerifier = proxyquire(
        '../../ZelBack/src/services/appMessaging/appEventVerifier',
        {
          config: configStub,
          '../utils/specLibs': specLibsStub,
          '../signatureVerifier': signatureVerifierStub,
          '../utils/chainUtilities': chainUtilitiesStub,
        },
      );

      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'wordpress1735018430692' },
        isUpdate: true,
        validSignersByIteration: [new Set(['teamSupport'])],
      });
      const result = await appEventVerifier.authorize({
        appEvent,
        previousState: { owner: 'ownerA' },
        daemonHeight: 2000000,
      });
      expect(result.signer).to.equal('teamSupport');
    });

    it('does not offer team-support as a signer before its activation height', async () => {
      chainUtilitiesStub.getChainTeamSupportAddressUpdates.returns([
        { address: 'teamSupport', height: 2000000 },
      ]);
      appEventVerifier = proxyquire(
        '../../ZelBack/src/services/appMessaging/appEventVerifier',
        {
          config: configStub,
          '../utils/specLibs': specLibsStub,
          '../signatureVerifier': signatureVerifierStub,
          '../utils/chainUtilities': chainUtilitiesStub,
        },
      );

      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'wordpress1735018430692' },
        isUpdate: true,
        validSignersByIteration: [new Set(['teamSupport']), new Set()],
      });
      await expect(appEventVerifier.authorize({
        appEvent,
        previousState: { owner: 'ownerA' },
        daemonHeight: 1000000,
      })).to.be.rejectedWith(/does not correspond with Flux App owner/);
    });

    it('accepts a usersToExtend signer for a content-unchanged renewal', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'myapp' },
        isUpdate: true,
        renewalVerdict: 'unchanged',
        // First pass (owner + previousOwner + teamSupport) fails; second
        // pass (usersToExtend) succeeds.
        validSignersByIteration: [new Set(), new Set(['extender1'])],
      });
      const result = await appEventVerifier.authorize({
        appEvent,
        previousState: { owner: 'ownerA' },
        daemonHeight: 1000,
      });
      expect(result.signer).to.equal('extender1');
    });

    it('rejects a usersToExtend signer when the renewal changes content', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'myapp' },
        isUpdate: true,
        renewalVerdict: 'changed',
        validSignersByIteration: [new Set(), new Set(['extender1'])],
      });
      await expect(appEventVerifier.authorize({
        appEvent,
        previousState: { owner: 'ownerA' },
        daemonHeight: 1000,
      })).to.be.rejectedWith(/does not correspond with Flux App owner/);
    });

    it('throws on an unauthorized signature after all passes', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'myapp' },
        isUpdate: false,
        validSignersByIteration: [new Set()],
      });
      await expect(
        appEventVerifier.authorize({ appEvent, daemonHeight: 1000 }),
      ).to.be.rejectedWith(/does not correspond with Flux App owner/);
    });
  });

  describe('authorize (verifyHash option)', () => {
    it('skips the hash check when verifyHash: false is passed (origination path)', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'myapp' },
        hashValid: false, // would normally fail
        validSignersByIteration: [new Set(['ownerA'])],
      });
      const result = await appEventVerifier.authorize({
        appEvent, daemonHeight: 1000, verifyHash: false,
      });
      expect(result.valid).to.be.true;
    });

    it('still runs the hash check by default (receiving path)', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'ownerA', name: 'myapp' },
        hashValid: false,
      });
      await expect(
        appEventVerifier.authorize({ appEvent, daemonHeight: 1000 }),
      ).to.be.rejectedWith(/Invalid Flux App hash/);
    });
  });

  describe('computeOutboundHash', () => {
    it('delegates envelope v1 to computeMessageHash with the spec blob', async () => {
      const hash = await appEventVerifier.computeOutboundHash({
        type: 'fluxappregister',
        envelopeVersion: 1,
        specBlob: { name: 'myapp', version: 8 },
        timestamp: 12345,
        signature: 'sig',
      });
      expect(hash).to.equal('v1-hash-abc');

      const backend = await specLibsStub.getSpecBackend();
      expect(backend.computeMessageHash.calledOnce).to.be.true;
      const { args } = backend.computeMessageHash.firstCall;
      expect(args).to.deep.equal([
        'fluxappregister', 1, { name: 'myapp', version: 8 }, 12345, 'sig',
      ]);
    });

    it('delegates envelope v2 to computeMessageHashV2 with the content hash and extend flag', async () => {
      const hash = await appEventVerifier.computeOutboundHash({
        type: 'fluxappregister',
        envelopeVersion: 2,
        contentHash: 'deadbeef',
        timestamp: 12345,
        extend: true,
        signature: 'sig',
      });
      expect(hash).to.equal('v2-hash-xyz');

      const backend = await specLibsStub.getSpecBackend();
      expect(backend.computeMessageHashV2.calledOnce).to.be.true;
      const { args } = backend.computeMessageHashV2.firstCall;
      // extend must sit between timestamp and signature — its omission was a real
      // hash-mismatch bug (signature landed in the extend slot).
      expect(args).to.deep.equal([
        'fluxappregister', 2, 'deadbeef', 12345, true, 'sig',
      ]);
    });

    it('rejects envelope v1 without a spec blob', async () => {
      await expect(appEventVerifier.computeOutboundHash({
        type: 'fluxappregister',
        envelopeVersion: 1,
        timestamp: 12345,
        signature: 'sig',
      })).to.be.rejectedWith(/envelope v1 requires specBlob/);
    });

    it('rejects envelope v2 without a content hash', async () => {
      await expect(appEventVerifier.computeOutboundHash({
        type: 'fluxappregister',
        envelopeVersion: 2,
        timestamp: 12345,
        signature: 'sig',
      })).to.be.rejectedWith(/envelope v2 requires contentHash/);
    });
  });

  describe('requestAttestation', () => {
    it('signs the content hash AND the envelope hash, under the app purpose', async () => {
      benchmarkServiceStub.attest.resolves({ status: 'success', data: JSON.stringify({ status: 'ok', signature: 'attest-signature-b64' }) });

      const signature = await appEventVerifier.requestAttestation('deadbeef', { encrypted: {} });

      expect(signature).to.equal('attest-signature-b64');
      // The envelope hash is the half a node without a secure backend can check
      // for itself, so it has to reach the signer. And the purpose has to ride
      // along, or the backend signs verbatim under the wrong key.
      expect(benchmarkServiceStub.attest.calledOnceWithExactly({
        message: `deadbeef${'e'.repeat(64)}`,
        purpose: 'app',
      })).to.be.true;
    });

    it('throws when the attestation call does not succeed', async () => {
      benchmarkServiceStub.attest.resolves({ status: 'error', data: 'attestation unavailable' });

      await expect(appEventVerifier.requestAttestation('deadbeef', { encrypted: {} }))
        .to.be.rejectedWith(/Failed to obtain arcane attestation/);
    });

    it('throws when the attestation response omits a signature', async () => {
      benchmarkServiceStub.attest.resolves({ status: 'success', data: JSON.stringify({ status: 'ok' }) });

      await expect(appEventVerifier.requestAttestation('deadbeef', { encrypted: {} }))
        .to.be.rejectedWith(/Failed to obtain arcane attestation/);
    });
  });

  describe('verifyAttestation', () => {
    it('delegates to the event with the local verify primitive and the network key', () => {
      const appEvent = { verifyArcaneAttestation: sinon.stub().returns(true) };

      const result = appEventVerifier.verifyAttestation(appEvent);

      expect(result).to.be.true;
      expect(appEvent.verifyArcaneAttestation.calledOnceWithExactly(
        arcaneAttestationStub.verifyAttestationSignature,
        'test-app-attestation-pubkey',
      )).to.be.true;
    });

    it('returns false when the event reports an invalid attestation', () => {
      const appEvent = { verifyArcaneAttestation: sinon.stub().returns(false) };
      expect(appEventVerifier.verifyAttestation(appEvent)).to.be.false;
    });
  });

  describe('the one update that predates update re-verification', () => {
    const RACE_HASH = '70b2d8a546f003b906055e168d3e7921bfedfe9c83b5bd8fc79b84d979977b76';
    const RACE_SIGNER = '1GTMhsaa55GaH7sGYif9d5dEzkGrGXYW4N';

    it('accepts the named message from the signer the entry names', async () => {
      // wordpress1735018430692: the transfer confirmed at h=1880959 and this
      // update, mined two blocks later, was already signed by the owner that
      // transfer replaced. The network accepted it, so resync must too.
      const appEvent = new FakeAppEvent({
        spec: { owner: '1GygtXKccaXPbJfB5ZZg2Xu9ukCG7tkrUs', name: 'wordpress1735018430692' },
        isUpdate: true,
        hash: RACE_HASH,
        validSignersByIteration: [new Set([RACE_SIGNER])],
      });
      const result = await appEventVerifier.authorize({
        appEvent,
        previousState: { owner: '1GygtXKccaXPbJfB5ZZg2Xu9ukCG7tkrUs' },
        daemonHeight: 1880961,
      });
      expect(result.signer).to.equal(RACE_SIGNER);
    });

    it('refuses a former owner on every other message', async () => {
      // The takeover a general relaxation would grant: a former owner of a name
      // signs an update to the app holding it now and pays the fee. Nothing
      // about the message can put it in the set — the set is keyed by hash, and
      // a hash commits to the content it authorizes.
      const appEvent = new FakeAppEvent({
        spec: { owner: 'currentOwner', name: 'myapp' },
        isUpdate: true,
        hash: 'attacker-message-hash',
        validSignersByIteration: [new Set(['formerOwner'])],
      });
      await expect(appEventVerifier.authorize({
        appEvent,
        previousState: { owner: 'currentOwner' },
        daemonHeight: 2831782,
      })).to.be.rejectedWith(/does not correspond with Flux App owner/);
    });

    it('does not let the named signer authorize a different message', async () => {
      const appEvent = new FakeAppEvent({
        spec: { owner: 'currentOwner', name: 'wordpress1735018430692' },
        isUpdate: true,
        hash: 'some-other-hash-for-the-same-app',
        validSignersByIteration: [new Set([RACE_SIGNER])],
      });
      await expect(appEventVerifier.authorize({
        appEvent,
        previousState: { owner: 'currentOwner' },
        daemonHeight: 2831782,
      })).to.be.rejectedWith(/does not correspond with Flux App owner/);
    });
  });

});
