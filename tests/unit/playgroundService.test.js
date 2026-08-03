const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const CONFIG = {
  fluxapps: {
    playgroundSessionCpu: 2,
    playgroundSessionMemoryMb: 4096,
    playgroundSessionRootFsGb: 10,
    playgroundSessionMaxComponents: 3,
    playgroundSessionTtlMs: 900000,
    playgroundNodeConcurrentSessions: 1,
    playgroundNodeSessionsPerHour: 2,
    playgroundCallerSessionsPerHour: 3,
    playgroundWindowMs: 3600000,
  },
};

// The real registry: the concurrency gate and the janitor's protection both read
// it, so stubbing it would hide the thing several of these tests are about.
const sessionRegistry = require('../../ZelBack/src/services/appPlayground/playgroundSessionRegistry');

describe('playgroundService', () => {
  let stubs;
  let service;
  let limits;

  function totals(overrides = {}) {
    return {
      cpu: 1,
      memoryMb: 1024,
      storageGb: 0,
      rootFsGb: 4,
      swapGb: 0,
      hostDiskGb: 4,
      componentCount: 1,
      ...overrides,
    };
  }

  function load(opts = {}) {
    limits = proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundLimits', { config: CONFIG });
    limits.reset();

    stubs = {
      tier: sinon.stub().resolves(opts.tier ?? 'nimbus'),
      installedApps: sinon.stub().resolves({ status: 'success', data: opts.installed ?? [] }),
      nodeCapacity: sinon.stub().resolves({ availableSpace: 500, availableCpu: 100, availableRam: 30000 }),
      capacityShortfall: sinon.stub().returns(opts.shortfall ?? null),
      burstShortfall: sinon.stub().returns(null),
      reserve: sinon.stub(),
      release: sinon.stub(),
      withLock: async (fn) => fn(),
      runSession: sinon.stub().resolves({ web: { probe: { passed: true } } }),
      teardownSession: sinon.stub().resolves([]),
      reapOrphans: sinon.stub().resolves({ removed: 0 }),
      audit: sinon.stub().resolves(null),
      findFlaggedSince: sinon.stub().resolves(null),
      isBlocked: sinon.stub().resolves(opts.blocked ?? false),
      captureIngress: sinon.stub().resolves({ observed: { ip: '1.2.3.4', port: 5000 }, asserted: {} }),
      validateSpec: sinon.stub().resolves({ name: opts.appName ?? 'demoapp' }),
      fromSpec: sinon.stub().returns({
        resourceTotals: () => (opts.totals ?? totals()),
        allImages: () => ['nginx:latest'],
        startupOrder: ['web'],
        getComponent: () => ({ name: 'web', identifier: 'web_demoapp' }),
      }),
    };

    return proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundService', {
      config: CONFIG,
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
      },
      '../messageHelper': {
        createErrorMessage: (m) => ({ status: 'error', data: { message: m } }),
        errUnauthorizedMessage: () => ({ status: 'error', data: { message: 'Unauthorized' } }),
        createDataMessage: (d) => ({ status: 'success', data: d }),
      },
      '../serviceHelper': { ensureObject: (o) => o },
      '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
      '../generalService': { getNewNodeTier: stubs.tier },
      '../appRequirements/hwRequirements': {
        nodeCapacity: stubs.nodeCapacity,
        capacityShortfall: stubs.capacityShortfall,
        burstHeadroomShortfall: stubs.burstShortfall,
      },
      '../utils/admissionControl': {
        withLock: stubs.withLock, reserve: stubs.reserve, release: stubs.release,
      },
      '../appQuery/appQueryService': { installedApps: stubs.installedApps },
      '../utils/jobRegistry': require('../../ZelBack/src/services/utils/jobRegistry'),
      '../appManagement/operationsController': {
        accepted: (res, handle, extra) => res.status(202).json({ ...handle, ...extra }),
      },
      '../utils/specLibs': {
        validateSubmissionSpec: stubs.validateSpec,
        getSpecBackend: async () => ({ DeploymentSpec: { fromSpec: stubs.fromSpec } }),
      },
      '../utils/appConstants': { appsFolder: '/tmp/apps/' },
      './playgroundLimits': limits,
      './playgroundRunner': {
        runSession: stubs.runSession,
        teardownSession: stubs.teardownSession,
        reapOrphans: stubs.reapOrphans,
      },
      './playgroundSessionRegistry': sessionRegistry,
      './playgroundAudit': {
        record: stubs.audit,
        captureIngress: stubs.captureIngress,
        findFlaggedSince: stubs.findFlaggedSince,
      },
      './playgroundAbuse': { isBlocked: stubs.isBlocked },
    });
  }

  const caller = { fluxId: 'zelid1', sourceIp: '1.2.3.4' };

  beforeEach(() => {
    service = load();
    sessionRegistry.reset();
  });

  afterEach(() => {
    sessionRegistry.reset();
    sinon.restore();
  });

  async function settle() {
    // driveSession is deliberately not awaited by submitSession; let its
    // microtasks drain so assertions see the finished state.
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setImmediate(resolve); });
  }

  // Docker's labels are the ground truth, not our record of what is live, so
  // this is the one check that catches a session we lost track of rather than
  // one whose teardown merely failed. Running it here bounds the debris to one
  // session's worth at the only moment it matters, instead of up to a sweep
  // interval later.
  describe('collecting debris before a new session', () => {
    it('reaps abandoned containers before the session claims anything', async () => {
      await service.submitSession({}, caller);

      expect(stubs.reapOrphans.calledOnce).to.equal(true);
      expect(stubs.reapOrphans.calledBefore(stubs.runSession)).to.equal(true);
      await settle();
    });

    it('starts the session anyway when the check itself fails', async () => {
      // A docker that cannot list containers will fail this session a few steps
      // further on, with a better message than this could give.
      stubs.reapOrphans.rejects(new Error('docker unreachable'));

      const handle = await service.submitSession({}, caller);

      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });
  });

  describe('eligibility', () => {
    it('accepts a session on a nimbus node', async () => {
      const handle = await service.submitSession({}, caller);
      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });

    it('accepts a session on a stratus node', async () => {
      service = load({ tier: 'stratus' });
      const handle = await service.submitSession({}, caller);
      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });

    // Cumulus is 4 cores / 7 GB, where a 2-core guest is real load competing
    // with the apps the operator is actually paid to run.
    it('refuses a session on a cumulus node, and names the tier', async () => {
      service = load({ tier: 'cumulus' });
      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('ineligible');
      expect(threw.message).to.include('cumulus');
    });

    // Assuming a node is big enough puts guest containers on exactly the nodes
    // least able to absorb them - the outcome the tier rule exists to prevent.
    it('refuses when the tier cannot be read at all', async () => {
      service = load();
      stubs.tier.rejects(new Error('daemon down'));
      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('ineligible');
    });
  });

  describe('admission', () => {
    it('requires an authenticated FluxID', async () => {
      let threw = null;
      await service.submitSession({}, { sourceIp: '1.2.3.4' }).catch((e) => { threw = e; });
      expect(threw.message).to.include('FluxID');
    });

    it('refuses a spec over the session ceiling and says every node agrees', async () => {
      service = load({ totals: totals({ cpu: 8 }) });
      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('rejected');
      expect(threw.message).to.include('Every node applies the same session ceiling');
    });

    it('refuses when the node has no capacity right now', async () => {
      service = load({ shortfall: 'Not enough cpu' });
      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('busy');
      expect(threw.message).to.include('Try another node');
    });

    // A capacity refusal is not the caller's fault and they can do nothing about
    // it, so it must not spend one of their three sessions for the hour.
    //
    // The service and its limiter are loaded ONCE and only the capacity answer
    // changes between attempts. Reloading would hand the last attempt a fresh
    // set of counters, and the test would pass whether or not the earlier
    // refusals had charged anything.
    it('does not charge the caller for a session the node had no room for', async () => {
      stubs.capacityShortfall.returns('Not enough cpu');
      await service.submitSession({}, caller).catch(() => {});
      await service.submitSession({}, caller).catch(() => {});
      await service.submitSession({}, caller).catch(() => {});

      // The caller's allowance is 3 and the node's is 2. If any of those three
      // refusals had charged either window, this fourth attempt is refused.
      stubs.capacityShortfall.returns(null);
      const handle = await service.submitSession({}, caller);
      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });

    it('releases the capacity reservation when the hourly limit refuses', async () => {
      service = load();
      // A limiter that always refuses, so the refusal lands AFTER admission has
      // already reserved capacity — the window the release has to cover.
      const refusing = { ...limits, consumeSessionSlot: () => ({ allowed: false, scope: 'caller', retryAfterMs: 1000, message: 'over' }) };
      service = proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundService', {
        config: CONFIG,
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        '../messageHelper': { createErrorMessage: (m) => m, errUnauthorizedMessage: () => 'unauth', createDataMessage: (d) => d },
        '../serviceHelper': { ensureObject: (o) => o },
        '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(true) },
        '../generalService': { getNewNodeTier: stubs.tier },
        '../appRequirements/hwRequirements': {
          nodeCapacity: stubs.nodeCapacity,
          capacityShortfall: stubs.capacityShortfall,
          burstHeadroomShortfall: stubs.burstShortfall,
        },
        '../utils/admissionControl': { withLock: stubs.withLock, reserve: stubs.reserve, release: stubs.release },
        '../appQuery/appQueryService': { installedApps: stubs.installedApps },
        '../utils/jobRegistry': require('../../ZelBack/src/services/utils/jobRegistry'),
        '../appManagement/operationsController': { accepted: (res, h) => h },
        '../utils/specLibs': {
          validateSubmissionSpec: stubs.validateSpec,
          getSpecBackend: async () => ({ DeploymentSpec: { fromSpec: stubs.fromSpec } }),
        },
        '../utils/appConstants': { appsFolder: '/tmp/apps/' },
        './playgroundLimits': refusing,
        './playgroundRunner': { runSession: stubs.runSession, teardownSession: stubs.teardownSession, reapOrphans: stubs.reapOrphans },
        './playgroundSessionRegistry': sessionRegistry,
        './playgroundAudit': {
          record: stubs.audit,
          captureIngress: stubs.captureIngress,
          findFlaggedSince: stubs.findFlaggedSince,
        },
        './playgroundAbuse': { isBlocked: stubs.isBlocked },
      });

      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('busy');
      expect(stubs.reserve.called).to.equal(true);
      // Released under the key it was reserved under, whatever that key is.
      expect(stubs.release.calledWith(stubs.reserve.firstCall.args[0])).to.equal(true);
    });
  });

  describe('abuse blocking', () => {
    it('refuses a caller this node flagged, without doing any work', async () => {
      service = load({ blocked: true });

      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });

      expect(threw.kind).to.equal('busy');
      expect(stubs.validateSpec.called).to.equal(false);
      expect(stubs.runSession.called).to.equal(false);
    });

    // Naming the signal would tell someone grinding at this exactly which of
    // the three to defeat.
    it('does not say why it refused', async () => {
      service = load({ blocked: true });

      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });

      expect(threw.message).to.not.match(/cpu|mining|miner|flag/i);
      expect(threw.message).to.include('another node');
    });

    it('checks the blocklist against the caller and the observed address', async () => {
      await service.submitSession({}, caller);
      await settle();
      expect(stubs.isBlocked.firstCall.args[0]).to.equal('zelid1');
      expect(stubs.isBlocked.firstCall.args[1]).to.equal('1.2.3.4');
    });
  });

  describe('one session at a time', () => {
    it('refuses a second session while one is live', async () => {
      // A run that never settles, so the first session stays live.
      stubs.runSession.returns(new Promise(() => {}));
      await service.submitSession({}, caller);

      let threw = null;
      await service.submitSession({}, { fluxId: 'zelid2', sourceIp: '5.6.7.8' }).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('busy');
      expect(threw.message).to.include('already running');
    });

    it('frees the slot once the session finishes', async () => {
      await service.submitSession({}, caller);
      await settle();
      expect(sessionRegistry.size()).to.equal(0);

      const second = await service.submitSession({}, { fluxId: 'zelid2', sourceIp: '5.6.7.8' });
      expect(second.sessionId).to.match(/^op_/);
      await settle();
    });
  });

  // A name is a lease — it says which app holds it right now, and an expiry
  // hands it to whoever registers it next. Everything a session leaves on the
  // node can outlive the session, so none of it is named after the spec.
  describe('session identity', () => {
    it('names nothing after the spec, so an installed app of that name is no obstacle', async () => {
      service = load({ installed: [{ name: 'demoapp' }] });
      const handle = await service.submitSession({}, caller);
      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });

    it('builds the deployment against the session, never against the app name', async () => {
      await service.submitSession({}, caller);
      const [, , opts] = stubs.fromSpec.firstCall.args;
      expect(opts.identity).to.match(/^pg-[0-9a-f]{12}$/);
      expect(opts.identity).to.not.include('demoapp');
      await settle();
    });

    // The reservation key is the defect this closes: admission is keyed by name
    // and an install reserves under the app's, so a session reserving under the
    // spec's name is overwritten by a same-named install and then deleted by its
    // release — the session's capacity silently stops being counted while its
    // containers run.
    it('reserves capacity under the session, not the app name', async () => {
      const handle = await service.submitSession({}, caller);
      expect(stubs.reserve.firstCall.args[0]).to.equal(handle.sessionId);
      expect(stubs.reserve.firstCall.args[0]).to.not.equal('demoapp');
      await settle();
    });

    // The identity has to exist before the spec is built against it, which is
    // earlier than the job used to be registered. The poll handle is still the
    // same id, so a caller sees one number.
    it('polls under the same id the session was built against', async () => {
      const handle = await service.submitSession({}, caller);
      expect(handle.jobId).to.equal(handle.sessionId);
      expect(handle.statusUrl).to.include(handle.sessionId);
      expect(service.getSession(handle.sessionId, caller.fluxId)).to.not.equal(null);
      await settle();
    });
  });

  describe('teardown', () => {
    it('tears the session down when the run finishes', async () => {
      await service.submitSession({}, caller);
      await settle();
      expect(stubs.teardownSession.calledOnce).to.equal(true);
    });

    // Every way a session can end has to leave the node in the same state, so a
    // failed run must destroy its containers exactly as a successful one does.
    it('tears the session down when the run fails', async () => {
      service = load();
      stubs.runSession.rejects(new Error('image refused'));
      await service.submitSession({}, caller);
      await settle();
      expect(stubs.teardownSession.calledOnce).to.equal(true);
      expect(sessionRegistry.size()).to.equal(0);
    });

    it('releases the capacity reservation on teardown', async () => {
      await service.submitSession({}, caller);
      await settle();
      expect(stubs.release.calledWith(stubs.reserve.firstCall.args[0])).to.equal(true);
    });

    it('writes the audit record once the verdict is known', async () => {
      await service.submitSession({}, caller);
      await settle();
      expect(stubs.audit.calledOnce).to.equal(true);
      expect(stubs.audit.firstCall.args[0].verdict).to.equal('passed');
    });

    // A cancel is the outcome the caller asked for, so it is its own terminal
    // state - not an error the spec caused.
    it('records a cancel as cancelled rather than as a failure', async () => {
      service = load();
      stubs.runSession.rejects(Object.assign(new Error('The session was cancelled.'), { kind: 'cancelled' }));

      await service.submitSession({}, caller);
      await settle();

      expect(stubs.audit.firstCall.args[0].verdict).to.equal('cancelled');
      expect(stubs.teardownSession.calledOnce).to.equal(true);
      expect(sessionRegistry.size()).to.equal(0);
    });

    it('records a failed verdict when a component does not pass its probe', async () => {
      service = load();
      stubs.runSession.resolves({ web: { probe: { passed: false } } });
      await service.submitSession({}, caller);
      await settle();
      expect(stubs.audit.firstCall.args[0].verdict).to.equal('failed');
    });
  });

  describe('sessionDetail', () => {
    it('states what a pass does not prove', () => {
      const detail = service.sessionDetail({
        sessionId: 'op_1', appName: 'demoapp', results: {}, startedAt: Date.now(), finished: false,
      });
      expect(detail.doesNotProve).to.include('syncthing');
      expect(detail.doesNotProve).to.include('load balancing');
      expect(detail.proves).to.include('declares');
    });
  });
});
