'use strict';

const crypto = require('crypto');

const { quorumThreshold } = require('./peerRings');

// Node-down certificates: the verdict, the quorum, and what a receiver checks
// (NODE_DOWN_CERTIFICATES.md §3, §5, §6.3, §6.10). Pure — a verdict is signed
// bytes, a certificate is a bag of them, and verification is arithmetic over a
// jury the caller recomputed at the certificate's named fingerprint. Signature
// verification is injected: the quorum rules never depend on the curve.
//
// The canonical encodings are byte-normative (certs doc §6.3, WIRE_CONTRACT §B)
// and pinned by tests/unit/fixtures/rings-fixture.json: two implementations
// that canonicalise differently do not fail a test — they evict different nodes.

// Domain separation: a verdict can never be replayed as any other signed
// message, and an alive can never be replayed as a verdict.
const VERDICT_DOMAIN = 'fluxnodedown-verdict:';
const ALIVE_DOMAIN = 'fluxnodedown-alive:';

// No field may contain the separator — checked, never assumed: a certificate is
// composed by whoever sends it, and a value carrying the separator would shift
// the meaning of every field after it.
const FIELD_SEPARATOR = '|';

// How far ahead of the verifier's own height a verdict may be stamped. One
// block is what honest propagation produces; anything further extends the
// replay window by exactly the amount of the lie.
const FUTURE_BLOCKS_TOLERANCE = 1;

// A verdict's lifetime, counted against the verifier's own height. Callers
// pass this as verifyCertificate's maxAgeBlocks unless a test narrows it.
const VERDICT_LIFETIME_BLOCKS = 10;

// The nodedown record's lifetime (§6.12): sized just past the 640-block list
// expiry, where the certificate becomes both uncheckable and pointless.
// membershipHistory's retention is derived from THIS plus slack — every
// standing certificate must stay cold-verifiable for its whole life
// (NODE_DOWN_REQUIREMENTS_COMMITTEE_RECOVERY.md R1).
const RECORD_LIFETIME_MS = 6 * 60 * 60 * 1000;

const JUDGEMENT = Object.freeze({
  UNREACHABLE: 'unreachable',
  REACHABLE: 'reachable',
  ABSTAIN: 'abstain',
});

const REASON = Object.freeze({
  ACCEPTED: 'accepted',
  MALFORMED: 'malformed',
  UNKNOWN_FINGERPRINT: 'unknown_fingerprint',
  SUB_QUORUM: 'sub_quorum',
});

const DISCARDED = Object.freeze({
  MALFORMED: 'malformed',
  WRONG_SUBJECT: 'wrong_subject',
  NOT_UNREACHABLE: 'not_unreachable',
  STALE: 'stale',
  NOT_A_WATCHER: 'not_a_watcher',
  // Cast under a membership that assigns this subject a DIFFERENT jury: a real
  // vote answering a different question — neither a forgery nor stale.
  FOREIGN_JURY: 'foreign_jury',
  // The juror shares the subject's address on the list the COUNTER holds — the
  // walk's same-address rule re-applied where the knowledge is freshest. It can
  // only prevent a certificate, never create one (formal/verdict-churn).
  CO_TENANT: 'cotenant',
  BAD_SIGNATURE: 'bad_signature',
  DUPLICATE_SIGNER: 'duplicate_signer',
  DUPLICATE_OWNER: 'duplicate_owner',
});

/**
 * @typedef {object} VerdictShape
 * @property {string} subject collateral outpoint — never an address
 * @property {string} juror the juror's node key
 * @property {string} judgement one of JUDGEMENT
 * @property {number} height chain height the observation was made at
 * @property {string} fingerprint membership fingerprint the verdict was cast under
 * @property {*} [signature] opaque to this module; verified via the injected seam
 */

/**
 * The exact bytes a juror signs. Null when any field would corrupt the
 * encoding — refused, never escaped.
 *
 * @param {VerdictShape} verdict
 * @returns {Buffer | null}
 */
function verdictPayload(verdict) {
  const parts = [
    verdict.subject,
    verdict.juror,
    verdict.judgement,
    String(verdict.height),
    verdict.fingerprint,
  ];
  if (parts.some((part) => typeof part !== 'string' || part.includes(FIELD_SEPARATOR))) {
    return null;
  }
  return Buffer.from(VERDICT_DOMAIN + parts.join(FIELD_SEPARATOR));
}

