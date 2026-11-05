// fleet: 3
import {
  describe, it, before, after,
} from 'mocha';
import { readFileSync } from 'node:fs';
import { expect } from 'chai';
import { shutdownFluxosGracefully } from '../framework/container.js';
import { clearMaster, resetFdm } from '../framework/fdm-control.js';
import { waitForUp } from '../framework/wait.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { placeSilentPrimaryApp, A, B } from '../framework/silent-primary.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';

// A primary that shut down and has not come back is handed over once the
// network has certified it down, and not before: until then its closed
// connection is a reboot.

const NODE_DOWN_GRACE_MS = loadSharedConfig().fluxapps.nodeDownGraceS * 1000;
const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const primaryOutpoint = `${list[B].txhash}:${list[B].outidx}`;
// From the certificate to the standby running the app: a few election passes and
// a container start.
const TAKEOVER_MS = 4 * 60 * 1000;

describe('a primary certified down is handed over', function () {
  let fleet;
  dumpLogsOnFailure(() => fleet?.env);
  const appName = `e2egone${Date.now()}`;
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
    this.timeout(NODE_DOWN_GRACE_MS + 2 * TAKEOVER_MS + 120000);
    const notCertifiedFrom = await fleet.verdicts(A, 'notCertified');
    const standbyFrom = client(A).getLastEventId();

    await shutdownFluxosGracefully(client(B).container, { hold: true, stopSyncthingAfter: true });
    await clearMaster(appName);
    const stored = await client(A).waitForEvent('nodedown:stored', (d) => d.subject === primaryOutpoint,
      NODE_DOWN_GRACE_MS + TAKEOVER_MS, { afterId: standbyFrom });
    // The moment the standby decides: its promotion begins.
    const promoting = await client(A).waitForEvent('primaryRole:changed', (d) => d.identifier === fleet.identifier && d.to === 'promoting',
      TAKEOVER_MS, { afterId: standbyFrom });
    expect(promoting.id, 'the standby deciding before the certificate').to.be.above(stored.id);
    await waitForUp(client(A), appName, 'the standby runs the app', { timeout: TAKEOVER_MS, interval: 3000 });
    expect(await fleet.verdicts(A, 'notCertified'), 'the standby held by the missing certificate first').to.be.above(notCertifiedFrom);
    expect(fleet.twoRan, 'moments when more than one node ran the component').to.deep.equal([]);
  });
});
