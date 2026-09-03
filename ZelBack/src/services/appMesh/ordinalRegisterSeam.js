'use strict';

// The mesh's window onto the ordinal registers. An ordinal (db-0, db-1, …)
// is a write-once grant on the app's founding committee, one register per
// ordinal per app, decided exactly once; this seam is how the mesh asks for
// one, probes one, releases one, and reads who holds them. The grant plane
// registers its provider at wiring; until it does, every answer is the
// closed one — undecided, wait, refused, nobody — so an unwired plane can
// never found, release or name anything.
//
// Contract:
//   probeOrdinal(appName, ordinal)   -> {decided, holder}   a quorum read; burns no epoch
//   askOrdinal(appName, ordinal)     -> {answer: 'yes'} | {answer: 'no', holder} | {answer: 'wait', retryAfterMs?, reason?}
//                                       'yes' is durable: asking again answers yes from the record
//   releaseOrdinal(appName, ordinal) -> {released, reason?}   grantee-signed; only the holder's own node
//   ordinalHolders(appName)          -> Map<ordinal, outpoint>   the fleet-synced record read, for names
//   vacateOrdinal(appName, ordinal, holder) -> {vacated, reason?}   reclaim by node-down certificate, judged
//                                       by the register at the derivation's placement-dead edge; the
//                                       joiner's scan asks it for a held ordinal, and founds on 'vacated'
// A lagging holders record is a temporarily unknown name, never a collision;
// the scan for a free ordinal probes and never reads the record.

const CONTRACT = Object.freeze(['probeOrdinal', 'askOrdinal', 'releaseOrdinal', 'ordinalHolders', 'vacateOrdinal']);

const closed = Object.freeze({
  probeOrdinal: async () => ({ decided: false, holder: null }),
  askOrdinal: async () => ({ answer: 'wait', reason: 'unwired' }),
  releaseOrdinal: async () => ({ released: false, reason: 'unwired' }),
  ordinalHolders: async () => new Map(),
  vacateOrdinal: async () => ({ vacated: false, reason: 'unwired' }),
});

let provider = closed;

/**
 * Wire the grant plane's ordinal registers in. The full contract or nothing:
 * a partial provider would fail open at whichever call it lacks.
 *
 * @param {object} candidate implements every CONTRACT function
 */
function registerProvider(candidate) {
  CONTRACT.forEach((name) => {
    if (typeof candidate?.[name] !== 'function') {
      throw new Error(`ordinal register provider is missing ${name}`);
    }
  });
  provider = candidate;
}

function registered() {
  return provider !== closed;
}

function resetForTests() {
  provider = closed;
}

async function probeOrdinal(appName, ordinal) {
  return provider.probeOrdinal(appName, ordinal);
}

async function askOrdinal(appName, ordinal) {
  return provider.askOrdinal(appName, ordinal);
}

async function releaseOrdinal(appName, ordinal) {
  return provider.releaseOrdinal(appName, ordinal);
}

async function ordinalHolders(appName) {
  return provider.ordinalHolders(appName);
}

async function vacateOrdinal(appName, ordinal, holder) {
  return provider.vacateOrdinal(appName, ordinal, holder);
}

module.exports = {
  registerProvider,
  registered,
  resetForTests,
  probeOrdinal,
  askOrdinal,
  releaseOrdinal,
  ordinalHolders,
  vacateOrdinal,
};
