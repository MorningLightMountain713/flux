'use strict';


const log = require('../../lib/log');
const capabilities = require('../utils/capabilities');
const chainState = require('../chainState');
const verifyPool = require('../utils/verifyPool');
const { compareChainOrder, isPositioned } = require('../utils/chainOrder');
const appEventVerifier = require('../appMessaging/appEventVerifier');
const confirmedMessageStore = require('../appMessaging/confirmedMessageStore');
const appRecords = require('../appDatabase/appRecords');
const specLibrary = require('../utils/specLibrary');
const { createChain } = require('./decisionChain');

/**
 * Decides stored app messages.
 *
 * Storing never decides: a route stores a message and wakes the decider, which
 * runs afterwards and takes the chain-state lock itself. Nothing records what
 * is left to decide; the data says it: a stored message with a payment record
 * and no decision under the current rule version is undecided, and a name is
 * decided again from its earliest undecided message.
 *
 * A wake names the hashes a route resolved; a full pass compares every stored
 * hash with every decided one, and runs whenever chain state becomes consistent
 * (every boot, every rewind) and whenever the scan catches up (payment
 * positions are complete from its first catch-up, and the payments a rewind
 * took away are recorded again).
 *
 * A batch of names is decided, then written in order, each step one store call
 * for the whole batch: the triggering messages' decisions are removed, the
 * later decisions are written, the decisions after a message the rule could not
 * evaluate are removed, the `onDecided` listeners run for each name (the
 * registry row), and the triggering messages' decisions are written last. A
 * crash anywhere before that last write leaves the names undecided, and they
 * are decided again. A full pass runs no `onDecided` listener: the `onFullPass`
 * listeners that follow it read every decision.
 */


/** Names decided under one hold of the chain-state lock. */
const NAMES_PER_BATCH = 500;

const decidedListeners = [];
const fullPassListeners = [];
const pendingHashes = new Set();
let fullPassPending = false;
let running = null;
let started = false;

/** The name a stored message is decided under: its spec's name, lower-cased. */
function nameOf(message) {
  const name = message.appSpecifications?.name;
  return typeof name === 'string' ? name.toLowerCase() : '';
}

function typeOf(message) {
  return String(message.type).endsWith('register') ? 'registration' : 'update';
}

/**
 * Registers `fn(name, decisions)`, called for each name a wake decided, after
 * its later decisions are written and before its triggering message's decision
 * is.
 * @param {(name: string, decisions: object[]) => Promise<void>} fn
 * @returns {() => void} unsubscribe
 */
function onDecided(fn) {
  decidedListeners.push(fn);
  return () => {
    const index = decidedListeners.indexOf(fn);
    if (index !== -1) decidedListeners.splice(index, 1);
  };
}

/**
 * Registers `fn({unpositioned})`, called after each full pass completes with the
 * number of names it left undecided because a payment record has no position.
 * @param {(outcome: {unpositioned: number}) => Promise<void>} fn
 * @returns {() => void} unsubscribe
 */
function onFullPass(fn) {
  fullPassListeners.push(fn);
  return () => {
    const index = fullPassListeners.indexOf(fn);
    if (index !== -1) fullPassListeners.splice(index, 1);
  };
}

/**
 * Every name holding a confirmed message with no decision under the current
 * rule version. A confirmed message is one whose payment the chain holds.
 * @returns {Promise<Set<string>>}
 */
async function undecidedNames() {
  const [summaries, decided] = await Promise.all([
    appRecords.messages().confirmedSummaries(),
    appRecords.decisions().decidedHashes(specLibrary.loaded().RULE_VERSION),
  ]);
  const names = new Set();
  for (const { hash, name } of summaries) {
    if (!decided.has(hash)) names.add(String(name ?? '').toLowerCase());
  }
  return names;
}

/**
 * Every confirmed message decided under one of `names`, in its permanent form.
 * @param {Set<string>} names
 * @returns {Promise<object[]>}
 */
async function messagesNamed(names) {
  const records = names.has('')
    ? await appRecords.messages().confirmed()
    : await appRecords.messages().confirmedNamed([...names].filter(Boolean));
  return records.map((record) => record.permanentForm()).filter((message) => names.has(nameOf(message)));
}

