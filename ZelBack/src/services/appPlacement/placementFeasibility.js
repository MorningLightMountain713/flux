'use strict';

// Placement feasibility for synced apps.
//
// A placement constraint may only reject a node when a better-placed candidate
// provably exists. This module supplies the proof: it computes, from the
// deterministic node list and the IP location table, how many distinct fault
// domains an app's eligible candidates span, and from that each domain's share
// of the app's instances - the smallest uniform level the domains can absorb.
// The spawner, the registration validator and the placement API all consume
// this one computation.
//
// Every approximation in here errs toward counting MORE candidates and MORE
// domains, which pushes the share toward 1 - i.e. toward the strict behaviour
// the network has today - never toward stacking instances. A missing table, an
// unresolvable location, a region-granularity pin the table cannot answer: all
// degrade to the status quo.
//
// The same principle at the entry level: an ALLOWED restriction the table
// cannot fully resolve over-includes (a region-level pin admits the whole
// country), while a FORBIDDEN restriction it cannot resolve is not applied at
// all. A constraint never strands an app on missing data, and a ban never
// applies to a node it cannot be proven to cover.

const config = require('config');
const log = require('../../lib/log');
const fluxCommunicationUtils = require('../fluxCommunicationUtils');
const networkStateService = require('../networkStateService');
const generalService = require('../generalService');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const cidrUtils = require('../utils/cidrUtils');
const verificationHelper = require('../verificationHelper');
const { bareIp, socketAddressesMatch } = require('../utils/socketAddressUtils');
const ipLocationStore = require('./ipLocationStore');
const { Privilege, authOf } = require('../utils/privileges');
const { getSpecBackend } = require('../utils/specLibs');


