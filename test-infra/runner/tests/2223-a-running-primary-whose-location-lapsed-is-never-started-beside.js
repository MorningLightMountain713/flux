// fleet: 3
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { pushImage } from '../framework/registry-helper.js';
import { buildSeedableSyncthingApp } from '../framework/seed-helper.js';
import { appDataRoot, componentIdentifier, crashFluxos, getAppContainerStatus } from '../framework/container.js';
import { electMaster, clearMaster, resetFdm } from '../framework/fdm-control.js';
import {
  waitFor, waitForReconcileActuated, waitForUp, waitForElectionDecisions,
} from '../framework/wait.js';
import { bootAndPeer, installOnNodes, seedSyncScopedData } from '../framework/reconciler-suite.js';
import { isDaemonUp, listFolderFiles } from '../framework/syncthing-real.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A primary's FluxOS dies without announcing a shutdown. Its container and its
// syncthing go on running, and its location lapses. The standby that remembers
// it can see neither a location nor, once its syncthing drops the unlisted
// device, a sync connection - and it never starts a second instance beside the
// one still running: a silence it cannot explain is never a reason to.
//
// The location expiry and the shutdown window are short so the lapse happens
// inside the suite; the node-list eviction is set beyond it, so nothing else
// releases the standby.
//
// A = the standby, B = the primary, C = a bystander the discovery ring needs.

const A = 0;
const B = 1;
const C = 2;
const LOCATION_TTL_S = 240;
const SIGTERM_EXPIRY_S = 120;
// The lapse, the shutdown window a release would wait out, and several passes beyond.
const WATCHED_MS = (LOCATION_TTL_S + SIGTERM_EXPIRY_S) * 1000 + 8 * 60 * 1000;

describe('a running primary whose location lapsed is never started beside', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const appName = `e2elapse${Date.now()}`;
  let identifier;
  const client = (i) => env.clients[i];
  const isUp = async (i) => {
    const status = await getAppContainerStatus(client(i).container, appName);
    return !!(status && status.status.startsWith('Up'));
  };

  before(async function () {
    this.timeout(900000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      syncthing: 'real',
      tickerAutostart: false,
      configOverrides: {
        fluxapps: {
          minOutgoing: 1,
          minIncoming: 1,
          sigtermExpiryS: SIGTERM_EXPIRY_S,
          locationTtlS: LOCATION_TTL_S,
          nodeMonitorIntervalMs: 60 * 60 * 1000,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });
    await Promise.all(env.clients.map((c, i) => waitFor(() => isDaemonUp(c), {
      timeout: 180000, interval: 3000, label: `syncthing daemon up on node ${i}`,
    })));
    await resetFdm();
    await pushImage(appName, 'v1');
    const app = await buildSeedableSyncthingApp({ pinnedTo: [B, A], name: appName, syncMode: 'activeStandby', instances: 2 });
    identifier = componentIdentifier(app);

    await electMaster(appName, client(B).ip);
    const primaryAfter = client(B).getLastEventId();
    await installOnNodes(env, app, [B]);
    await waitForReconcileActuated(client(B), identifier, 'dataCleared', 120000, { afterId: primaryAfter });
    await seedSyncScopedData(env, appName, B);
    await waitForUp(client(B), appName, 'the primary is running', { timeout: 180000, interval: 3000 });

    const standbyAfter = client(A).getLastEventId();
    await installOnNodes(env, app, [A]);
    await waitForReconcileActuated(client(A), identifier, 'dataCleared', 120000, { afterId: standbyAfter });
    await waitFor(async () => (await listFolderFiles(client(A), `${await appDataRoot(client(A).container, appName)}/appdata`)).split(' ').includes('seed-data'), {
      timeout: 240000, interval: 5000, label: 'the primary\'s data reached the standby',
    });
    await waitForElectionDecisions(client(A), identifier, 'primaryObserved', 1, { timeout: 60000 });
  });

  after(async function () {
    this.timeout(60000);
    await resetFdm().catch(() => {});
    await env?.teardown();
  });

  it('never runs the component on a second node while the primary\'s container runs', async function () {
    this.timeout(WATCHED_MS + 300000);
    const bIp = client(B).ip;
    await crashFluxos(client(B).container, { hold: true });
    await clearMaster(appName);

    const samples = [];
    let lapsed = false;
    const deadline = Date.now() + WATCHED_MS;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const up = await Promise.all([A, B, C].map((i) => isUp(i).catch(() => null)));
      // eslint-disable-next-line no-await-in-loop
      const atB = await client(A).getAppLocationsAt(appName, bIp).catch(() => null);
      if (Array.isArray(atB) && atB.length === 0) lapsed = true;
      samples.push({ at: Date.now(), up });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 5000); });
    }

    expect(samples.every((s) => s.up[B]), 'fixture: the primary\'s container ran throughout').to.equal(true);
    expect(lapsed, 'fixture: the primary\'s location lapsed on the standby').to.equal(true);
    const twoRan = samples.filter((s) => s.up[B] && (s.up[A] || s.up[C]));
    expect(twoRan.length, 'samples in which a second node ran the component').to.equal(0);
  });
});
