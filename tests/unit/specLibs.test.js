'use strict';

const { expect } = require('chai');

const { validateSubmissionSpec, getSpec } = require('../../ZelBack/src/services/utils/specLibs');

describe('specLibs — how a spec validation failure reaches the caller', () => {
  let ValidationError;

  before(async () => {
    ({ ValidationError } = await getSpec());
  });

  // These wrappers used to catch the ValidationError and rethrow a plain Error
  // carrying a message rebuilt from errors[0]. That threw away the type, which
  // every FluxOS route surfaces as `name` in its response body, and it named
  // only the first bad field. flux-spec composes the message itself now, so the
  // error is worth strictly more unmodified — do not reintroduce the catch.
  describe('validateSubmissionSpec', () => {
    it('propagates the ValidationError rather than downgrading it to Error', async () => {
      try {
        await validateSubmissionSpec({ version: 9, name: 'x' });
        expect.fail('an incomplete v9 submission should not validate');
      } catch (err) {
        expect(err).to.be.instanceOf(ValidationError);
        expect(err.name).to.equal('ValidationError');
      }
    });

    it('names every missing field in the message, not just the first', async () => {
      try {
        await validateSubmissionSpec({ version: 9, name: 'x' });
        expect.fail('an incomplete v9 submission should not validate');
      } catch (err) {
        expect(err.message).to.include('description: Required');
        expect(err.message).to.include('owner: Required');
        expect(err.message).to.include('components: Required');
      }
    });

    it('keeps the structured errors array intact for callers that branch on it', async () => {
      try {
        await validateSubmissionSpec({ version: 9, name: 'x' });
        expect.fail('an incomplete v9 submission should not validate');
      } catch (err) {
        expect(err.errors).to.be.an('array').with.length.greaterThan(1);
        expect(err.errors[0]).to.have.property('field');
        expect(err.errors[0]).to.have.property('message');
      }
    });
  });

  // THE OWNER IS THE ONLY KEY THAT CAN EVER MANAGE THE APP AGAIN. An address one
  // character off its own checksum is as unsignable as a username, and a
  // registration carrying one orphans the app at the moment it is created -
  // which is the incident that produced the rule (owner set to the literal
  // string "TrippleCore", restored on-chain at height 2861184).
  //
  // The rule lives in flux-spec, where isValidSigningIdentity and
  // FluxAppSpecV9.validateSemantics both have their own tests. What has no test
  // there and cannot have one is whether THIS NODE'S live submission path still
  // reaches it. The rule is a semantic one precisely because the schema accepts
  // the shape, so a seam that stopped calling validateSemantics - or built the
  // spec some other way - would refuse nothing, and every flux-spec suite would
  // stay green.
  describe('an owner no signature can be verified against', () => {
    const withOwner = (owner) => ({
      version: 9,
      name: 'ownertest',
      description: 'x',
      owner,
      instances: 3,
      ttl: 86_400,
      contacts: { email: ['admin@example.com'] },
      components: {
        web: {
          name: 'web',
          image: 'nginx:latest',
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          persistentStorage: { sizeGb: 5, mounts: { '/data': { source: 'data', destination: '/data' } }, sync: null },
        },
      },
    });

    const refusal = async (owner) => validateSubmissionSpec(withOwner(owner)).then(() => null, (err) => err);

    it('accepts the spec when the owner is a Flux ID, so the refusals below are about the owner', async () => {
      const spec = await validateSubmissionSpec(withOwner('16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1'));
      expect(spec.owner).to.equal('16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1');
    });

    it('refuses a Flux ID whose checksum does not hold, which only decoding can see', async () => {
      // the accepted id above with its last character changed: same length,
      // same alphabet, same shape - the schema cannot tell them apart
      const err = await refusal('16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC2');
      expect(err, 'a submission path that no longer reaches validateSemantics refuses nothing')
        .to.be.instanceOf(ValidationError);
      expect(err.errors.map((e) => e.code)).to.include('UNSIGNABLE_IDENTITY');
      expect(err.errors.some((e) => String(e.field).includes('owner')), `no error names owner: ${JSON.stringify(err.errors)}`).to.equal(true);
    });

    // The two layers, and why the semantic rule has to exist. The incident's
    // own value is refused by the SCHEMA - wrong length, wrong alphabet - and a
    // shape check is enough for it. The checksum case above is the one no
    // pattern can reach, and it is the one that would otherwise reach the chain.
    it('refuses a username at the schema, which needs no decoding', async () => {
      const err = await refusal('TrippleCore');
      expect(err).to.be.instanceOf(ValidationError);
      expect(err.errors.map((e) => e.code)).to.include('INVALID_VALUE');
    });

    it('accepts an Ethereum address, so the rule is the identity and not the Flux ID alphabet', async () => {
      const spec = await validateSubmissionSpec(withOwner('0x52908400098527886E0F7030069857D2E4169EE7'));
      expect(spec.owner).to.equal('0x52908400098527886E0F7030069857D2E4169EE7');
    });
  });

  // The version-activation gate — chain policy, and until now completely
  // untested: removing it from both wrappers broke nothing across 31 suites.
  //
  // It runs BEFORE the version class validates anything, which is what makes it
  // testable without a fully valid spec: below the height the call fails on the
  // gate, above it the call gets far enough to fail on the schema instead. The
  // difference between those two errors is the assertion.
  describe('version activation height', () => {
    // v9 activates at 2,791,000 in the test config.
    const V9_ACTIVATION = 2_791_000;
    const incompleteV9 = { version: 9, name: 'x' };

    for (const [label, validate] of [
      ['validateSubmissionSpec', (blob, opts) => validateSubmissionSpec(blob, opts)],
    ]) {
      describe(label, () => {
        it('refuses a version the chain has not activated yet', async () => {
          try {
            await validate(incompleteV9, { height: V9_ACTIVATION - 1 });
            expect.fail('a pre-activation height should be refused');
          } catch (err) {
            expect(err.message).to.match(/version 9 not yet supported/);
          }
        });

        it('lets the spec through to real validation once activated', async () => {
          // Reaching the schema failure IS the pass condition: the gate did not
          // fire. Asserting "does not throw" would be wrong — this blob is
          // invalid either way, which is exactly how a broken gate would hide.
          try {
            await validate(incompleteV9, { height: V9_ACTIVATION });
            expect.fail('an incomplete v9 spec should still fail validation');
          } catch (err) {
            expect(err).to.be.instanceOf(ValidationError);
            expect(err.message).to.not.match(/not yet supported/);
          }
        });

        it('skips the gate entirely when no height is supplied', async () => {
          // Callers without a daemon height (offline tooling, tests) must not be
          // gated on a height they do not have.
          try {
            await validate(incompleteV9);
            expect.fail('an incomplete v9 spec should still fail validation');
          } catch (err) {
            expect(err).to.be.instanceOf(ValidationError);
            expect(err.message).to.not.match(/not yet supported/);
          }
        });
      });
    }
  });

  // The height reaches the class. A legacy version gates some of its rules by
  // height and judges an unstated height as the current era; this node's live
  // path has to hand the daemon height over, or a registration is judged by
  // rules the chain has not reached yet.
  describe('the height a legacy submission is judged at', () => {
    const singleInstanceV8 = () => ({
      version: 8,
      name: 'heighttest',
      description: 'x',
      owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
      instances: 1,
      contacts: [],
      geolocation: [],
      expire: 88_000,
      nodes: [],
      staticip: false,
      enterprise: '',
      compose: [{
        name: 'web',
        description: 'x',
        repotag: 'nginx:latest',
        ports: [31_000],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: '/data',
        cpu: 0.5,
        ram: 300,
        hdd: 5,
        repoauth: '',
      }],
    });
    const verdict = (opts) => validateSubmissionSpec(singleInstanceV8(), opts).then(() => null, (err) => err);

    it('refuses a single-instance v8 below the height that allowed one', async () => {
      const err = await verdict({ height: 2_176_518 });
      expect(err).to.be.instanceOf(ValidationError);
      expect(err.errors.some((e) => e.code === 'OUT_OF_RANGE' && String(e.field).includes('instances')), JSON.stringify(err.errors)).to.equal(true);
    });

    it('accepts it from that height, and with no height at all', async () => {
      expect(await verdict({ height: 2_176_519 })).to.equal(null);
      expect(await verdict()).to.equal(null);
    });
  });

  // An unsupported version is not a schema failure, so it stays a plain Error —
  // the type distinction is the point of surfacing ValidationError at all.
  it('leaves a version rejection as a plain Error', async () => {
    try {
      await validateSubmissionSpec({ version: 99, name: 'x' });
      expect.fail('version 99 should not validate');
    } catch (err) {
      expect(err).to.not.be.instanceOf(ValidationError);
      expect(err.message).to.match(/Unsupported Flux App specification version/);
    }
  });

  // The rule that stops a registry password reaching the chain, asked at the door
  // that decides. The library has always had the rule; until it was wired here,
  // nothing in FluxOS ever passed the flag that arms it, so it had never once run
  // on a real submission. Every existing test drove `validateSemantics` by hand
  // and checked the rule, which is a different question from whether anyone asks it.
  describe('encryption-forcing fields at the submission door', () => {
    const withImageAuth = () => ({
      version: 9,
      name: 'credentialtest',
      description: 'x',
      owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
      instances: 3,
      ttl: 86_400,
      contacts: { email: ['admin@example.com'] },
      components: {
        web: {
          name: 'web',
          image: 'nginx:latest',
          cpu: 0.5,
          memory: 300,
          rootFsGb: 2,
          // A literal registry credential. From v9 this field is plaintext: the
          // protection moved off the field and onto the sealed spec.
          imageAuth: 'registryuser:hunter2',
          persistentStorage: {
            sizeGb: 5,
            mounts: { '/data': { source: 'data', destination: '/data' } },
            sync: null,
          },
        },
      },
    });

    async function refusal(options) {
      try {
        await validateSubmissionSpec(withImageAuth(), options);
        return null;
      } catch (err) {
        return err;
      }
    }

    it('refuses imageAuth when the caller states nothing about encryption', async () => {
      const err = await refusal(undefined);
      expect(err, 'silence must not accept a spec that publishes a password')
        .to.be.instanceOf(ValidationError);
      expect(err.errors.map((e) => e.code)).to.include('ENCRYPTION_REQUIRED');
    });

    it('refuses imageAuth on a submission stated to be cleartext', async () => {
      const err = await refusal({ encrypted: false });
      expect(err).to.be.instanceOf(ValidationError);
      expect(err.errors.map((e) => e.code)).to.include('ENCRYPTION_REQUIRED');
    });

    it('names the field, so the submitter knows what to remove or seal', async () => {
      const err = await refusal(undefined);
      expect(err.message).to.match(/imageAuth/);
      expect(err.message).to.match(/encrypted spec/);
    });

    it('accepts imageAuth once the caller states the spec will be sealed', async () => {
      const err = await refusal({ encrypted: true });
      expect(err, err && err.message).to.equal(null);
    });
  });
});