// geonames/ip-api continent convention - the same vocabulary the location
// table's country -> continent map uses
const CONTINENT_CODES = new Set(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA']);

/**
 * The bottom rung of the fault-domain ladder: /16 (v4) or /32 (v6) arithmetic,
 * which is what the network used before the location table existed.
 * @param {string} ip Bare IP address
 * @returns {string | null} null when the address does not parse
 */
function netDomain(ip) {
  const parsed = cidrUtils.parseIp(ip);
  if (!parsed) return null;
  return `net:${cidrUtils.prefixKey(ip, parsed.version === 4 ? 16 : 32)}`;
}

/**
 * The fault-domain function over one node location snapshot: the domain the
 * view already keyed for that address - organisation, else registry allocation
 * block - else /16 arithmetic. An address the snapshot does not carry falls to
 * /16 as well, and over-approximating the domain count errs strict.
 * @param {Map<string, object>} byIp The resident node location view
 * @returns {(address: string) => string | null}
 */
function domainFunction(byIp) {
  return (address) => {
    const ip = bareIp(address);
    if (!ip) return null;
    return byIp.get(ip)?.d ?? netDomain(ip);
  };
}

/**
 * The node location view plus what it says about the table behind it. A process
 * that does not yet hold the view answers in the same direction as no table at
 * all - an empty view, every node on /16 arithmetic - because the alternative
 * reads as zero candidates, which is a proof this node does not have.
 * @returns {{byIp: Map<string, object>, tableAvailable: boolean,
 *   tableGenerated: string|null}}
 */
function nodeLocationView() {
  const snapshot = ipLocationStore.nodeLocationSnapshot();
  return {
    byIp: snapshot.byIp,
    tableAvailable: snapshot.ready,
    tableGenerated: snapshot.ready ? snapshot.generated : null,
  };
}

/**
 * The fault-domain key for a single address, straight from the stored table:
 * organisation, else registry allocation block, else /16 (v4) / /32 (v6)
 * arithmetic. A store that cannot be read falls to /16, exactly like no table.
 * Prefer placementComputation's domainOf when several addresses are keyed at
 * once - it answers from one snapshot instead of a lookup each.
 * @param {string} address ip or ip:port
 * @returns {Promise<string | null>} null when the address does not parse
 */
async function faultDomain(address) {
  const ip = bareIp(address);
  if (!ip) return null;
  let hit = null;
  try {
    hit = await ipLocationStore.lookup(ip);
  } catch (error) {
    log.warn(`placementFeasibility - location lookup unavailable for ${ip}, using /16: ${error.message}`);
  }
  if (hit?.org) return `org:${hit.org}`;
  if (hit?.block) return `blk:${hit.block.start}-${hit.block.end}`;
  return netDomain(ip);
}


/**
 * The Placement for a caller that holds a submission DOCUMENT rather than a spec
 * object - the registration check and the deploy-form advice endpoint, which are
 * both asked about an app that does not exist yet.
 *
 * Everything else must pass a spec and let `spec.placement` answer.
 * placementComputation refuses a document on purpose: reading `geolocation` and
 * `nodes` off one is the v8 spelling, and a v9 document carries neither, so the
 * silent answer was "no restrictions at all". Converting HERE keeps that
 * conversion visible at the two call sites that genuinely need it, and uses the
 * same converter the version classes use, so one parser answers for both paths.
 * @param {object} doc A submission document (`geolocation` strings, `nodes`)
 * @returns {Promise<object>} a Placement
 */
async function placementFromDocument(doc) {
  const { Placement, convertGeolocation } = await getSpecBackend();
  const { geoAllow, geoDeny } = convertGeolocation(doc?.geolocation ?? []);
  const named = doc?.nodes ?? [];
  const isOutpoint = (entry) => /^[0-9a-f]{64}:\d+$/i.test(entry);
  return Placement.from({
    geoAllow,
    geoDeny,
    targetIps: named.filter((entry) => !isOutpoint(entry)),
    targetOutpoints: named.filter(isOutpoint),
  });
}

/**
 * The node-list entries an app may be placed on. A spec carrying a non-empty
 * `nodes` list is a closed pool - checkAppNodesRequirements enforces it at
 * install from v7 on, and only enterprise owners may carry one from v8 on - so
 * the candidate set IS that list. Counting the whole network for such
 * an app computes a share against fault domains it can never use, which
 * strands it below its instance count.
 * Asked of `placement` rather than of a `nodes` array: the two are the same
 * fact spelled differently by version, and matchesTarget already knows all
 * three ways an owner can name a node - address, collateral outpoint, and
 * operator key, which only v9 can express.
 * @param {Array<object>} nodeList The deterministic node list
 * @param {object} placement The spec's Placement
 * @returns {Array<object>}
 */
function pooledNodes(nodeList, placement) {
  if (!placement.hasTargets()) return nodeList;
  return nodeList.filter((node) => placement.matchesTarget({
    ip: node.ip,
    outpoint: `${node.txhash}:${node.outidx}`,
    operator: node.pubkey ?? undefined,
    ipMatcher: socketAddressesMatch,
  }));
}

/**
 * The per-domain share: the smallest uniform level L at which the domains can
 * absorb all instances, i.e. sum(min(candidatesInDomain, L)) >= instances.
 * When every domain holds at least ceil(instances / domains) candidates this
 * is exactly ceil(instances / domains); when shallow domains cannot absorb
 * their share the level rises only as far as needed, so an app is never
 * stranded by domains too small to take what the average assumes.
 * @param {number[]} domainSizes Candidate count per fault domain
 * @param {number} instances Required instance count
 * @returns {number}
 */
function domainShareLevel(domainSizes, instances) {
  if (domainSizes.length === 0) return instances;
  let level = Math.ceil(instances / domainSizes.length);
  const absorbed = (l) => domainSizes.reduce((sum, size) => sum + Math.min(size, l), 0);
  while (level < instances && absorbed(level) < instances) level += 1;
  return level;
}

/**
 * One placement computation over the current network: the feasibility numbers
 * and the fault-domain function they were computed with. The node location view
 * is read ONCE here, and every domain the caller keys afterwards comes from that
 * same snapshot - so a spawn decision and the share it is measured against can
 * never be answering from two different views of the network.
 * Takes the SPEC OBJECT, not a serialized document. Placement lives on the
 * spec's `placement` accessor, which every version builds - a v8 spec converts
 * its `geolocation` strings into the same entries a v9 spec declares natively.
 * Reading `geolocation`/`nodes` off a serialized document instead worked only
 * for v8: a v9 document carries neither name, so every restriction read as
 * absent and the candidate set silently became the whole network.
 * @param {object} spec App specification object (must expose `placement`)
 * @param {number} [minInstances] Required instance count; defaults to the spec's
 * @returns {Promise<{feasibility: object, domainOf: (address: string) => string|null}>}
 */
async function placementComputation(spec, minInstances) {
  const instances = minInstances ?? spec.instances ?? config.get('fluxapps.minimumInstances');
  // Asked before the accessor rather than after: the accessor waits for the
  // list, and this is reached from a request handler that cannot wait.
  if (!networkStateService.isReady()) {
    const error = new Error('Node list is not available yet');
    error.statusCode = 503;
    throw error;
  }
  const nodeList = await fluxCommunicationUtils.deterministicFluxList();
  if (!Array.isArray(nodeList) || nodeList.length === 0) {
    // an empty node list is missing data, not an empty network - reporting
    // zero candidates would read as proven impossibility to the callers
    const error = new Error('Node list is not available yet');
    error.statusCode = 503;
    throw error;
  }
  // After the 503s on purpose: an unavailable node list is a condition the
  // caller retries, and the spawner branches on that status. A missing
  // placement is a programming error and must not be answered as "try again".
  const placement = spec?.placement;
  if (!placement) {
    // Refusing is the point. A missing placement used to read as "no
    // restrictions at all", which is the failure this signature exists to end.
    throw new Error('placementComputation requires a spec object carrying placement');
  }
  const { byIp, tableAvailable, tableGenerated } = nodeLocationView();
  const domainOf = domainFunction(byIp);
  // The spec's entries decide the rule and the node decides nothing about it,
  // so the question is asked of `placement` once here rather than re-derived
  // per node - a spec may carry two hundred entries against six thousand nodes.
  const geoRestricted = placement.hasGeoRestrictions();

  const domains = new Map(); // fault domain -> candidate count
  // Tier is deliberately NOT a filter. A tier is a collateral class, not a
  // hardware guarantee: install-time sizes an app against the node's actual
  // CPU, RAM and disk, so a node whose hardware exceeds its tier's nominal
  // figure accepts apps this arithmetic would have ruled out. Excluding on
  // the nominal figure therefore refuses deployable apps, and no bound this
  // module can compute is a proof of unfitness. Install time enforces it.
  const candidates = pooledNodes(nodeList, placement);
  let candidateCount = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const node of candidates) {
    const ip = bareIp(node.ip);
    if (!ip) continue; // eslint-disable-line no-continue
    if (geoRestricted && tableAvailable) {
      const doc = byIp.get(ip);
      // A node the view does not carry has no provable location, and an
      // unprovable location COUNTS - this arithmetic is deliberately
      // optimistic so that a shortfall it reports is a proven one. That is
      // the opposite of Placement.matches(), which refuses a node it cannot
      // locate, so the two predicates are asked here rather than the whole
      // matcher: same rule, this module's burden of proof.
      const loc = doc
        ? { continent: doc.n ?? null, country: doc.c ?? null, region: doc.r ?? null }
        : null;
      if (loc && (placement.isDeniedIn(loc) || !placement.isAllowedIn(loc))) continue; // eslint-disable-line no-continue
    }
    const domain = domainOf(ip);
    if (!domain) continue; // eslint-disable-line no-continue
    candidateCount += 1;
    domains.set(domain, (domains.get(domain) ?? 0) + 1);
  }

  const domainCount = domains.size;
  return {
    feasibility: {
      instances,
      candidateCount,
      domainCount,
      maxPerDomain: domainShareLevel([...domains.values()], instances),
      placeable: domainCount > 0,
      tableAvailable,
      tableGenerated,
    },
    domainOf,
  };
}

