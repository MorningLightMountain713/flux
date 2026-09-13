// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { execInContainer } from '../framework/container.js';
import { pushImage, mirrorExecutorImage, executorImageReference } from '../framework/registry-helper.js';
import { buildSeedableApp } from '../framework/seed-helper.js';
import { waitFor, waitForOperation, restartFluxosAndAwaitRecovery } from '../framework/wait.js';
import { bootAndPeer, installOnNodes } from '../framework/reconciler-suite.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { authenticate } from '../auth.js';
import { appOwnerKey } from '../framework/keys.js';
import {
  volumeRoot, resetVolume, seedLargeFile, exists,
} from '../framework/volume-fixture.js';

// A file operation runs in its OWN container, so restarting FluxOS does not
// interrupt it: flux-op keeps working and publishes its own result by
// exchanging staging with the destination. What the restart destroys is the
// process's memory of which containers are legitimate - liveContainerIds is
// in-memory - and boot recovery force-removes every file-operation container it
// does not recognise.
//
// So before the durable record existed, a restart KILLED an operation that was
// minutes from finishing, swept its staging directory, and answered the
// caller's poll with "no such job". No data was corrupted - a publish is one
// atomic exchange - but the work was destroyed and nothing said so.
//
// Everything here is asserted from outside FluxOS: the poll for the job, and
// docker for the container. The one assertion that could pass vacuously - "the
// operation survived" when it had already finished - carries its own canary.

