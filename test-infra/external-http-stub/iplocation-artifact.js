'use strict';

// The harness's IP location artifact: built here once for the stub that serves
// it and for the harness that seeds a fleet's Mongo with it, so both hold the
// same bytes for the same publication.

const crypto = require('crypto');
const zlib = require('zlib');

// The harness fleet lives in 198.18.0.0/15 (RFC 2544 benchmarking range).
const HARNESS_NET_START = (198 * 2 ** 24) + (18 * 2 ** 16);
const HARNESS_NET_END = HARNESS_NET_START + (2 * 2 ** 16) - 1;

const GEO_MAGIC = 'FLXGEO';
const GEO_FORMAT = 2;

// The FluxOS store refuses any baseline below its truncation floor - a
// fleet-integrity constant, deliberately not configurable. The harness
// artifact therefore ships at real scale: this many one-address filler rows
// in space no harness fleet touches (16.0.0.0 up), alternating between two
// filler organisations so no reader could collapse them, ahead of the fleet
// rows. Only the binary artifact is padded; the format-1 JSON reader has no
// floor, and thirty megabytes of JSON per fetch would buy nothing.
const GEO_FILLER_ROWS = 1500000;
const GEO_FILLER_START = 16 * 2 ** 24;
const GEO_FILLER_END = GEO_FILLER_START + GEO_FILLER_ROWS - 1;
const GEO_FILLER_ORGS = ['harness:filler-0', 'harness:filler-1'];
// The class codes the artifact carries, and the only two a reader knows. Named
// here so a suite says 'residential' and the wire value stays the publisher's
// business - fluxos-network-policy's scripts/orgclasses.js is the definition.
const NETWORK_CLASS_CODES = { residential: 1, hosting: 2 };

// The artifact's country and region vocabularies, index-aligned: regions[k] is
// a region OF countries[k]. The split gives organisation k country k, so the
// region it may carry is the one belonging to that same country - a row whose
// region contradicts its country would describe a geography no real build
// publishes.
const GEO_COUNTRIES = ['DE', 'FR', 'NL', 'FI', 'BH'];
const GEO_REGIONS = ['DE-HE', 'FR-IDF', 'NL-NH', 'FI-18', 'BH-13'];
// The region-name vocabulary a real build publishes alongside the codes, keyed
// '<CC>|<name>'. An app may name its region the way ip-api does rather than by
// code, and this is what lets a node answer such an entry at region granularity
// instead of falling back to the whole country. Index-aligned with the two
// tables above: GEO_REGION_NAMES[k] names GEO_REGIONS[k] in GEO_COUNTRIES[k].
const GEO_REGION_NAMES = ['Hesse', 'Ile-de-France', 'North Holland', 'Uusimaa', 'Capital'];

let fillerBytesCache = null;

/**
 * The filler section's row bytes, identical for every artifact: encoded once,
 * reused on every regeneration. Filler org indices are 0 and 1 - the two
 * filler organisations lead the combined orgs table, so these bytes never
 * depend on the fleet split being served.
 * @returns {Buffer}
 */
function fillerBytes() {
  if (fillerBytesCache) return fillerBytesCache;
  const bytes = [];
  for (let i = 0; i < GEO_FILLER_ROWS; i += 1) {
    writeVarint(bytes, i === 0 ? GEO_FILLER_START : 0); // gap (prevEnd starts at -1)
    writeVarint(bytes, 0); // single-address row
    writeVarint(bytes, (i % 2) + 1); // filler org index + 1
    writeVarint(bytes, 1); // countries[0]
    writeVarint(bytes, 0); // no region
  }
  fillerBytesCache = Buffer.from(bytes);
  return fillerBytesCache;
}

// The stamp's epoch: any fixed instant works, since a reader only compares stamps for equality.
const GENERATED_EPOCH_MS = Date.UTC(2026, 0, 1);
const GENERATED_SPAN_MS = 10 ** 12;

/**
 * The `generated` stamp of an artifact, derived from everything else it
 * carries. Nodes key their cached per-node locations on `generated` and
 * invalidate them when it changes, so two different artifacts must carry
 * different stamps; the same artifact carries the same stamp in every run,
 * which keeps its bytes, and so its digest, identical across runs.
 * @param {object} artifact Format-1 artifact without `generated`
 * @returns {string} ISO timestamp
 */
