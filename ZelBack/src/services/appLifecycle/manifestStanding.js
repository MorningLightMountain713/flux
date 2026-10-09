'use strict';

// Which manifest an app stands on, derived from the rows a node holds and the
// listed row. A node keeps every manifest it takes for an app (one row per
// manifest, keyed by the app identity and the manifest's hash) and stands on the
// highest-ranked one the listed row validates: signed by the listed owner, or
// named by the listed spec's `content` block. Rank is the height at which the
// signer took the app, then the version within that ownership, so what a later
// owner signs outranks anything an earlier owner signed. Nothing is chosen at
// arrival; a row the listed row stops validating stays, and stands again should
// the row return to its signer.
//
// A leaf of the content plane: the sync index and the slot service both read
// it, and neither is required here.

const appsRepository = require('../appDatabase/appsRepository');
const appRecords = require('../appDatabase/appRecords');
const { getSpec } = require('../utils/specLibs');

/**
 * The manifest the listed spec names, or null. The `content` block is in the
 * sealed set, so an encrypted spec is opened under its own provider.
 * @param {object} app - the listed app (InstantiatedSpec)
 * @returns {Promise<?string>}
 */
async function namedManifestOf(app) {
  let { spec } = app;
  if (!spec) return null;
  if (spec.sealed) spec = await spec.decrypt(await spec.createProvider());
  const content = spec.content ?? null;
  return content && typeof content.manifest === 'string' ? content.manifest : null;
}

/**
 * The manifest an app stands on. `row` is null when no held row is valid for the
 * listed row; `aside` is true when the spec names a manifest this node lacks,
 * which a row write asks peers and FluxDrive for. The spec is opened for the name
 * it carries only when a resolved row the listed owner did not sign needs it, or
 * none is resolved.
 *
 * @param {string} identity
 * @param {object} [deps] - { getApp?, getRows? }
 * @returns {Promise<{app: ?object, row: ?object, aside: boolean, rows: object[]}>}
 */
async function standingManifest(identity, deps = {}) {
  const { getApp = (id) => appRecords.registry().byIdentity(id), getRows = (id) => appRecords.manifests().byIdentity(id) } = deps;
  const app = await getApp(identity);
  const rows = await getRows(identity);
  if (!app) {
    return {
      app: null, row: null, aside: false, rows,
    };
  }
  const { ownerSignedIsValid, manifestRank, outranks } = await getSpec();
  const resolved = rows.filter((row) => row.isResolved);
  const needsName = resolved.length === 0 || resolved.some((row) => row.signer !== app.owner);
  const namedHash = needsName ? await namedManifestOf(app) : null;
  const valid = resolved.filter((row) => ownerSignedIsValid(
    { identity, hash: row.hash },
    { appIdentity: identity, listedOwnerSigned: row.signer === app.owner, namedHash },
  ));
  if (!valid.length) {
    return {
      app, row: null, aside: namedHash !== null, rows,
    };
  }
  const rank = (row) => manifestRank({ ownedFrom: row.ownedFrom, version: row.version });
  let best = valid[0];
  for (const row of valid.slice(1)) if (outranks(rank(row), rank(best))) best = row;
  return {
    app, row: best, aside: false, rows,
  };
}

/**
 * The highest version signed within one ownership, among the rows this node
 * holds and the manifests held in the pool with the app's waiting updates. A
 * submission takes the number after it. The app's original ownership also
 * counts the registration's list, signed at height 0 before the height existed.
 * @param {string} identity
 * @param {{owner: string, from: number, original?: boolean}} ownership
 * @param {object} [deps] - { getRows?, pendingRanks? }
 * @returns {Promise<number>} 0 when nothing is signed under the ownership
 */
async function highestVersionInOwnership(identity, ownership, deps = {}) {
  const { getRows = (id) => appRecords.manifests().byIdentity(id), pendingRanks = appsRepository.carriedManifestRanks } = deps;
  const within = (ownedFrom) => ownedFrom === ownership.from || (ownership.original === true && ownedFrom === 0);
  const rows = (await getRows(identity)).filter((row) => row.signer === ownership.owner && within(row.ownedFrom));
  const pending = (await pendingRanks(identity)).filter((rank) => within(rank.ownedFrom));
  return Math.max(0, ...rows.map((row) => row.version), ...pending.map((rank) => rank.version));
}

/**
 * The ownership the chain lists now, as the version rule keys it: the listed
 * owner, the height they took the app, and whether that ownership is the
 * app's first — under which the registration's list, signed before the app
 * had a height, counts in the version sequence.
 * @param {Array<{owner: string, from: number}>} owners appHistory.ownerships, in order
 * @returns {{owner: string, from: number, original: boolean}|null} null when nothing applied
 */
function listedOwnership(owners) {
  if (!owners.length) return null;
  const { owner, from } = owners[owners.length - 1];
  return { owner, from, original: owners.length === 1 };
}

/**
 * The index this node serves to a reconciling peer: for each app with a servable
 * standing manifest (one that arrived in a node broadcast), its identity and the
 * rank of that manifest. A row without a broadcast cannot be re-served, so it is
 * not promised.
 * @param {object} [deps] - { listResolved?, standing? }
 * @returns {Promise<Array<{identity: string, version: number, ownedFrom: number}>>}
 */
async function standingIndex(deps = {}) {
  const { listResolved = () => appRecords.manifests().resolved(), standing = standingManifest } = deps;
  const resolved = await listResolved();
  const identities = [...new Set(resolved.map((row) => row.identity))];
  const servable = new Set(resolved.filter((row) => row.servable).map((row) => `${row.identity}\n${row.hash}`));
  const index = [];
  for (const identity of identities) {
    // eslint-disable-next-line no-await-in-loop
    const { row } = await standing(identity, deps);
    if (row && servable.has(`${identity}\n${row.hash}`)) {
      index.push({ identity, version: row.version, ownedFrom: row.ownedFrom });
    }
  }
  return index;
}

module.exports = {
  namedManifestOf,
  listedOwnership,
  standingManifest,
  highestVersionInOwnership,
  standingIndex,
};
