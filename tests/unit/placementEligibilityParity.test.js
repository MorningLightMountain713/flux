// Differential test: the candidate filter must never exclude a node the
// installer would accept.
//
// placementFeasibility.nodeLocationMatchesGeolocation decides who COUNTS as a
// candidate, and hwRequirements.checkAppGeolocationRequirements decides who may
// actually INSTALL. They are separate implementations of the same rule, over
// different data sources, and neither module's own suite owns the relationship
// between them. A candidate filter stricter than the installer under-counts,
// which drives the registration gate toward refusing deployable apps and the
// spawner toward standing down when it is the last eligible node.
//
// The asymmetry is deliberate and one-directional: over-counting is safe (the
// installer still refuses), under-counting is not. So this asserts implication,
// not equivalence - installer accepts => filter counts.

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const { loadSpecLibrary } = require('./fixtures/fluxSpec');

// The published table's name-to-code map, for the region NAMES a v1-v8 spec and
// an ip-api self-report both use. Only the table connects those to the ISO codes
// v9 carries, and BOTH sides of this differential read it: the filter through
// ipLocationStore.regionCodeForName, the installer through the resolver
// specCutover registers into the spec library. One function for both here, for
// the same reason there is one table in production - the real store answers null
// for everything until a table is loaded, which is not the case under test.
const REGION_CODES = new Map(Object.entries({
  'FI|Uusimaa': 'FI-18',
  'FI|Pirkanmaa': 'FI-11',
  'DE|Bavaria': 'DE-BY',
  'BH|Manama': 'BH-13',
  'US|California': 'US-CA',
  'US|Hawaii': 'US-HI',
  'CA|Ontario': 'CA-ON',
  'AT|Vienna': 'AT-9',
}));
const regionCodeForName = (countryCode, regionName) => (
  countryCode && regionName ? REGION_CODES.get(`${countryCode}|${regionName}`) ?? null : null
);

const placementFeasibility = proxyquire('../../ZelBack/src/services/appPlacement/placementFeasibility', {
  './ipLocationStore': { regionCodeForName },
});

// every geolocation shape the network actually carries, plus the shapes the
// spec permits but production has not exercised
const GEO_SPECS = [
  [],
  ['acEU'],
  ['acEU_FI'],
  ['acAS_BH'],
  ['acNA_US_California'],
  // a legacy region name on a node the table places in a different country:
  // the region NAME is still compared against the node's own self-report, but
  // the continent and country it is compared alongside now come from the table
  ['acEU_AT_Vienna'],
  ['a!cEU_AT_Vienna'],
  ['acEU_FI_Uusimaa'],
  ['acEU_FI_NONE'],
  ['acALL'],
  ['acEU_ALL'],
  ['acEU_FI_ALL'],
  ['a!cEU'],
  ['a!cEU_FI'],
  ['a!cNA_US_Hawaii'],
  ['a!cEU_DE_NONE'],
  ['acEU', 'a!cEU_RU'],
  ['acEU_FI', 'acAS_BH'],
  ['acNA', 'a!cNA_US'],
  ['aEU'],
  ['bFI'],
  ['aEU', 'bFI'],
  // the table's own region vocabulary - full ISO 3166-2
  ['acEU_FI_FI-18'],
  ['acNA_US_US-CA'],
  ['a!cEU_FI_FI-18'],
  ['a!cNA_US_US-HI'],
  ['acEU_FI_FI-18', 'acAS_BH'],
  ['acEU', 'a!cEU_FI_FI-18'],
  // Legacy pins, which compose as AND: a country pin applies unconditionally at
  // install time and a continent pin only when no modern entry is present. All
  // three of these diverged until flux-spec `787ed39` and this tree's
  // `936cace58` - convertLegacyPin ORed the first, dropped the country pin of
  // the second, and made the third the union of two constraints the owner asked
  // for the intersection of. They were pinned individually while that was true;
  // now that both sides agree they belong in the grid with everything else.
  ['acEU', 'bFI'],
  ['aNA', 'bDE'],
  // Pins naming a country and a continent that do not exist. Install time
  // compares them against every node and matches none, so the app is placeable
  // nowhere; the conversion said "unconstrained" until `787ed39`. `a=EU` is on
  // chain, a typo on a v8 test app.
  ['bZZ'],
  ['a=EU'],
];