function contentStamp(artifact) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(artifact)).digest();
  const offset = Number(digest.readBigUInt64BE(0) % BigInt(GENERATED_SPAN_MS));
  return new Date(GENERATED_EPOCH_MS + offset).toISOString();
}

/**
 * Which region each organisation's addresses carry.
 *
 * Organisation k takes GEO_REGIONS[k % GEO_REGIONS.length] - the region of the
 * country the split already gives it - EXCEPT the last organisation, which
 * carries none. A regioned fleet therefore holds both nodes whose region the
 * table proves and nodes whose region it does not carry, which is what the
 * region-pin semantics need on both sides: a pin is satisfied only by a proven
 * region, and a region deny catches only a proven region.
 *
 * Without regions every organisation carries none, which is the artifact every
 * other suite sees.
 * @param {number} domains How many organisations the fleet is split across
 * @param {boolean} withRegions Whether to assign regions at all
 * @returns {{table: string[], assigned: object, unassigned: string[]}}
 */
function regionAssignment(domains, withRegions) {
  const orgCount = Math.max(domains, 1);
  const assigned = {};
  for (let org = 0; org < orgCount; org += 1) {
    assigned[org] = withRegions && org !== orgCount - 1
      ? GEO_REGIONS[org % GEO_REGIONS.length]
      : null;
  }
  const taken = new Set(Object.values(assigned).filter((region) => region !== null));
  return {
    table: [...GEO_REGIONS],
    assigned,
    // regions the vocabulary publishes that no address in this artifact claims
    unassigned: GEO_REGIONS.filter((region) => !taken.has(region)),
    // the name each published region also answers to, so a suite can pin with
    // the vocabulary an app actually carries rather than the code
    names: Object.fromEntries(GEO_REGIONS.map((code, k) => [code, GEO_REGION_NAMES[k]])),
  };
}

/**
 * An iplocation artifact for the harness range. The same rows feed both served
 * representations: this object is what /iplocation.json serves, and
 * encodeGeoTable turns it into the format-2 /iplocation.bin.gz.
 *
 * `domains: 1` (the default) puts the whole fleet in one organisation, which
 * is the single-fault-domain posture the tableless fallback produced - suites
 * written against that keep their meaning while now exercising the real table
 * reader rather than skipping it.
 *
 * `domains: n` with a `subnet` (`198.18.5`) assigns that /24's addresses to n
 * organisations ROUND-ROBIN, one range per address. The harness gives its
 * nodes consecutive addresses from .10, so anything coarser than per-address
 * puts the whole fleet in one bucket; interleaving is what actually splits it.
 * Everything outside that /24 stays in one organisation, so the artifact is a
 * few hundred ranges rather than a hundred thousand.
 *
 * `withRegions` additionally gives every row the region its organisation
 * carries (see regionAssignment), as the optional fifth row element. Without
 * it the rows stay four elements long and no row claims a region, so both
 * representations are byte-identical to what a caller that never asks for
 * regions has always been served.
 *
 * `networkClasses` says which of the organisations run access networks and
 * which sell hosting - `{ 0: 'residential', 1: 'hosting' }` keyed by
 * organisation INDEX, since that is what a caller controls. Omitted, the
 * artifact carries an EMPTY orgClasses section - which is what a real build
 * carrying no verdicts publishes, and what every suite that does not care about
 * classification should see: an organisation with no verdict is one nothing
 * enforces against.
 * @param {number} domains How many organisations to split across
 * @param {string} [subnet] Dotted /24 prefix to split, e.g. '198.18.5'
 * @param {boolean} [withRegions] Whether rows carry a region
 * @param {object} [networkClasses] Organisation index -> 'residential'|'hosting'
 * @returns {object} artifact in format 1
 */
