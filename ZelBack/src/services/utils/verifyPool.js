'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const log = require('../../lib/log');

const WORKER_PATH = path.join(__dirname, 'verifyWorker.js');

// A batch that keeps killing its worker will not verify on the next attempt
// either. Giving up rejects the caller, which its gossip handler catches;
// resubmitting forever would respawn workers in a loop instead.
const MAX_BATCH_ATTEMPTS = 3;

let slots = [];
let nextBatchId = 0;

function createSlot() {
  const worker = new Worker(WORKER_PATH);
  // Keyed by batch id, never by arrival order. The caller maps results back
  // positionally, so if a reply could attach to the wrong batch the node would
  // accept signatures it never verified - silently, and with nothing in the
  // worker to stop a future maintainer adding a second postMessage for a metric
  // or a progress line.
  const pending = new Map();

  worker.on('error', (err) => log.error(`Verify worker error: ${err.message}`));

  worker.on('message', (reply) => {
    const entry = pending.get(reply && reply.id);
    if (!entry) {
      log.warn(`Verify worker replied for unknown batch ${reply && reply.id}`);
      return;
    }
    pending.delete(entry.id);
    // One verdict per item or the whole reply is untrustworthy: a short array
    // would leave the tail of the batch reading as unverified, and a long one
    // means the worker is not answering the question that was asked. Fail
    // closed rather than hand the caller something to index into.
    if (!Array.isArray(reply.results) || reply.results.length !== entry.batch.length) {
      entry.reject(new Error(
        `Verify worker returned ${Array.isArray(reply.results) ? reply.results.length : 'no'} `
        + `results for a batch of ${entry.batch.length}`,
      ));
      return;
    }
    entry.resolve(reply.results);
  });

  worker.on('exit', (code) => {
    const idx = slots.findIndex((s) => s.worker === worker);
    // stop() empties slots before the exit events land, so a worker that is no
    // longer registered was shut down deliberately and its batches are already
    // settled. That ordering is load-bearing - respawning here would resurrect
    // a stopped pool.
    if (idx === -1) return;

    slots[idx] = createSlot();
    const replacement = slots[idx];
    // Settle on EVERY exit path, whatever the code. A clean exit used to leave
    // these promises unresolved, so the Promise.all inside verify() never
    // settled and the awaiting gossip handler hung indefinitely holding its
    // references. A rejection the caller catches is strictly better than that.
    for (const entry of pending.values()) {
      if (entry.attempts >= MAX_BATCH_ATTEMPTS) {
        entry.reject(new Error(
          `Verify worker exited (code ${code}); batch gave up after ${MAX_BATCH_ATTEMPTS} attempts`,
        ));
      } else {
        entry.attempts += 1;
        replacement.pending.set(entry.id, entry);
        replacement.worker.postMessage({ id: entry.id, items: entry.batch });
      }
    }
    log.error(`Verify worker exited with code ${code}, respawned; ${pending.size} batches resubmitted or rejected`);
    pending.clear();
  });

  return { worker, pending };
}

function start(poolSize) {
  const size = poolSize ?? Math.max(1, os.cpus().length - 1);
  if (slots.length) return;
  for (let i = 0; i < size; i++) {
    slots.push(createSlot());
  }
  log.info(`Verify worker pool started: ${slots.length} workers`);
}

function stop() {
  // Empty slots FIRST so the exit handlers know this shutdown was deliberate,
  // then settle what is outstanding: terminating a worker strands its batches
  // exactly as an unexpected exit does.
  const draining = slots;
  slots = [];
  for (const { worker, pending } of draining) {
    for (const entry of pending.values()) {
      entry.reject(new Error('Verify pool stopped'));
    }
    pending.clear();
    worker.terminate();
  }
}

function sendToWorker(slot, batch) {
  const id = nextBatchId;
  nextBatchId += 1;

  return new Promise((resolve, reject) => {
    slot.pending.set(id, {
      id, batch, attempts: 1, resolve, reject,
    });
    slot.worker.postMessage({ id, items: batch });
  });
}

async function verify(items) {
  if (!slots.length) start();

  const n = slots.length;
  const chunkSize = Math.ceil(items.length / n);
  const promises = [];
  for (let i = 0; i < n; i++) {
    const slice = items.slice(i * chunkSize, (i + 1) * chunkSize);
    if (slice.length > 0) {
      promises.push(sendToWorker(slots[i], slice));
    }
  }

  const chunks = await Promise.all(promises);
  const results = [];
  for (const chunk of chunks) {
    for (const r of chunk) results.push(r);
  }
  return results;
}

module.exports = { start, stop, verify };
