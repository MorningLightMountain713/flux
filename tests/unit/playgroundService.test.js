const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// RFC 5737 documentation ranges: a balancer, a customer behind it, and a caller
// that reaches the node directly.
const BALANCER = '203.0.113.7';
const CLIENT = '198.51.100.23';
const DIRECT = '192.0.2.55';

// The real resolution logic with a controlled balancer list. A factory because
// every proxyquire map of playgroundService needs it: left out of one, the real
// module loads and drags its flux-spec loader in with it.
function resolver(fdmAddresses = [BALANCER]) {
  return proxyquire.load('../../ZelBack/src/services/utils/ingressCapture', {
    config: { fdmAddresses },
    './specLibs': { getSpecBackend: async () => ({}) },
  });
}

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
      isArcane: sinon.stub().returns(opts.arcane ?? true),
      servesLocalNode: sinon.stub().resolves(
        opts.serves === false
          ? { serves: false, candidates: ['10.0.0.9:16127', '10.0.0.8:16127'] }
          : { serves: true, candidates: [] },
      ),
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
      wakeIdleLoop: sinon.stub(),
      captureIngress: sinon.stub().resolves({ observed: { ip: '1.2.3.4', port: 5000 }, asserted: {} }),
      servingSet: sinon.stub().resolves(opts.servingSet ?? []),
      // The fleet-wide tally seam. Mirrors the real shape: a verdict plus the token
      // and the node that issued it, because the teardown has to return it there.
      fleetReserve: sinon.stub().resolves(opts.fleet ?? {
        allowed: true, token: 'fleet-token-1', at: 'counter', reason: null,
      }),
      fleetRelease: sinon.stub().resolves(),
      fleetAnnounce: sinon.stub().resolves(),
      windowIndex: sinon.stub().returns(20347),
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
      '../utils/ingressCapture': resolver(opts.fdmAddresses),
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
      },
      '../messageHelper': {
        createErrorMessage: (m) => ({ status: 'error', data: { message: m } }),
        errUnauthorizedMessage: () => ({ status: 'error', data: { message: 'Unauthorized' } }),
        createDataMessage: (d) => ({ status: 'success', data: d }),
      },
      '../serviceHelper': { ensureObject: (o) => o },
      '../verificationHelper': { verifyPrivilege: sinon.stub().resolves(opts.authorized ?? true) },
      '../utils/globalState': { isArcane: stubs.isArcane },
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
      // hourly:false swaps in a limiter that always refuses, so a refusal lands
      // AFTER the fleet slot has been taken - the window a release has to cover.
      './playgroundLimits': opts.hourly === false
        ? { ...limits, consumeSessionSlot: () => ({ allowed: false, scope: 'caller', retryAfterMs: 1000, message: 'over' }) }
        : limits,
      './playgroundRunner': {
        runSession: stubs.runSession,
        teardownSession: stubs.teardownSession,
        reapOrphans: stubs.reapOrphans,
      },
      './playgroundSessionRegistry': sessionRegistry,
      '../utils/limitCounter': {
        reserve: stubs.fleetReserve,
        release: stubs.fleetRelease,
        announce: stubs.fleetAnnounce,
      },
      './playgroundServingSet': {
        servesLocalNode: stubs.servesLocalNode,
        servingSet: stubs.servingSet,
        windowIndex: stubs.windowIndex,
      },
      './playgroundAudit': {
        record: stubs.audit,
        captureIngress: stubs.captureIngress,
        findFlaggedSince: stubs.findFlaggedSince,
      },
      './playgroundAbuse': { isBlocked: stubs.isBlocked },
      '../appLifecycle/appSpawner': { wakeIdleLoop: stubs.wakeIdleLoop },
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

    // The only control here a simultaneous fan-out cannot outrun. Everything
    // else is enforced from a gossiped record, so every other control has a
    // window in which every node independently says yes to the same caller.
    it('refuses a caller this node does not serve, and says where to go', async () => {
      service = load({ serves: false });
      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });

      expect(threw.kind).to.equal('busy');
      // the refusal names URLs for the same reason the endpoint does
      expect(threw.message).to.include('https://10-0-0-9-16127.node.api.runonflux.io');
    });

    it('decides that before reading anything else about the caller', async () => {
      service = load({ serves: false });
      await service.submitSession({}, caller).catch(() => {});
      expect(stubs.isBlocked.called, 'no DB read for a caller this node never serves').to.equal(false);
      expect(stubs.validateSpec.called, 'and no spec validation either').to.equal(false);
    });

    // A session is the one thing this node runs for a stranger, and what contains
    // it is the Arcane environment: the systemd slice its load is capped in, the
    // managed iptables its egress policy is written into, the tc rules that cap
    // its bandwidth. Without them the containment is absent, not weaker.
    it('refuses on a node that is not Arcane, whatever its tier', async () => {
      service = load({ arcane: false, tier: 'stratus' });
      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('ineligible');
      expect(threw.message).to.include('ArcaneOS');
    });

    // isArcane() reads a verdict that is null until resolved, and null is not
    // true — so a node that has not yet decided refuses, which is the safe
    // direction. Checked before the tier because it is a local read.
    it('decides Arcane before asking for the tier at all', async () => {
      service = load({ arcane: false });
      await service.submitSession({}, caller).catch(() => {});
      expect(stubs.tier.called, 'never went looking for the tier').to.equal(false);
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
        '../utils/globalState': { isArcane: stubs.isArcane },
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
        '../utils/ingressCapture': resolver(),
        './playgroundLimits': refusing,
        './playgroundRunner': { runSession: stubs.runSession, teardownSession: stubs.teardownSession, reapOrphans: stubs.reapOrphans },
        './playgroundSessionRegistry': sessionRegistry,
      '../utils/limitCounter': {
        reserve: stubs.fleetReserve,
        release: stubs.fleetRelease,
        announce: stubs.fleetAnnounce,
      },
      './playgroundServingSet': {
        servesLocalNode: stubs.servesLocalNode,
        servingSet: stubs.servingSet,
        windowIndex: stubs.windowIndex,
      },
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

  // A session is free, interruptible work. When paid work cannot otherwise fit,
  // the node asks for the capacity back rather than refusing the paid app — a
  // refusal benches its hash in the spawner's error cache for seven days.
  describe('reclaiming capacity for paid work', () => {
    const jobRegistry = require('../../ZelBack/src/services/utils/jobRegistry');

    it('ends a live session and gives its capacity back', async () => {
      const handle = await service.submitSession({}, caller);
      await settle();
      sessionRegistry.add({
        sessionId: handle.sessionId,
        appName: 'demoapp',
        startedAt: Date.now(),
        reserved: true,
        finished: false,
        deployment: { resourceTotals: () => totals() },
        results: {},
      });

      const ended = await service.reclaimFor({ cpu: 1, memoryMb: 1024, hostDiskGb: 4 });

      expect(ended).to.equal(1);
      expect(stubs.teardownSession.called).to.equal(true);
    });

    // Eviction is NOT a cancel and must not report as one. The owner asked for a
    // session and the node took it away; a cancel would tell them they stopped
    // it themselves, and a failure would tell them their spec was at fault.
    it('reports its own terminal state, not a cancel and not a failure', async () => {
      // A job of its own rather than one from submitSession, whose run settles on
      // its own and would reach a terminal state first — evicted() will not
      // overwrite one, which is the correct behaviour and not what this asserts.
      const handle = jobRegistry.start({ kind: 'playground', owner: caller.fluxId });
      const session = {
        sessionId: handle.jobId,
        appName: 'demoapp',
        startedAt: Date.now(),
        reserved: true,
        finished: false,
        deployment: { resourceTotals: () => totals() },
        results: {},
      };
      sessionRegistry.add(session);

      await service.reclaimFor({ cpu: 1, memoryMb: 1024, hostDiskGb: 4 });

      const job = jobRegistry.get(handle.jobId, caller.fluxId);
      expect(job.status).to.equal(jobRegistry.JobStatus.EVICTED);
      expect(job.status).to.not.equal(jobRegistry.JobStatus.CANCELED);
      expect(job.status).to.not.equal(jobRegistry.JobStatus.FAILED);
      // And it says why, because this is the one outcome the owner had no part in.
      expect(job.error.detail).to.include('paid application');
      expect(session.verdict).to.equal('evicted');
      await settle();
    });

    it('stops as soon as enough has been freed, rather than clearing the node', async () => {
      const make = (id, startedAt) => ({
        sessionId: id,
        appName: 'demoapp',
        startedAt,
        reserved: true,
        finished: false,
        deployment: { resourceTotals: () => totals() },
        results: {},
      });
      // Oldest first: that session has had the most of what it came for.
      sessionRegistry.add(make('op_old', 1000));
      sessionRegistry.add(make('op_new', 2000));

      const ended = await service.reclaimFor({ cpu: 1, memoryMb: 1024, hostDiskGb: 4 });

      expect(ended).to.equal(1);
      expect(sessionRegistry.get('op_new'), 'the newer session survives').to.not.equal(null);
    });

    it('wakes the spawn loop, so the deferred install retries now rather than in five minutes', async () => {
      sessionRegistry.add({
        sessionId: 'op_x',
        appName: 'demoapp',
        startedAt: Date.now(),
        reserved: true,
        finished: false,
        deployment: { resourceTotals: () => totals() },
        results: {},
      });

      await service.reclaimFor({ cpu: 1, memoryMb: 1024, hostDiskGb: 4 });

      expect(stubs.wakeIdleLoop.calledOnce).to.equal(true);
    });

    it('does nothing, and wakes nothing, when there is no session to end', async () => {
      const ended = await service.reclaimFor({ cpu: 1, memoryMb: 1024, hostDiskGb: 4 });

      expect(ended).to.equal(0);
      expect(stubs.wakeIdleLoop.called).to.equal(false);
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

  describe('the fleet-wide tally', () => {
    it('refuses when the caller is already at their fleet allowance', async () => {
      // The only control that knows what the caller is doing on OTHER nodes.
      // Everything else caps what this node gives away and is identity-blind
      // across the fleet.
      service = load({ fleet: { allowed: false, token: null, at: 'counter', reason: 'concurrent' } });
      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });

      expect(threw.kind).to.equal('busy');
      expect(threw.message).to.include('allowance');
    });

    it('refuses rather than admitting when the tally cannot be reached', async () => {
      // Letting a caller through because the tally is unreachable would make
      // taking it down the way to remove the limit.
      service = load({ fleet: { allowed: false, token: null, at: null, reason: 'counterUnreachable' } });
      let threw = null;
      await service.submitSession({}, caller).catch((e) => { threw = e; });

      expect(threw.kind).to.equal('busy');
      expect(threw.message).to.include('cannot be reached');
    });

    it('asks before anything is built', async () => {
      service = load({ fleet: { allowed: false, token: null, at: 'counter', reason: 'concurrent' } });
      await service.submitSession({}, caller).catch(() => {});

      expect(stubs.runSession.called, 'nothing ran').to.be.false;
    });

    it('gives the slot back when a later check refuses the session', async () => {
      // The fleet slot is taken before the per-node hourly window is charged. A
      // refusal after that point must return it, or the caller loses an allowance
      // for a session that never ran.
      service = load({ hourly: false });
      await service.submitSession({}, caller).catch(() => {});

      sinon.assert.calledOnce(stubs.fleetRelease);
    });

    it('returns the slot to the node that issued it', async () => {
      // A release sent to the wrong node frees nothing and leaves the real slot
      // held until its lease expires, so the issuing node travels with the token.
      service = load({ fleet: { allowed: true, token: 'tok-9', at: 'deputy', reason: null }, hourly: false });
      await service.submitSession({}, caller).catch(() => {});

      sinon.assert.calledWithExactly(
        stubs.fleetRelease, 'playground', 'identity', caller.fluxId, 'tok-9', 'deputy',
      );
    });
  });

  describe('servingSetAPI', () => {
    function resSpy() {
      const captured = { code: 200, body: null };
      return {
        captured,
        status(code) { captured.code = code; return this; },
        json(body) { captured.body = body; return body; },
      };
    }

    it('answers for the caller in the auth header, never a parameter', async () => {
      // No input to validate and no way to ask about another identity: the set is
      // derived from whoever is authenticated.
      const svc = load({ servingSet: [{ ip: '1.1.1.1:16127' }, { ip: '2.2.2.2:16127' }] });
      const res = resSpy();

      // A parameter and a query naming a DIFFERENT identity are both offered, and
      // both must be ignored: reading either would turn this into an enumeration
      // of any FluxID's set.
      await svc.servingSetAPI({
        headers: { zelidauth: { zelid: '1CallerZelId' } },
        params: { zelid: '1SomeoneElse' },
        query: { zelid: '1SomeoneElse' },
      }, res);

      expect(res.captured.code).to.equal(200);
      expect(res.captured.body.status).to.equal('success');
      // URLs, not bare addresses: a node serves its API under a certificate for its
      // *.node.api.runonflux.io name, so an address is not somewhere a client can go
      expect(res.captured.body.data.nodes).to.deep.equal([
        'https://1-1-1-1-16127.node.api.runonflux.io',
        'https://2-2-2-2-16127.node.api.runonflux.io',
      ]);
      sinon.assert.calledOnceWithExactly(stubs.servingSet, '1CallerZelId');
    });

    it('reports the window the answer belongs to', async () => {
      // The set rotates, so a cached answer needs to say which window it is from.
      const svc = load({ servingSet: [{ ip: '1.1.1.1:16127' }] });
      const res = resSpy();

      await svc.servingSetAPI({ headers: { zelidauth: { zelid: '1CallerZelId' } }, params: {} }, res);

      expect(res.captured.body.data.window).to.equal(20347);
    });

    it('drops a node the list carries with no address', async () => {
      const svc = load({ servingSet: [{ ip: '1.1.1.1:16127' }, { ip: null }] });
      const res = resSpy();

      await svc.servingSetAPI({ headers: { zelidauth: { zelid: '1CallerZelId' } }, params: {} }, res);

      expect(res.captured.body.data.nodes).to.deep.equal(['https://1-1-1-1-16127.node.api.runonflux.io']);
    });

    it('refuses an unauthenticated caller', async () => {
      const svc = load({ authorized: false });
      const res = resSpy();

      await svc.servingSetAPI({ headers: {}, params: {} }, res);

      expect(res.captured.code).to.equal(401);
      expect(stubs.servingSet.called).to.be.false;
    });

    it('refuses a caller whose auth header carries no FluxID', async () => {
      // verifyPrivilege passing but no zelid would otherwise compute a set for
      // `null` and hand it back as if it meant something.
      const svc = load({});
      const res = resSpy();

      await svc.servingSetAPI({ headers: { zelidauth: {} }, params: {} }, res);

      expect(res.captured.code).to.equal(401);
      expect(stubs.servingSet.called).to.be.false;
    });

    it('answers 503 rather than throwing when the set cannot be computed', async () => {
      const svc = load({});
      stubs.servingSet.rejects(new Error('node list unavailable'));
      const res = resSpy();

      await svc.servingSetAPI({ headers: { zelidauth: { zelid: '1CallerZelId' } }, params: {} }, res);

      expect(res.captured.code).to.equal(503);
      expect(res.captured.body.status).to.equal('error');
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

  // The abuse controls key on `fluxId|sourceIp`. A browser reaches a node
  // through FDM, so if sourceIp is the socket peer it is the SAME balancer for
  // every customer, both keys collapse to the FluxID, and the per-address half
  // of each control stops existing. These assert on what isBlocked is keyed
  // with, because that is a control rather than a record.
  describe('submitSessionAPI - the address the controls are keyed on', () => {
    function fakeReq({ peer, forwardedFor } = {}) {
      const headers = { zelidauth: { zelid: 'zelid1' } };
      if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
      return { headers, socket: { remoteAddress: peer }, body: {} };
    }

    function fakeRes() {
      const res = { statusCode: null, payload: null };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (payload) => { res.payload = payload; return res; };
      res.setHeader = () => {};
      return res;
    }

    it('keys on the customer behind the balancer, not the balancer', async () => {
      await service.submitSessionAPI(
        fakeReq({ peer: BALANCER, forwardedFor: CLIENT }),
        fakeRes(),
      );
      await settle();

      expect(stubs.isBlocked.calledOnce).to.equal(true);
      expect(stubs.isBlocked.firstCall.args[1]).to.equal(CLIENT);
    });

    it('gives two customers behind one balancer two different keys', async () => {
      const other = '198.51.100.24';
      await service.submitSessionAPI(fakeReq({ peer: BALANCER, forwardedFor: CLIENT }), fakeRes());
      await settle();
      await service.submitSessionAPI(fakeReq({ peer: BALANCER, forwardedFor: other }), fakeRes());
      await settle();

      const keyed = stubs.isBlocked.getCalls().map((call) => call.args[1]);
      expect(keyed).to.deep.equal([CLIENT, other]);
    });

    it('ignores the header when the peer is not a balancer', async () => {
      await service.submitSessionAPI(
        fakeReq({ peer: DIRECT, forwardedFor: CLIENT }),
        fakeRes(),
      );
      await settle();

      // A direct caller writes whatever it likes into the header; every node is
      // reachable, so an unrecognised peer's claim is worth nothing.
      expect(stubs.isBlocked.firstCall.args[1]).to.equal(DIRECT);
    });

    it('leaves the sealed ingress record unresolved', async () => {
      await service.submitSessionAPI(
        fakeReq({ peer: BALANCER, forwardedFor: CLIENT }),
        fakeRes(),
      );
      await settle();

      // The record is signed and gossiped, so a conclusion drawn from this
      // node's own balancer list must not enter it - two nodes with different
      // lists would sign different answers for one request.
      const [session] = stubs.audit.firstCall.args;
      expect(session.ingress.observed.ip).to.equal('1.2.3.4');
      expect(session.ingress).to.not.have.property('resolved');
    });
  });
});