/**
 * The exact bytes a subject's owner signs to refute a certificate about it.
 *
 * @param {string} subject collateral outpoint
 * @param {number} height the subject's own chain height
 * @returns {Buffer | null}
 */
function alivePayload(subject, height) {
  const parts = [subject, String(height)];
  if (parts.some((part) => typeof part !== 'string' || part.includes(FIELD_SEPARATOR))) {
    return null;
  }
  return Buffer.from(ALIVE_DOMAIN + parts.join(FIELD_SEPARATOR));
}

/**
 * The jury in collection order for this subject — hash-ranked, so every juror
 * computes the same order with no message exchanged. The head R names are where
 * verdicts land first; a failed push walks to the next name, so a dead
 * collector costs one attempt, never the certificate.
 *
 * @param {string} subject
 * @param {Array<{key: string}>} jury
 * @returns {Array<{key: string}>}
 */
function collectorRanking(subject, jury) {
  return [...jury]
    .map((watcher) => ({
      watcher,
      sortKey: crypto.createHash('sha256').update(`${subject}:${watcher.key}`).digest(),
    }))
    .sort((a, b) => Buffer.compare(a.sortKey, b.sortKey))
    .map((entry) => entry.watcher);
}

/**
 * Where verdicts about this subject are pushed. r <= 0 is push-to-all — §3 as
 * adopted; a positive r bounds the burst without touching the correctness
 * argument (assembly still requires H distinct owners).
 *
 * @param {string} subject
 * @param {Array<{key: string}>} jury
 * @param {number} r
 * @returns {Array<{key: string}>}
 */
function collectors(subject, jury, r) {
  if (r <= 0) return [...jury];
  return collectorRanking(subject, jury).slice(0, r);
}

/**
 * A certificate is a bag of verdicts that reached H — nothing DECIDES to make
 * one. The mirror of verifyCertificate, deliberately: assembly applies exactly
 * the rules verification will, so a node cannot build something it would itself
 * reject. Both count distinct OWNERS.
 *
 * @param {string} subject
 * @param {string} assembler any juror whose pile crossed H — not a coordinator
 * @param {number} height stapling height; verification ages VERDICTS, never this
 * @param {string} membership the fingerprint this certificate names
 * @param {VerdictShape[]} verdicts
 * @param {Array<{key: string, owner: string}>} jury
 * @param {Set<string>} sameJury every fingerprint assigning this subject an
 *   identical jury, this certificate's own included
 * @param {Set<string>} [cotenants] juror keys sharing the subject's address on
 *   the list the caller currently holds
 * @returns {object | null} certificate, or null below quorum
 */
function assemble(subject, assembler, height, membership, verdicts, jury, sameJury, cotenants = new Set()) {
  const assigned = new Map(jury.map((watcher) => [watcher.key, watcher.owner]));
  const byOwner = new Map();
  verdicts.forEach((verdict) => {
    if (verdict.judgement !== JUDGEMENT.UNREACHABLE || !verdict.signature) return;
    if (!sameJury.has(verdict.fingerprint)) return;
    if (cotenants.has(verdict.juror)) return;
    const owner = assigned.get(verdict.juror);
    if (owner !== undefined && !byOwner.has(owner)) {
      byOwner.set(owner, verdict);
    }
  });
  if (byOwner.size < quorumThreshold(jury.length)) return null;
  return {
    subject,
    assembler,
    height,
    fingerprint: membership,
    verdicts: [...byOwner.values()],
  };
}

/**
 * Does this certificate stand?
 *
 * `watchers` is the subject's jury recomputed against the list AT the
 * certificate's own fingerprint; null means the fingerprint fell outside the
 * retained window — reject, do not apply, do not relay. `sameJury` is every
 * rebuildable fingerprint assigning the same jury: the unit that has to agree
 * is the jury, not the network list. `verifySignature(owner, payload,
 * signature)` is the injected crypto seam. Verdicts age in BLOCKS against the
 * verifier's own height, both directions.
 *
 * @param {{subject: string, verdicts: VerdictShape[]}} certificate
 * @param {Array<{key: string, owner: string}> | null} watchers
 * @param {Set<string>} sameJury
 * @param {(owner: string, payload: Buffer, signature: *) => boolean} verifySignature
 * @param {number} nowHeight
 * @param {number} maxAgeBlocks
 * @param {Set<string>} [cotenants]
 * @returns {{accepted: boolean, reason: string, counted: number, needed: number,
 *   discarded: Object<string, number>}}
 */
