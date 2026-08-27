'use strict';

const { expect } = require('chai');

const { validateSubmissionSpec, validateGossipSpec, getSpec } = require('../../ZelBack/src/services/utils/specLibs');

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

  describe('validateGossipSpec', () => {
    it('propagates the ValidationError on the gossip path too', async () => {
      try {
        await validateGossipSpec({ version: 9, name: 'x' });
        expect.fail('an incomplete v9 gossip spec should not validate');
      } catch (err) {
        expect(err).to.be.instanceOf(ValidationError);
        expect(err.name).to.equal('ValidationError');
      }
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
    const V9_ACTIVATION = 2791000;
    const incompleteV9 = { version: 9, name: 'x' };

    for (const [label, validate] of [
      ['validateSubmissionSpec', (blob, opts) => validateSubmissionSpec(blob, opts)],
      ['validateGossipSpec', (blob, opts) => validateGossipSpec(blob, opts)],
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
});
