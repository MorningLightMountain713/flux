const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const CONFIG = {
  fluxapps: {
    playgroundSessionImageMaxBytes: 2e9,
    playgroundProbeTimeoutMs: 180000,
    playgroundProbeStableMs: 30000,
    playgroundLogLines: 50,
  },
};

describe('playgroundRunner', () => {
  let stubs;
  let runner;

  function load(opts = {}) {
    stubs = {
      inspect: sinon.stub(),
      isPortOpen: sinon.stub().resolves(false),
      logs: sinon.stub().resolves(null),
      forceRemove: sinon.stub().resolves('removed'),
      start: sinon.stub().resolves('started'),
      create: sinon.stub().resolves(),
      imageSize: sinon.stub().resolves(0),
      listContainers: sinon.stub().resolves([]),
      removeNetwork: sinon.stub().resolves(),
      ensureNetwork: sinon.stub().resolves(),
      verifyRepository: sinon.stub().resolves({
        decompressedSizeClearanceBytes: opts.imageBytes ?? 100_000_000,
      }),
      verifyComponentImage: sinon.stub().resolves({ repoTag: 'nginx:latest' }),
      delay: sinon.stub().resolves(),
    };

    return proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundRunner', {
      config: CONFIG,
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
      },
      '../dockerService': {
        dockerContainerInspect: stubs.inspect,
        dockerContainerLogs: stubs.logs,
        appDockerForceRemove: stubs.forceRemove,
        appDockerStart: stubs.start,
        appDockerCreate: stubs.create,
        appDockerImageSize: stubs.imageSize,
        dockerListContainers: stubs.listContainers,
        forceRemoveFluxAppDockerNetwork: stubs.removeNetwork,
        dockerPullStream: sinon.stub(),
      },
      '../serviceHelper': {
        delay: stubs.delay,
        dockerBufferToString: (b) => String(b),
      },
      '../fluxNetworkHelper': { isPortOpen: stubs.isPortOpen },
      '../appNetwork/appDockerNetwork': { ensureAppDockerNetwork: stubs.ensureNetwork },
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
      imageAuth: null,
      portBindings: [{ containerPort: 80, hostPort: 31000, protocol: 'tcp' }],
      ...overrides,
    };
  }

  const running = (health = null) => ({
    State: { Running: true, ...(health ? { Health: { Status: health } } : {}) },
    NetworkSettings: { Networks: { fluxDockerNetwork_demoapp: { IPAddress: '172.23.1.5' } } },
  });

  /**
   * Drive the probe's clock from the inspect call count, so a test that needs
   * time to pass is deterministic rather than dependent on how fast it runs.
   */
  function clockPerInspect(msPerCall) {
    const base = process.hrtime.bigint();
    let calls = 0;
    stubs.inspect.callsFake(() => {
      calls += 1;
      return Promise.resolve(stubs.inspectResult);
    });
    sinon.stub(process.hrtime, 'bigint').callsFake(
      () => base + BigInt(calls) * BigInt(msPerCall) * 1_000_000n,
    );
  }

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

    it('passes on a healthy docker health check', async () => {
      stubs.inspect.resolves(running('healthy'));
      const probe = await runner.probeComponent(component(), farDeadline());
      expect(probe.passed).to.equal(true);
      expect(probe.basis).to.equal('healthcheck');
    });

    it('fails on an unhealthy docker health check', async () => {
      stubs.inspect.resolves(running('unhealthy'));
      const probe = await runner.probeComponent(component(), farDeadline());
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('healthcheck');
    });

    it('falls to a TCP connect when the image declares no health check', async () => {
      stubs.inspect.resolves(running());
      stubs.isPortOpen.resolves(true);
      const probe = await runner.probeComponent(component(), farDeadline());
      expect(probe.passed).to.equal(true);
      expect(probe.basis).to.equal('tcp');
      expect(probe.detail).to.include('80');
    });

    // The probe dials the container from the node, the same direction real
    // traffic would arrive from, so a process bound only to loopback fails here.
    it('dials the container address, not the host', async () => {
      stubs.inspect.resolves(running());
      stubs.isPortOpen.resolves(true);
      await runner.probeComponent(component(), farDeadline());
      expect(stubs.isPortOpen.firstCall.args[0]).to.equal('172.23.1.5');
      expect(stubs.isPortOpen.firstCall.args[1]).to.equal(80);
    });

    // A UDP port has no accept to observe, so connecting to it proves nothing
    // either way and is not worth reporting as evidence.
    it('does not probe UDP ports', async () => {
      stubs.inspect.resolves(running());
      const udpOnly = component({ portBindings: [{ containerPort: 53, hostPort: 31000, protocol: 'udp' }] });
      stubs.inspectResult = running();
      clockPerInspect(20_000);
      const probe = await runner.probeComponent(udpOnly, farDeadline());
      expect(stubs.isPortOpen.called).to.equal(false);
      expect(probe.basis).to.equal('uptime');
    });

    it('reports a weak uptime pass when nothing ever accepts, and says so', async () => {
      stubs.inspectResult = running();
      clockPerInspect(20_000);
      const probe = await runner.probeComponent(component(), farDeadline());
      expect(probe.passed).to.equal(true);
      expect(probe.basis).to.equal('uptime');
      expect(probe.weak).to.equal(true);
      expect(probe.detail).to.include('unproven');
    });

    it('fails a container that exited non-zero, naming the status', async () => {
      stubs.inspect.resolves({ State: { Running: false, ExitCode: 137 } });
      const probe = await runner.probeComponent(component(), farDeadline());
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('exit');
      expect(probe.exitCode).to.equal(137);
    });

    // Exit 0 is genuinely ambiguous - a finished job and a server that gave up
    // both leave it - so it is reported as ambiguous rather than guessed at.
    it('fails a clean exit but does not claim to know why', async () => {
      stubs.inspect.resolves({ State: { Running: false, ExitCode: 0 } });
      const probe = await runner.probeComponent(component(), farDeadline());
      expect(probe.passed).to.equal(false);
      expect(probe.detail).to.include('exited cleanly');
    });

    // The probe wait is the longest stretch of a session, so a cancel that only
    // landed between components could take the whole probe timeout to be felt.
    it('gives up the probe promptly when the session is cancelled', async () => {
      stubs.inspectResult = running('starting');
      clockPerInspect(1000);
      const probe = await runner.probeComponent(component(), farDeadline(), () => true);
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('cancelled');
    });

    it('fails when the container has gone', async () => {
      stubs.inspect.resolves(null);
      const probe = await runner.probeComponent(component(), farDeadline());
      expect(probe.passed).to.equal(false);
      expect(probe.basis).to.equal('container');
    });

    // A health check that exists but has not settled must keep waiting: passing
    // it on the weaker uptime rung would report a container as good on evidence
    // its own image says is not yet sufficient.
    it('keeps waiting on a starting health check rather than dropping to a weaker rung', async () => {
      stubs.inspectResult = running('starting');
      clockPerInspect(20_000);
      const deadline = process.hrtime.bigint() + 100n * 1_000_000_000n;
      const probe = await runner.probeComponent(component(), deadline);
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
      Labels: { 'flux.playground': id },
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
        { Id: 'x', Names: ['/fluxweb_realapp'], Labels: { 'runonflux.app': 'realapp' } },
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
      expect(stubs.removeNetwork.calledWith('demoapp')).to.equal(true);
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

    it('still removes the network when there are no containers', async () => {
      const bare = { sessionId: 'op_1', appName: 'demoapp', results: {} };
      await runner.teardownSession(bare);
      expect(stubs.removeNetwork.calledWith('demoapp')).to.equal(true);
    });
  });

  describe('runSession', () => {
    function session() {
      const comp = component();
      return {
        sessionId: 'op_1',
        appName: 'demoapp',
        fluxId: 'zelid1',
        results: {},
        deployment: {
          startupOrder: ['web'],
          getComponent: () => comp,
        },
      };
    }

    it('creates the container with no host port bindings', async () => {
      stubs.inspect.resolves(running('healthy'));
      await runner.runSession(session());
      expect(stubs.create.firstCall.args[1].publishPorts).to.equal(false);
    });

    it('labels the container with the session id so the reaper can find it', async () => {
      stubs.inspect.resolves(running('healthy'));
      await runner.runSession(session());
      expect(stubs.create.firstCall.args[1].labels['flux.playground']).to.equal('op_1');
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

    it('refuses an oversize image before pulling anything', async () => {
      runner = load({ imageBytes: 6e9 });
      let threw = null;
      await runner.runSession(session()).catch((error) => { threw = error; });
      expect(threw).to.be.an('error');
      expect(threw.message).to.include('6.00 GB');
      expect(threw.kind).to.equal('rejected');
      expect(stubs.create.called).to.equal(false);
      expect(stubs.ensureNetwork.called).to.equal(false);
    });
  });
});