/**
 * Compute the placement feasibility of an app over the current network.
 * @param {object} spec App specification object (must expose `placement`)
 * @param {number} [minInstances] Required instance count; defaults to the spec's
 * @returns {Promise<{instances: number, candidateCount: number, domainCount: number,
 *   maxPerDomain: number, placeable: boolean, tableAvailable: boolean,
 *   tableGenerated: string|null}>}
 */
async function placementFeasibility(spec, minInstances) {
  const { feasibility } = await placementComputation(spec, minInstances);
  return feasibility;
}

/**
 * How many of the given app locations sit in a fault domain.
 * @param {Array<{ip: string}>} locations Running or installing app locations
 * @param {string} domainKey A fault domain key
 * @param {(address: string) => string|null} [domainOf] A placementComputation
 *   domain function; without it each location costs a lookup of its own
 * @returns {Promise<number>}
 */
async function countHeldInDomain(locations, domainKey, domainOf) {
  if (!domainKey) return 0;
  const held = locations ?? [];
  if (domainOf) return held.filter((location) => domainOf(location.ip) === domainKey).length;
  const domains = await Promise.all(held.map((location) => faultDomain(location.ip)));
  return domains.filter((domain) => domain === domainKey).length;
}

/**
 * Whether the app's spec names this node, by socket address or by collateral
 * outpoint. Being named is the owner's own placement choice and bypasses the
 * diversity share.
 * @param {object} spec App specification object (must expose `placement`)
 * @param {string} localSocketAddr This node's ip:port
 * @returns {Promise<boolean>}
 */
async function specNamesThisNode(spec, localSocketAddr) {
  const placement = spec?.placement;
  if (!placement || !placement.hasTargets()) return false;
  // The address answers without a daemon call, so it is asked first and the
  // collateral lookup only happens when the address did not settle it.
  if (placement.isPinnedTo({ ip: localSocketAddr, ipMatcher: socketAddressesMatch })) return true;
  try {
    const collateral = await generalService.obtainNodeCollateralInformation();
    return placement.isPinnedTo({ outpoint: `${collateral.txhash}:${collateral.txindex}` });
  } catch (error) {
    log.warn(`placementFeasibility - could not resolve node collateral: ${error.message}`);
    return false;
  }
}