// Node locations spanning both sides of every boundary above.
//
// continentCode/countryCode/regionName are the node's own ip-api self-report.
// tableContinent/tableCountry/tableRegion are what the published table
// resolves for its address, and default to the self-report where the two
// agree - which is the ordinary case, but NOT the interesting one. The last
// entries are where they disagree, because that is the only shape in which
// the filter can be stricter than the installer, and a fixture that derives
// both sides from one value cannot express it at all.
//
// tableMissing marks a node the table cannot place: no covering row. The
// filter sees no document and counts it; the installer falls back to its own
// self-report and may refuse. That direction is safe and is asserted too.
const NODE_LOCATIONS = [
  { continentCode: 'EU', countryCode: 'FI', regionName: 'Uusimaa', tableRegion: 'FI-18' },
  { continentCode: 'EU', countryCode: 'FI', regionName: 'Pirkanmaa', tableRegion: 'FI-11' },
  { continentCode: 'EU', countryCode: 'FI', regionName: 'Uusimaa', tableRegion: null },
  { continentCode: 'EU', countryCode: 'DE', regionName: 'Bavaria', tableRegion: 'DE-BY' },
  { continentCode: 'EU', countryCode: 'RU', regionName: 'Moscow', tableRegion: null },
  { continentCode: 'AS', countryCode: 'BH', regionName: 'Manama', tableRegion: 'BH-13' },
  { continentCode: 'NA', countryCode: 'US', regionName: 'California', tableRegion: 'US-CA' },
  { continentCode: 'NA', countryCode: 'US', regionName: 'Hawaii', tableRegion: 'US-HI' },
  { continentCode: 'NA', countryCode: 'CA', regionName: 'Ontario', tableRegion: 'CA-ON' },
  { continentCode: 'SA', countryCode: 'BR', regionName: 'Sao Paulo', tableRegion: null },
  // the table and the self-report disagree about the country
  {
    continentCode: 'EU', countryCode: 'AT', regionName: 'Vienna', tableRegion: null, tableCountry: 'DE',
  },
  {
    continentCode: 'EU', countryCode: 'DE', regionName: 'Bavaria', tableRegion: 'AT-9', tableCountry: 'AT',
  },
  // and about the continent, which drags the country with it
  {
    continentCode: 'AS', countryCode: 'BH', regionName: 'Manama', tableRegion: null, tableContinent: 'EU', tableCountry: 'GB',
  },
  // the table cannot place this node at all
  {
    continentCode: 'EU', countryCode: 'FI', regionName: 'Uusimaa', tableRegion: null, tableMissing: true,
  },
];

/** What the published table resolves for a node, or null when it has no row. */
function tableHit(nodeGeo) {
  if (nodeGeo.tableMissing) return null;
  return {
    org: 'aabbccddeeff',
    block: { start: 0, end: 0 },
    countryCode: nodeGeo.tableCountry ?? nodeGeo.countryCode,
    continentCode: nodeGeo.tableContinent ?? nodeGeo.continentCode,
    region: nodeGeo.tableRegion,
  };
}

/**
 * The filter-side location for a node: what the candidate filter reads from
 * the nodelocations view, which is derived from the published table and from
 * nothing else. A node the table cannot place has no document, and the filter
 * is handed null for it.
 */
function filterLocation(nodeGeo) {
  const hit = tableHit(nodeGeo);
  if (!hit) return null;
  return {
    continentCode: hit.continentCode,
    countryCode: hit.countryCode,
    region: hit.region ?? null,
  };
}

/**
 * The location the installer is answered with, derived exactly as
 * geolocationService.getPlacementLocation derives it: the published table when
 * it can place the node, and the node's own self-report when it cannot - which
 * carries no region, because a self-report's region name is not the table's
 * vocabulary. Mirrored here rather than driven through the real function
 * because that one lazily requires the location store from inside
 * geolocationService, where proxyquiring hwRequirements cannot reach it.
 */
function placementLocation(nodeGeo) {
  const hit = tableHit(nodeGeo);
  if (hit?.continentCode && hit.countryCode) {
    const location = { continent: hit.continentCode, country: hit.countryCode };
    if (hit.region) location.region = hit.region;
    return location;
  }
  return { continent: nodeGeo.continentCode, country: nodeGeo.countryCode };
}

/**
 * Does the real install-time gate accept this node for this spec?
 *
 * Runs the actual hwRequirements implementation - not a reimplementation, which
 * would defeat the purpose. It used to call checkAppGeolocationRequirements,
 * which is development's name for this and does not exist here: the gate is
 * checkPlacement, and it asks the spec's own Placement rather than comparing
 * geolocation strings itself. Every call threw a TypeError that the catch below
 * turned into "the installer refuses", so the installer side of this
 * differential was a constant - which passes the under-count assertion for
 * every pair and fails the other two for every pair.
 *
 * The v7 strings become a Placement through the same converter the version
 * classes and placementFeasibility both use. That is not the thing under test:
 * what differs between the two sides is how each then COMPARES - the filter
 * through geolocationRule against the raw strings, the installer through
 * Placement.isAllowedIn/isDeniedIn.
 */
const installerGates = new Map();

async function installerAccepts(geolocation, nodeGeo) {
  // one proxied module per node location, not per call - the stubs are fixed
  // per node and the grid re-visits each node once per spec shape
  const key = JSON.stringify(nodeGeo);
  if (!installerGates.has(key)) {
    installerGates.set(key, proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
      '../geolocationService': {
        getPlacementLocation: sinon.stub().resolves(placementLocation(nodeGeo)),
        isStaticIP: () => true,
        isDataCenter: () => true,
      },
    }));
  }
  const { geoAllow, geoDeny } = flux.convertGeolocation(geolocation);
  const placement = flux.Placement.from({ geoAllow, geoDeny });
  try {
    await installerGates.get(key).checkPlacement({ name: 'parity', version: 7, placement });
    return true;
  } catch (error) {
    return false;
  }
}

