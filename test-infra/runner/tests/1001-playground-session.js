// weight: heavy
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { pushTestApp, pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST } from '../framework/subnet-config.js';
import { execInContainer } from '../framework/container.js';
import { waitFor, waitForDaemonReady } from '../framework/wait.js';
import { authenticate } from '../auth.js';
import { userKey, appOwnerKey } from '../framework/keys.js';

// The playground runs an UNSIGNED spec on one node, at the resources it
// declares, and reports what happened. Everything here is what unit tests with
// docker stubbed cannot reach: real containers on a real daemon, a real
// per-session network on a reserved /27, real iptables and tc rules, and -
// since 2026-08-02 - a real docker EVENT STREAM as the only thing telling a
// session what its containers are doing.
//
// The event path is why this suite exists. The payload shape (label filtering,
// `exitCode` on a die) was verified by hand against a daemon; nothing checked
// that a session reaches a verdict from those events, or that
// subscribe-then-snapshot really catches a container that dies before anything
// looks at it.
//
// ONE node, and NO bootAndPeer. Unlike the registration suites, nothing here
// crosses the mesh: the playground takes an unsigned spec, admits it against
// this node's own capacity, and runs it locally. It never gossips, never
// submits, and never reads a peer - so the submission door's minOutgoing /
// minIncoming floors, which every registration suite has to lower for a small
// fleet, simply do not apply. A peered fleet would only make this slower.
//
// The node is forced NIMBUS: the playground refuses cumulus, and cumulus is
// what the daemon stub reports by default.
//
// NOT COVERED, deliberately, each for a reason:
//  - egress default-deny and the 1 Mbit/s cap. Worth its own suite: proving
//    "reaches 443, cannot reach the node or another app's network" needs a
//    container that attempts an outbound connection and reports the result,
//    which is a different shape of test from these.
//  - the 15-minute TTL expiring on its own. The window is the config value; a
//    session that ends by deadline rather than by cancel is the same code path
//    with a longer wait.
//  - the repeat-miner refusal. It needs a session flagged by the CPU heuristic
//    (>=90% of allocation, never answered, ran the full window), so it is a
//    fifteen-minute test of a probabilistic signal.
//  - capacity shortfall. The ceiling refuses first on any spec big enough to
//    exhaust a harness node.

const NODE_SESSION_BUDGET = 50;

async function poll(client, zelidauth, jobId, { sinceSeq = null } = {}) {
  const query = sinceSeq === null ? '' : `?sinceSeq=${sinceSeq}`;
  const res = await client.getAuthed(`/apps/operations/${jobId}${query}`, zelidauth, { noCache: true });
  return res.data;
}

/** The operations resource cancels on DELETE; the node client has no delete helper. */
async function cancel(client, zelidauth, jobId) {
  await fetch(`${client.url}/apps/operations/${jobId}`, {
    method: 'DELETE',
    headers: { zelidauth },
  }).catch(() => {});
}

/** Wait for a session to stop being Running, and hand back its final view. */
async function settled(client, zelidauth, jobId, timeout = 180000) {
  let view = null;
  await waitFor(async () => {
    view = await poll(client, zelidauth, jobId);
    return Boolean(view) && view.status !== 'Running';
  }, { timeout, label: `session ${jobId} settles` });
  return view;
}

/** Wait for one component to reach a verdict, while the session still runs. */
async function verdictFor(client, zelidauth, jobId, component, timeout = 180000) {
  let probe = null;
  await waitFor(async () => {
    const view = await poll(client, zelidauth, jobId);
    probe = view?.detail?.components?.[component]?.probe ?? null;
    return Boolean(probe);
  }, { timeout, label: `${component} reaches a verdict` });
  return probe;
}

/** End a session and wait for it, so the next test starts on a free node. */
async function endSession(client, zelidauth, jobId) {
  await cancel(client, zelidauth, jobId);
  return settled(client, zelidauth, jobId);
}