/**
 * The placement category of a computed feasibility - the availability promise
 * the network can make for the spec:
 *   'impossible'  - fewer eligible nodes than instances, even though every
 *                   approximation counts TOWARD eligibility, so the shortfall
 *                   is proven. The spec can never reach its instance count;
 *                   registration rejects it.
 *   'constrained' - the instance count is reachable, but a synced app's
 *                   instances outnumber its fault domains, so some instances
 *                   must share a provider. Deliverable, with less resiliency
 *                   than the instance count implies; registration warns.
 *   'ok'          - the requested count and diversity are both deliverable.
 * @param {object} feasibility A placementFeasibility() result
 * @param {boolean} syncedApp Whether the spec has synced components
 * @returns {'impossible'|'constrained'|'ok'}
 */
function placementCategory(feasibility, syncedApp) {
  if (feasibility.candidateCount < feasibility.instances) return 'impossible';
  if (syncedApp && feasibility.domainCount < feasibility.instances) return 'constrained';
  return 'ok';
}

/**
 * The placement-relevant sizing of a spec: the fields that decide how many
 * nodes could hold it. Compared between an update and the spec it replaces.
 * @param {object} spec Formatted app specifications
 * @returns {string} A comparable digest
 */
function placementShape(spec) {
  // EXACTLY what placementComputation reads, and nothing else. It is asked
  // `pooledNodes(nodeList, placement)` and an instance count; resources never
  // reach it, because tier is deliberately not a filter here - install time
  // sizes an app against the node's real hardware. A shape carrying component
  // sizes would gate an update that only grew a disk, and if the network had
  // shrunk since registration that renewal would be refused over a number this
  // gate cannot act on. Which is the harm changesPlacement exists to prevent.
  return JSON.stringify({
    instances: spec.instances ?? null,
    placement: spec.placement ? spec.placement.toCanonical() : null,
  });
}

/**
 * How many machines a spec names. A pinned spec may only ever use the nodes it
 * names, so this is the ceiling on its instance count - and the two shortfalls
 * read differently to an owner, which is why the count is asked separately from
 * the candidate count.
 * @param {object} placement A Placement
 * @returns {number}
 */
function placementPinCount(placement) {
  if (!placement) return 0;
  return placement.targetIps.length
    + placement.targetOutpoints.length
    + placement.targetOperators.length;
}

/**
 * Whether an update changes anything placement depends on. An update that
 * touches none of it - an expire-only renewal, a cancellation (expire: 1), a
 * description or environment edit - must never be refused by the placement
 * gate: the owner is not making placement worse, and refusing would strand
 * them with an app they can neither renew nor cancel.
 * @param {object} next The update's formatted specifications
 * @param {object} previous The specifications it replaces
 * @returns {boolean}
 */
function changesPlacement(next, previous) {
  if (!previous) return true; // nothing to compare against - gate it
  // A previous spec this node could not read carries no placement to compare
  // against. Reading that absence as a change would gate exactly the renewals
  // and cancellations this exists to let through - so an unreadable previous
  // is treated as unchanged, which is the direction that cannot strand an
  // owner with an app they can neither renew nor cancel.
  if (!previous.placement) return false;
  return placementShape(next) !== placementShape(previous);
}

/**
 * Enforce placement feasibility on the user-facing registration and update
 * paths: an impossible spec is rejected before it is paid for, a constrained
 * synced spec is accepted with a warning. Called from the API front door
 * only - never from p2p message verification, where nodes with different
 * table versions must not disagree about message validity. A failure to
 * COMPUTE feasibility never rejects: without the computation there is no
 * proof, and only proven impossibility may refuse a registration.
 *
 * On an update path, pass the previous specifications: an update that does
 * not change placement is never gated (see changesPlacement).
 *
 * Takes a SPEC, not a submission document. It read `compose`, `geolocation` and
 * `nodes` and converted through placementFromDocument, which is the v8 spelling:
 * a v9 spec carries none of those, so it would not have failed - it would have
 * built a Placement with no restrictions at all and reported every spec
 * feasible, for every caller, silently. The spec's own Placement answers
 * instead, and placementFeasibility refuses a spec that has none rather than
 * reading the absence as "unrestricted". placementFromDocument stays for the
 * advice endpoint, which really is asked about an app that does not exist yet.
 * @param {object} spec An app specification object carrying `placement`
 * @param {string} caller Log prefix identifying the calling path
 * @param {object} [previousSpec] The specifications an update replaces
 * @returns {Promise<object|null>} The feasibility, or null when it could not
 *   be computed or the check did not apply
 * @throws When the spec provably cannot reach its instance count
 */
