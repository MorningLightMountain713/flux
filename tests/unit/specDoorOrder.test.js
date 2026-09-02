'use strict';

/**
 * Spec door order — the bound on a submitted document, and where it comes from.
 *
 * flux-spec's own door coverage is asserted in that repo
 * (packages/spec-backend/test/unit/doorCoverage.test.js). That suite cannot see
 * this: which of its doors FluxOS calls, and in what order.
 *
 * The order is load-bearing today, and nothing but this file says so.
 *
 *   - `deserializeSpec` routes a legacy document to `FluxAppSpecVn.deserialize`,
 *     which runs `assertLegacyWireBounds` — size and depth, both bounded.
 *   - `validateSubmissionSpec` routes the same document to
 *     `FluxAppSpecVn.fromSubmission`, which runs NEITHER. The guard was wired to
 *     all eight `deserialize` doors and none of the eight `fromSubmission` ones.
 *
 * So a caller that deserializes first is bounded, and a caller that goes
 * straight to submission is not. FluxOS does both:
 *
 *   - `appSubmission.js:143` calls `deserializeSpec` and only then
 *     `validateSubmissionSpec`. Registration is bounded — by the order, not by
 *     the door it eventually reaches.
 *   - `playgroundService.js:129` calls `validateSubmissionSpec` on the raw
 *     request body with no prior deserialize. That reaches the unbounded door.
 *
 * These tests pin both halves. When flux-spec bounds its legacy submission
 * doors, the "unbounded" expectations below fail and say so — that is the
 * signal to delete them, and to stop relying on call order.
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
// are built well past those so a bound, if present, cannot be a near miss.
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

function oversizedV8() {
  const doc = validV8();
  // Bulk goes in a field the door KEEPS, so a rejection can only be the size
  // bound and never an unknown-field check firing first.
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

/** Drive a door and reduce the outcome to a comparable code. */
async function outcome(fn) {
  try {
    await fn();
    return 'ACCEPTED';
  } catch (error) {
    if (error && Array.isArray(error.errors) && error.errors.length) return error.errors[0].code;
    return `${error.constructor.name}: ${String(error.message).slice(0, 60)}`;
  }
}

describe('spec door order — where the bound on a submitted document comes from', () => {
  let deserializeSpec;

  before(async () => {
    await getSpec();
    ({ deserializeSpec } = await getSpecBackend());
  });

  it('the baseline document is accepted by both doors', async () => {
    expect(await outcome(() => deserializeSpec(validV8())), 'baseline must pass the wire door, '
      + 'or every probe below rejects for the wrong reason').to.equal('ACCEPTED');
    expect(await outcome(() => validateSubmissionSpec(validV8())), 'baseline must pass the '
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
    // These two expectations are the defect, pinned. They are written as
    // "accepts" on purpose: when flux-spec wires assertLegacyWireBounds into the
    // legacy fromSubmission doors, these fail, and the failure message is the
    // instruction. Do not relax them to `.to.not.throw()` — that would pass
    // either way and prove nothing.
    it('[known gap] accepts an oversized document', async () => {
      const got = await outcome(() => validateSubmissionSpec(oversizedV8()));
      expect(got, 'FluxOS\'s submission door now bounds size. flux-spec has wired '
        + 'assertLegacyWireBounds into the legacy fromSubmission doors, so registration no '
        + 'longer depends on deserializeSpec running first. Change this to expect '
        + 'SPEC_TOO_LARGE and delete this note.').to.equal('ACCEPTED');
    });

    it('[known gap] does not refuse an over-deep document with a verdict', async () => {
      const got = await outcome(() => validateSubmissionSpec(overDeepV8()));
      expect(got, 'FluxOS\'s submission door now bounds depth. Change this to expect '
        + 'DOCUMENT_TOO_DEEP and delete this note.').to.not.equal('DOCUMENT_TOO_DEEP');
    });
  });

  describe('the consequence, stated so a reorder cannot pass silently', () => {
    it('the wire door refuses what the submission door accepts', async () => {
      const viaWire = await outcome(() => deserializeSpec(oversizedV8()));
      const viaSubmission = await outcome(() => validateSubmissionSpec(oversizedV8()));

      expect(viaWire).to.equal('SPEC_TOO_LARGE');
      expect(viaSubmission, 'the two doors disagree about the same document, which is why the '
        + 'order matters: appSubmission.js calls deserializeSpec first and is bounded, '
        + 'playgroundService.js does not and is bounded by nothing').to.not.equal(viaWire);
    });
  });
});