/**
 * The confirmed messages a run decides, grouped by name: every name holding an
 * undecided message on a full pass, else the names holding the woken hashes.
 * @param {boolean} full
 * @param {string[]} hashes
 * @returns {Promise<Map<string, object[]>>}
 */
async function messagesToDecide(full, hashes) {
  let messages;
  if (full) {
    const names = await undecidedNames();
    messages = names.size ? await messagesNamed(names) : [];
  } else {
    const woken = await appRecords.messages().confirmedByHashes(hashes);
    messages = woken.length ? await messagesNamed(new Set(woken.map((record) => String(record.name ?? '').toLowerCase()))) : [];
  }
  const grouped = new Map();
  for (const message of messages) {
    const name = nameOf(message);
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(message);
  }
  return grouped;
}

/**
 * A name's stored messages with a payment record, in chain order, as the rule
 * reads them, and the index of the first to decide.
 * @returns {Promise<?{entries: object[], from: number}|'unpositioned'>} null
 *   when nothing is left to decide; 'unpositioned' when the name cannot be
 *   ordered yet (a payment record without its position)
 */
async function entriesOf(messages, records, decisions) {
  const paid = messages.filter((message) => records.has(message.hash));
  if (paid.some((message) => !isPositioned(records.get(message.hash)))) return 'unpositioned';
  paid.sort((a, b) => compareChainOrder(records.get(a.hash), records.get(b.hash)));

  const entries = [];
  for (const message of paid) {
    const record = records.get(message.hash);
    let event = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      event = await appEventVerifier.deserializeMessage(message);
    } catch {
      event = null;
    }
    entries.push({
      hash: message.hash,
      type: typeOf(message),
      timestamp: message.timestamp,
      record: {
        ...record,
        valueSat: record.value,
        blockTime: record.blockTime ?? message.registeredAt ?? null,
      },
      spec: event ? event.spec : null,
      event,
      contentHash: message.contentHash ?? null,
      signers: [],
      decision: decisions.get(message.hash) ?? null,
    });
  }
  const { RULE_VERSION } = specLibrary.loaded();
  const from = entries.findIndex((entry) => entry.decision?.ruleVersion !== RULE_VERSION);
  return from === -1 ? null : { entries, from };
}

/**
 * Writes a batch's decisions in the crash-safe order. A name whose listener
 * fails keeps its triggering message undecided, and is decided again.
 * @param {Array<{name: string, entries: object[], from: number, decisions: object[], blocked: ?object}>} decided
 * @param {boolean} full - a full pass, which runs no `onDecided` listener
 * @returns {Promise<number>} the decisions written
 */
async function writeDecided(decided, full) {
  const store = appRecords.decisions();
  const triggers = new Set(decided.map(({ entries, from }) => entries[from].hash));
  const blockedTails = decided.flatMap(({ entries, blocked }) => {
    if (!blocked) return [];
    const at = entries.findIndex((entry) => entry.hash === blocked.hash);
    return entries.slice(at).filter((entry) => entry.decision).map((entry) => entry.hash);
  });

  await store.undecide([...triggers]);
  await store.write(decided.flatMap(({ decisions }) => decisions.filter((decision) => !triggers.has(decision.hash))));
  await store.undecide(blockedTails);
  const settled = [];
  for (const entry of decided) {
    try {
      if (!full) {
        for (const fn of decidedListeners) {
          // eslint-disable-next-line no-await-in-loop
          await fn(entry.name, entry.decisions);
        }
      }
      settled.push(entry);
    } catch (error) {
      log.error(`decider - ${entry.name}: not decided: ${error.message}`);
    }
  }
  await store.write(settled.flatMap(({ decisions }) => decisions.filter((decision) => triggers.has(decision.hash))));

  for (const { name, blocked } of decided) {
    if (blocked) log.warn(`decider - ${name}: ${blocked.hash} not decided, this node could not evaluate it: ${blocked.error.message}`);
  }
  return settled.reduce((sum, { decisions }) => sum + decisions.length, 0);
}