function buildIpLocationArtifact(domains, subnet, withRegions = false, networkClasses = null) {
  const orgs = Array.from({ length: Math.max(domains, 1) }, (unused, i) => `harness:org-${i}`);
  const countries = GEO_COUNTRIES;
  const { assigned } = regionAssignment(domains, withRegions);
  // a row is [start, end, orgIdx, ccIdx] and, once regions are asked for,
  // [start, end, orgIdx, ccIdx, regionIdx] with null for "no region"
  const row = (start, end, org, cc) => (withRegions
    ? [start, end, org, cc, assigned[org] === null ? null : GEO_REGIONS.indexOf(assigned[org])]
    : [start, end, org, cc]);
  const v4 = [];
  if (domains <= 1 || !subnet) {
    v4.push(row(HARNESS_NET_START, HARNESS_NET_END, 0, 0));
  } else {
    const [a, b, c] = subnet.split('.').map(Number);
    const base = (a * 2 ** 24) + (b * 2 ** 16) + (c * 2 ** 8);
    if (base > HARNESS_NET_START) v4.push(row(HARNESS_NET_START, base - 1, 0, 0));
    for (let octet = 0; octet < 256; octet += 1) {
      const org = octet % domains;
      v4.push(row(base + octet, base + octet, org, org % countries.length));
    }
    if (base + 255 < HARNESS_NET_END) v4.push(row(base + 256, HARNESS_NET_END, 0, 0));
  }
  const artifact = {
    format: 1,
    sources: { harness: 'stub' },
    countries,
    continents: {
      DE: 'EU', FR: 'EU', NL: 'EU', FI: 'EU', BH: 'AS',
    },
    orgs,
    // the vocabulary a real build publishes; which of them any row claims is
    // regionAssignment's business
    regions: GEO_REGIONS,
    regionNames: Object.fromEntries(
      GEO_REGIONS.map((code, k) => [`${GEO_COUNTRIES[k]}|${GEO_REGION_NAMES[k]}`, code]),
    ),
    // Keyed by organisation TOKEN, which is what the header carries and what a
    // reader looks up - the caller names an index because that is what it
    // controls, and the two are joined here rather than in the suite.
    ...(networkClasses ? {
      orgClasses: Object.fromEntries(
        Object.entries(networkClasses)
          .filter(([index]) => orgs[Number(index)])
          .map(([index, klass]) => [orgs[Number(index)], NETWORK_CLASS_CODES[klass]]),
      ),
    } : {}),
    v4,
    v6: [],
  };
  return { ...artifact, generated: contentStamp(artifact) };
}

/**
 * Append one unsigned LEB128 varint. Plain arithmetic rather than shifts:
 * range bounds run past 2^31 (198.18.0.0 is 3,323,068,416), which the signed
 * 32-bit shift operators cannot carry.
 * @param {number[]} bytes Output byte list, appended in place
 * @param {number} value Non-negative integer
 */
function writeVarint(bytes, value) {
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining % 0x80) + 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
}

/**
 * Encode a format-1 artifact as the format-2 wire artifact iplocation.bin.gz.
 *
 * Layout, little-endian, gzipped whole: magic FLXGEO, version byte 2, u32
 * header length, the UTF-8 JSON header, u32 row count, then five unsigned
 * LEB128 varints per row - gap (start - previousEnd - 1, previousEnd starting
 * at -1), len (end - start), then org, country and region as their table index
 * PLUS ONE, with 0 meaning "none".
 *
 * Throws on anything a strict reader rejects, so the stub cannot publish bytes
 * it presents as well-formed and are not - with one deliberate exception,
 * `pad: false`. The padded artifact is the one every suite wants: it meets the
 * reader's truncation floor (>= 1,500,000 rows), which is a fleet-integrity
 * invariant rather than a knob. `pad: false` drops the filler section and
 * publishes the fleet rows alone - a structurally valid artifact whose row
 * count is a few hundred, i.e. FLOOR BAIT BY DESIGN, and the only way a
 * harness fleet can exercise the floor at all. Everything else about the two
 * encodings is identical, header included: the filler organisations still lead
 * the orgs table, so fleet row indices do not move and the padded encoding is
 * byte-identical to what a caller that never passes `pad` has always been served.
 * @param {object} artifact Format-1 artifact
 * @param {{pad?: boolean}} [options] pad: false omits the filler rows
 * @returns {Buffer} gzipped format-2 bytes
 */