function verifyCertificate(certificate, watchers, sameJury, verifySignature, nowHeight, maxAgeBlocks, cotenants = new Set()) {
  const discarded = {};
  const discard = (why) => {
    discarded[why] = (discarded[why] || 0) + 1;
  };

  if (!certificate.verdicts || !certificate.verdicts.length) {
    return { accepted: false, reason: REASON.MALFORMED, counted: 0, needed: 0, discarded };
  }
  if (watchers === null) {
    return { accepted: false, reason: REASON.UNKNOWN_FINGERPRINT, counted: 0, needed: 0, discarded };
  }

  const assigned = new Map(watchers.map((watcher) => [watcher.key, watcher.owner]));
  const needed = quorumThreshold(watchers.length);
  const signers = new Set();
  const owners = new Set();
  let counted = 0;

  certificate.verdicts.forEach((verdict) => {
    const payload = verdictPayload(verdict);
    if (payload === null || !verdict.signature) {
      discard(DISCARDED.MALFORMED);
      return;
    }
    if (verdict.subject !== certificate.subject) {
      discard(DISCARDED.WRONG_SUBJECT);
      return;
    }
    if (verdict.judgement !== JUDGEMENT.UNREACHABLE) {
      // Reachable and abstain can PREVENT a certificate by being absent from
      // it; they never contribute to one — an asymmetric cut ends in no
      // certificate rather than a weaker one.
      discard(DISCARDED.NOT_UNREACHABLE);
      return;
    }
    if (
      verdict.height > nowHeight + FUTURE_BLOCKS_TOLERANCE
      || nowHeight - verdict.height > maxAgeBlocks
    ) {
      discard(DISCARDED.STALE);
      return;
    }
    if (!sameJury.has(verdict.fingerprint)) {
      // Checked BEFORE the watcher lookup so the attribution is right: a juror
      // can sit on both juries, and NOT_A_WATCHER would report a splice as a
      // forgery.
      discard(DISCARDED.FOREIGN_JURY);
      return;
    }
    const owner = assigned.get(verdict.juror);
    if (owner === undefined) {
      // What a forgery looks like: quorum-many verdicts, every signature real,
      // none of the signers ever assigned.
      discard(DISCARDED.NOT_A_WATCHER);
      return;
    }
    if (cotenants.has(verdict.juror)) {
      discard(DISCARDED.CO_TENANT);
      return;
    }
    if (signers.has(verdict.juror)) {
      discard(DISCARDED.DUPLICATE_SIGNER);
      return;
    }
    if (owners.has(owner)) {
      // The quorum unit is the distinct owner — enforced against the
      // certificate, not trusted to the walk, because the certificate is
      // composed by whoever sent it.
      discard(DISCARDED.DUPLICATE_OWNER);
      return;
    }
    if (!verifySignature(owner, payload, verdict.signature)) {
      discard(DISCARDED.BAD_SIGNATURE);
      return;
    }
    signers.add(verdict.juror);
    owners.add(owner);
    counted += 1;
  });

  const accepted = counted >= needed;
  return {
    accepted,
    reason: accepted ? REASON.ACCEPTED : REASON.SUB_QUORUM,
    counted,
    needed,
    discarded,
  };
}

module.exports = {
  VERDICT_DOMAIN,
  ALIVE_DOMAIN,
  FIELD_SEPARATOR,
  FUTURE_BLOCKS_TOLERANCE,
  VERDICT_LIFETIME_BLOCKS,
  RECORD_LIFETIME_MS,
  JUDGEMENT,
  REASON,
  DISCARDED,
  verdictPayload,
  alivePayload,
  collectorRanking,
  collectors,
  assemble,
  verifyCertificate,
};
