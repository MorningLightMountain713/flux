'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const { loadSpecLibrary, V9_SUBMISSION, assertAnswers } = require('./fixtures/fluxSpec');

// The real submission validator, spied rather than replaced. The playground's
// intake IS flux-spec's own validation - the same call the registration gate
// makes, with a different question - so a double of it would let this suite
// admit specs no node will ever accept, and let the SESSION purpose stop
// meaning anything.
const specLibs = require('../../ZelBack/src/services/utils/specLibs');

// RFC 5737 documentation ranges: a balancer, a customer behind it, and a caller
// that reaches the node directly.
const BALANCER = '203.0.113.7';
const CLIENT = '198.51.100.23';
const DIRECT = '192.0.2.55';

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

/**
 * A shallow copy without the named keys. Deliberately a delete rather than
 * `key: undefined`: a key that is present holding undefined is not the same
 * input to a schema validator as a key that is absent, and this file leans on
 * exactly that difference.
 */
function without(source, ...keys) {
  const copy = { ...source };
  keys.forEach((key) => { delete copy[key]; });
  return copy;
}

// The spec every session in this file submits. Derived from the shared v9
// submission with the two changes a playground session forces:
//
//   - no `instances`. A session is one copy on one node, which is precisely the
//     placement family SESSION-purpose validation drops. REGISTRATION refuses
//     this same blob, and a test below proves it - that difference is the whole
//     reason the purpose argument exists, and no hand-written validator double
//     could express it.
//   - no persistent storage. A session keeps nothing, so the ceiling refuses
//     any; the shared fixture declares 5 GB and is used unchanged below to
//     prove the ceiling still says so.
//
// The resources are ones the real schema accepts. `memory` must be a multiple
// of 100, so the 1024 MB the previous hand-written totals reported was a number
// no node would ever have validated.
const SUBMISSION = {
  ...without(V9_SUBMISSION, 'instances'),
  name: 'demoapp',
  components: {
    web: {
      ...without(V9_SUBMISSION.components.web, 'persistentStorage'),
      cpu: 1,
      memory: 1000,
      rootFsGb: 4,
    },
  },
};

// Over the session ceiling on CPU (2 cores) and nothing else, so the refusal
// can only be the ceiling's.
const OVERSIZED = {
  ...SUBMISSION,
  components: { web: { ...SUBMISSION.components.web, cpu: 8 } },
};

// The shared fixture's component unchanged: 5 GB of persistent storage, which
// the library validates happily and the session ceiling refuses.
const KEEPS_STORAGE = { ...SUBMISSION, components: V9_SUBMISSION.components };

// The real registry: the concurrency gate and the janitor's protection both read
// it, so stubbing it would hide the thing several of these tests are about.
const sessionRegistry = require('../../ZelBack/src/services/appPlayground/playgroundSessionRegistry');

