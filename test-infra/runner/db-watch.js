#!/usr/bin/env node
// A stopwatch on one node's database, for the class of bug where STATE THAT WAS THERE
// GOES MISSING — an app row that vanishes, a hash that un-resolves, a local app the
// node forgets it installed.
//
// Everything else the harness records is a log of ACTIONS: journals, node logs, SSE
// events, docker events. None of them says what the database CONTAINED at a given
// second, so "the app is gone" and "the app was there at 06:37:29 and gone by :30"
// are indistinguishable — and only the second one can be lined up against a log.
//
//   node test-infra/runner/db-watch.js --node 1                 # every 500ms
//   node test-infra/runner/db-watch.js --node 3 --interval 250 --out /tmp/dbwatch.log
//
// DELIBERATELY NOT WIRED INTO A GATE. It watches ONE node at a few samples a second,
// so using it in a gate means choosing the node before you know which one misbehaves
// — the guess you cannot make in advance. Point it at a node during a targeted
// investigation, which is the only context every capture on the box came from.
//
// It lives here rather than in /tmp because the last one lived in /tmp: it recorded
// the three 505 investigations on cindy and was then lost, so the next person needing
// it had nothing but the output format to work back from. Same reason gate-progress.sh
// and archive-run.sh are in the repo.

import { dbClient, closeDb } from './framework/db-client.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const nodeNum = Number(arg('node'));
const intervalMs = Number(arg('interval', '500'));
const outPath = arg('out');

if (!Number.isInteger(nodeNum) || nodeNum < 1) {
  console.error('usage: db-watch.js --node <n> [--interval ms] [--out file]');
  console.error('  <n> is the node NUMBER (1-based), matching the dbClient prefix nodeNN_');
  process.exit(2);
}

const db = dbClient(nodeNum);
let out = null;
if (outPath) {
  const { createWriteStream } = await import('node:fs');
  out = createWriteStream(outPath, { flags: 'a' });
}
const emit = (line) => (out ? out.write(`${line}\n`) : console.log(line));

// A sample is one line so it greps and sorts against any other log by timestamp.
// A read that FAILS is recorded rather than skipped: "mongo did not answer" at the
// second a row vanished is itself the finding, and a gap in the file cannot say
// whether nothing changed or nothing was looked at.
async function sample() {
  const t = new Date().toISOString().slice(11, 23);
  try {
    const [local, global_, height, installing] = await Promise.all([
      db.localAppCount().catch((e) => `err:${e.message}`),
      db.appSpecCount().catch((e) => `err:${e.message}`),
      db.explorerHeight().catch((e) => `err:${e.message}`),
      db.installingCount().catch((e) => `err:${e.message}`),
    ]);
    let rows = [];
    try {
      rows = (await db.listLocalApps()) ?? [];
    } catch (e) {
      rows = [`err:${e.message}`];
    }
    const names = rows.map((r) => (typeof r === 'string' ? r : `${r.name}:${String(r.hash ?? '').slice(0, 12)}`));
    emit(`${t} local=${local} global=${global_} installing=${installing} h=${height} rows=[${names.join(',')}]`);
  } catch (err) {
    emit(`${t} SAMPLE-FAILED ${err.message}`);
  }
}

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await closeDb().catch(() => {});
  if (out) out.end();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

emit(`# db-watch node=${nodeNum} interval=${intervalMs}ms started ${new Date().toISOString()}`);
for (;;) {
  // eslint-disable-next-line no-await-in-loop
  await sample();
  if (stopping) break;
  // eslint-disable-next-line no-await-in-loop
  await new Promise((r) => { setTimeout(r, intervalMs); });
}
