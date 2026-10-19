// Fetches a network's app history into one corpus file, for the suite that
// boots a node upgraded over it (suite 3404):
//
//   node test-infra/app-corpus/fetch.mjs <out.json.gz> [api base, default https://api.runonflux.io]
//
// The corpus is what a node running a release holds just before it upgrades:
// every permanent app message with the height and value of its payment, the
// app list that node serves, and the chain tip both were read at. The list and
// the messages are read one after the other, so a message paid between the two
// reads would show as a difference: the tip is read before and after and the
// fetch refused if a block that paid an app message landed between them.
//
// A payment's position in its block is the block's own where another message
// for the same app was paid in that block, and 0 otherwise: chain order is
// decided per app, so only those positions order anything.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const [out, base = 'https://api.runonflux.io'] = process.argv.slice(2);
if (!out) {
  console.error('usage: node test-infra/app-corpus/fetch.mjs <out.json.gz> [api base]');
  process.exit(2);
}

async function get(path) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${base}${path}`);
      // eslint-disable-next-line no-await-in-loop
      const body = await res.json();
      if (body.status === 'success') return body.data;
      lastError = new Error(`${path}: ${JSON.stringify(body).slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }
  throw lastError;
}

const appName = (message) => String((message.appSpecifications ?? message.zelAppSpecifications)?.name ?? '').toLowerCase();

const tipBefore = await get('/daemon/getblockcount');
const messages = await get('/apps/permanentmessages');
const listed = await get('/apps/globalappsspecifications');
const tip = await get('/daemon/getblockcount');
const paidBetween = messages.filter((m) => m.height > tipBefore && m.height <= tip);
if (paidBetween.length) {
  throw new Error(`${paidBetween.length} app message(s) paid between the reads (${tipBefore}..${tip}); fetch again`);
}

const perBlock = new Map();
for (const message of messages) {
  const key = `${appName(message)}@${message.height}`;
  perBlock.set(key, (perBlock.get(key) ?? 0) + 1);
}
const sharedHeights = [...new Set([...perBlock].filter(([, n]) => n > 1).map(([key]) => Number(key.split('@').pop())))];
const positions = new Map();
for (const height of sharedHeights) {
  // eslint-disable-next-line no-await-in-loop
  const block = await get(`/daemon/getblock?hashheight=${height}&verbosity=1`);
  block.tx.forEach((txid, txIndex) => positions.set(txid, txIndex));
}
for (const message of messages) {
  const key = `${appName(message)}@${message.height}`;
  if (perBlock.get(key) > 1 && !positions.has(message.txid)) {
    throw new Error(`${message.txid} is not in block ${message.height}`);
  }
}

const corpus = {
  source: base,
  fetchedAt: new Date().toISOString(),
  tip,
  messages: messages.map((m) => ({ ...m, txIndex: positions.get(m.txid) ?? 0 })),
  listed,
};
writeFileSync(out, gzipSync(Buffer.from(JSON.stringify(corpus))));
console.log(`${out}: ${messages.length} messages, ${listed.length} listed apps, tip ${tip}, ${sharedHeights.length} blocks positioned`);
