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