async function checkPlacementFeasibility(spec, caller, previousSpec) {
  if (previousSpec && !changesPlacement(spec, previousSpec)) return null;
  let synced;
  let feasibility;
  try {
    synced = spec.hasSyncthing();
    feasibility = await placementFeasibility(spec);
  } catch (error) {
    log.warn(`${caller} - placement feasibility check failed: ${error.message}`);
    return null;
  }
  const category = placementCategory(feasibility, synced);
  const geoRestricted = spec.placement.hasGeoRestrictions();
  const pinCount = placementPinCount(spec.placement);
  if (category === 'impossible' && pinCount >= feasibility.instances) {
    // A pinned spec names the only machines it may ever use, and the owner
    // holds them. Named enough of them and the shortfall is that some are not
    // in the confirmed list at this moment - a node rebooting, one that missed
    // a check-in, or one not yet installed. That resolves without touching the
    // spec, and it is the owner's to resolve, so this reports rather than
    // refuses. Naming FEWER machines than instances is the other thing entirely
    // and still refuses below: no wait fixes arithmetic.
    log.warn(`${caller} - App ${spec.name} requests ${feasibility.instances} instances and names ${pinCount} node(s), of which ${feasibility.candidateCount} are in the confirmed node list right now; it will run below its instance count until the rest confirm`);
    return feasibility;
  }
  if (category === 'impossible') {
    // A geo-restricted request that resolves to NO candidate at all is a
    // shortfall this node usually cannot stand behind. Candidate countries
    // come from the published table while country-level install eligibility
    // is decided by each node's own ip-api self-report, and the two disagree
    // for some ranges - a total miss there is indistinguishable from the
    // table mis-attributing that geography. Some candidates resolving proves
    // the attribution works, so a shortfall above zero is real and refusable.
    //
    // The one exception is a spec whose every allow entry is a region pin in
    // the table's own vocabulary: the installer resolves its region through
    // the same table this count reads, so zero candidates means zero nodes
    // whose installer would accept - registering it sells a deployment that
    // provably cannot start. Same source on both ends turns the miss into
    // proof, and proof rejects.
    // Asked of the Placement's own allow entries rather than re-parsed from
    // geolocation strings the spec no longer carries: an entry is a region pin
    // exactly when it names one.
    const allows = spec.placement.geoAllow ?? [];
    const allTableRegionPins = allows.length > 0
      && allows.every((entry) => Boolean(entry.region));
    if (geoRestricted && feasibility.candidateCount === 0 && !allTableRegionPins) {
      log.warn(`${caller} - App ${spec.name} resolves no eligible node for its geolocation; the location table may not cover it, so the registration is allowed`);
      return feasibility;
    }
    // Two different shortfalls, and telling an owner the wrong one sends them to
    // edit a field that was never the problem: a pinned spec has no allowed
    // locations to widen, and the machines it may use are the ones it names.
    if (pinCount) {
      throw new Error(`App ${spec.name} requests ${feasibility.instances} instances but names only ${pinCount} node(s), so it can never reach that count. Name at least ${feasibility.instances} nodes or lower the instance count.`);
    }
    throw new Error(`App ${spec.name} requests ${feasibility.instances} instances but only ${feasibility.candidateCount} eligible nodes exist for its geolocation and tier requirements. Widen the allowed locations or lower the instance count.`);
  }
  if (category === 'constrained') {
    log.warn(`${caller} - App ${spec.name} requests ${feasibility.instances} instances across ${feasibility.domainCount} fault domain(s); synced instances will co-locate up to ${feasibility.maxPerDomain} per domain`);
  }
  return feasibility;
}

/**
 * Normalise one structured geolocation entry to the spec-string form the
 * network stores and matches (ac<CONT>, ac<CONT>_<CC>, ac<CONT>_<CC>_<REGION>,
 * a!c... when forbidden). Vocabulary is the location table's: two-letter
 * continent codes, ISO 3166-1 alpha-2 countries, ISO 3166-2 regions. The
 * continent may be omitted when the table can derive it from the country;
 * a continent that contradicts the table's pairing is an error rather than
 * a silent correction.
 * @param {{continent?: string, country?: string, region?: string,
 *   forbidden?: boolean}} entry Structured geolocation entry
 * @returns {string} Spec-string form
 */
