const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { PassThrough } = require('stream');

/** Let the follow's data events reach the buffer before asserting on it. */
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

const CONFIG = {
  fluxapps: {
    playgroundSessionImageMaxBytes: 2e9,
    playgroundSessionImageTotalMaxBytes: 6e9,
    playgroundProbeTimeoutMs: 180000,
    playgroundProbeStableMs: 30000,
    playgroundLogLines: 200,
    playgroundLogRetainedLines: 2000,
    playgroundMinerCpuBusyFraction: 0.9,
    // Tiny running window so the observation loop finishes in test time; the
    // fake watcher's changedOr is a real short wait so it iterates a handful of
    // times rather than spinning.
    playgroundSessionTtlMs: 60,
    playgroundTcpRetryMs: 5,
    // Fast enough to take several samples inside that window.
    playgroundCpuSampleMs: 5,
  },
};

describe('playgroundRunner', () => {
  let stubs;
  let runner;

  function load(opts = {}) {
    stubs = {
      inspect: sinon.stub(),
      isPortOpen: sinon.stub().resolves(false),
      // Each follow gets its own PassThrough, kept so a test can write into it
      // mid-session exactly as a container writing to its log would.
      follows: [],
      forceRemove: sinon.stub().resolves('removed'),
      start: sinon.stub().resolves('started'),
      create: sinon.stub().resolves(),
      imageSize: sinon.stub().resolves(0),
      listContainers: sinon.stub().resolves([]),
      stats: sinon.stub().resolves(opts.stats ?? null),
      removeNetwork: sinon.stub().resolves(),
      createSessionNetwork: sinon.stub().resolves({
        slot: 0, bridge: 'flxpg0', networkName: 'fluxPlayground_op_1', subnet: '172.23.255.0/27',
      }),
      reapOrphanNetworks: sinon.stub().resolves({ removed: 0, networks: [] }),
      verifyRepository: sinon.stub().resolves({
        decompressedSizeClearanceBytes: opts.imageBytes ?? 100_000_000,
      }),
      verifyComponentImage: sinon.stub().resolves({ repoTag: 'nginx:latest' }),
      delay: sinon.stub().callsFake(() => new Promise((r) => { setTimeout(r, 5); })),
    };

    // What the event stream would have told the session. Tests vary this to
    // say what the containers are doing; the runner never asks docker itself.
    stubs.watched = {
      known: true,
      running: true,
      gone: false,
      exitCode: null,
      health: 'healthy',
      hasHealthCheck: true,
      address: '172.23.1.5',
      ...(opts.watched ?? {}),
    };
    stubs.watcherStopped = 0;
    stubs.createSessionWatcher = sinon.stub().callsFake(() => ({
      start: sinon.stub().resolves(),
      stop: () => { stubs.watcherStopped += 1; },
      state: () => ({ ...stubs.watched }),
      anyRunning: () => stubs.watched.running,
      // A real wait, bounded, so the observation loop advances toward its
      // deadline instead of spinning.
      changedOr: (ms) => new Promise((resolve) => { setTimeout(resolve, Math.min(ms, 10)); }),
      refresh: sinon.stub().resolves(),
    }));

    stubs.logStream = sinon.stub().callsFake(async () => {
      const stream = new PassThrough();
      const stop = sinon.stub().callsFake(() => stream.end());
      stubs.follows.push({ stream, stop });
      if (opts.logs) stream.write(opts.logs);
      return { stream, stop };
    });

    stubs.logError = sinon.stub();

    return proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundRunner', {
      config: CONFIG,
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: stubs.logError,
      },
      '../dockerService': {
        dockerContainerInspect: stubs.inspect,
        dockerContainerLogsStream: stubs.logStream,
        appDockerForceRemove: stubs.forceRemove,
        appDockerStart: stubs.start,
        appDockerCreate: stubs.create,
        appDockerImageSize: stubs.imageSize,
        dockerListContainers: stubs.listContainers,
        dockerContainerStats: stubs.stats,
        forceRemoveFluxAppDockerNetwork: stubs.removeNetwork,
        dockerPullStream: sinon.stub(),
      },
      '../fluxNetworkHelper': { isPortOpen: stubs.isPortOpen },
      './playgroundNetwork': {
        createSessionNetwork: stubs.createSessionNetwork,
        reapOrphanNetworks: stubs.reapOrphanNetworks,
        networkNameFor: (id) => `fluxPlayground_${id}`,
      },
      './playgroundWatcher': { createSessionWatcher: stubs.createSessionWatcher },
      '../appLifecycle/componentProvisioner': { verifyComponentImage: stubs.verifyComponentImage },
      '../appSecurity/imageManager': { verifyRepository: stubs.verifyRepository },
      util: { promisify: () => (opts.pull ?? (async () => 'pulled')) },
    });
  }


  /**
   * Docker's raw stats shape. cpuShare is the fraction of the whole host used,
   * which is what the daemon reports — the runner has to scale it against the
   * component's own allocation before it means anything.
   */
  function dockerStats(cpuShare, hostCores = 8) {
    return {
      cpu_stats: {
        cpu_usage: { total_usage: cpuShare * hostCores * 1e9 },
        system_cpu_usage: hostCores * 1e9,
        online_cpus: hostCores,
      },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    };
  }

  /** Same module, but retaining fewer lines than the test emits. */
  function proxyquireWithRetention(retained, logs) {
    const cfg = {
      fluxapps: { ...CONFIG.fluxapps, playgroundLogRetainedLines: retained },
    };
    const saved = load({ logs });
    saved.__cfg = cfg;
    return proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundRunner', {
      config: cfg,
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../dockerService': {
        dockerContainerInspect: stubs.inspect,
        dockerContainerLogsStream: stubs.logStream,
        appDockerForceRemove: stubs.forceRemove,
        appDockerStart: stubs.start,
        appDockerCreate: stubs.create,
        appDockerImageSize: stubs.imageSize,
        dockerListContainers: stubs.listContainers,
        dockerContainerStats: stubs.stats,
        forceRemoveFluxAppDockerNetwork: stubs.removeNetwork,
        dockerPullStream: sinon.stub(),
      },
      '../fluxNetworkHelper': { isPortOpen: stubs.isPortOpen },
      './playgroundNetwork': {
        createSessionNetwork: stubs.createSessionNetwork,
        reapOrphanNetworks: stubs.reapOrphanNetworks,
        networkNameFor: (id) => `fluxPlayground_${id}`,
      },
      './playgroundWatcher': { createSessionWatcher: stubs.createSessionWatcher },
      '../appLifecycle/componentProvisioner': { verifyComponentImage: stubs.verifyComponentImage },
      '../appSecurity/imageManager': { verifyRepository: stubs.verifyRepository },
      util: { promisify: () => async () => 'pulled' },
    });
  }

  function component(overrides = {}) {
    return {
      name: 'web',
      appName: 'demoapp',
      identifier: 'web_demoapp',
      image: 'nginx:latest',
      // Load-bearing: the CPU reading is scaled against the component's own
      // allocation, so a fixture without one is genuinely unmeasurable.
      cpu: 2,
      imageAuth: null,
      portBindings: [{ containerPort: 80, hostPort: 31000, protocol: 'tcp' }],
      ...overrides,
    };
  }

  const running = (health = null) => ({
    State: { Running: true, ...(health ? { Health: { Status: health } } : {}) },
    NetworkSettings: { Networks: { fluxDockerNetwork_demoapp: { IPAddress: '172.23.1.5' } } },
  });

  beforeEach(() => {
    runner = load();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkImageSize', () => {
    it('admits an image inside the session limit', async () => {
      const verdict = await runner.checkImageSize(component());
      expect(verdict.ok).to.equal(true);
    });

    it('refuses an oversize image, naming both sizes', async () => {
      runner = load({ imageBytes: 6e9 });
      const verdict = await runner.checkImageSize(component());
      expect(verdict.ok).to.equal(false);
      expect(verdict.reason).to.include('6.00 GB');
      expect(verdict.reason).to.include('2.00 GB');
    });

    // An unmeasurable layer is the registry's ambiguity, not evidence of size.
    // Refusing on it would make a whole class of legitimate registries unusable.
    it('admits an image whose size could not be measured', async () => {
      runner = load({ imageBytes: 0 });
      const verdict = await runner.checkImageSize(component());
      expect(verdict.ok).to.equal(true);
    });

    // The measurement is the reason this exists: discovering an image is two
    // gigabytes by downloading two gigabytes helps nobody.
    it('measures without pulling', async () => {
      await runner.checkImageSize(component());
      expect(stubs.verifyComponentImage.called).to.equal(false);
    });
  });

  describe('probeComponent — the ladder', () => {
    const farDeadline = () => process.hrtime.bigint() + 600n * 1_000_000_000n;

    /**
     * The container state the probe reads, under the test's control.
     *
     * The probe no longer asks docker anything - it reads what the watcher has
     * been told by the event stream - so what a test varies is that state.
     * `msPerWait` advances a virtual clock once per wait, so a test that needs
     * time to pass is deterministic rather than dependent on how fast it runs.
     */
    function watcherWith(state = {}, { msPerWait = 0 } = {}) {
      const current = {
        known: true,
        running: true,
        gone: false,
        exitCode: null,
        health: null,
        hasHealthCheck: false,
        address: '172.23.1.5',
        ...state,
      };
      let waits = 0;
      if (msPerWait) {
        const base = process.hrtime.bigint();
        sinon.stub(process.hrtime, 'bigint').callsFake(
          () => base + BigInt(waits) * BigInt(msPerWait) * 1_000_000n,
        );
      }
      return {
        state: () => ({ ...current }),
        anyRunning: () => current.running,
        async changedOr() { waits += 1; },
      };
    }

    it('passes on a healthy docker health check', async () => {
      const probe = await runner.probeComponent(component(), watcherWith({ hasHealthCheck: true, health: 'healthy' }), farDeadline());
      expect(probe.passed).to.equal(true);
      expect(probe.basis).to.equal('healthcheck');
    });

    it('fails on an unhealthy docker health check', async () => {
      const probe = await runner.probeComponent(component(), watcherWith({ hasHealthCheck: true, health: 'unhealthy' }), farDeadline());
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('healthcheck');
    });

    it('falls to a TCP connect when the image declares no health check', async () => {
      stubs.isPortOpen.resolves(true);
      const probe = await runner.probeComponent(component(), watcherWith(), farDeadline());
      expect(probe.passed).to.equal(true);
      expect(probe.basis).to.equal('tcp');
      expect(probe.detail).to.include('80');
    });

    // The probe dials the container from the node, the same direction real
    // traffic would arrive from, so a process bound only to loopback fails here.
    it('dials the container address, not the host', async () => {
      stubs.isPortOpen.resolves(true);
      await runner.probeComponent(component(), watcherWith(), farDeadline());
      expect(stubs.isPortOpen.firstCall.args[0]).to.equal('172.23.1.5');
      expect(stubs.isPortOpen.firstCall.args[1]).to.equal(80);
    });

    // A UDP port has no accept to observe, so connecting to it proves nothing
    // either way and is not worth reporting as evidence.
    it('does not probe UDP ports', async () => {
      const udpOnly = component({ portBindings: [{ containerPort: 53, hostPort: 31000, protocol: 'udp' }] });
      const probe = await runner.probeComponent(udpOnly, watcherWith({}, { msPerWait: 20_000 }), farDeadline());
      expect(stubs.isPortOpen.called).to.equal(false);
      expect(probe.basis).to.equal('uptime');
    });

    it('reports a weak uptime pass when nothing ever accepts, and says so', async () => {
      const probe = await runner.probeComponent(component(), watcherWith({}, { msPerWait: 20_000 }), farDeadline());
      expect(probe.passed).to.equal(true);
      expect(probe.basis).to.equal('uptime');
      expect(probe.weak).to.equal(true);
      expect(probe.detail).to.include('unproven');
    });

    it('fails a container that exited non-zero, naming the status', async () => {
      const probe = await runner.probeComponent(component(), watcherWith({ running: false, exitCode: 137 }), farDeadline());
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('exit');
      expect(probe.exitCode).to.equal(137);
    });

    // Exit 0 is genuinely ambiguous - a finished job and a server that gave up
    // both leave it - so it is reported as ambiguous rather than guessed at.
    it('fails a clean exit but does not claim to know why', async () => {
      const probe = await runner.probeComponent(component(), watcherWith({ running: false, exitCode: 0 }), farDeadline());
      expect(probe.passed).to.equal(false);
      expect(probe.detail).to.include('exited cleanly');
    });

    // Nothing is known until the first snapshot lands. Reading that silence as
    // "not running" would report every component as exited before it had been
    // looked at once.
    it('waits rather than calling an unknown container exited', async () => {
      const probe = await runner.probeComponent(
        component(),
        watcherWith({ known: false, running: false, hasHealthCheck: true }, { msPerWait: 20_000 }),
        process.hrtime.bigint() + 100n * 1_000_000_000n,
      );
      expect(probe.basis).to.equal('timeout');
    });

    // The probe wait is the longest stretch of a session, so a cancel that only
    // landed between components could take the whole probe timeout to be felt.
    it('gives up the probe promptly when the session is cancelled', async () => {
      const probe = await runner.probeComponent(component(), watcherWith({ hasHealthCheck: true, health: 'starting' }), farDeadline(), () => true);
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('cancelled');
    });

    it('fails when the container has gone', async () => {
      const probe = await runner.probeComponent(component(), watcherWith({ gone: true }), farDeadline());
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('container');
    });

    // A health check that exists but has not settled must keep waiting: passing
    // it on the weaker uptime rung would report a container as good on evidence
    // its own image says is not yet sufficient.
    it('keeps waiting on a starting health check rather than dropping to a weaker rung', async () => {
      const deadline = process.hrtime.bigint() + 100n * 1_000_000_000n;
      const probe = await runner.probeComponent(
        component(),
        watcherWith({ hasHealthCheck: true, health: 'starting' }, { msPerWait: 20_000 }),
        deadline,
      );
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('timeout');
      expect(probe.detail).to.include('starting');
      expect(stubs.isPortOpen.called).to.equal(false);
    });
  });

  describe('reapOrphans', () => {
    const labelled = (id, name) => ({
      Id: id,
      Names: [`/${name}`],
      Labels: { 'io.runonflux.playground': id },
    });

    it('removes containers no live session claims', async () => {
      stubs.listContainers.resolves([labelled('op_dead', 'fluxweb_gone')]);
      const result = await runner.reapOrphans(new Set());
      expect(result.removed).to.equal(1);
      expect(stubs.forceRemove.calledWith('fluxweb_gone')).to.equal(true);
    });

    it('leaves a live session alone', async () => {
      stubs.listContainers.resolves([labelled('op_live', 'fluxweb_live')]);
      const result = await runner.reapOrphans(new Set(['op_live']));
      expect(result.removed).to.equal(0);
      expect(stubs.forceRemove.called).to.equal(false);
    });

    // The sweep must key on the label alone. Anything else on the node - real
    // apps above all - is somebody else's to remove.
    it('never touches a container without the playground label', async () => {
      stubs.listContainers.resolves([
        { Id: 'x', Names: ['/fluxweb_realapp'], Labels: { 'io.runonflux.app': 'realapp' } },
      ]);
      const result = await runner.reapOrphans(new Set());
      expect(result.removed).to.equal(0);
      expect(stubs.forceRemove.called).to.equal(false);
    });

    it('keeps going when one removal fails', async () => {
      stubs.listContainers.resolves([labelled('a', 'fluxa'), labelled('b', 'fluxb')]);
      stubs.forceRemove.onFirstCall().rejects(new Error('docker busy'));
      const result = await runner.reapOrphans(new Set());
      expect(result.removed).to.equal(1);
    });
  });

  describe('teardownSession', () => {
    function session() {
      return {
        sessionId: 'op_1',
        appName: 'demoapp',
        results: { web: {} },
        deployment: { getComponent: () => component() },
      };
    }

    it('removes the containers and the network', async () => {
      await runner.teardownSession(session());
      expect(stubs.forceRemove.calledWith('web_demoapp')).to.equal(true);
      // By session, never by app name. Removing an app-named network here
      // force-disconnects every container attached to it, so a same-named paid
      // app would be cut off its own network by a guest's teardown.
      expect(stubs.removeNetwork.calledWith(null, { networkName: 'fluxPlayground_op_1' })).to.equal(true);
    });

    // Every removal swallows its own failure so a session still gets marked
    // finished. Without a check afterwards, a partial teardown reads in the log
    // exactly like a clean one.
    it('says so, loudly, when a container survives the teardown', async () => {
      stubs.forceRemove.rejects(new Error('device busy'));
      stubs.listContainers.resolves([{
        Id: 'abc', Names: ['/web_demoapp'], Labels: { 'io.runonflux.playground': 'op_1' },
      }]);

      await runner.teardownSession(session());

      const said = stubs.logError.args.map((args) => String(args[0])).join(' ');
      expect(said).to.include('web_demoapp');
      expect(said).to.include('left');
    });

    it('says nothing when everything really did go', async () => {
      stubs.listContainers.resolves([]);

      await runner.teardownSession(session());

      expect(stubs.logError.called).to.equal(false);
    });

    it('ignores containers belonging to another session', async () => {
      stubs.listContainers.resolves([{
        Id: 'abc', Names: ['/web_other'], Labels: { 'io.runonflux.playground': 'op_someone_else' },
      }]);

      await runner.teardownSession(session());

      expect(stubs.logError.called).to.equal(false);
    });

    // Teardown runs from the completion path, the deadline timer and the cancel
    // path. A throw here would leave the node believing a session it can no
    // longer see still occupies its only slot.
    it('never throws when docker refuses', async () => {
      stubs.forceRemove.rejects(new Error('docker gone'));
      stubs.removeNetwork.rejects(new Error('network gone'));
      let threw = null;
      await runner.teardownSession(session()).catch((error) => { threw = error; });
      expect(threw).to.equal(null);
    });

    // A session torn down before its network was recorded still has to have it
    // removed: the name is derivable from the session id, which always exists.
    it('still removes the network when there are no containers', async () => {
      const bare = { sessionId: 'op_1', appName: 'demoapp', results: {} };
      await runner.teardownSession(bare);
      expect(stubs.removeNetwork.calledWith(null, { networkName: 'fluxPlayground_op_1' })).to.equal(true);
    });
  });

  describe('runSession', () => {
    function session({ components: names = ['web'] } = {}) {
      const comps = new Map(names.map((name) => [
        name,
        component({ name, identifier: `${name}_demoapp` }),
      ]));
      return {
        sessionId: 'op_1',
        appName: 'demoapp',
        fluxId: 'zelid1',
        results: {},
        deployment: {
          startupOrder: names,
          getComponent: (name) => comps.get(name),
        },
      };
    }

    // Concurrent sessions are the point; only their PULLS contend, for bandwidth
    // shared with the paid apps this node is installing. So the stagger is a
    // queue on the pull rather than a delay before starting — a delay would be a
    // number standing in for "is anyone else pulling", which is knowable.
    it('never lets two sessions pull at the same time', async () => {
      let pulling = 0;
      let everOverlapped = false;
      const gate = [];
      const pull = async () => {
        pulling += 1;
        if (pulling > 1) everOverlapped = true;
        await new Promise((resolve) => { gate.push(resolve); });
        pulling -= 1;
        return 'pulled';
      };

      const runnerA = load({ pull });
      stubs.inspect.resolves(running('healthy'));
      const first = runnerA.runSession({ ...session(), sessionId: 'op_a' });
      const second = runnerA.runSession({ ...session(), sessionId: 'op_b' });

      // Let both reach the pull. Only one may be inside it.
      await new Promise((resolve) => { setImmediate(resolve); });
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(pulling, 'exactly one session is pulling').to.equal(1);

      // Release them in turn; the second only starts once the first is done.
      while (gate.length) gate.shift()();
      await new Promise((resolve) => { setImmediate(resolve); });
      while (gate.length) gate.shift()();
      await Promise.all([first, second]).catch(() => {});

      expect(everOverlapped, 'the pulls never overlapped').to.equal(false);
    });

    it('creates the container with no host port bindings', async () => {
      stubs.inspect.resolves(running('healthy'));
      await runner.runSession(session());
      expect(stubs.create.firstCall.args[1].publishPorts).to.equal(false);
    });

    it('labels the container with the session id so the reaper can find it', async () => {
      stubs.inspect.resolves(running('healthy'));
      await runner.runSession(session());
      expect(stubs.create.firstCall.args[1].labels['io.runonflux.playground']).to.equal('op_1');
    });

    it('puts the container in the playground slice, not the app slice', async () => {
      stubs.inspect.resolves(running('healthy'));
      await runner.runSession(session());
      expect(stubs.create.firstCall.args[1].cgroupSlice).to.equal('flux-playground.slice');
    });

    // A crash is a RESULT the owner needs to see. Restarting the container would
    // hide the single most useful thing a session can tell them.
    it('never restarts the container', async () => {
      stubs.inspect.resolves(running('healthy'));
      await runner.runSession(session());
      expect(stubs.create.firstCall.args[1].restartPolicy).to.equal('no');
    });

    // Teardown works from session.results, so a component that fails part way
    // through its own start - image pulled, container created, start refused -
    // must already be in it or its container outlives the session.
    it('claims a component before starting it, so a half-started one is still torn down', async () => {
      const s = session();
      stubs.start.rejects(new Error('docker refused the start'));

      await runner.runSession(s).catch(() => {});

      expect(Object.keys(s.results)).to.deep.equal(['web']);
      expect(s.results.web.started).to.equal(false);
    });

    it('stops before starting a component once cancelled', async () => {
      const s = session();
      const result = await runner.runSession(s, { isCancelled: () => true }).catch((e) => e);

      expect(result).to.be.an('error');
      expect(result.kind).to.equal('cancelled');
      expect(stubs.create.called).to.equal(false);
    });

    // The aggregate replaced the old component-count ceiling: it bounds pull
    // bandwidth, which is the only cost counting components ever stood in for.
    it('refuses a spec whose images are individually fine but too big together', async () => {
      // Four components at 1.8 GB each: each passes the per-image cap, the sum
      // does not.
      const comp = component();
      const many = {
        sessionId: 'op_1',
        appName: 'demoapp',
        fluxId: 'zelid1',
        results: {},
        deployment: {
          startupOrder: ['a', 'b', 'c', 'd'],
          getComponent: () => comp,
        },
      };
      runner = load({ imageBytes: 1.8e9 });

      let threw = null;
      await runner.runSession(many).catch((e) => { threw = e; });

      expect(threw).to.be.an('error');
      expect(threw.kind).to.equal('rejected');
      expect(threw.message).to.include('in total');
      expect(stubs.createSessionNetwork.called).to.equal(false);
    });

    it('admits a many-component spec whose images are small', async () => {
      const comp = component();
      const many = {
        sessionId: 'op_1',
        appName: 'demoapp',
        fluxId: 'zelid1',
        results: {},
        deployment: {
          startupOrder: ['a', 'b', 'c', 'd', 'e', 'f'],
          getComponent: () => comp,
        },
      };
      runner = load({ imageBytes: 3e8 });
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(many);

      expect(stubs.createSessionNetwork.calledOnce).to.equal(true);
    });

    // Measured against the container's OWN allocation. A 2-core component using
    // 2 host cores is flat out; the same component using half a core is not,
    // and docker's raw figure cannot tell them apart on its own.
    it('records a pegged session as busy, scaled to what the spec asked for', async () => {
      const s2 = session();
      runner = load({ stats: dockerStats(2 / 8) }); // 2 host cores of 8
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(s2);

      expect(s2.cpuBusyFraction).to.equal(1);
    });

    it('records a mostly idle session as not busy', async () => {
      const s2 = session();
      runner = load({ stats: dockerStats(0.1 / 8) }); // a tenth of one core
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(s2);

      expect(s2.cpuBusyFraction).to.equal(0);
    });

    // null, never 0: "could not tell" must not read downstream as "was idle",
    // or an unsampleable session looks like an innocent one.
    it('reports null rather than zero when the cpu could not be sampled', async () => {
      const s2 = session();
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(s2);

      expect(s2.cpuBusyFraction).to.equal(null);
    });

    // A terminal needs a stream: everything it has not seen, in order, once.
    // Re-reading the last N lines cannot give that - reads overlap, so the
    // client must guess what is new, and anything faster than N lines per tick
    // is lost before anyone sees it.
    it('numbers log lines so a client can tell exactly what is new', async () => {
      const s2 = session();
      runner = load({ logs: '2026-08-02T10:00:00.000000000Z hello\n2026-08-02T10:00:01.000000000Z world\n' });
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(s2);

      const { lines } = s2.logBuffers.web.view();
      expect(lines.map((l) => l.text)).to.include.members(['hello', 'world']);
      expect(lines.map((l) => l.seq)).to.deep.equal(lines.map((_, i) => i + 1));
    });

    // One counter for the session, so a client tracks a single number and
    // "everything above N" means the same thing whichever component wrote it.
    it('numbers across components from one session-wide sequence', async () => {
      const s2 = session({ components: ['web', 'db'] });
      stubs.inspect.resolves(running('healthy'));

      const run = runner.runSession(s2);
      await settle();
      stubs.follows[0].stream.write('2026-08-02T10:00:00.000000000Z from web\n');
      await settle();
      stubs.follows[1].stream.write('2026-08-02T10:00:01.000000000Z from db\n');
      await run;

      const web = s2.logBuffers.web.view().lines;
      const db = s2.logBuffers.db.view().lines;
      const allSeqs = [...web, ...db].map((l) => l.seq);
      expect(new Set(allSeqs).size, 'a sequence number must identify one line in the session').to.equal(allSeqs.length);
    });

    it('returns only what is above the caller cursor, and keeps the rest', async () => {
      const s2 = session();
      runner = load({ logs: '2026-08-02T10:00:00.000000000Z one\n2026-08-02T10:00:01.000000000Z two\n' });
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(s2);

      const all = s2.logBuffers.web.view().lines;
      expect(all).to.have.lengthOf(2);

      const after = s2.logBuffers.web.view(all[0].seq).lines;
      expect(after.map((l) => l.text)).to.deep.equal(['two']);

      // Read, not consumed: asking again from the same cursor answers the same,
      // so a response that never arrived costs nothing.
      expect(s2.logBuffers.web.view(all[0].seq).lines.map((l) => l.text)).to.deep.equal(['two']);
      expect(s2.logBuffers.web.view().lines).to.have.lengthOf(2);
    });

    // Duplicates used to be possible because docker's `since` is inclusive and
    // second-granular, so consecutive reads overlapped and the buffer had to
    // de-duplicate them. A follow has no overlap, so that guarantee is now
    // structural; what this pins is that it really is following, once each.
    it('follows each component once instead of re-reading it', async () => {
      const s2 = session();
      runner = load({ logs: '2026-08-02T10:00:00.000000000Z hello\n' });
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(s2);

      expect(stubs.logStream.callCount).to.equal(1);
      expect(stubs.logStream.firstCall.args[0]).to.equal('web_demoapp');
      expect(stubs.logStream.firstCall.args[1].timestamps).to.equal(true);
      expect(s2.logBuffers.web.view().lines.filter((l) => l.text === 'hello')).to.have.lengthOf(1);
    });

    it('reassembles a line delivered across two chunks', async () => {
      // A stream breaks on no particular boundary, so half a line is normal.
      const s2 = session();
      stubs.inspect.resolves(running('healthy'));

      const run = runner.runSession(s2);
      await settle();
      stubs.follows[0].stream.write('2026-08-02T10:00:00.000000000Z hel');
      await settle();
      stubs.follows[0].stream.write('lo world\n');
      await run;

      expect(s2.logBuffers.web.view().lines.map((l) => l.text)).to.include('hello world');
    });

    it('keeps a final line that never got its newline', async () => {
      // A container killed mid-write leaves exactly this, and it is often the
      // most interesting line in the log.
      const s2 = session();
      stubs.inspect.resolves(running('healthy'));

      const run = runner.runSession(s2);
      await settle();
      stubs.follows[0].stream.write('2026-08-02T10:00:00.000000000Z died right here');
      await run;
      await runner.teardownSession(s2);
      await settle();

      expect(s2.logBuffers.web.view().lines.map((l) => l.text)).to.include('died right here');
    });

    it('captures output written while it is watching, not only at the start', async () => {
      const s2 = session();
      stubs.inspect.resolves(running('healthy'));

      const run = runner.runSession(s2);
      await settle();
      stubs.follows[0].stream.write('2026-08-02T10:00:00.000000000Z early\n');
      await settle();
      stubs.follows[0].stream.write('2026-08-02T10:00:05.000000000Z later\n');
      await run;

      expect(s2.logBuffers.web.view().lines.map((l) => l.text)).to.include.members(['early', 'later']);
    });

    it('stops every follow at teardown', async () => {
      // A follow outliving its session holds a docker connection open for
      // nothing, and a cancelled session's containers are still up.
      const s2 = session();
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(s2);
      await runner.teardownSession(s2);

      expect(stubs.follows).to.have.lengthOf(1);
      expect(stubs.follows[0].stop.calledOnce).to.equal(true);
    });

    it('reports how many lines it dropped, so a truncated log is not read as complete', async () => {
      // Trailing newline included: forty COMPLETE lines. Without it the last one
      // is a partial, held back until flush, which is its own test.
      const many = `${Array.from({ length: 40 }, (_, i) => `2026-08-02T10:00:${String(i).padStart(2, '0')}.000000000Z line${i}`).join('\n')}\n`;
      const s2 = session();
      // Retain far fewer than were emitted.
      runner = proxyquireWithRetention(5, many);
      stubs.inspect.resolves(running('healthy'));

      await runner.runSession(s2);

      const { lines, dropped, total } = s2.logBuffers.web.view();
      expect(lines).to.have.lengthOf(5);
      expect(dropped).to.equal(total - 5);
      // `total` counts what THIS component produced, which is no longer the
      // sequence number now that the sequence is session-wide.
      expect(total).to.equal(40);
    });

    // The session is the RUNNING window. It ends on whichever comes first: the
    // deadline, a cancel, or every container stopping on its own.
    it('keeps running after the probe reaches a verdict', async () => {
      const s2 = session();

      await runner.runSession(s2);

      // The verdict lands almost immediately; the session still holds open for
      // its whole window, which is the thing the owner actually watches.
      expect(s2.results.web.probe.basis).to.equal('healthcheck');
      expect(s2.reachedDeadline).to.equal(true);
    });

    it('ends early when every container has stopped, without waiting out the window', async () => {
      const s2 = session();

      // The probe passes on the health check, then the container stops - which
      // reaches the session as a die event, not as a poll noticing later.
      const run = runner.runSession(s2);
      await settle();
      stubs.watched.running = false;
      await run;

      expect(s2.reachedDeadline).to.equal(undefined);
    });

    it('watches by subscription, not by asking docker', async () => {
      // The whole point: a fifteen-minute session used to cost thousands of
      // inspect and stats calls. Container state now arrives on the event
      // stream, and the runner never inspects at all.
      const s2 = session();

      await runner.runSession(s2);

      expect(stubs.inspect.called, 'the runner must not poll docker for state').to.equal(false);
      expect(stubs.createSessionWatcher.calledOnce).to.equal(true);
    });

    it('subscribes before starting anything, so no transition happens unobserved', async () => {
      // Inspect-then-subscribe leaves a window in which a container that dies
      // immediately fires its event into nothing, and the session then waits
      // out its whole deadline for a verdict that already happened.
      const s2 = session();

      await runner.runSession(s2);

      expect(stubs.createSessionWatcher.calledBefore(stubs.create)).to.equal(true);
      expect(stubs.createSessionWatcher.calledBefore(stubs.start)).to.equal(true);
    });

    it('follows the log for the whole session, not just around the probe', async () => {
      const s2 = session();
      stubs.inspect.resolves(running('healthy'));

      const run = runner.runSession(s2);
      await settle();
      // Written well after the probe would have reached its verdict.
      stubs.follows[0].stream.write('2026-08-02T10:05:00.000000000Z still here\n');
      await run;

      expect(s2.logBuffers.web.view().lines.map((l) => l.text)).to.include('still here');
    });

    it('refuses an oversize image before pulling anything', async () => {
      runner = load({ imageBytes: 6e9 });
      let threw = null;
      await runner.runSession(session()).catch((error) => { threw = error; });
      expect(threw).to.be.an('error');
      expect(threw.message).to.include('6.00 GB');
      expect(threw.kind).to.equal('rejected');
      expect(stubs.create.called).to.equal(false);
      expect(stubs.createSessionNetwork.called).to.equal(false);
    });
  });
});