function encodeGeoTable(artifact, { pad = true } = {}) {
  const { countries, orgs, v4 } = artifact;
  const regions = artifact.regions ?? [];
  const header = Buffer.from(JSON.stringify({
    generated: artifact.generated,
    sources: artifact.sources,
    countries,
    continents: artifact.continents,
    // the two filler organisations lead, so fleet org indices shift by two
    // in the wire artifact - and by nothing anywhere else
    orgs: [...GEO_FILLER_ORGS, ...orgs],
    regions,
    // omitted when the artifact carries no regions, so a suite can publish the
    // pre-vocabulary artifact a node held before the section existed
    ...(regions.length ? { regionNames: artifact.regionNames ?? {} } : {}),
    // omitted when nothing is classified, for the same reason: a build carrying
    // no verdicts is a state the reader already handles, and it must stay
    // distinguishable from one that carries them
    // ALWAYS emitted, including as {}, because that is what the real builder
    // does. Omitting it when empty meant the stub covered a shape production
    // never produces, and did not cover the one production produces when the
    // ledger classifies nothing - the shape every node saw the day the section
    // shipped.
    orgClasses: artifact.orgClasses ?? {},
  }), 'utf8');
  const preamble = Buffer.alloc(GEO_MAGIC.length + 1 + 4);
  preamble.write(GEO_MAGIC, 0, 'ascii');
  preamble.writeUInt8(GEO_FORMAT, GEO_MAGIC.length);
  preamble.writeUInt32LE(header.length, GEO_MAGIC.length + 1);
  const rowCount = Buffer.alloc(4);
  rowCount.writeUInt32LE((pad ? GEO_FILLER_ROWS : 0) + v4.length, 0);
  const rows = [];
  let previousEnd = pad ? GEO_FILLER_END : -1;
  v4.forEach(([start, end, org, cc, region], i) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || start <= previousEnd) {
      throw new Error(`row ${i}: bounds unsorted, overlapping, below the rows already written or not integers`);
    }
    const indexes = [org === null || org === undefined ? 0 : org + 1 + GEO_FILLER_ORGS.length, (cc ?? -1) + 1, (region ?? -1) + 1];
    const limits = [orgs.length + GEO_FILLER_ORGS.length, countries.length, regions.length];
    indexes.forEach((index, column) => {
      if (!Number.isInteger(index) || index < 0 || index > limits[column]) {
        throw new Error(`row ${i}: index out of table bounds`);
      }
    });
    writeVarint(rows, start - previousEnd - 1);
    writeVarint(rows, end - start);
    indexes.forEach((index) => writeVarint(rows, index));
    previousEnd = end;
  });
  const sections = [preamble, header, rowCount];
  if (pad) sections.push(fillerBytes());
  sections.push(Buffer.from(rows));
  return zlib.gzipSync(Buffer.concat(sections));
}

/**
 * The wire artifact for whatever is being served, and the row count its header
 * claims. A caller-supplied malformed artifact (the reject-and-keep suites) has
 * no valid format-2 encoding, so the binary route serves its gzipped JSON:
 * bytes that fetch cleanly and fail the reader exactly like their JSON
 * counterpart - and no row count, because those bytes carry none.
 * @param {object|null} artifact Format-1 artifact, or null for no artifact
 * @param {{pad?: boolean}} [options] pad: false omits the filler rows
 * @returns {{bytes: Buffer|null, rowCount: number|null}}
 */
function encodeIpLocationBinary(artifact, { pad = true } = {}) {
  if (!artifact) return { bytes: null, rowCount: null };
  try {
    return {
      bytes: encodeGeoTable(artifact, { pad }),
      rowCount: (pad ? GEO_FILLER_ROWS : 0) + artifact.v4.length,
    };
  } catch {
    return { bytes: zlib.gzipSync(Buffer.from(JSON.stringify(artifact), 'utf8')), rowCount: null };
  }
}

/**
 * The artifact a control-route publication body serves, and whether its binary
 * carries the filler rows. One mapping for the stub's POST /iplocation and for
 * the harness, which needs the bytes a fleet will boot onto before the stub runs.
 * @param {object} body { domains, subnet, regions, classes } or { artifact }, and { pad }
 * @returns {{artifact: object|null, pad: boolean}}
 */
function artifactForPublication(body = {}) {
  const pad = body.pad !== false;
  if (Object.prototype.hasOwnProperty.call(body, 'artifact')) return { artifact: body.artifact, pad };
  const domains = body.domains ?? 1;
  return {
    artifact: buildIpLocationArtifact(domains, body.subnet, body.regions === true, body.classes ?? null),
    pad,
  };
}

module.exports = {
  GEO_FILLER_ROWS,
  regionAssignment,
  buildIpLocationArtifact,
  encodeIpLocationBinary,
  artifactForPublication,
};