describe('a file operation survives a FluxOS restart', function () {
  let env;
  let node;
  let auth;
  dumpLogsOnFailure(() => env);

  const ts = Date.now();
  const appName = `e2eopsurvive${ts}`;
  const root = volumeRoot(appName);

  // Big enough that compressing it outlives a FluxOS restart, and small enough
  // to fit the 1GB volume beside its own output. Random bytes do not compress,
  // so gzip reads all of it and writes about as much.
  const SOURCE_MB = 400;

  const post = (path, body) => node.request('POST', path, { body, headers: { zelidauth: auth.zelidauth } });
  const get = (path) => node.request('GET', path, { headers: { zelidauth: auth.zelidauth } });

  const inNode = (cmd) => execInContainer(node.container, cmd);

  // Docker's own view, not FluxOS's. The whole question is whether FluxOS left
  // this container alone, so asking FluxOS would be asking the defendant.
  async function fileOpContainerIds() {
    const r = await inNode("docker ps -a --filter 'label=runonflux.role=fileop' --format '{{.ID}} {{.State}}'");
    return r.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [id, state] = line.trim().split(/\s+/);
      return { id, state };
    });
  }

  before(async function () {
    this.timeout(900000);

    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      configOverrides: {
        // Three nodes cannot reach the production peer floors; the fleet exists
        // to make node 0 a real one rather than to be peered with.
        fluxapps: {
          minOutgoing: 1,
          minIncoming: 1,
          volumeOperations: { image: executorImageReference() },
        },
      },
    });
    await mirrorExecutorImage();
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });

    await pushImage(appName, 'v1');
    const app = await buildSeedableApp({
      name: appName,
      compose: [{
        name: appName,
        description: 'file operation restart survival',
        repotag: `${REGISTRY_REPO_HOST}/${appName}:v1`,
        ports: [],
        domains: [''],
        environmentParameters: [],
        commands: [],
        containerPorts: [80],
        containerData: '/appdata',
        cpu: 0.1,
        ram: 100,
        hdd: 1,
        repoauth: '',
      }],
    });
    await installOnNodes(env, app, [0]);

    node = env.clients[0];
    auth = await authenticate(node.url, appOwnerKey());

    await waitFor(async () => exists(node.container, root), {
      timeout: 60000, interval: 2000, label: 'app volume mounted',
    });
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('keeps running, finishes, and stays pollable across the restart', async function () {
    this.timeout(900000);

    await resetVolume(node.container, appName);
    await seedLargeFile(node.container, appName, 'bulk/payload.bin', SOURCE_MB);

    const accepted = await post('/apps/compressobject', {
      appname: appName,
      component: appName,
      source: 'bulk',
      destination: 'bulk.tar.gz',
    });
    expect(accepted.status, `compressobject: ${JSON.stringify(accepted.data)}`).to.equal(202);
    const { jobId } = accepted.data.data;

    // The container has to exist before a restart can be said to have spared
    // it. Without this the restart can land before the operation ever started,
    // and everything below would be true of a suite that tested nothing.
    let before = [];
    await waitFor(async () => {
      before = await fileOpContainerIds();
      return before.some((c) => c.state === 'running');
    }, { timeout: 120000, interval: 1000, label: 'the operation container is running' });
    const containerId = before.find((c) => c.state === 'running').id;

    // THE CANARY. If the compression has already finished there is nothing left
    // for the restart to spare, and the assertions below would pass over a
    // completed operation. Fail loudly and say what to change, rather than
    // reporting a green that means nothing.
    const midFlight = await get(`/apps/operations/${jobId}`);
    expect(
      midFlight.data?.data?.status,
      `the operation finished before the restart - raise SOURCE_MB above ${SOURCE_MB}, this assertion is otherwise vacuous`,
    ).to.equal('Running');

    await restartFluxosAndAwaitRecovery(node);

    // 1. NOT REAPED. This is the defect: boot recovery removes every fileop
    //    container it does not recognise, and after a restart it recognises
    //    none of them unless the record survived.
    const after = await fileOpContainerIds();
    const survivor = after.find((c) => c.id === containerId);
    expect(survivor, `the restart reaped the running operation (${JSON.stringify(after)})`).to.not.equal(undefined);

    // 2. STILL POLLABLE. The job was re-opened under its original id, so a
    //    caller that was watching is not told the work never existed.
    const resumed = await get(`/apps/operations/${jobId}`);
    expect(resumed.status, 'the job a caller was polling answers again').to.equal(200);
    expect(['Running', 'Succeeded']).to.include(resumed.data?.data?.status);

    // 3. IT FINISHES, AND PUBLISHES. The real proof - the work was not merely
    //    left alive, it completed and its result reached the destination.
    const job = await waitForOperation(node, jobId, auth.zelidauth, { timeout: 600000 });
    expect(job.status, `the adopted operation did not succeed: ${JSON.stringify(job.error)}`).to.equal('Succeeded');

    expect(await exists(node.container, `${root}/bulk.tar.gz`), 'the archive reached the destination').to.equal(true);

    const size = parseInt((await inNode(`stat -c '%s' ${root}/bulk.tar.gz`)).stdout.trim(), 10);
    expect(size, 'and it is not an empty or truncated archive').to.be.greaterThan(SOURCE_MB * 1024 * 100);

    // 4. NOTHING LEAKED. The record is dropped and the staging directory
    //    reclaimed once the adopted operation settles, exactly as they are for
    //    one this process started itself.
    const staging = await inNode(`ls -d ${root}/.flux-op-* 2>/dev/null || true`);
    expect(staging.stdout.trim(), 'staging was reclaimed after the adopted operation settled').to.equal('');
  });

  // The negative case. Adoption must not turn boot recovery into a no-op that
  // leaves debris behind: a fileop container no record claims is still reaped.
  it('still reaps a file-operation container no record claims', async function () {
    this.timeout(300000);

    // A container carrying the fileop label that FluxOS never started, so no
    // record names it. Sleeps rather than exiting, so "reaped" means removed
    // rather than merely finished.
    const started = await inNode(
      "docker run -d --label runonflux.role=fileop --entrypoint sh "
      + `${executorImageReference()} -c 'sleep 600'`,
    );
    const orphanId = started.stdout.trim().slice(0, 12);
    expect(orphanId, 'the orphan container started').to.not.equal('');

    await restartFluxosAndAwaitRecovery(node);

    const after = await fileOpContainerIds();
    expect(
      after.some((c) => c.id.startsWith(orphanId)),
      'a fileop container no record claims must still be reaped',
    ).to.equal(false);
  });
});
