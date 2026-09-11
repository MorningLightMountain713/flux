const { expect } = require('chai');
const sinon = require('sinon');
const { resetGlobalState } = require('./fixtures/globalState');
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const proxyquire = require('proxyquire').noCallThru();
const {
  loadSpecLibrary, V8_SUBMISSION, V9_SUBMISSION, v8Spec, v9Spec,
} = require('./fixtures/fluxSpec');

describe('appEvacuationSafety tests', () => {
  before(async function loadLibrary() {
    // The first fromSubmission compiles the ajv schemas.
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  let appEvacuationSafety;
  let fluxNetworkHelperStub;
  let globalStateStub;
  let deps;

  const LOCAL = '1.2.3.4:16127';

  // REAL spec classes, not stored documents. This module asks the class - a
  // document answers the v8 spelling only, and a v9 app read that way reports no
  // synced components at all, which this function's caller reads as "stateless"
  // and clears for removal.
  async function statelessSpec(overrides = {}) {
    return v8Spec({
      name: 'plainapp',
      compose: [{ ...V8_SUBMISSION.compose[0], name: 'web', containerData: '/data' }],
      ...overrides,
    });
  }

  async function statefulSpec(overrides = {}) {
    return v8Spec({
      name: 'palworld1',
      compose: [{ ...V8_SUBMISSION.compose[0], name: 'server', containerData: 'g:/data' }],
      ...overrides,
    });
  }

  /** The same stateful app as a v9 spec: no compose, no containerData. */
  async function statefulSpecV9(overrides = {}) {
    return v9Spec({
      name: 'palworld1',
      components: {
        server: {
          ...V9_SUBMISSION.components.web,
          name: 'server',
          persistentStorage: {
            sizeGb: 5,
            mounts: { '/data': { source: 'data', destination: '/data' } },
            sync: { mode: 'activeStandby' },
          },
        },
      },
      ...overrides,
    });
  }

  function locations(...ips) {
    return ips.map((ip, index) => ({ ip, runningSince: new Date(1_700_000_000_000 + index) }));
  }

  beforeEach(() => {
    fluxNetworkHelperStub = {
      getLocalSocketAddress: sinon.stub().resolves(LOCAL),
    };
    globalStateStub = resetGlobalState();

    appEvacuationSafety = proxyquire('../../ZelBack/src/services/appLifecycle/appEvacuationSafety', {
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      '../fluxNetworkHelper': fluxNetworkHelperStub,
      '../utils/globalState': globalStateStub,
    });

    deps = {
      appLocation: sinon.stub(),
      getApplicationGlobalSpecifications: sinon.stub(),
      findSyncedPeer: sinon.stub().resolves({ deviceID: 'PEER1', globalBytes: 1024 }),
      // Both required. The default case is this node running the g: component
      // with the election able to name another node as primary, so the checks
      // below reach the syncthing evidence rather than stopping short of it.
      isElectedPrimary: sinon.stub().resolves(false),
      isComponentRunningLocally: sinon.stub().resolves(true),
    };
  });

  afterEach(() => {
    operationRegistry.clear();
    sinon.restore();
  });

  describe('refuses on anything it cannot establish', () => {
    it('refuses while a backup is running', async () => {
      operationRegistry.acquire('plainapp', 'backup', 'test');

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('backup');
    });

    it('refuses while a restore is running', async () => {
      operationRegistry.acquire('plainapp', 'restore', 'test');

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('restore');
    });

    it('refuses when the global specification is unavailable', async () => {
      deps.getApplicationGlobalSpecifications.resolves(null);

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('specification');
    });

    it('refuses when this node does not know its own address', async () => {
      // Named, and with a populated location list. Asserting only `safe` on an
      // empty list proved the NEXT guard instead: appLocation returned
      // undefined either way, so the refusal came from "no instance locations"
      // and this one could be deleted without the test noticing. With the list
      // populated and the guard gone, otherHostCount compares against an
      // undefined address, never matches this node, and counts this node as
      // another host holding the app.
      deps.getApplicationGlobalSpecifications.resolves(await statelessSpec());
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));
      fluxNetworkHelperStub.getLocalSocketAddress.resolves(null);

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(false);
      expect(result.code).to.equal('NO_LOCAL_ADDRESS');
      expect(result.reason).to.contain('local socket address');
    });

    it('refuses on an empty location list rather than reading it as "runs nowhere"', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statelessSpec());
      deps.appLocation.resolves([]);

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('no instance locations');
    });

    it('refuses when the safety check itself throws', async () => {
      deps.getApplicationGlobalSpecifications.rejects(new Error('db gone'));

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('db gone');
    });
  });

  describe('the app must be at full strength', () => {
    it('refuses while the app is already short, because another move is in flight', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statelessSpec({ instances: 3 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('below its instance count');
    });

    it('allows when the app is exactly at its instance count', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statelessSpec({ instances: 3 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127', '9.9.9.9:16127'));

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(true);
    });

    it('falls back to the configured minimum when the spec names no instance count', async () => {
      // Must match the spawner's own `$ifNull: [instances, 3]`, or the departure
      // creates a deficit the spawner does not agree exists.
      deps.getApplicationGlobalSpecifications.resolves(await statelessSpec());
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('/3');
    });
  });

  describe('stateless apps', () => {
    it('may be given up even as the only instance, because there is no data to lose', async () => {
      // The 57 single-instance apps on residential nodes are all stateless. The
      // container is rebuilt from the specification elsewhere.
      deps.getApplicationGlobalSpecifications.resolves(await statelessSpec({ instances: 1 }));
      deps.appLocation.resolves(locations(LOCAL));

      const result = await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      expect(result.safe).to.equal(true);
      expect(result.reason).to.contain('stateless');
    });

    it('never consults syncthing', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statelessSpec({ instances: 1 }));
      deps.appLocation.resolves(locations(LOCAL));

      await appEvacuationSafety.canSafelyRemoveApp('plainapp', deps);

      sinon.assert.notCalled(deps.findSyncedPeer);
    });
  });

  describe('stateful apps', () => {
    it('is refused when no other host holds it', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({ instances: 1 }));
      deps.appLocation.resolves(locations(LOCAL));

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('only host');
    });

    it('is refused when no connected peer holds the folder in full', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({ instances: 2 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));
      deps.findSyncedPeer.resolves(null);

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('no connected peer');
    });

    it('is allowed when a connected peer holds every synced folder', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({ instances: 2 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(true);
      sinon.assert.calledWith(deps.findSyncedPeer, 'fluxserver_palworld1');
    });

    it('requires EVERY synced component to be held, not just the first', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({
        instances: 2,
        compose: [
          { ...V8_SUBMISSION.compose[0], name: 'server', containerData: 'g:/data', ports: [31_001] },
          { ...V8_SUBMISSION.compose[0], name: 'db', containerData: 'r:/var/lib/mysql', ports: [31_002] },
        ],
      }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));
      deps.findSyncedPeer.onFirstCall().resolves({ deviceID: 'PEER1', globalBytes: 1 });
      deps.findSyncedPeer.onSecondCall().resolves(null);

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(false);
    });

    it('asks the elected primary to stand down rather than refusing outright', async () => {
      // Not a removal and not a dead end: everything else has passed, so the
      // only thing left is that this node is the one writing. It stops, and the
      // next pass finds the component running elsewhere.
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({ instances: 2 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));
      deps.isElectedPrimary = sinon.stub().resolves(true);

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(false);
      expect(result.code).to.equal('STAND_DOWN_REQUIRED');
      expect(result.standDown).to.deep.equal(['server_palworld1']);
    });

    it('names only the components actually running here', async () => {
      // The caller stops what this returns, so a component already stopped must
      // not appear - stopping it again is noise, and marking it unelectable is
      // wrong for something this node is not running.
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({ instances: 2 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));
      deps.isElectedPrimary = sinon.stub().resolves(true);
      deps.isComponentRunningLocally = sinon.stub().resolves(false);

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(true);
      expect(result.code).to.equal('SYNCED_ELSEWHERE');
    });

    it('never asks a node holding the only good copy to stand down', async () => {
      // The ordering IS the safety property. If the synced-peer check ran after
      // the election, a primary with no complete peer would stop writing and
      // then discover it cannot leave - an app stopped here and running nowhere.
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({ instances: 2 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));
      deps.isElectedPrimary = sinon.stub().resolves(true);
      deps.findSyncedPeer.resolves(null);

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.code).to.equal('NO_SYNCED_PEER');
      expect(result.standDown).to.equal(undefined);
      sinon.assert.notCalled(deps.isElectedPrimary);
    });
  });

  describe('an election that cannot answer is not an election that said no', () => {
    beforeEach(async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({ instances: 2 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));
    });

    it('refuses while this node runs the g: component and the election cannot say', async () => {
      // The whole defect in one assertion. `null` is "nobody can tell me who
      // the primary is", and answering it the way `false` is answered deletes
      // the volume of the node that may well be the one writing to it.
      deps.isElectedPrimary = sinon.stub().resolves(null);

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(false);
      expect(result.code).to.equal('ELECTION_UNKNOWN');
    });

    it('proceeds on an unknown election when this node is not running the component', async () => {
      // A node not running the writer cannot be the writer, whatever the
      // election does or does not know - so a load-balancer outage stalls the
      // trim only where a writer actually lives.
      deps.isElectedPrimary = sinon.stub().resolves(null);
      deps.isComponentRunningLocally = sinon.stub().resolves(false);

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(true);
      expect(deps.isElectedPrimary.called).to.equal(false);
    });

    it('never asks the election about an app with no g: component', async () => {
      // `s:` and `r:` components are stateful but have no primary at all, so
      // demanding an election verdict for them would stall their trim for good.
      deps.getApplicationGlobalSpecifications.resolves({
        name: 'shared1',
        version: 8,
        compose: [{ name: 'db', containerData: 's:/data' }],
        instances: 2,
      });
      deps.isElectedPrimary = sinon.stub().resolves(null);

      const result = await appEvacuationSafety.canSafelyRemoveApp('shared1', deps);

      expect(result.safe).to.equal(true);
      expect(deps.isElectedPrimary.called).to.equal(false);
    });

    // These two use an app with NO g: component on purpose. A g: app reaches
    // the election check and would throw a TypeError on the missing dependency
    // anyway, so it cannot tell an explicit requirement from an accident. An
    // s: app never reaches that call at all: without the requirement the
    // omission is invisible and the removal comes back safe.
    const sharedOnlySpec = {
      name: 'shared1',
      version: 8,
      compose: [{ name: 'db', containerData: 's:/data' }],
      instances: 2,
    };

    it('refuses, loudly, when a caller omits the election check altogether', async () => {
      // It used to default to `async () => false` - the one unavailable input
      // in this function that answered instead of refusing. A caller that
      // cannot ask must not be told the removal is safe.
      deps.getApplicationGlobalSpecifications.resolves(sharedOnlySpec);
      delete deps.isElectedPrimary;

      const result = await appEvacuationSafety.canSafelyRemoveApp('shared1', deps);

      expect(result.safe).to.equal(false);
      expect(result.code).to.equal('CHECK_FAILED');
      expect(result.reason).to.contain('isElectedPrimary');
    });

    it('refuses when a caller omits the running-component check', async () => {
      deps.getApplicationGlobalSpecifications.resolves(sharedOnlySpec);
      delete deps.isComponentRunningLocally;

      const result = await appEvacuationSafety.canSafelyRemoveApp('shared1', deps);

      expect(result.safe).to.equal(false);
      expect(result.code).to.equal('CHECK_FAILED');
    });
  });

  describe('instances are counted per host, not per node slot', () => {
    it('does not treat a second slot on our own machine as another copy', async () => {
      // 329 target slots sit on 148 machines. Two locations at one address fail
      // together and are being evacuated together, so they were never two copies.
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpec({ instances: 2 }));
      deps.appLocation.resolves(locations(LOCAL, '1.2.3.4:16137'));

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(false);
      expect(result.reason).to.contain('only host');
    });

    it('counts distinct hosts once each', () => {
      const counted = appEvacuationSafety.otherHostCount(
        locations(LOCAL, '5.6.7.8:16127', '5.6.7.8:16137', '9.9.9.9:16127'),
        LOCAL,
      );

      expect(counted).to.equal(2);
    });
  });

  describe('syncedComponents', () => {
    it('reads the sync mode through the mount parser, not a substring', () => {
      // `/dogs/data` contains "g:" nowhere but a naive check on the letter would
      // still trip; the canonical parser is what keeps this honest.
      const components = appEvacuationSafety.syncedComponents({
        name: 'app', version: 8, compose: [{ name: 'c', containerData: '/dogs/data' }],
      });

      expect(components).to.be.empty;
    });

    // THE CASE THIS MODULE WAS BLIND TO. It read spec.compose and each
    // component's containerData - the v8 spelling. A v9 spec carries neither, so
    // it did not fail on one: it returned an EMPTY list, which canSafelyRemoveApp
    // reads as "stateless" and clears for removal BEFORE the only-host check is
    // ever reached. Every v9 app was judged to have no data worth keeping.
    it('sees a v9 app\'s synced components, which carry no compose and no containerData', async () => {
      const spec = await statefulSpecV9();
      expect(spec.compose, 'a v9 spec has no compose at all').to.equal(undefined);

      const components = appEvacuationSafety.syncedComponents(spec);

      expect(components).to.have.lengthOf(1);
      expect(components[0].folderId).to.equal('fluxserver_palworld1');
      expect(components[0].syncMode).to.equal('g');
    });

    it('refuses to hand back a stateful v9 app that no peer holds', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpecV9({ instances: 2 }));
      deps.appLocation.resolves(locations(LOCAL, '5.6.7.8:16127'));
      deps.findSyncedPeer.resolves(null);

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      // Read as stateless it answered safe:true here, and the only-host check
      // below never ran.
      expect(result.safe).to.equal(false);
      expect(result.code).to.equal('NO_SYNCED_PEER');
    });

    it('refuses a stateful v9 app when this node is its only host', async () => {
      deps.getApplicationGlobalSpecifications.resolves(await statefulSpecV9({ instances: 1 }));
      deps.appLocation.resolves(locations(LOCAL));

      const result = await appEvacuationSafety.canSafelyRemoveApp('palworld1', deps);

      expect(result.safe).to.equal(false);
      expect(result.code).to.equal('ONLY_HOST');
    });

    it('names the folder id each synced component owns', async () => {
      const components = appEvacuationSafety.syncedComponents(await statefulSpec());

      expect(components).to.have.lengthOf(1);
      expect(components[0].folderId).to.equal('fluxserver_palworld1');
      expect(components[0].syncMode).to.equal('g');
    });
  });
});
