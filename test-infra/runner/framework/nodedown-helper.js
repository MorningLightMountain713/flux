// The node-down certificate rows as the survivors of an incident have synced
// them, read from each node's own store (db-client). Both waits take the
// survivors as env.clients indices, the way the suites keep them.
import { waitFor } from './wait.js';
import { dbClient } from './db-client.js';

// At least `atLeast` certification rows for the subject on every survivor:
// the certificate landed everywhere, whichever transport delivered it.
export async function waitForRowsOnEverySurvivor(survivors, subject, atLeast, { timeout = 240000 } = {}) {
  let counts = [];
  await waitFor(async () => {
    counts = await Promise.all(survivors.map(
      async (i) => (await dbClient(i + 1).getNodeDownRecords(subject)).length,
    ));
    return counts.every((count) => count >= atLeast);
  }, { timeout, interval: 5000, label: `${atLeast} nodedown row(s) on every survivor` })
    .catch((error) => {
      throw new Error(`${error.message}\n    rows per survivor: ${JSON.stringify(counts)}`);
    });
}

// The store refuses a certificate while an unrefuted record for the subject
// stands (nodeDownStore: already_standing), and a return refutes it only once
// the subject's announce is stored after the row. A suite that stages the next
// death waits for the last record to be refuted on every survivor first, or
// the next certificate lands on none of them.
export async function waitForRecordRefutedOnEverySurvivor(survivors, subject, label, { timeout = 240000 } = {}) {
  let states = [];
  await waitFor(async () => {
    states = await Promise.all(survivors.map(
      (i) => dbClient(i + 1).getNodeDownRecordState(subject),
    ));
    return states.every((state) => state !== 'standing');
  }, { timeout, interval: 5000, label })
    .catch((error) => {
      throw new Error(`${error.message}\n    record state per survivor: ${JSON.stringify(states)}`);
    });
}
