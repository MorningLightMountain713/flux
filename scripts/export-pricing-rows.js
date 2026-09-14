'use strict';

/**
 * Builds the fixture tests/unit/legacyPricingCorpus.test.js reads: every update
 * on chain, projected to the three numbers legacy pricing consults.
 *
 * Run once, not per suite. The corpus is ~86MB of JSON and parsing it costs a
 * second and 300MB of heap - affordable here, and not something a unit suite
 * should carry. What comes out is 3.2MB and loads in milliseconds.
 *
 *   node scripts/export-pricing-rows.js [out-file]
 *
 * Fetches the corpus itself unless FLUX_MESSAGE_CORPUS names a local copy, so
 * CI needs no checkout of anything but this repo. The node gzips the response:
 * 26MB over the wire against 86MB on disk.
 *
 * The pairing - which spec each update REPLACED - is flux-spec's
 * `specTransitions`, deliberately not restated here. An app updated many times
 * pairs each update with the one BEFORE it, not with its registration, and
 * getting that wrong reports 4,106 fork-crossing updates where there are 460.
 * It is tested where it lives.
 *
 * THE OUTPUT IS NOT REPRODUCIBLE, and the test that reads it is written for
 * that. The corpus is whatever node you asked, and two answers differ: against
 * a 2026-09-03 snapshot, a fetch on 09-14 carried 1,105 newer updates and was
 * missing four older ones (PresearchNode1664355818947 and cimon3, heights
 * 1239434-1309958). So the fixture is a population to assert INVARIANTS over,
 * never a golden file - a pinned count or a pinned row would fail on the day
 * the chain moved, for no reason anyone could act on.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const DEFAULT_SOURCE = 'https://api.runonflux.io/apps/permanentmessages';
const OUT = process.argv[2] || path.join(__dirname, '..', 'tests', 'unit', 'fixtures', 'pricing-update-rows.json');

/**
 * The corpus, from a local copy when one is named and from a node otherwise.
 * @returns {Promise<object>} the parsed response
 */
async function readCorpus() {
  const local = process.env.FLUX_MESSAGE_CORPUS;
  if (local) {
    if (!fs.existsSync(local)) throw new Error(`FLUX_MESSAGE_CORPUS names ${local}, which does not exist`);
    process.stderr.write(`reading ${local}\n`);
    return JSON.parse(fs.readFileSync(local, 'utf8'));
  }

  const url = process.env.FLUX_CORPUS_URL || DEFAULT_SOURCE;
  process.stderr.write(`fetching ${url}\n`);
  const body = await new Promise((resolve, reject) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: 300_000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }
      // Decompressed here rather than by asking for identity: the corpus is
      // 86MB uncompressed and 26MB gzipped, and the node serves gzip without
      // advertising it on a HEAD.
      const encoding = res.headers['content-encoding'];
      const stream = encoding === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }).on('error', reject).on('timeout', function onTimeout() {
      this.destroy(new Error(`timed out fetching ${url}`));
    });
  });
  return JSON.parse(body);
}

async function main() {
  const { specTransitions } = await import('@runonflux/flux-spec-backend/testing');
  const corpus = await readCorpus();
  const messages = corpus.data || corpus;

  const rows = specTransitions(messages).map((t) => ({
    prevHeight: t.from.height,
    prevExpire: t.from.expire,
    updateHeight: t.to.height,
    // The version of the spec being REPLACED, which is the one whose expire and
    // registration height price the update.
    version: t.from.version,
  }));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rows));
  const mb = (fs.statSync(OUT).size / 1_048_576).toFixed(1);
  process.stderr.write(`${rows.length} rows -> ${OUT} (${mb}MB)\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