function normalizeStructuredEntry(entry) {
  if (entry.forbidden !== undefined && typeof entry.forbidden !== 'boolean') {
    throw new Error('Invalid geolocation entry: forbidden must be a boolean');
  }
  const field = (value, name) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new Error(`Invalid geolocation entry: ${name} must be a string`);
    // capped before it can reach a rejection message: an unbounded value
    // echoed into an error writes arbitrary volume into the node's logs, and
    // holding a Flux ID is not a reason to be trusted with the length
    if (value.length > 20) throw new Error(`Invalid geolocation entry: ${name} is too long`);
    return value.trim().toUpperCase();
  };
  const continent = field(entry.continent, 'continent');
  const country = field(entry.country, 'country');
  const region = field(entry.region, 'region');
  if (region && !country) {
    throw new Error(`Invalid geolocation entry: region ${region} requires its country`);
  }
  if (!continent && !country) {
    throw new Error('Invalid geolocation entry: a continent or country is required');
  }
  if (continent && !CONTINENT_CODES.has(continent)) {
    throw new Error(`Invalid geolocation entry: unknown continent code ${continent}`);
  }
  if (country && !/^[A-Z]{2}$/.test(country)) {
    throw new Error(`Invalid geolocation entry: ${country} is not an ISO 3166-1 alpha-2 country code`);
  }
  if (region && !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region)) {
    throw new Error(`Invalid geolocation entry: ${region} is not an ISO 3166-2 region code`);
  }
  if (region && region.slice(0, 2) !== country) {
    throw new Error(`Invalid geolocation entry: region ${region} does not belong to ${country}`);
  }
  const tableContinent = country ? ipLocationStore.continentForCountry(country) : null;
  if (country && ipLocationStore.status().ready && !tableContinent) {
    throw new Error(`Invalid geolocation entry: unknown country code ${country}`);
  }
  if (continent && tableContinent && continent !== tableContinent) {
    throw new Error(`Invalid geolocation entry: country ${country} is in ${tableContinent}, not ${continent}`);
  }
  const resolvedContinent = continent ?? tableContinent;
  if (!resolvedContinent) {
    throw new Error(`Invalid geolocation entry: cannot derive the continent of ${country} without the location table - include continent`);
  }
  const parts = [resolvedContinent];
  if (country) parts.push(country);
  // The region is emitted in the table's vocabulary (full ISO 3166-2, already
  // validated to belong to its country above). Placement matches it at region
  // granularity and the installer resolves its own region through the same
  // table - one vocabulary end to end, enforced on proof in both directions:
  // a node the table cannot place at region granularity satisfies no region
  // pin and is caught by no region deny.
  if (region) parts.push(region);
  return `${entry.forbidden === true ? 'a!c' : 'ac'}${parts.join('_')}`;
}

/**
 * Normalise a mixed geolocation array: spec strings pass through verbatim,
 * structured entries become spec strings. Also reports which normalised entries
 * carry a region part placement can only honour at country granularity.
 *
 * Which entries those are is flux-spec's answer, not one computed here: the
 * library reports every entry whose region it could not read, and an entry the
 * count honours exactly must never be reported as widened. Structured entries
 * always emit table-vocabulary regions, so they are never coarsened.
 * @param {Array<string|object>} entries Geolocation entries, either syntax
 * @returns {Promise<{normalized: string[], coarsened: string[]}>}
 */
async function normalizeGeolocation(entries) {
  const normalized = entries.map((entry) => {
    if (typeof entry === 'string') {
      if (entry.length > 50) throw new Error('Invalid geolocation specified');
      return entry;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return normalizeStructuredEntry(entry);
    }
    throw new Error('Invalid geolocation specified');
  });
  const { convertGeolocation } = await getSpecBackend();
  const { unresolved } = convertGeolocation(normalized);
  const coarsened = (unresolved || []).map((u) => u.entry);
  return { normalized, coarsened };
}

/**
 * Whether any component of a submission document replicates its storage.
 *
 * Asked of the library, which answers for either version: a v9 component says
 * so in `persistentStorage.sync`, and a legacy one spells the same thing as a
 * flag on its primary mount, which the conversion reads into that field.
 *
 * A component whose storage cannot be read is not synced rather than an error.
 * This is advice about a spec the caller has not registered yet, and an
 * unreadable mount string is refused where it matters — at the submission door,
 * by the owner, before anything is signed.
 * @param {object} doc A submission document, legacy or v9 shaped
 * @returns {Promise<boolean>}
 */
async function anyComponentSynced(doc) {
  const { parseContainerData } = await getSpecBackend();
  const isSynced = (containerData) => {
    if (typeof containerData !== 'string') return false;
    try {
      return parseContainerData(containerData, 0, [], new Map(), 0).persistentStorage.sync !== null;
    } catch {
      return false;
    }
  };
  if (Array.isArray(doc.compose)) return doc.compose.some((c) => isSynced(c?.containerData));
  return isSynced(doc.containerData);
}

/**
 * The geolocation input of a prospective spec, in either accepted shape: the
 * spec's flat geolocation array (spec strings and/or structured entries), or
 * the v9 placement shape - geoAllow/geoDeny arrays of structured entries,
 * exactly what a v9 spec's placement carries - so the deploy form can pass
 * one object to both this endpoint and the spec it registers. Returns the
 * mixed entry list normalizeGeolocation consumes.
 * @param {object} spec Request body
 * @returns {Array<string|object>}
 */
function geolocationEntries(spec) {
  const hasPlacementShape = spec.geoAllow !== undefined || spec.geoDeny !== undefined;
  if (!hasPlacementShape) {
    const entries = spec.geolocation ?? [];
    // 10 entries is the registration limit - nothing beyond it can be bought
    if (!Array.isArray(entries) || entries.length > 10) {
      throw new Error('Invalid geolocation specified');
    }
    return entries;
  }
  if (spec.geolocation !== undefined) {
    throw new Error('Provide either geolocation or geoAllow/geoDeny, not both');
  }
  const entries = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const [name, list, forbidden] of [['geoAllow', spec.geoAllow, false], ['geoDeny', spec.geoDeny, true]]) {
    if (list === undefined || list === null) continue; // eslint-disable-line no-continue
    // the v9 schema caps each list at 100 entries
    if (!Array.isArray(list) || list.length > 100) {
      throw new Error(`Invalid ${name} specified`);
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.forbidden !== undefined) {
        throw new Error(`Invalid ${name} specified`);
      }
      entries.push({ ...entry, forbidden });
    }
  }
  return entries;
}