async function startSession(client, zelidauth, spec) {
  const res = await client.post('/apps/playground', spec, { zelidauth });
  expect(res.status, `session refused: ${JSON.stringify(res.data)}`).to.equal('success');
  return res.data.jobId;
}

function component({ image, env = {}, entrypoint = null, ...overrides }) {
  return {
    name: 'web',
    description: 'playground session component',
    image,
    cpu: 0.5,
    memory: 300,
    rootFsGb: 2,
    ...(Object.keys(env).length ? { env } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...overrides,
  };
}

function sessionSpec({ name, components, ...overrides }) {
  return {
    version: 9,
    name,
    description: 'playground integration session',
    owner: userKey().zelid,
    ttl: 2592000,
    contacts: { email: ['admin@example.com'] },
    components,
    ...overrides,
  };
}

/** One component called `web`, which is what most of these need. */
function oneComponent({ name, image, env, entrypoint, ...rest }) {
  return sessionSpec({ name, components: { web: component({ image, env, entrypoint, ...rest }) } });
}

const uniqueName = () => `pg${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('playground: a session runs on a real node and reports what happened', function () {
  let env;
  let client;
  let zelidauth;
  let appImage;
  let busyboxImage;

  before(async function () {
    this.timeout(360000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 1,
      nodeTiers: { 0: 'NIMBUS' },
      configOverrides: {
        fluxapps: {
          // A probe would otherwise spend 30s proving "it stayed up" before
          // every uptime verdict, on every test in this file.
          playgroundProbeStableMs: 5000,
          // Production runs 2 sessions per node and 3 per caller PER HOUR.
          // This file runs a dozen, so without raising them every test after
          // the second would be refused by the rate limiter rather than
          // testing what it is named for. The limiter has its own suite below,
          // at its own settings.
          playgroundNodeSessionsPerHour: NODE_SESSION_BUDGET,
          playgroundCallerSessionsPerHour: NODE_SESSION_BUDGET,
        },
      },
    });
    [client] = env.clients;
    await waitForDaemonReady(client);
    ({ zelidauth } = await authenticate(client.url, userKey()));

    await pushTestApp('e2e-playground-app', 'v1');
    await pushBusybox('e2e-playground-busybox', 'v1');
    appImage = `${REGISTRY_REPO_HOST}/e2e-playground-app:v1`;
    busyboxImage = `${REGISTRY_REPO_HOST}/e2e-playground-busybox:v1`;
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  describe('accepting work', function () {
    it('accepts an unsigned spec and answers a job to poll', async function () {
      this.timeout(120000);
      const res = await client.post('/apps/playground', oneComponent({ name: uniqueName(), image: appImage }), { zelidauth });

      expect(res.status).to.equal('success');
      expect(res.data.jobId).to.match(/^op_/);
      expect(res.data.sessionId).to.equal(res.data.jobId);
      expect(res.data.statusUrl).to.include(res.data.jobId);

      await endSession(client, zelidauth, res.data.jobId);
    });

    it('requires an authenticated FluxID', async function () {
      this.timeout(60000);
      const res = await client.post('/apps/playground', oneComponent({ name: uniqueName(), image: appImage }));

      expect(res.status).to.equal('error');
    });

    it('refuses a spec that fails submission validation, before running anything', async function () {
      this.timeout(60000);
      // No components at all: flux-spec's own submission validator is the only
      // shape check the playground runs, so a spec it refuses is one
      // registration would refuse too.
      const res = await client.post('/apps/playground', sessionSpec({ name: uniqueName(), components: {} }), { zelidauth });

      expect(res.status).to.equal('error');
    });

    it('refuses a spec over the session ceiling, and says every node will agree', async function () {
      this.timeout(60000);
      const spec = oneComponent({ name: uniqueName(), image: appImage, cpu: 8 });

      const res = await client.post('/apps/playground', spec, { zelidauth });

      expect(res.status).to.equal('error');
      expect(res.data.message).to.include('8');
      // A ceiling refusal is the spec's own shape, identical on every node -
      // otherwise an owner shops the whole fleet and none of them says yes.
      expect(res.data.message).to.include('another node will answer the same');
    });

    it('refuses persistent storage rather than silently keeping nothing', async function () {
      this.timeout(60000);
      const spec = oneComponent({
        name: uniqueName(),
        image: appImage,
        persistentStorage: { sizeGb: 5, mounts: { '/data': { source: 'data', destination: '/data' } } },
      });

      const res = await client.post('/apps/playground', spec, { zelidauth });

      expect(res.status).to.equal('error');
      expect(res.data.message).to.include('keeps nothing');
    });

    it('refuses a second session while one is running, and says to try another node', async function () {
      this.timeout(240000);
      const jobId = await startSession(client, zelidauth, oneComponent({ name: uniqueName(), image: appImage }));
      await verdictFor(client, zelidauth, jobId, 'web');

      const second = await client.post('/apps/playground', oneComponent({ name: uniqueName(), image: appImage }), { zelidauth });

      expect(second.status).to.equal('error');
      expect(second.data.message).to.include('another node');

      await endSession(client, zelidauth, jobId);
    });
  });

  describe('the probe ladder', function () {
    // The container never binds a port and declares no health check, so the
    // only rung left is "it stayed up" - reported as the weak evidence it is
    // rather than dressed up as a health check.
    it('passes on uptime alone, and says the evidence is weak', async function () {
      this.timeout(240000);
      const jobId = await startSession(client, zelidauth, oneComponent({ name: uniqueName(), image: appImage }));

      const probe = await verdictFor(client, zelidauth, jobId, 'web');
      expect(probe.passed).to.equal(true);
      expect(probe.basis).to.equal('uptime');
      expect(probe.weak).to.equal(true);

      await endSession(client, zelidauth, jobId);
    });

    it('passes on a TCP connect when something is actually listening', async function () {
      this.timeout(240000);
      const spec = oneComponent({
        name: uniqueName(),
        image: busyboxImage,
        entrypoint: ['/bin/busybox', 'sh', '-c', 'busybox nc -l -p 80 -e /bin/busybox true; sleep 999'],
        ports: { http: { containerPort: 80, hostPort: 31000 } },
      });

      const jobId = await startSession(client, zelidauth, spec);
      const probe = await verdictFor(client, zelidauth, jobId, 'web');

      expect(probe.passed).to.equal(true);
      expect(probe.basis).to.equal('tcp');
      // The probe dials the CONTAINER from the node, the direction real traffic
      // arrives from, so a process bound only to loopback would not pass here.
      expect(probe.detail).to.include('80');

      await endSession(client, zelidauth, jobId);
    });

    // THE race. The container exits about a second after it starts, so on a
    // real daemon its die event can land before anything has looked at it.
    // Inspect-then-subscribe loses that event and the session waits out its
    // whole deadline; subscribe-then-snapshot reports the exit. The code comes
    // straight from the event payload, so this proves the payload is read too.
    it('reports a container that exits immediately, with its exit code', async function () {
      this.timeout(240000);
      const spec = oneComponent({
        name: uniqueName(),
        image: appImage,
        env: { EXIT_AFTER_S: '1', EXIT_CODE: '17' },
      });

      const jobId = await startSession(client, zelidauth, spec);
      const probe = await verdictFor(client, zelidauth, jobId, 'web');

      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('exit');
      expect(probe.exitCode).to.equal(17);
      expect(probe.detail).to.include('17');

      // Every container has stopped, so the session ends itself rather than
      // holding the node's only slot for the rest of the window.
      const view = await settled(client, zelidauth, jobId);
      // The OPERATION succeeded - it ran the spec and reported what happened -
      // while the app itself failed. A client reading completion from the
      // status and the outcome from the verdict gets both right.
      expect(view.status).to.equal('Succeeded');
      expect(view.detail.verdict).to.equal('failed');
    });

    // Exit 0 is genuinely ambiguous - a finished job and a server that gave up
    // on its configuration both leave it - so it is reported as ambiguous.
    it('reports a clean exit without claiming to know why', async function () {
      this.timeout(240000);
      const spec = oneComponent({
        name: uniqueName(),
        image: appImage,
        env: { EXIT_AFTER_S: '1', EXIT_CODE: '0' },
      });

      const jobId = await startSession(client, zelidauth, spec);
      const probe = await verdictFor(client, zelidauth, jobId, 'web');

      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('exit');
      expect(probe.exitCode).to.equal(0);
      expect(probe.detail).to.include('exited cleanly');

      await settled(client, zelidauth, jobId);
    });

    it('runs every component of a multi-component spec and reports each', async function () {
      this.timeout(300000);
      const spec = sessionSpec({
        name: uniqueName(),
        components: {
          web: component({ image: appImage }),
          worker: { ...component({ image: appImage, env: { EXIT_AFTER_S: '1', EXIT_CODE: '3' } }), name: 'worker' },
        },
      });

      const jobId = await startSession(client, zelidauth, spec);
      await verdictFor(client, zelidauth, jobId, 'web');
      await verdictFor(client, zelidauth, jobId, 'worker');

      const view = await poll(client, zelidauth, jobId);
      expect(view.detail.components.web.probe.passed).to.equal(true);
      expect(view.detail.components.worker.probe.basis).to.equal('exit');
      expect(view.detail.components.worker.probe.exitCode).to.equal(3);
      // One failing component fails the session, whatever the others did.
      const settledView = await endSession(client, zelidauth, jobId);
      expect(settledView.detail.verdict).to.be.oneOf(['failed', 'cancelled']);
    });
  });

  describe('the log stream', function () {
    it('streams the container output, and answers a cursor with only what is new', async function () {
      this.timeout(240000);
      const marker = `playground-marker-${Date.now()}`;
      const spec = oneComponent({
        name: uniqueName(),
        image: busyboxImage,
        entrypoint: ['/bin/busybox', 'sh', '-c', `echo ${marker}; sleep 999`],
      });

      const jobId = await startSession(client, zelidauth, spec);
      await verdictFor(client, zelidauth, jobId, 'web');

      let logs = null;
      await waitFor(async () => {
        const view = await poll(client, zelidauth, jobId);
        logs = view?.detail?.components?.web?.logs ?? null;
        return Boolean(logs) && logs.lines.some((line) => line.text.includes(marker));
      }, { timeout: 60000, label: 'the marker line reaches the log buffer' });

      expect(logs.total).to.be.greaterThan(0);
      const highest = Math.max(...logs.lines.map((line) => line.seq));

      // Read, not consumed. Asking again from the cursor returns nothing new,
      // and asking from the top still returns everything - which is what makes
      // a response that never arrived cost nothing to re-request.
      const fromCursor = await poll(client, zelidauth, jobId, { sinceSeq: highest });
      expect(fromCursor.detail.components.web.logs.lines).to.have.lengthOf(0);

      const fromZero = await poll(client, zelidauth, jobId);
      expect(fromZero.detail.components.web.logs.lines.some((line) => line.text.includes(marker))).to.equal(true);

      await endSession(client, zelidauth, jobId);
    });

    // The most useful log in a session is the one belonging to the container
    // that died. A reader attached after the fact would have missed it.
    it('keeps the output of a container that exited', async function () {
      this.timeout(240000);
      const marker = `dying-words-${Date.now()}`;
      const spec = oneComponent({
        name: uniqueName(),
        image: busyboxImage,
        entrypoint: ['/bin/busybox', 'sh', '-c', `echo ${marker}; exit 9`],
      });

      const jobId = await startSession(client, zelidauth, spec);
      const probe = await verdictFor(client, zelidauth, jobId, 'web');
      expect(probe.basis).to.equal('exit');

      const view = await settled(client, zelidauth, jobId);
      const { lines } = view.detail.components.web.logs;
      expect(lines.some((line) => line.text.includes(marker)), 'the dead container said something and it was kept').to.equal(true);
    });

    it('says how many lines it dropped, so a truncated log is not read as complete', async function () {
      this.timeout(300000);
      // Far more lines than the retained window, as fast as busybox can write.
      const spec = oneComponent({
        name: uniqueName(),
        image: busyboxImage,
        entrypoint: ['/bin/busybox', 'sh', '-c', 'i=0; while [ $i -lt 5000 ]; do echo line-$i; i=$((i+1)); done; sleep 999'],
      });

      const jobId = await startSession(client, zelidauth, spec);
      await verdictFor(client, zelidauth, jobId, 'web');

      let logs = null;
      await waitFor(async () => {
        const view = await poll(client, zelidauth, jobId);
        logs = view?.detail?.components?.web?.logs ?? null;
        return Boolean(logs) && logs.dropped > 0;
      }, { timeout: 120000, label: 'the buffer overflows its retention' });

      expect(logs.total).to.be.greaterThan(logs.lines.length);
      expect(logs.dropped).to.equal(logs.total - logs.lines.length);

      await endSession(client, zelidauth, jobId);
    });
  });

  describe('what a session is allowed to be', function () {
    it('publishes no host ports - a session has no inbound path at all', async function () {
      this.timeout(240000);
      const appName = uniqueName();
      const spec = sessionSpec({
        name: appName,
        components: {
          web: component({
            image: appImage,
            // Declared, and still not published: the probe dials the container
            // on the session network, and nothing outside the node may reach it.
            ports: { http: { containerPort: 80, hostPort: 31000 } },
          }),
        },
      });

      const jobId = await startSession(client, zelidauth, spec);
      await verdictFor(client, zelidauth, jobId, 'web');

      const { stdout } = await execInContainer(client.container, ['docker', 'ps', '--format', '{{.Names}} {{.Ports}}']);
      const row = stdout.split('\n').find((line) => line.includes(appName));
      expect(row, 'the session container is running').to.be.a('string');
      expect(row).to.not.include('0.0.0.0');
      expect(row).to.not.include('31000');

      await endSession(client, zelidauth, jobId);
    });

    it('runs on its own network, not on an app network', async function () {
      this.timeout(240000);
      const appName = uniqueName();
      const jobId = await startSession(client, zelidauth, oneComponent({ name: appName, image: appImage }));
      await verdictFor(client, zelidauth, jobId, 'web');

      // The bridge is NAMED (flxpg0..7) rather than left as docker's derived
      // br-<id>, which is what lets one static firewall rule cover every
      // session for the life of the node.
      const { stdout } = await execInContainer(client.container, ['ip', '-o', 'link', 'show']);
      expect(stdout).to.match(/flxpg\d/);

      await endSession(client, zelidauth, jobId);
    });
  });

  describe('ownership and teardown', function () {
    it('does not show a session to another FluxID', async function () {
      this.timeout(240000);
      const jobId = await startSession(client, zelidauth, oneComponent({ name: uniqueName(), image: appImage }));
      await verdictFor(client, zelidauth, jobId, 'web');

      const stranger = await authenticate(client.url, appOwnerKey());
      const res = await client.getAuthed(`/apps/operations/${jobId}`, stranger.zelidauth, { noCache: true });

      // Unknown, expired and someone else's are ONE answer: a jobId must not
      // tell a caller whether another identity has an operation running.
      expect(res.status).to.equal('error');

      await endSession(client, zelidauth, jobId);
    });

    it("answers an unknown job the same way as another identity's", async function () {
      this.timeout(60000);
      const res = await client.getAuthed('/apps/operations/op_doesnotexist', zelidauth, { noCache: true });

      expect(res.status).to.equal('error');
    });

    it('reports a cancelled session as cancelled, not as an error', async function () {
      this.timeout(240000);
      const jobId = await startSession(client, zelidauth, oneComponent({ name: uniqueName(), image: appImage }));
      await verdictFor(client, zelidauth, jobId, 'web');

      const view = await endSession(client, zelidauth, jobId);

      // The caller got the outcome they asked for, so it is its own terminal
      // state rather than an error the spec did not cause.
      expect(view.status).to.equal('Canceled');
      expect(view.detail.verdict).to.equal('cancelled');
    });

    it('leaves no container and no network behind', async function () {
      this.timeout(240000);
      const appName = uniqueName();
      const jobId = await startSession(client, zelidauth, oneComponent({ name: appName, image: appImage }));
      await verdictFor(client, zelidauth, jobId, 'web');

      await endSession(client, zelidauth, jobId);

      // Ground truth from the daemon, not from what the session claims it did.
      await waitFor(async () => {
        const { stdout } = await execInContainer(client.container, ['docker', 'ps', '-a', '--format', '{{.Names}}']);
        return !stdout.includes(appName);
      }, { timeout: 60000, label: 'the session container is gone' });

      const { stdout: networks } = await execInContainer(client.container, ['docker', 'network', 'ls', '--format', '{{.Name}}']);
      expect(networks).to.not.include(appName);
    });

    it('frees the slot, so the next session is admitted', async function () {
      this.timeout(300000);
      const first = await startSession(client, zelidauth, oneComponent({ name: uniqueName(), image: appImage }));
      await verdictFor(client, zelidauth, first, 'web');
      await endSession(client, zelidauth, first);

      // The concurrency slot, the capacity reservation and the subnet all have
      // to come back, or a node runs exactly one session per restart.
      const second = await startSession(client, zelidauth, oneComponent({ name: uniqueName(), image: appImage }));
      await verdictFor(client, zelidauth, second, 'web');
      await endSession(client, zelidauth, second);
    });
  });
});

describe('playground: the hourly rate limit', function () {
  let env;
  let client;
  let zelidauth;
  let appImage;

  before(async function () {
    this.timeout(360000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 1,
      nodeTiers: { 0: 'NIMBUS' },
      configOverrides: {
        fluxapps: {
          playgroundProbeStableMs: 5000,
          // One per hour: the second attempt is the refusal under test. The
          // caller limit is left above it so the NODE limit is what bites.
          playgroundNodeSessionsPerHour: 1,
          playgroundCallerSessionsPerHour: 10,
        },
      },
    });
    [client] = env.clients;
    await waitForDaemonReady(client);
    ({ zelidauth } = await authenticate(client.url, userKey()));
    await pushTestApp('e2e-playground-rate', 'v1');
    appImage = `${REGISTRY_REPO_HOST}/e2e-playground-rate:v1`;
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('refuses once the node has spent its budget, even with the slot free', async function () {
    this.timeout(300000);
    const jobId = await startSession(client, zelidauth, oneComponent({ name: uniqueName(), image: appImage }));
    await verdictFor(client, zelidauth, jobId, 'web');
    await endSession(client, zelidauth, jobId);

    // The concurrency slot is free; the hourly budget is not. These are
    // different refusals and a caller has to be able to tell them apart.
    const refused = await client.post('/apps/playground', oneComponent({ name: uniqueName(), image: appImage }), { zelidauth });

    expect(refused.status).to.equal('error');
    expect(refused.data.message).to.include('for the hour');
  });
});

describe('playground: an ineligible node refuses before doing any work', function () {
  let env;
  let client;
  let zelidauth;

  before(async function () {
    this.timeout(360000);
    // No nodeTiers: the daemon stub reports cumulus, which is 4 cores / 7 GB,
    // where a 2-core guest is real load competing with the apps the node is
    // already paid to run.
    env = await createTestEnv({ hookCtx: this, nodes: 1 });
    [client] = env.clients;
    await waitForDaemonReady(client);
    ({ zelidauth } = await authenticate(client.url, userKey()));
  });

  after(async function () {
    this.timeout(60000);
    await env?.teardown();
  });

  it('refuses on tier, and names the tier it is', async function () {
    this.timeout(60000);
    const spec = oneComponent({ name: uniqueName(), image: `${REGISTRY_REPO_HOST}/e2e-playground-app:v1` });

    const res = await client.post('/apps/playground', spec, { zelidauth });

    expect(res.status).to.equal('error');
    expect(res.data.message).to.include('cumulus');
  });
});
