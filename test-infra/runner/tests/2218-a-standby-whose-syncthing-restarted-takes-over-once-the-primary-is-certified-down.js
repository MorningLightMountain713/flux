// fleet: 3
import {
  describe, it, before, after,
} from 'mocha';
import { readFileSync } from 'node:fs';
import { expect } from 'chai';
import { execInContainer, crashFluxos } from '../framework/container.js';
import { clearMaster, resetFdm } from '../framework/fdm-control.js';
import { waitForUp } from '../framework/wait.js';
import { stopDaemon, startDaemon } from '../framework/syncthing-real.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { placeSilentPrimaryApp, A, B } from '../framework/silent-primary.js';

// A standby whose syncthing restarted after the primary went has no closing of
// its own to read, and no connection stands against a certificate: it takes the
// app once the network has certified the primary down, and not before.

const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const primaryOutpoint = `${list[B].txhash}:${list[B].outidx}`;
// From the certificate to the standby running the app: a few election passes and
// a container start.
const TAKEOVER_MS = 4 * 60 * 1000;

describe('a standby whose syncthing restarted takes over once the primary is certified down', function () {
  let fleet;
  dumpLogsOnFailure(() => fleet?.env);
  const appName = `e2egrace${Date.now()}`;
  const client = (i) => fleet.env.clients[i];

  before(async function () {
    this.timeout(900000);
    fleet = await placeSilentPrimaryApp({ hookCtx: this, appName });
  });

  after(async function () {
    this.timeout(60000);
    fleet?.stop();
    await resetFdm().catch(() => {});
    await fleet?.env.teardown();
  });

  it('starts on the standby once the network has certified the primary down, and not before', async function () {
    this.timeout(2 * TAKEOVER_MS + 300000);
    const standbyFrom = client(A).getLastEventId();
    // The whole primary goes, with no announcement: the process, the container and
    // the daemon. FDM still names it, so the standby does not act on the closing
    // its syncthing sees - and then that syncthing restarts.
    await crashFluxos(client(B).container, { hold: true });
    await execInContainer(client(B).container, `docker kill ${fleet.identifier}`);
    await stopDaemon(client(B));
    await stopDaemon(client(A));
    await startDaemon(client(A), { paused: true });
    await clearMaster(appName);

    const stored = await client(A).waitForEvent('nodedown:stored', (d) => d.subject === primaryOutpoint,
      TAKEOVER_MS, { afterId: standbyFrom });
    // The moment the standby decides: its promotion begins.
    const promoting = await client(A).waitForEvent('primaryRole:changed', (d) => d.identifier === fleet.identifier && d.to === 'promoting',
      TAKEOVER_MS, { afterId: standbyFrom });
    expect(promoting.id, 'the standby deciding before the certificate').to.be.above(stored.id);
    await waitForUp(client(A), appName, 'the standby runs the app', { timeout: TAKEOVER_MS, interval: 3000 });
    expect(fleet.twoRan, 'moments when more than one node ran the component').to.deep.equal([]);
  });
});