// Advice is computed on every request, deliberately. The answer is one pass
// over the resident node list with the rule already parsed - no I/O - so a memo
// would save a few milliseconds while introducing a staleness window on numbers
// the caller is about to spend money against.

/**
 * The placement advice for a prospective app spec, before payment: how many
 * fault domains the requested geography spans, how many instances it can
 * truly hold, and the spec-string geolocation that was evaluated.
 * Geolocation entries are spec strings ('acEU_CZ', 'a!cEU', legacy
 * 'aEU'/'bFR') or structured { continent?, country?, region?, forbidden? }
 * objects; the v9 placement shape ({ geoAllow, geoDeny } arrays) is accepted
 * in place of the flat array. The structured forms are normalised to spec
 * strings, and normalizedGeolocation echoes exactly what was evaluated so
 * the caller can register it verbatim. coarsenedEntries lists entries whose
 * region part placement cannot honour at region granularity. Compose or
 * top-level sizing narrows candidates to the tiers that can hold the app.
 * Throws on invalid input.
 * @param {object} spec Prospective spec { instances?, geolocation? |
 *   geoAllow?/geoDeny?, compose? | containerData?, cpu/ram/hdd? }
 * @returns {Promise<object>} Feasibility plus the advice fields
 */
async function placementAdvice(spec) {
  // An unparsed body reaches here as {} - answering about a default spec would
  // advise a purchase the caller never described. This endpoint requires
  // Content-Type: application/json, which is what makes req.body exist.
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).length === 0) {
    throw new Error('Empty or unparsed request body - send JSON with Content-Type: application/json');
  }
  const instances = serviceHelper.ensureNumber(spec.instances ?? config.get('fluxapps.minimumInstances'));
  if (!Number.isInteger(instances) || instances < 1 || instances > config.get('fluxapps.maximumInstances')) {
    throw new Error('Invalid instances specified');
  }
  const { normalized, coarsened } = await normalizeGeolocation(geolocationEntries(spec));
  // advice differs from enforcement here: the registration gate stays
  // permissive without a table (nothing is provable), but serving a
  // geo-restricted ANSWER computed over the whole network would advise a
  // purchase on numbers that mean nothing - say unavailable instead
  if (normalized.some((value) => value !== '') && !ipLocationStore.status().ready) {
    const error = new Error('The IP location table is not available yet - geolocation feasibility cannot be answered');
    error.statusCode = 503;
    throw error;
  }
  const synced = await anyComponentSynced(spec);
  const placement = await placementFromDocument({ geolocation: normalized });
  const feasibility = await placementFeasibility({ placement, instances }, instances);
  // the availability gate above raced the computation: a store that became
  // unreadable in between degrades the numbers to the /16 posture, which for
  // a geo-restricted question is the whole network - unavailable, not advice
  if (normalized.some((value) => value !== '') && !feasibility.tableAvailable) {
    const error = new Error('The IP location table is not available yet - geolocation feasibility cannot be answered');
    error.statusCode = 503;
    throw error;
  }
  return {
    ...feasibility,
    syncedApp: synced,
    category: placementCategory(feasibility, synced),
    // diversity below the requested count: some fault domain must hold more than one instance
    constrained: synced && feasibility.domainCount < feasibility.instances,
    // with the water-filled share, any count up to the candidate pool is reachable
    satisfiable: feasibility.candidateCount >= feasibility.instances,
    normalizedGeolocation: normalized,
    coarsenedEntries: coarsened,
  };
}

/**
 * API handler: POST /apps/placementfeasibility.
 *
 * Requires a signed-in Flux ID, and the reason is compatibility rather than
 * cost. This endpoint is new, so it could ask from the outset without breaking
 * a caller, and whoever asks it is about to sign a registration anyway - the
 * gate takes nothing the deploy path does not already hold.
 *
 * Cost is deliberately not the reason, because it does not survive contact with
 * the neighbours: verifyAppRegistrationParameters and validateAppUpdate run the
 * same pass over the node list and stay open, because tooling calls them to
 * check a spec before there is a signature to gate on. Every caller does send a
 * different spec, so no shared cache bounds this the way one bounds the
 * placement geography - but that is a fact about caching, not a reason to gate.
 * @param {import('express').Request} req Request
 * @param {import('express').Response} res Response
 */
