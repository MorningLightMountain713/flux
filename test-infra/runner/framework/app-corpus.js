// A network's app history (test-infra/app-corpus/fetch.mjs), put where a node
// running a release before v9 keeps it, so the node a suite upgrades boots over
// the history a real node upgrades over.
//
// A release before v9 keeps three collections the first v9 start moves: the
// payment index (daemon database), the permanent messages and the app list it
// derived from them (global apps database). Each is written here in the shape
// that release writes it. The position of each payment in its block is not in
// that index: v9 asks the daemon's address index for it, so the daemon stub is
// given it.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { seedAddressDeltas } from './daemon-control.js';

// The indexes a release keeps on each collection, as a node running 8.21.1
// holds them. Its boot updates payment rows by transaction before its explorer
// starts and indexes anything, so the corpus is written with them.
export const LEGACY_INDEXES = Object.freeze({
  payments: [
    { key: { txid: 1 }, name: 'query for getting txid' },
    { key: { height: 1 }, name: 'query for getting height' },
    { key: { hash: 1 }, name: 'query for getting app hash', unique: true },
    { key: { message: 1 }, name: 'query for getting app hashes depending if we have message' },
  ],
  messages: [
    { key: { 'appSpecifications.name': 1 }, name: 'query for getting app message based on zelapp specs name' },
    { key: { 'appSpecifications.owner': 1 }, name: 'query for getting app message based on zelapp specs owner' },
    { key: { 'appSpecifications.version': 1 }, name: 'query for getting app message based on version' },
    { key: { txid: 1 }, name: 'query for getting zelapp message based on txid' },
    { key: { 'appSpecifications.repotag': 1 }, name: 'query for getting app message based on image' },
    { key: { hash: 1 }, name: 'query for getting zelapp message based on hash', unique: true },
    { key: { 'appSpecifications.nodes': 1 }, name: 'query for getting app message based on nodes' },
    { key: { height: 1 }, name: 'query for getting zelapp message based on height' },
    { key: { 'appSpecifications.name': 1, height: -1, timestamp: -1 }, name: 'newestAppMessageByName' },
  ],
  listed: [
    { key: { name: 1 }, name: 'query for getting zelapp based on zelapp specs name' },
    { key: { owner: 1 }, name: 'query for getting zelapp based on zelapp specs owner' },
    { key: { repotag: 1 }, name: 'query for getting zelapp based on image' },
    { key: { height: 1 }, name: 'query for getting zelapp based on last height update' },
    { key: { hash: 1 }, name: 'query for getting zelapp based on last hash' },
  ],
});

// The daemon stub's control API parses at most 100 KB a request.
const DELTAS_PER_REQUEST = 400;

/**
 * Reads a corpus file.
 * @param {string} path
 * @returns {{source: string, fetchedAt: string, tip: number, messages: object[], listed: object[]}}
 */
export function loadAppCorpus(path) {
  const corpus = JSON.parse(gunzipSync(readFileSync(path)).toString());
  if (!Number.isInteger(corpus.tip) || !Array.isArray(corpus.messages) || !Array.isArray(corpus.listed)) {
    throw new Error(`${path} is not an app corpus: it needs tip, messages and listed`);
  }
  return corpus;
}

/**
 * The payment index rows a release before v9 holds for the corpus: every
 * message stored, none waiting to be fetched.
 * @param {object} corpus
 * @returns {object[]}
 */
export function legacyPaymentRows(corpus) {
  return corpus.messages.map((m) => ({
    txid: m.txid,
    height: m.height,
    hash: m.hash,
    value: m.valueSat,
    message: true,
    syncAttempts: 0,
    nextRetryHeight: m.height,
    retryFromHeight: m.height,
  }));
}

/**
 * The permanent messages as a release before v9 stores them: what its API serves.
 * @param {object} corpus
 * @returns {object[]}
 */
export function legacyPermanentMessages(corpus) {
  return corpus.messages.map(({ txIndex, ...message }) => message);
}

/**
 * Gives the daemon stub every corpus payment's position in its block, as its
 * address index answers it. The stub returns seeded deltas for every query, so
 * the address the payment was made to is not one the position is read by.
 * @param {object} corpus
 */
export async function seedPaymentPositions(corpus) {
  const deltas = corpus.messages.map((m) => ({
    satoshis: m.valueSat, txid: m.txid, index: 0, blockindex: m.txIndex, height: m.height,
  }));
  for (let i = 0; i < deltas.length; i += DELTAS_PER_REQUEST) {
    // eslint-disable-next-line no-await-in-loop
    await seedAddressDeltas(deltas.slice(i, i + DELTAS_PER_REQUEST));
  }
}
