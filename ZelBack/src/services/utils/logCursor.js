'use strict';

/**
 * The position a log reader has reached, as an opaque token.
 *
 * Docker's `since` is inclusive and resolves to milliseconds, so a reader cannot
 * ask for "everything after this line" - it can only ask for "everything from
 * this millisecond", and gets back the lines it already holds along with the new
 * ones. Advancing past them is what loses data: a line at .9265 is gone forever
 * to a reader that asked from .927.
 *
 * So the position is a pair - the millisecond reached, and how many lines were
 * already delivered from it. The re-read is deliberate, and the count is what
 * makes it exact: docker returns the same lines in the same order, so the first
 * `count` of them are the ones already held. Identical repeated lines within one
 * millisecond are handled by this and are not handled by comparing text.
 *
 * Opaque on the wire because clients and nodes upgrade independently: a reader
 * hands back what it was given without reading it, so this shape can change
 * without every client changing with it.
 *
 * A node that reads through flux-telemetryd adds where it stopped in the file:
 * the file's inode and first-entry time, which together name it, and the byte
 * offset. With them the daemon seeks straight back; without them - a docker
 * reader, or a file rotated away - `{ms, count}` alone places the reader, so
 * every reader understands every token. The inode and the time are decimal
 * strings: a double holds integers exactly only up to 2^53.
 */

const DIGITS = /^\d{1,20}$/;
const SIGNED_DIGITS = /^-?\d{1,19}$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MIN = -9_223_372_036_854_775_808n;
const I64_MAX = 9_223_372_036_854_775_807n;

/**
 * @param {{ms: number, count: number, ino?: string, firstNs?: string, off?: number}} position
 * @returns {string} the token a reader hands back
 */
function encode(position) {
  const token = { v: 1, ms: position.ms, count: position.count };
  if (filePosition(position)) {
    token.ino = position.ino;
    token.firstNs = position.firstNs;
    token.off = position.off;
  }
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

/**
 * Whether a position carries a whole file position: all three parts, each
 * well formed. Anything less is no file position at all.
 *
 * @param {object} position
 * @returns {boolean}
 */
function filePosition(position) {
  return typeof position.ino === 'string' && DIGITS.test(position.ino)
    && BigInt(position.ino) <= U64_MAX
    && typeof position.firstNs === 'string' && SIGNED_DIGITS.test(position.firstNs)
    && BigInt(position.firstNs) >= I64_MIN && BigInt(position.firstNs) <= I64_MAX
    && Number.isSafeInteger(position.off) && position.off >= 0;
}

/**
 * A token that is absent, truncated, from a future version, or simply not one of
 * ours is not an error - it is a reader with no position, which is answered with
 * the most recent lines the same as a first request.
 *
 * @param {string} token
 * @returns {{ms: number, count: number, ino?: string, firstNs?: string, off?: number}|null}
 */
function decode(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (parsed.v !== 1) return null;
    if (!Number.isFinite(parsed.ms) || !Number.isInteger(parsed.count)) return null;
    if (parsed.ms < 0 || parsed.count < 0) return null;
    const position = { ms: parsed.ms, count: parsed.count };
    if (filePosition(parsed)) {
      position.ino = parsed.ino;
      position.firstNs = parsed.firstNs;
      position.off = parsed.off;
    }
    return position;
  } catch (error) {
    return null;
  }
}

module.exports = { encode, decode };