/**
 * Decides a batch of names, holding the chain-state lock: payment records and
 * decisions are read under it, so no rewind moves them meanwhile.
 * @param {Array<[string, object[]]>} batch - names and their stored messages
 * @param {boolean} full - a full pass
 * @returns {Promise<{written: number, unpositioned: number}>}
 */
async function decideNames(batch, full) {
  return chainState.exclusive(async () => {
    const hashes = batch.flatMap(([, messages]) => messages.map((message) => message.hash));
    const [records, decisions, chain] = await Promise.all([
      confirmedMessageStore.paymentRecords(hashes),
      appRecords.decisions().byHashes(hashes),
      createChain(),
    ]);

    const work = [];
    let unpositioned = 0;
    for (const [name, messages] of batch) {
      // eslint-disable-next-line no-await-in-loop
      const pending = await entriesOf(messages, records, decisions);
      if (pending === 'unpositioned') unpositioned += 1;
      else if (pending) work.push({ name, pending });
    }

    // Who signed each message still to decide, recovered in one batch.
    const toRecover = work.flatMap(({ pending }) => pending.entries.slice(pending.from).filter((entry) => entry.event));
    const signers = await verifyPool.recover(toRecover.map((entry) => ({
      payloads: entry.event.signaturePayloads(),
      signature: entry.event.signature,
    })));
    toRecover.forEach((entry, index) => { entry.signers = signers[index]; });

    const decided = [];
    for (const { name, pending } of work) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { decisions, blocked } = await specLibrary.loaded().decideName({
          name, entries: pending.entries, from: pending.from, chain,
        });
        decided.push({ name, ...pending, decisions, blocked });
      } catch (error) {
        log.error(`decider - ${name}: not decided: ${error.message}`);
      }
    }
    return { written: await writeDecided(decided, full), unpositioned };
  });
}

async function runOnce() {
  await capabilities.whenUp('chainStateConsistent', { for: 'appRegistryConsistent' });
  const full = fullPassPending;
  const hashes = [...pendingHashes];
  fullPassPending = false;
  pendingHashes.clear();

  const grouped = [...(await messagesToDecide(full, hashes))];
  let written = 0;
  let unpositioned = 0;
  for (let offset = 0; offset < grouped.length; offset += NAMES_PER_BATCH) {
    // eslint-disable-next-line no-await-in-loop
    const result = await decideNames(grouped.slice(offset, offset + NAMES_PER_BATCH), full);
    written += result.written;
    unpositioned += result.unpositioned;
  }
  if (grouped.length) log.info(`decider - ${written} decision(s) over ${grouped.length} name(s)${full ? ', full pass' : ''}`);
  if (unpositioned) log.warn(`decider - ${unpositioned} name(s) wait: a payment record has no position yet`);
  if (full) {
    for (const fn of fullPassListeners) {
      // eslint-disable-next-line no-await-in-loop
      await fn({ unpositioned });
    }
  }
}

function schedule() {
  if (running) return;
  running = (async () => {
    try {
      while (fullPassPending || pendingHashes.size) {
        // eslint-disable-next-line no-await-in-loop
        await runOnce();
      }
    } catch (error) {
      log.error(`decider - run failed: ${error.message}`);
    } finally {
      running = null;
    }
  })();
}

/**
 * Asks for the names holding these stored messages to be decided.
 * @param {string[]} hashes
 */
function wake(hashes) {
  hashes.forEach((hash) => pendingHashes.add(hash));
  schedule();
}

/** Asks for every name holding an undecided message to be decided. */
function wakeAll() {
  fullPassPending = true;
  schedule();
}

/**
 * Starts deciding: a full pass each time chain state becomes consistent and
 * each time the scan catches up, and a pass for whatever the store routes
 * resolve.
 */
function start() {
  if (started) return;
  started = true;
  confirmedMessageStore.onStored(wake);
  capabilities.onUp('chainStateConsistent', wakeAll);
  capabilities.onUp('explorerSynced', wakeAll);
  if (capabilities.isUp('chainStateConsistent')) wakeAll();
}

/** Resolves once no run is in progress or pending. */
async function idle() {
  while (running) {
    // eslint-disable-next-line no-await-in-loop
    await running;
  }
}

module.exports = {
  idle,
  onDecided,
  onFullPass,
  start,
  wake,
  wakeAll,
};
