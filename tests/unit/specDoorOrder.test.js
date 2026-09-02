'use strict';

/**
 * Spec door order — a submitted document is bounded whichever door it reaches.
 *
 * flux-spec asserts its own door-to-guard coverage
 * (packages/spec-backend/test/unit/doorCoverage.test.js). What that suite cannot
 * see is which of its doors FluxOS calls, and in what order. This file asserts
 * that the answer does not matter.
 *
 * Two doors take a user-supplied spec document, and FluxOS reaches them by
 * different routes:
 *
 *   - `deserializeSpec` routes to `FluxAppSpecVn.deserialize`. Registration
 *     (appSubmission.js) goes here first.
 *   - `validateSubmissionSpec` routes to `FluxAppSpecVn.fromSubmission`. The
 *     playground (playgroundService.js) goes straight here, with no prior
 *     deserialize.
 *
 * Both apply `assertLegacyWireBounds`, so both refuse an oversized or over-deep
 * document and neither route depends on the other running first. The final test
 * states that agreement directly: if one door loses its bound, the two answers
 * diverge and the safety of a route silently becomes a property of its call
 * order rather than of its doors.
 *
 * Runs against the real spec library (see tests/unit/fixtures/fluxSpec.js for
 * why the library is never doubled here). No database, no network.
 */

const { expect } = require('chai');

const {
  validateSubmissionSpec,
  getSpec,
  getSpecBackend,
} = require('../../ZelBack/src/services/utils/specLibs');

// LEGACY_MAX_WIRE_BYTES is 1,048,576 and MAX_DOCUMENT_DEPTH is 32. Both probes
// sit well past those, so a refusal cannot be a near miss on either bound.
const OVERSIZE_BYTES = 1_500_000;
const OVER_DEPTH = 100;

/** A v8 document that is valid apart from the probe applied to it. */
function validV8() {
  return {
    version: 8,
    name: 'doorordertest',
    description: 'x',
    owner: '16dNCFf7nR3nx5iwn2RQMBw6KcJXkE3JC1',
    instances: 3,
    contacts: [],
    geolocation: [],
    expire: 88000,
    nodes: [],
    staticip: false,
    compose: [{
      name: 'web',
      description: 'x',
      repotag: 'nginx:latest',
      ports: ['31000'],
      domains: [''],
      environmentParameters: [],
      commands: [],
      containerPorts: ['80'],
      containerData: '/data',
      cpu: 0.5,
      ram: 300,
      hdd: 5,
      repoauth: '',
    }],
  };
}

// Bulk and depth go in a field both doors KEEP, so a refusal can only be the
// bound and never an unknown-field check firing ahead of it.
function oversizedV8() {
  const doc = validV8();
  const pad = [];
  let bytes = 0;
  while (bytes < OVERSIZE_BYTES) {
    const entry = `K${pad.length}=${'A'.repeat(64)}`;
    pad.push(entry);
    bytes += entry.length;
  }
  doc.compose[0].environmentParameters = pad;
  return doc;
}

function overDeepV8() {
  const doc = validV8();
  const root = {};
  let cursor = root;
  for (let i = 0; i < OVER_DEPTH; i += 1) { cursor.n = {}; cursor = cursor.n; }
  doc.compose[0].environmentParameters = [root];
  return doc;
}

/**
 * Drive a door and reduce the outcome to a comparable code.
 *
 * The code is compared, not merely the fact of a throw: every door here rejects
 * a malformed document for several reasons, and only the named code says the
 * bound is what refused it.
 */
async function outcome(fn) {
  try {
    await fn();
    return 'ACCEPTED';
  } catch (error) {
    if (error && Array.isArray(error.errors) && error.errors.length) return error.errors[0].code;
    return `${error.constructor.name}: ${String(error.message).slice(0, 60)}`;
  }
}

describe('spec door order — a submitted document is bounded at either door', () => {
  let deserializeSpec;

  before(async () => {
    await getSpec();
    ({ deserializeSpec } = await getSpecBackend());
  });

  it('the baseline document is accepted by both doors', async () => {
    expect(await outcome(() => deserializeSpec(validV8())), 'the baseline must pass the wire '
      + 'door, or every probe below rejects for the wrong reason').to.equal('ACCEPTED');
    expect(await outcome(() => validateSubmissionSpec(validV8())), 'the baseline must pass the '
      + 'submission door').to.equal('ACCEPTED');
  });

  describe('the wire door, which registration reaches first', () => {
    it('refuses an oversized document', async () => {
      expect(await outcome(() => deserializeSpec(oversizedV8()))).to.equal('SPEC_TOO_LARGE');
    });

    it('refuses an over-deep document', async () => {
      expect(await outcome(() => deserializeSpec(overDeepV8()))).to.equal('DOCUMENT_TOO_DEEP');
    });
  });

  describe('the submission door, which the playground reaches directly', () => {
    it('refuses an oversized document', async () => {
      expect(await outcome(() => validateSubmissionSpec(oversizedV8())), 'the playground calls '
        + 'this door on a raw request body with nothing in front of it').to.equal('SPEC_TOO_LARGE');
    });

    it('refuses an over-deep document', async () => {
      expect(await outcome(() => validateSubmissionSpec(overDeepV8())), 'an unbounded depth here '
        + 'is a stack overflow, not a verdict').to.equal('DOCUMENT_TOO_DEEP');
    });
  });

  describe('the two doors agree, so no route depends on its call order', () => {
    it('gives the same verdict on an oversized document', async () => {
      const viaWire = await outcome(() => deserializeSpec(oversizedV8()));
      const viaSubmission = await outcome(() => validateSubmissionSpec(oversizedV8()));
      expect(viaSubmission, 'the doors disagree about the same document, so whether a route is '
        + 'bounded now depends on which door it reaches first').to.equal(viaWire);
    });

    it('gives the same verdict on an over-deep document', async () => {
      const viaWire = await outcome(() => deserializeSpec(overDeepV8()));
      const viaSubmission = await outcome(() => validateSubmissionSpec(overDeepV8()));
      expect(viaSubmission, 'the doors disagree about the same document, so whether a route is '
        + 'bounded now depends on which door it reaches first').to.equal(viaWire);
    });
  });
});