describe('playgroundService', () => {
  let stubs;
  let service;
  let limits;
  // The real flux-spec namespace, loaded once. Every spec and deployment in
  // this file is built by it.
  let flux;
  // A real DeploymentSpec, for the sessions that are put straight into the
  // registry rather than submitted.
  let deployment;
  // Real ResourceTotals, standing in for the paid app that needs the room back.
  let paidWork;

  // The real resolution logic with a controlled balancer list. A factory because
  // every proxyquire map of playgroundService needs it: left out of one, the real
  // module loads and drags its flux-spec loader in with it.
  function resolver(fdmAddresses = [BALANCER]) {
    return proxyquire.load('../../ZelBack/src/services/utils/ingressCapture', {
      config: { fdmAddresses },
      './specLibs': { getSpecBackend: async () => flux },
    });
  }

  /** A real DeploymentSpec, built the way playgroundService builds one. */
  async function buildDeployment(submission = SUBMISSION, identity = 'pg-000000000000') {
    const spec = await specLibs.validateSubmissionSpec(
      submission, { purpose: flux.ValidationPurpose.SESSION },
    );
    return flux.DeploymentSpec.fromSpec(spec, '/tmp/apps/', { replica: null, identity });
  }

  before(async () => {
    flux = await loadSpecLibrary();
    deployment = await buildDeployment();
    paidWork = deployment.resourceTotals();
  });

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
      // A spy over the real validator, not a double of it: the tests below read
      // what the service asked, and the answer is whatever flux-spec really
      // returns for that submission - a FluxAppSpecV9, or a throw.
      validateSpec: sinon.stub().callsFake(
        (raw, options) => specLibs.validateSubmissionSpec(raw, options),
      ),
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
      '../utils/jobRegistry': require('../../ZelBack/src/services/utils/jobRegistry'),
      '../appManagement/operationsController': {
        accepted: (res, handle, extra) => res.status(202).json({ ...handle, ...extra }),
      },
      '../utils/specLibs': {
        validateSubmissionSpec: stubs.validateSpec,
        // The real library. DeploymentSpec.fromSpec is what turns the validated
        // spec into the object every collaborator below is handed, so it is the
        // one place where a double would be both invisible and total.
        getSpecBackend: async () => flux,
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

  /** A session record the registry can hold, carrying a real DeploymentSpec. */
  function liveSession(sessionId, startedAt = Date.now()) {
    return {
      sessionId,
      appName: deployment.appName,
      startedAt,
      reserved: true,
      finished: false,
      deployment,
      results: {},
    };
  }

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
  describe('spec intake', () => {
    it('asks the SESSION validation question and fabricates nothing', async () => {
      const rawSpec = { ...SUBMISSION };
      await service.submitSession(rawSpec, caller);
      const [sentSpec, options] = stubs.validateSpec.firstCall.args;
      expect(options.purpose, 'a session is one copy on one node').to.equal(flux.ValidationPurpose.SESSION);
      expect(sentSpec, 'the submission passes through untouched').to.deep.equal(rawSpec);
      expect(sentSpec.instances, 'no invented value enters any record').to.equal(undefined);
      await settle();
    });

    it('accepts a spec a registration would refuse, because a session is not a registration', async () => {
      // The submission declares no `instances`, which REGISTRATION requires and
      // SESSION has no use for. Both questions are asked of the same real
      // validator here, so the purpose is load-bearing rather than a string
      // this suite passes around.
      const handle = await service.submitSession(SUBMISSION, caller);
      expect(handle.sessionId).to.match(/^op_/);

      let threw = null;
      await specLibs.validateSubmissionSpec(SUBMISSION, { purpose: flux.ValidationPurpose.REGISTRATION })
        .catch((error) => { threw = error; });
      expect(threw, 'the same blob is not a registration').to.not.equal(null);
      expect(threw.message).to.include('instances');
      await settle();
    });

    it('refuses a spec the library will not accept, before anything is built', async () => {
      // A name no v9 app may hold. The refusal is the library's, not this
      // suite's idea of one.
      let threw = null;
      await service.submitSession({ ...SUBMISSION, name: 'fluxdemo' }, caller).catch((error) => { threw = error; });

      expect(threw.message).to.include('flux');
      expect(stubs.reserve.called, 'nothing was reserved for a spec that never validated').to.equal(false);
      expect(stubs.runSession.called).to.equal(false);
    });
  });

  describe('collecting debris before a new session', () => {
    it('reaps abandoned containers before the session claims anything', async () => {
      await service.submitSession(SUBMISSION, caller);

      expect(stubs.reapOrphans.calledOnce).to.equal(true);
      expect(stubs.reapOrphans.calledBefore(stubs.runSession)).to.equal(true);
      await settle();
    });

    it('starts the session anyway when the check itself fails', async () => {
      // A docker that cannot list containers will fail this session a few steps
      // further on, with a better message than this could give.
      stubs.reapOrphans.rejects(new Error('docker unreachable'));

      const handle = await service.submitSession(SUBMISSION, caller);

      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });
  });

  describe('eligibility', () => {
    it('accepts a session on a nimbus node', async () => {
      const handle = await service.submitSession(SUBMISSION, caller);
      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });

    it('accepts a session on a stratus node', async () => {
      service = load({ tier: 'stratus' });
      const handle = await service.submitSession(SUBMISSION, caller);
      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });

    // Cumulus is 4 cores / 7 GB, where a 2-core guest is real load competing
    // with the apps the operator is actually paid to run.
    it('refuses a session on a cumulus node, and names the tier', async () => {
      service = load({ tier: 'cumulus' });
      let threw = null;
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('ineligible');
      expect(threw.message).to.include('cumulus');
    });

    // The only control here a simultaneous fan-out cannot outrun. Everything
    // else is enforced from a gossiped record, so every other control has a
    // window in which every node independently says yes to the same caller.
    it('refuses a caller this node does not serve, and says where to go', async () => {
      service = load({ serves: false });
      let threw = null;
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });

      expect(threw.kind).to.equal('busy');
      // the refusal names URLs for the same reason the endpoint does
      expect(threw.message).to.include('https://10-0-0-9-16127.node.api.runonflux.io');
    });

    it('decides that before reading anything else about the caller', async () => {
      service = load({ serves: false });
      await service.submitSession(SUBMISSION, caller).catch(() => {});
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
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('ineligible');
      expect(threw.message).to.include('ArcaneOS');
    });

    // isArcane() reads a verdict that is null until resolved, and null is not
    // true — so a node that has not yet decided refuses, which is the safe
    // direction. Checked before the tier because it is a local read.
    it('decides Arcane before asking for the tier at all', async () => {
      service = load({ arcane: false });
      await service.submitSession(SUBMISSION, caller).catch(() => {});
      expect(stubs.tier.called, 'never went looking for the tier').to.equal(false);
    });

    // Assuming a node is big enough puts guest containers on exactly the nodes
    // least able to absorb them - the outcome the tier rule exists to prevent.
    it('refuses when the tier cannot be read at all', async () => {
      service = load();
      stubs.tier.rejects(new Error('daemon down'));
      let threw = null;
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('ineligible');
    });
  });

  describe('admission', () => {
    it('requires an authenticated FluxID', async () => {
      let threw = null;
      await service.submitSession(SUBMISSION, { sourceIp: '1.2.3.4' }).catch((e) => { threw = e; });
      expect(threw.message).to.include('FluxID');
    });

    it('refuses a spec over the session ceiling and says every node agrees', async () => {
      let threw = null;
      await service.submitSession(OVERSIZED, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('rejected');
      // the numbers the owner has to change, read off the real spec
      expect(threw.message).to.include('8 CPU cores');
      expect(threw.message).to.include('Every node applies the same session ceiling');
    });

    // A session keeps nothing, so storage it could write to is storage the node
    // has to reclaim. The library accepts this spec - it is the shared fixture
    // unchanged - and the ceiling is what refuses it.
    it('refuses a spec that asks the node to keep something', async () => {
      let threw = null;
      await service.submitSession(KEEPS_STORAGE, caller).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('rejected');
      expect(threw.message).to.include('5 GB of persistent storage');
    });

    it('refuses when the node has no capacity right now', async () => {
      service = load({ shortfall: 'Not enough cpu' });
      let threw = null;
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });
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
      await service.submitSession(SUBMISSION, caller).catch(() => {});
      await service.submitSession(SUBMISSION, caller).catch(() => {});
      await service.submitSession(SUBMISSION, caller).catch(() => {});

      // The caller's allowance is 3 and the node's is 2. If any of those three
      // refusals had charged either window, this fourth attempt is refused.
      stubs.capacityShortfall.returns(null);
      const handle = await service.submitSession(SUBMISSION, caller);
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
        '../utils/jobRegistry': require('../../ZelBack/src/services/utils/jobRegistry'),
        '../appManagement/operationsController': { accepted: (res, h) => h },
        '../utils/specLibs': {
          validateSubmissionSpec: stubs.validateSpec,
          getSpecBackend: async () => flux,
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
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });
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
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });

      expect(threw.kind).to.equal('busy');
      expect(stubs.validateSpec.called).to.equal(false);
      expect(stubs.runSession.called).to.equal(false);
    });

    // Naming the signal would tell someone grinding at this exactly which of
    // the three to defeat.
    it('does not say why it refused', async () => {
      service = load({ blocked: true });

      let threw = null;
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });

      expect(threw.message).to.not.match(/cpu|mining|miner|flag/i);
      expect(threw.message).to.include('another node');
    });

    it('checks the blocklist against the caller and the observed address', async () => {
      await service.submitSession(SUBMISSION, caller);
      await settle();
      expect(stubs.isBlocked.firstCall.args[0]).to.equal('zelid1');
      expect(stubs.isBlocked.firstCall.args[1]).to.equal('1.2.3.4');
    });
  });

  describe('one session at a time', () => {
    it('refuses a second session while one is live', async () => {
      // A run that never settles, so the first session stays live.
      stubs.runSession.returns(new Promise(() => {}));
      await service.submitSession(SUBMISSION, caller);

      let threw = null;
      await service.submitSession(SUBMISSION, { fluxId: 'zelid2', sourceIp: '5.6.7.8' }).catch((e) => { threw = e; });
      expect(threw.kind).to.equal('busy');
      expect(threw.message).to.include('already running');
    });

    it('frees the slot once the session finishes', async () => {
      await service.submitSession(SUBMISSION, caller);
      await settle();
      expect(sessionRegistry.size()).to.equal(0);

      const second = await service.submitSession(SUBMISSION, { fluxId: 'zelid2', sourceIp: '5.6.7.8' });
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
      const handle = await service.submitSession(SUBMISSION, caller);
      expect(handle.sessionId).to.match(/^op_/);
      await settle();
    });

    it('builds the deployment against the session, never against the app name', async () => {
      await service.submitSession(SUBMISSION, caller);
      // The deployment the real DeploymentSpec built, read back off the
      // reservation it was handed to.
      const [, handed] = stubs.reserve.firstCall.args;

      expect(handed.identity).to.match(/^pg-[0-9a-f]{12}$/);
      expect(handed.identity).to.not.include('demoapp');
      // And it is the identity the class actually built the container names
      // from - the names are what outlive a failed teardown.
      expect(handed.getComponent('web').identifier).to.equal(`web_${handed.identity}`);
      expect(handed.networkName).to.include(handed.identity);
      expect(handed.networkName).to.not.include('demoapp');
      // The owner's own name survives for display and the audit record.
      expect(handed.appName).to.equal('demoapp');
      await settle();
    });

    // The reservation key is the defect this closes: admission is keyed by name
    // and an install reserves under the app's, so a session reserving under the
    // spec's name is overwritten by a same-named install and then deleted by its
    // release — the session's capacity silently stops being counted while its
    // containers run.
    it('reserves capacity under the session, not the app name', async () => {
      const handle = await service.submitSession(SUBMISSION, caller);
      expect(stubs.reserve.firstCall.args[0]).to.equal(handle.sessionId);
      expect(stubs.reserve.firstCall.args[0]).to.not.equal('demoapp');
      await settle();
    });

    // The identity has to exist before the spec is built against it, which is
    // earlier than the job used to be registered. The poll handle is still the
    // same id, so a caller sees one number.
    it('polls under the same id the session was built against', async () => {
      const handle = await service.submitSession(SUBMISSION, caller);
      expect(handle.jobId).to.equal(handle.sessionId);
      expect(handle.statusUrl).to.include(handle.sessionId);
      expect(service.getSession(handle.sessionId, caller.fluxId)).to.not.equal(null);
      await settle();
    });
  });

  // Using the real classes is not sufficient on its own. Every collaborator in
  // this block stays stubbed, so nothing here exercises what the REAL one would
  // do with the object it was handed - a delegation could disappear from
  // flux-spec with this suite still green. So the argument is read back and
  // asked what the real collaborator asks it.
  describe('what the stubbed collaborators are handed', () => {
    it('hands admission a deployment it can price', async () => {
      await service.submitSession(SUBMISSION, caller);
      const [, handed] = stubs.reserve.firstCall.args;

      // admissionControl.reserve() calls exactly these two.
      assertAnswers(handed, ['resourceTotals', 'reservableHostDiskGb']);
      expect(handed.reservableHostDiskGb()).to.equal(handed.resourceTotals().hostDiskGb);
      await settle();
    });

    it('hands the capacity check totals it can read every dimension of', async () => {
      await service.submitSession(SUBMISSION, caller);
      const [, totals] = stubs.capacityShortfall.firstCall.args;

      // hwRequirements.capacityShortfall reads these as PROPERTIES, not
      // methods: hostDiskGb against available space, cpu*10 against available
      // cpu, memoryMb against available ram. A missing one compares undefined
      // and silently admits.
      expect(totals.hostDiskGb, 'capacityShortfall compares hostDiskGb').to.be.a('number');
      expect(totals.cpu, 'capacityShortfall compares cpu').to.be.a('number');
      expect(totals.memoryMb, 'capacityShortfall compares memoryMb').to.be.a('number');
      // burstHeadroomShortfall reads cpu off the same object.
      expect(stubs.burstShortfall.firstCall.args[1].cpu).to.be.a('number');
      await settle();
    });

    it('hands the runner a deployment it can walk in startup order', async () => {
      await service.submitSession(SUBMISSION, caller);
      const [session] = stubs.runSession.firstCall.args;

      // playgroundRunner maps every name in startupOrder to a component and
      // starts the container that component's identifier names.
      assertAnswers(session.deployment, ['allImages']);
      expect(session.deployment.startupOrder).to.deep.equal(['web']);
      const component = session.deployment.getComponent(session.deployment.startupOrder[0]);
      expect(component.identifier).to.be.a('string');
      expect(component.name).to.equal('web');
      await settle();
    });

    it('hands the teardown a deployment its component names still resolve against', async () => {
      await service.submitSession(SUBMISSION, caller);
      await settle();
      const [session] = stubs.teardownSession.firstCall.args;

      // teardownSession resolves each name in session.results back to a
      // component to read its final logs; the names it can see are the
      // deployment's own.
      assertAnswers(session.deployment, ['getComponent']);
      session.deployment.startupOrder.forEach((name) => {
        expect(session.deployment.getComponent(name), name).to.not.equal(undefined);
      });
    });

    it('hands the audit record the images the deployment actually names', async () => {
      await service.submitSession(SUBMISSION, caller);
      await settle();
      const [session] = stubs.audit.firstCall.args;

      // playgroundAudit seals session.images into the identifying half of the
      // record, so they have to be the real image references.
      expect(session.images).to.deep.equal(session.deployment.allImages());
      expect(session.images).to.deep.equal(['nginx:latest']);
    });
  });

  // A session is free, interruptible work. When paid work cannot otherwise fit,
  // the node asks for the capacity back rather than refusing the paid app — a
  // refusal benches its hash in the spawner's error cache for seven days.
  describe('reclaiming capacity for paid work', () => {
    const jobRegistry = require('../../ZelBack/src/services/utils/jobRegistry');

    it('ends a live session and gives its capacity back', async () => {
      const handle = await service.submitSession(SUBMISSION, caller);
      await settle();
      sessionRegistry.add(liveSession(handle.sessionId));

      const ended = await service.reclaimFor(paidWork);

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
      const session = liveSession(handle.jobId);
      sessionRegistry.add(session);

      await service.reclaimFor(paidWork);

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
      // Oldest first: that session has had the most of what it came for.
      sessionRegistry.add(liveSession('op_old', 1000));
      sessionRegistry.add(liveSession('op_new', 2000));

      const ended = await service.reclaimFor(paidWork);

      expect(ended).to.equal(1);
      expect(sessionRegistry.get('op_new'), 'the newer session survives').to.not.equal(null);
    });

    it('wakes the spawn loop, so the deferred install retries now rather than in five minutes', async () => {
      sessionRegistry.add(liveSession('op_x'));

      await service.reclaimFor(paidWork);

      expect(stubs.wakeIdleLoop.calledOnce).to.equal(true);
    });

    it('does nothing, and wakes nothing, when there is no session to end', async () => {
      const ended = await service.reclaimFor(paidWork);

      expect(ended).to.equal(0);
      expect(stubs.wakeIdleLoop.called).to.equal(false);
    });
  });

  describe('teardown', () => {
    it('tears the session down when the run finishes', async () => {
      await service.submitSession(SUBMISSION, caller);
      await settle();
      expect(stubs.teardownSession.calledOnce).to.equal(true);
    });

    // Every way a session can end has to leave the node in the same state, so a
    // failed run must destroy its containers exactly as a successful one does.
    it('tears the session down when the run fails', async () => {
      service = load();
      stubs.runSession.rejects(new Error('image refused'));
      await service.submitSession(SUBMISSION, caller);
      await settle();
      expect(stubs.teardownSession.calledOnce).to.equal(true);
      expect(sessionRegistry.size()).to.equal(0);
    });

    it('releases the capacity reservation on teardown', async () => {
      await service.submitSession(SUBMISSION, caller);
      await settle();
      expect(stubs.release.calledWith(stubs.reserve.firstCall.args[0])).to.equal(true);
    });

    it('writes the audit record once the verdict is known', async () => {
      await service.submitSession(SUBMISSION, caller);
      await settle();
      expect(stubs.audit.calledOnce).to.equal(true);
      expect(stubs.audit.firstCall.args[0].verdict).to.equal('passed');
    });

    // The terminal status is the claim "this session has stopped and its slot
    // is free" - the admission check that refuses a second session reads
    // exactly that slot. Settling before the teardown finishes opens a window
    // where a caller who waited for Cancelled is refused by the very session
    // they cancelled (gate 1001 t7+, the whole cascade).
    it('stays Running until the teardown has finished, then settles', async () => {
      const jobRegistry = require('../../ZelBack/src/services/utils/jobRegistry');
      service = load();
      stubs.runSession.rejects(Object.assign(new Error('The session was cancelled.'), { kind: 'cancelled' }));
      let releaseTeardown;
      stubs.teardownSession.callsFake(() => new Promise((resolve) => { releaseTeardown = resolve; }));

      const handle = await service.submitSession(SUBMISSION, caller);
      await settle();

      expect(sessionRegistry.get(handle.sessionId), 'slot still held mid-teardown').to.not.equal(null);
      expect(jobRegistry.get(handle.jobId, caller.fluxId).status, 'Cancelled would promise a slot the registry still refuses')
        .to.equal(jobRegistry.JobStatus.RUNNING);

      releaseTeardown([]);
      await settle();

      expect(sessionRegistry.get(handle.sessionId), 'slot freed once teardown finished').to.equal(null);
      expect(jobRegistry.get(handle.jobId, caller.fluxId).status).to.equal(jobRegistry.JobStatus.CANCELED);
    });

    // A cancel is the outcome the caller asked for, so it is its own terminal
    // state - not an error the spec caused.
    it('records a cancel as cancelled rather than as a failure', async () => {
      service = load();
      stubs.runSession.rejects(Object.assign(new Error('The session was cancelled.'), { kind: 'cancelled' }));

      await service.submitSession(SUBMISSION, caller);
      await settle();

      expect(stubs.audit.firstCall.args[0].verdict).to.equal('cancelled');
      expect(stubs.teardownSession.calledOnce).to.equal(true);
      expect(sessionRegistry.size()).to.equal(0);
    });

    it('records a failed verdict when a component does not pass its probe', async () => {
      service = load();
      stubs.runSession.resolves({ web: { probe: { passed: false } } });
      await service.submitSession(SUBMISSION, caller);
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
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });

      expect(threw.kind).to.equal('busy');
      expect(threw.message).to.include('allowance');
    });

    it('refuses rather than admitting when the tally cannot be reached', async () => {
      // Letting a caller through because the tally is unreachable would make
      // taking it down the way to remove the limit.
      service = load({ fleet: { allowed: false, token: null, at: null, reason: 'counterUnreachable' } });
      let threw = null;
      await service.submitSession(SUBMISSION, caller).catch((e) => { threw = e; });

      expect(threw.kind).to.equal('busy');
      expect(threw.message).to.include('cannot be reached');
    });

    it('asks before anything is built', async () => {
      service = load({ fleet: { allowed: false, token: null, at: 'counter', reason: 'concurrent' } });
      await service.submitSession(SUBMISSION, caller).catch(() => {});

      expect(stubs.runSession.called, 'nothing ran').to.be.false;
    });

    it('gives the slot back when a later check refuses the session', async () => {
      // The fleet slot is taken before the per-node hourly window is charged. A
      // refusal after that point must return it, or the caller loses an allowance
      // for a session that never ran.
      service = load({ hourly: false });
      await service.submitSession(SUBMISSION, caller).catch(() => {});

      sinon.assert.calledOnce(stubs.fleetRelease);
    });

    it('returns the slot to the node that issued it', async () => {
      // A release sent to the wrong node frees nothing and leaves the real slot
      // held until its lease expires, so the issuing node travels with the token.
      service = load({ fleet: { allowed: true, token: 'tok-9', at: 'deputy', reason: null }, hourly: false });
      await service.submitSession(SUBMISSION, caller).catch(() => {});

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
      // The caller, not a bare FluxID: the endpoint must answer on the same axis
      // admission will judge the session by, or it names nodes that then refuse.
      sinon.assert.calledOnceWithExactly(stubs.servingSet, { fluxId: '1CallerZelId', sourceIp: null });
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
      return { headers, socket: { remoteAddress: peer }, body: { ...SUBMISSION } };
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
