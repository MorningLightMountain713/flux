const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

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

  // Minimal AppEvent class double — just enough surface for authorize() to
  // exercise the FluxOS authority logic without needing a real spec class.
  class FakeAppEvent {
    constructor({
      spec, hashValid = true, isUpdate = false,
      validSignersByIteration = [], renewalVerdict = 'changed',
    }) {
      this.spec = spec;
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

  class FakeAppEventLegacy {
    static deserialize(doc) { return { kind: 'v1', doc }; }
  }
  class FakeConfirmedAppEvent {
    static deserialize(doc) { return { kind: 'v2', doc }; }
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
      getSpecBackend: sinon.stub().resolves({
        AppEventLegacy: FakeAppEventLegacy,
        ConfirmedAppEvent: FakeConfirmedAppEvent,
        computeMessageHash: sinon.stub().returns('v1-hash-abc'),
        computeMessageHashV2: sinon.stub().returns('v2-hash-xyz'),
        buildArcaneAttestMessage: sinon.stub().callsFake((h) => `FLUX_ARCANE_ATTEST_v1${h}`),
      }),
    };

    benchmarkServiceStub = {
      attest: sinon.stub(),
    };

    arcaneAttestationStub = {
      ARCANE_ATTESTATION_PUBKEY: 'test-network-pubkey',
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
    it('dispatches envelope version 1 to AppEventLegacy', async () => {
      const msg = { version: 1, type: 'fluxappregister' };
      const result = await appEventVerifier.deserializeMessage(msg);
      expect(result).to.deep.equal({ kind: 'v1', doc: msg });
    });

    it('dispatches envelope version 2 to ConfirmedAppEvent', async () => {
      const msg = { version: 2, type: 'fluxappregister' };
      const result = await appEventVerifier.deserializeMessage(msg);
      expect(result).to.deep.equal({ kind: 'v2', doc: msg });
    });

    it('falls back to AppEventLegacy for any other/legacy envelope version', async () => {
      // Wire history has some zel*register messages with non-integer version
      // fields. AppEventLegacy is the compatibility path.
      const msg = { version: 0, type: 'zelappregister' };
      const result = await appEventVerifier.deserializeMessage(msg);
      expect(result.kind).to.equal('v1');
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
      const args = backend.computeMessageHash.firstCall.args;
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
      const args = backend.computeMessageHashV2.firstCall.args;
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
    it('signs the domain-separated content hash via the local secure backend and returns the signature', async () => {
      benchmarkServiceStub.attest.resolves({ status: 'success', data: { signature: 'attest-signature-b64', status: 'ok' } });

      const signature = await appEventVerifier.requestAttestation('deadbeef');

      expect(signature).to.equal('attest-signature-b64');
      expect(benchmarkServiceStub.attest.calledOnceWithExactly({ message: 'FLUX_ARCANE_ATTEST_v1deadbeef' })).to.be.true;
    });

    it('throws when the attestation call does not succeed', async () => {
      benchmarkServiceStub.attest.resolves({ status: 'error', data: 'attestation unavailable' });

      await expect(appEventVerifier.requestAttestation('deadbeef'))
        .to.be.rejectedWith(/Failed to obtain arcane attestation/);
    });

    it('throws when the attestation response omits a signature', async () => {
      benchmarkServiceStub.attest.resolves({ status: 'success', data: { status: 'ok' } });

      await expect(appEventVerifier.requestAttestation('deadbeef'))
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
        'test-network-pubkey',
      )).to.be.true;
    });

    it('returns false when the event reports an invalid attestation', () => {
      const appEvent = { verifyArcaneAttestation: sinon.stub().returns(false) };
      expect(appEventVerifier.verifyAttestation(appEvent)).to.be.false;
    });
  });

});