async function placementFeasibilityAPI(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege(Privilege.USER, authOf(req));
    if (authorized !== true) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }
    const response = messageHelper.createDataMessage(await placementAdvice(req.body ?? {}));
    res.json(response);
  } catch (error) {
    // rejected input and unavailable data are both ordinary answers here - a
    // stack per bad request would let a caller fill the error log
    log.warn(`placementFeasibilityAPI - ${error.message}`);
    const errorResponse = messageHelper.createErrorMessage(error.message, error.name, error.code);
    if (error.statusCode) res.status(error.statusCode);
    res.json(errorResponse);
  }
}

/**
 * The live placement geography in one pass over the node list: node, fault
 * domain and tier counts per continent and country, from the node's own
 * location table. Nodes the table cannot resolve are counted in unresolved
 * rather than guessed at; without a table the tree is empty and only the
 * totals (with /16 fault domains) are served.
 * @returns {Promise<{tableAvailable: boolean, tableGenerated: string|null,
 *   total: {nodes: number, domains: number}, unresolved: number,
 *   continents: object}>}
 */
async function placementLocations() {
  // A request is waiting on this, so it may not block: the accessors below wait
  // for the node list, and a client holding a connection through a boot is a
  // worse answer than a plain "not yet". Its sibling placementComputation says
  // the same thing the same way - without this the two would disagree, one
  // refusing to answer and the other reporting that an app can be placed
  // nowhere.
  if (!networkStateService.isReady()) {
    const error = new Error('Node list is not available yet');
    error.statusCode = 503;
    throw error;
  }

  const { byIp, tableAvailable, tableGenerated } = nodeLocationView();
  if (!tableAvailable) {
    // the tree IS the product here - totals over /16 fallback domains are
    // not the placement geography, so absence of the view is unavailability
    const error = new Error('The IP location table is not available yet');
    error.statusCode = 503;
    throw error;
  }
  const nodeList = await fluxCommunicationUtils.deterministicFluxList();
  const domainOf = domainFunction(byIp);
  const totalDomains = new Set();
  let totalNodes = 0;
  let unresolvedNodes = 0;
  const continents = new Map();
  // eslint-disable-next-line no-restricted-syntax
  for (const node of nodeList) {
    const ip = bareIp(node.ip);
    if (!ip) continue; // eslint-disable-line no-continue
    totalNodes += 1;
    const domain = domainOf(ip);
    if (domain) totalDomains.add(domain);
    const doc = byIp.get(ip);
    if (!doc?.c || !doc.n) {
      unresolvedNodes += 1;
      continue; // eslint-disable-line no-continue
    }
    const tier = typeof node.tier === 'string' ? node.tier : 'UNKNOWN';
    let continent = continents.get(doc.n);
    if (!continent) {
      continent = { nodes: 0, domains: new Set(), tiers: {}, countries: new Map() };
      continents.set(doc.n, continent);
    }
    continent.nodes += 1;
    if (domain) continent.domains.add(domain);
    continent.tiers[tier] = (continent.tiers[tier] ?? 0) + 1;
    let country = continent.countries.get(doc.c);
    if (!country) {
      country = { nodes: 0, domains: new Set(), tiers: {} };
      continent.countries.set(doc.c, country);
    }
    country.nodes += 1;
    if (domain) country.domains.add(domain);
    country.tiers[tier] = (country.tiers[tier] ?? 0) + 1;
  }
  const continentsOut = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const [code, continent] of continents) {
    const countriesOut = {};
    // eslint-disable-next-line no-restricted-syntax
    for (const [cc, country] of continent.countries) {
      countriesOut[cc] = { nodes: country.nodes, domains: country.domains.size, tiers: country.tiers };
    }
    continentsOut[code] = {
      nodes: continent.nodes,
      domains: continent.domains.size,
      tiers: continent.tiers,
      countries: countriesOut,
    };
  }
  return {
    tableAvailable,
    tableGenerated,
    total: { nodes: totalNodes, domains: totalDomains.size },
    unresolved: unresolvedNodes,
    continents: continentsOut,
  };
}

/**
 * API handler: GET /apps/placementlocations.
 * @param {import('express').Request} req Request
 * @param {import('express').Response} res Response
 */
async function placementLocationsAPI(req, res) {
  try {
    const response = messageHelper.createDataMessage(await placementLocations());
    res.json(response);
  } catch (error) {
    log.warn(`placementLocationsAPI - ${error.message}`);
    const errorResponse = messageHelper.createErrorMessage(error.message, error.name, error.code);
    if (error.statusCode) res.status(error.statusCode);
    res.json(errorResponse);
  }
}

module.exports = {
  faultDomain,
  placementComputation,
  placementFeasibility,
  placementCategory,
  changesPlacement,
  placementPinCount,
  countHeldInDomain,
  specNamesThisNode,
  checkPlacementFeasibility,
  normalizeGeolocation,
  placementAdvice,
  placementFeasibilityAPI,
  placementLocations,
  placementLocationsAPI,
};
