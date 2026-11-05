// fleet: 3
import {
  describe, it, before, after,
} from 'mocha';
import { readFileSync } from 'node:fs';
import { expect } from 'chai';
import { releaseFluxos, shutdownFluxosGracefully } from '../framework/container.js';
import { electMaster, clearMaster, resetFdm } from '../framework/fdm-control.js';
import { waitFor, waitForUp } from '../framework/wait.js';
import { startDaemon } from '../framework/syncthing-real.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { placeSilentPrimaryApp, A, B } from '../framework/silent-primary.js';
import { loadSharedConfig } from '../framework/coupled-knobs.js';
import { dbClient } from '../framework/db-client.js';

// A primary that closes its connections with a shutdown is rebooting until the
// network certifies it down: the jurors wait out the grace first. One back
// inside the grace is never certified and keeps the app, and the standby never
// takes it over.

const NODE_DOWN_GRACE_MS = loadSharedConfig().fluxapps.nodeDownGraceS * 1000;
const list = JSON.parse(
  readFileSync(new URL('../../fixtures/deterministic-list.json', import.meta.url), 'utf-8'),
);
const primaryOutpoint = `${list[B].txhash}:${list[B].outidx}`;

describe('a primary back inside the grace keeps the app', function () {
  let fleet;
  dumpLogsOnFailure(() => fleet?.env);
  const appName = `e2ereboot${Date.now()}`;
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

  it('holds the standby back while the primary reboots, and the primary runs the app again', async function () {
    this.timeout(600000);
    const standbyFrom = client(A).getLastEventId();
    const notCertifiedFrom = await fleet.verdicts(A, 'notCertified');
    const shutdownAt = Date.now();

    await shutdownFluxosGracefully(client(B).container, { hold: true, stopSyncthingAfter: true });
    // FDM no longer names a primary that does not answer.
    await clearMaster(appName);
    // The standby asks while the primary is away: held by the missing certificate,
    // or taking over.
    await waitFor(async () => await fleet.verdicts(A, 'notCertified') > notCertifiedFrom
      || fleet.becamePrimary(A, standbyFrom).length > 0, {
      timeout: 60000, interval: 2000, label: 'the standby judging the primary that shut down',
    });
    expect(fleet.becamePrimary(A, standbyFrom), 'the standby taking over from a rebooting primary').to.deep.equal([]);

    await startDaemon(client(B), { paused: true });
    await releaseFluxos(client(B).container);
    expect(Date.now() - shutdownAt, 'fixture: the primary was back inside the grace').to.be.below(NODE_DOWN_GRACE_MS);
    await electMaster(appName, client(B).ip);
    await waitForUp(client(B), appName, 'the primary runs the app again', { timeout: 300000, interval: 3000 });

    expect(await dbClient(A + 1).getNodeDownRecords(primaryOutpoint), 'a certificate for the primary that came back').to.deep.equal([]);
    expect(fleet.becamePrimary(A, standbyFrom), 'the standby taking over from a rebooting primary').to.deep.equal([]);
    expect(await fleet.isUp(A), 'the standby running the app').to.equal(false);
    expect(fleet.twoRan, 'moments when more than one node ran the component').to.deep.equal([]);
  });
});
