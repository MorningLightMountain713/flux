'use strict';

/**
 * The world a held key stands in: the generation its committee is dealt from
 * and the height that committee took over at. The referees serve it and the
 * holder holds it, so both derive it here from what messageStore.standingGeneration
 * answers, and two worlds compare by both numbers: a sale can hand the key to
 * a new world at a generation it already had (a transfer naming no record
 * keeps generation 0), or at a lower one (a v8 sale of a re-rolled app steps
 * back to 0), and neither is told apart by the generation alone.
 */

/**
 * @param {{record: ?{signer: string, data: object}, aside: boolean, ownership: ?{owner: string, from: number, transferred: boolean}}} standing
 * @returns {{generation: number, height: ?number, record: ?object, aside: boolean}}
 *   height is null for an app that never changed hands and stands on its registration
 */
function worldOf({ record, aside, ownership }) {
  const data = record?.data ?? null;
  // The height the standing committee takes over at, which it drains from: a
  // record the listed owner signed drains from its own named height, the
  // re-roll's drain; the record a transfer names, or the registration's
  // committee after a transfer naming none, from the height the transfer
  // applied, at every transfer. No drain for an app that never changed hands
  // and stands on its registration.
  let height = null;
  if (data) {
    height = record.signer === ownership?.owner ? data.height : Math.max(data.height, ownership?.from ?? 0);
  } else if (ownership?.transferred) {
    height = ownership.from;
  }
  return {
    generation: data?.generation ?? 0,
    height,
    record: data,
    aside: Boolean(aside),
  };
}

/**
 * @param {{generation: number, height?: ?number}} a
 * @param {{generation: number, height?: ?number}} b
 * @returns {boolean} whether the two are one world
 */
function sameWorld(a, b) {
  return a.generation === b.generation && (a.height ?? null) === (b.height ?? null);
}

module.exports = { worldOf, sameWorld };