let flux;

describe('placement eligibility parity with install-time geolocation', () => {
  before(async function loadLibrary() {
    // The first schema compile is slow; every later call is free.
    this.timeout(60_000);
    flux = await loadSpecLibrary();

  });

  it('counts every node the installer would accept, for every geolocation shape', async () => {
    const underCounted = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const geolocation of GEO_SPECS) {
      // eslint-disable-next-line no-restricted-syntax
      for (const nodeGeo of NODE_LOCATIONS) {
        // eslint-disable-next-line no-await-in-loop
        const accepted = await installerAccepts(geolocation, nodeGeo);
        const counted = placementFeasibility.nodeLocationMatchesGeolocation(filterLocation(nodeGeo), geolocation);
        if (accepted && !counted) {
          underCounted.push(`${JSON.stringify(geolocation)} vs ${nodeGeo.continentCode}_${nodeGeo.countryCode}_${nodeGeo.regionName}/${nodeGeo.tableRegion}`);
        }
      }
    }
    expect(underCounted, `candidate filter excluded nodes the installer accepts:\n  ${underCounted.join('\n  ')}`).to.deep.equal([]);
  });

  it('does not count a node the installer refuses at a granularity the table resolves', async () => {
    // The reverse direction is allowed to differ ONLY where the table cannot
    // resolve the spec's granularity (region). At continent and country
    // granularity the two must agree, or the advice numbers are fiction.
    const overCounted = [];
    const resolvable = GEO_SPECS.filter((entries) => entries.every((entry) => {
      const body = entry.startsWith('a!c') ? entry.slice(3) : entry.slice(2);
      // a region part - including _NONE, which install-time treats as one -
      // is granularity the table cannot resolve, so divergence there is the
      // deliberate over-inclusion, not a defect
      return body.split('_').length <= 2;
    }));
    // A node the table cannot place at all is the same deliberate
    // over-inclusion seen from the other side: the filter has no document for
    // it and counts it, the installer falls back to its own self-report and may
    // refuse. That direction is safe, and the test below asserts it directly.
    const placeable = NODE_LOCATIONS.filter((nodeGeo) => !nodeGeo.tableMissing);
    // eslint-disable-next-line no-restricted-syntax
    for (const geolocation of resolvable) {
      // eslint-disable-next-line no-restricted-syntax
      for (const nodeGeo of placeable) {
        // eslint-disable-next-line no-await-in-loop
        const accepted = await installerAccepts(geolocation, nodeGeo);
        const counted = placementFeasibility.nodeLocationMatchesGeolocation(filterLocation(nodeGeo), geolocation);
        if (!accepted && counted) {
          overCounted.push(`${JSON.stringify(geolocation)} vs ${nodeGeo.continentCode}_${nodeGeo.countryCode}`);
        }
      }
    }
    expect(overCounted, `candidate filter counted nodes the installer refuses:\n  ${overCounted.join('\n  ')}`).to.deep.equal([]);
  });

  it('agrees with the installer exactly at table-resolvable region granularity', async () => {
    // For region entries in the table's own vocabulary, on nodes whose region
    // the table knows, filter and installer read the same table - so they must
    // agree in BOTH directions. Divergence here is not over-inclusion, it is
    // one of the two implementations misreading the shared vocabulary.
    const isoRegionSpecs = GEO_SPECS.filter((entries) => entries.length
      && entries.every((entry) => {
        const body = entry.startsWith('a!c') ? entry.slice(3) : entry.slice(2);
        const parts = body.split('_');
        return parts.length <= 2 || /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(parts[2]);
      }));
    const regionKnown = NODE_LOCATIONS.filter((nodeGeo) => nodeGeo.tableRegion);
    const diverged = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const geolocation of isoRegionSpecs) {
      // eslint-disable-next-line no-restricted-syntax
      for (const nodeGeo of regionKnown) {
        // eslint-disable-next-line no-await-in-loop
        const accepted = await installerAccepts(geolocation, nodeGeo);
        const counted = placementFeasibility.nodeLocationMatchesGeolocation(filterLocation(nodeGeo), geolocation);
        if (accepted !== counted) {
          diverged.push(`${JSON.stringify(geolocation)} vs ${nodeGeo.continentCode}_${nodeGeo.countryCode}_${nodeGeo.tableRegion}: installer=${accepted} filter=${counted}`);
        }
      }
    }
    expect(diverged, `filter and installer disagree on shared vocabulary:\n  ${diverged.join('\n  ')}`).to.deep.equal([]);
  });

  it('counts a node whose location the table cannot resolve at all', async () => {
    // the table not knowing where a node is must never make it ineligible
    GEO_SPECS.filter((entries) => entries.length).forEach((geolocation) => {
      expect(placementFeasibility.nodeLocationMatchesGeolocation(null, geolocation)).to.equal(true);
      expect(placementFeasibility.nodeLocationMatchesGeolocation({ continentCode: null, countryCode: null }, geolocation)).to.equal(true);
    });
  });
});
