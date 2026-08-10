'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

chai.use(chaiAsPromised);
const { expect } = chai;

describe('relationshipResolver tests', () => {
  let relationshipResolver;
  let appsRepositoryStub;
  let specCutoverStub;
  let dockerServiceStub;
  let logStub;

  // Build a minimal InstantiatedSpec-shaped object whose spec mimics the
  // domain-class surface: dependencyEntries() returns MATERIALIZED edges
  // (fillDefaults semantics — strength requires, unordered, no network,
  // onRemove detach unless the test says otherwise) and linkedAppNames() is
  // the network-bearing projection, exactly as FluxAppSpecBase derives it.
  // activation is the v9 lifecycle dial pair; placement mimics the
  // InstantiatedSpec delegating getter.
  function instSpec({
    name, owner = 'owner1', dependencies, encrypted = false, activation, placement,
  } = {}) {
    const entries = Object.entries(dependencies || {}).map(([target, edge]) => [target, {
      strength: 'requires', after: false, condition: 'started', network: false, onRemove: 'detach', ...edge,
    }]);
    const spec = {
      // A real spec view carries identity as well as edges — the resolved view
      // is what callers read name/owner off once they hold one.
      name,
      owner,
      // `sealed` is the readability question, and the held spec answers it:
      // true on a raw EncryptedSpec, false on a cleartext one. Callers that
      // must not decrypt branch on this, so the mock has to carry it.
      sealed: encrypted,
      dependencyEntries: () => entries.map(([n, e]) => [n, { ...e }]),
      linkedAppNames() { return entries.filter(([, e]) => e.network === true).map(([n]) => n); },
    };
    if (activation !== undefined) spec.activation = activation;
    return {
      name,
      owner,
      isEncrypted: encrypted,
      spec,
      placement,
      // InstantiatedSpec sealed-vantage accessor: none when encrypted, else the spec's.
      linkedAppNames() { return encrypted ? [] : spec.linkedAppNames(); },
    };
  }

  // Network-bearing edges — the shareWith-fold shape (§10 of APP_RELATIONSHIPS.md).
  function linkedTo(...names) {
    return Object.fromEntries(names.map((n) => [n, { network: true, onRemove: 'detach' }]));
  }

  // A follower app: no independent run decision, reaped when orphaned.
  function follower(opts) {
    return instSpec({ ...opts, activation: { standalone: false, stopWhenUnneeded: true } });
  }

  // The resolved readable views the graph functions take as input, built here
  // the way the async caller builds them. A mock's `.spec` stands in for the
  // resolved view — for an encrypted app that is what decryption yields, which
  // is why an encrypted app's edges and activation are visible through it.
  function viewsMap(apps) {
    const m = new Map();
    apps.forEach((a) => { if (a && a.name) m.set(a.name.toLowerCase(), a.spec); });
    return m;
  }

  // Loads the module against the shared stubs. The real config (flag off) is used
  // unless fluxappsOverrides supplies e.g. { manageCollectorLifecycle: true }.
  function loadResolver(fluxappsOverrides) {
    const stubs = {
      '../appDatabase/appsRepository': appsRepositoryStub,
      '../utils/specCutover': specCutoverStub,
      '../dockerService': dockerServiceStub,
      '../../lib/log': logStub,
    };
    if (fluxappsOverrides) {
      stubs.config = { fluxapps: fluxappsOverrides };
    }
    return proxyquire('../../ZelBack/src/services/appLifecycle/relationshipResolver', stubs);
  }

  beforeEach(() => {
    appsRepositoryStub = {
      getInstalledApp: sinon.stub(),
      listInstalledApps: sinon.stub(),
      listGlobalAppInfo: sinon.stub(),
    };
    specCutoverStub = {
      // Resolves an app to its readable view: a cleartext app is readable as
      // itself, an encrypted one only once decrypted — null here unless a test
      // says the node holds its key.
      resolveInstantiatedSpec: sinon.stub().callsFake(async (app) => (app.isEncrypted ? null : app.spec)),
    };
    dockerServiceStub = {
      getAppContainerObjects: sinon.stub().resolves([]),
    };
    logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };

    relationshipResolver = loadResolver();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkAppDependencyRequirements', () => {
    it('resolves true and touches no database when there are no dependencies', async () => {
      const result = await relationshipResolver.checkAppDependencyRequirements(instSpec({ name: 'appB' }));
      expect(result).to.equal(true);
      sinon.assert.notCalled(appsRepositoryStub.getInstalledApp);
    });

    it('throws NETWORK_DEPENDENCY_NOT_READY when a dependency is not installed locally', async () => {
      appsRepositoryStub.getInstalledApp.resolves(null);
      const error = await expect(relationshipResolver.checkAppDependencyRequirements(instSpec({ name: 'appB', dependencies: linkedTo('appA') })))
        .to.be.rejectedWith(/is not installed on this node/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
    });

    it('throws a code-less hard failure when a dependency is owned by a different owner', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner2' }));
      const error = await expect(relationshipResolver.checkAppDependencyRequirements(instSpec({ name: 'appB', owner: 'owner1', dependencies: linkedTo('appA') })))
        .to.be.rejectedWith(/owned by a different owner/);
      expect(error.code).to.equal(undefined);
    });

    it('resolves true when every dependency is installed with the same owner', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      const result = await relationshipResolver.checkAppDependencyRequirements(instSpec({ name: 'appB', owner: 'owner1', dependencies: linkedTo('appA') }));
      expect(result).to.equal(true);
    });

    it('a wants edge never gates: an absent optional dependency does not defer the install', async () => {
      appsRepositoryStub.getInstalledApp.resolves(null);
      const result = await relationshipResolver.checkAppDependencyRequirements(instSpec({
        name: 'appB',
        dependencies: { cache: { strength: 'wants', network: true } },
      }));
      expect(result).to.equal(true);
      sinon.assert.notCalled(appsRepositoryStub.getInstalledApp);
    });

    it('flag off (default): an installed but not-running dependency still satisfies the check', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'exited' }]);
      const result = await relationshipResolver.checkAppDependencyRequirements(instSpec({ name: 'appB', owner: 'owner1', dependencies: linkedTo('appA') }));
      expect(result).to.equal(true);
      sinon.assert.notCalled(dockerServiceStub.getAppContainerObjects);
    });

    it('checks an ENCRYPTED consumer\'s edges, which the sealed accessor hides', async () => {
      // Read off the sealed InstantiatedSpec these edges are [], so the gate
      // passed vacuously and the app installed with none of its dependencies
      // verified. Resolved, the missing dependency is caught.
      const enc = instSpec({
        name: 'appB', owner: 'owner1', dependencies: linkedTo('appA'), encrypted: true,
      });
      specCutoverStub.resolveInstantiatedSpec.withArgs(enc).resolves(enc.spec);
      appsRepositoryStub.getInstalledApp.resolves(null);
      const error = await expect(relationshipResolver.checkAppDependencyRequirements(enc))
        .to.be.rejectedWith(/is not installed on this node/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
    });

    it('passes an ENCRYPTED consumer whose edges ARE satisfied', async () => {
      const enc = instSpec({
        name: 'appB', owner: 'owner1', dependencies: linkedTo('appA'), encrypted: true,
      });
      specCutoverStub.resolveInstantiatedSpec.withArgs(enc).resolves(enc.spec);
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      expect(await relationshipResolver.checkAppDependencyRequirements(enc)).to.equal(true);
    });

    it('defers rather than installing blind when the spec cannot be read here', async () => {
      const enc = instSpec({
        name: 'appB', owner: 'owner1', dependencies: linkedTo('appA'), encrypted: true,
      });
      specCutoverStub.resolveInstantiatedSpec.withArgs(enc).resolves(null);
      const error = await expect(relationshipResolver.checkAppDependencyRequirements(enc))
        .to.be.rejectedWith(/could not be decrypted on this node/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
    });
  });

  describe('checkAppDependencyRequirements with manageCollectorLifecycle on', () => {
    it('throws NETWORK_DEPENDENCY_NOT_READY when a dependency is installed but not running', async () => {
      const resolver = loadResolver({ manageCollectorLifecycle: true });
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'exited' }]);
      const error = await expect(resolver.checkAppDependencyRequirements(instSpec({ name: 'appB', owner: 'owner1', dependencies: linkedTo('appA') })))
        .to.be.rejectedWith(/installed but not running yet/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
    });

    it('resolves true when every dependency is installed and running', async () => {
      const resolver = loadResolver({ manageCollectorLifecycle: true });
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'running' }]);
      const result = await resolver.checkAppDependencyRequirements(instSpec({ name: 'appB', owner: 'owner1', dependencies: linkedTo('appA') }));
      expect(result).to.equal(true);
    });
  });

  describe('dependenciesReadyForSelection (never decrypts)', () => {
    it('true when the app declares no dependencies', async () => {
      expect(await relationshipResolver.dependenciesReadyForSelection(instSpec({ name: 'appB' }))).to.equal(true);
      sinon.assert.notCalled(specCutoverStub.resolveInstantiatedSpec);
    });

    it('true when a cleartext app\'s dependencies are satisfied', async () => {
      appsRepositoryStub.getInstalledApp.resolves(instSpec({ name: 'appA', owner: 'owner1' }));
      const ok = await relationshipResolver.dependenciesReadyForSelection(instSpec({ name: 'appB', owner: 'owner1', dependencies: linkedTo('appA') }));
      expect(ok).to.equal(true);
      sinon.assert.notCalled(specCutoverStub.resolveInstantiatedSpec);
    });

    it('NOT_READY when a cleartext app\'s dependency is missing — general-pool ordering still works', async () => {
      appsRepositoryStub.getInstalledApp.resolves(null);
      const error = await expect(relationshipResolver.dependenciesReadyForSelection(instSpec({ name: 'appB', dependencies: linkedTo('appA') })))
        .to.be.rejectedWith(/is not installed on this node/);
      expect(error.code).to.equal('NETWORK_DEPENDENCY_NOT_READY');
      sinon.assert.notCalled(specCutoverStub.resolveInstantiatedSpec);
    });

    it('treats an encrypted app as ready and does NOT decrypt it', async () => {
      // The whole point: this runs over every candidate on every cycle, so it
      // must never pay a decrypt. An encrypted app's edges are invisible here
      // and the install-time gate does the real check.
      const enc = instSpec({ name: 'appB', dependencies: linkedTo('missing'), encrypted: true });
      expect(await relationshipResolver.dependenciesReadyForSelection(enc)).to.equal(true);
      sinon.assert.notCalled(specCutoverStub.resolveInstantiatedSpec);
      sinon.assert.notCalled(appsRepositoryStub.getInstalledApp);
    });
  });

  describe('pureFollowerNames (resolve only where told)', () => {
    it('detects an ENCRYPTED follower when told to resolve it', async () => {
      const enc = follower({ name: 'collector', encrypted: true });
      specCutoverStub.resolveInstantiatedSpec.withArgs(enc).resolves(enc.spec);
      const names = await relationshipResolver.pureFollowerNames([enc], () => true);
      expect([...names]).to.eql(['collector']);
    });

    it('detects a CLEARTEXT follower without resolving it — the sealed read answers fully', async () => {
      const plain = follower({ name: 'collector' });
      const names = await relationshipResolver.pureFollowerNames([plain], () => false);
      expect([...names]).to.eql(['collector']);
      sinon.assert.notCalled(specCutoverStub.resolveInstantiatedSpec);
    });

    it('reports an ENCRYPTED follower standalone when not told to resolve — the price of not decrypting', async () => {
      const enc = follower({ name: 'collector', encrypted: true });
      const names = await relationshipResolver.pureFollowerNames([enc], () => false);
      expect([...names]).to.eql([]);
      sinon.assert.notCalled(specCutoverStub.resolveInstantiatedSpec);
    });

    it('resolves only the apps the predicate names', async () => {
      const pinned = follower({ name: 'pinned', encrypted: true });
      const general = follower({ name: 'general', encrypted: true });
      specCutoverStub.resolveInstantiatedSpec.withArgs(pinned).resolves(pinned.spec);
      const names = await relationshipResolver.pureFollowerNames(
        [pinned, general], (app) => app.name === 'pinned',
      );
      expect([...names]).to.eql(['pinned']);
      expect(specCutoverStub.resolveInstantiatedSpec.getCalls().map((c) => c.args[0].name)).to.eql(['pinned']);
    });
  });

  describe('isAppRunning', () => {
    it('is true when every container of the app is running', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'running' }]);
      expect(await relationshipResolver.isAppRunning('appA')).to.equal(true);
    });

    it('is false when any container of the app is not running', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([{ State: 'running' }, { State: 'exited' }]);
      expect(await relationshipResolver.isAppRunning('appA')).to.equal(false);
    });

    it('is false when the app has no containers', async () => {
      dockerServiceStub.getAppContainerObjects.resolves([]);
      expect(await relationshipResolver.isAppRunning('appA')).to.equal(false);
    });
  });

  describe('activation predicates', () => {
    it('isPureFollower is true only for activation.standalone === false', () => {
      expect(relationshipResolver.isPureFollower(follower({ name: 'c' }).spec)).to.equal(true);
      expect(relationshipResolver.isPureFollower(instSpec({ name: 'c', activation: { standalone: false, stopWhenUnneeded: false } }).spec)).to.equal(true);
      expect(relationshipResolver.isPureFollower(instSpec({ name: 'c', activation: { standalone: true, stopWhenUnneeded: true } }).spec)).to.equal(false);
      expect(relationshipResolver.isPureFollower(instSpec({ name: 'c' }).spec)).to.equal(false);
      expect(relationshipResolver.isPureFollower(null)).to.equal(false);
    });

    it('an encrypted app IS a follower once its spec is resolved', () => {
      // The predicate takes a resolved view, so encryption is not its question:
      // an encrypted app that declared itself a follower is one. Guarding this
      // on isEncrypted is what made every encrypted app permanently standalone.
      const enc = instSpec({ name: 'c', encrypted: true, activation: { standalone: false, stopWhenUnneeded: true } });
      expect(relationshipResolver.isPureFollower(enc.spec)).to.equal(true);
    });

    it('isPureFollower is false for a spec that could not be read here', () => {
      // buildViewsByName maps an undecryptable app to null and flips `complete`
      // false; standalone is the fail-toward-keeping answer for that case.
      expect(relationshipResolver.isPureFollower(null)).to.equal(false);
      expect(relationshipResolver.isPureFollower(undefined)).to.equal(false);
    });

    it('isStopWhenUnneeded reads the dial on its own — reap eligibility weighs the holds elsewhere', () => {
      expect(relationshipResolver.isStopWhenUnneeded(follower({ name: 'c' }).spec)).to.equal(true);
      expect(relationshipResolver.isStopWhenUnneeded(instSpec({ name: 'c', activation: { standalone: true, stopWhenUnneeded: true } }).spec)).to.equal(true);
      expect(relationshipResolver.isStopWhenUnneeded(instSpec({ name: 'c', activation: { standalone: false, stopWhenUnneeded: false } }).spec)).to.equal(false);
      expect(relationshipResolver.isStopWhenUnneeded(null)).to.equal(false);
    });
  });

  describe('computeRequiredDependencyNames', () => {
    it('marks a follower required when a workload depends on it', () => {
      const apps = [instSpec({ name: 'game', dependencies: linkedTo('collector') }), follower({ name: 'collector' })];
      expect([...relationshipResolver.computeRequiredDependencyNames(apps, viewsMap(apps))]).to.eql(['collector']);
    });

    it('a non-network edge holds its target just like a network one — strength and network govern other axes', () => {
      const apps = [
        instSpec({ name: 'game', dependencies: { collector: { onRemove: 'detach' } } }),
        follower({ name: 'collector' }),
      ];
      expect([...relationshipResolver.computeRequiredDependencyNames(apps, viewsMap(apps))]).to.eql(['collector']);
    });

    it('a wants edge holds its target on the node — optional is about starting, not presence', () => {
      const apps = [
        instSpec({ name: 'game', dependencies: { cache: { strength: 'wants' } } }),
        follower({ name: 'cache' }),
      ];
      expect([...relationshipResolver.computeRequiredDependencyNames(apps, viewsMap(apps))]).to.eql(['cache']);
    });

    it('follows the closure transitively through follower-to-follower edges', () => {
      const apps = [
        instSpec({ name: 'game', dependencies: linkedTo('datadog') }),
        follower({ name: 'datadog', dependencies: linkedTo('alloy') }),
        follower({ name: 'alloy' }),
      ];
      const required = relationshipResolver.computeRequiredDependencyNames(apps, viewsMap(apps));
      expect(required.has('datadog')).to.equal(true);
      expect(required.has('alloy')).to.equal(true);
    });

    it('a follower cannot keep itself (or a sibling) alive - closure starts from standalone apps only', () => {
      const apps = [follower({ name: 'datadog', dependencies: linkedTo('alloy') }), follower({ name: 'alloy' })];
      expect(relationshipResolver.computeRequiredDependencyNames(apps, viewsMap(apps)).size).to.equal(0);
    });

    it('ignores cross-owner edges', () => {
      const apps = [instSpec({ name: 'game', owner: 'owner1', dependencies: linkedTo('collector') }), follower({ name: 'collector', owner: 'owner2' })];
      expect(relationshipResolver.computeRequiredDependencyNames(apps, viewsMap(apps)).size).to.equal(0);
    });
  });

  describe('findCascadeWorkloadsRequiring', () => {
    it('legacy: returns workloads transitively requiring a pure-follower target, never sibling followers', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'game', dependencies: linkedTo('datadog') }),
        follower({ name: 'datadog', dependencies: linkedTo('alloy') }),
        follower({ name: 'alloy' }),
        instSpec({ name: 'unrelated' }),
      ]);
      const requiring = await relationshipResolver.findCascadeWorkloadsRequiring('alloy');
      expect(requiring.map((a) => a.name)).to.eql(['game']);
    });

    it('a declared cascade edge binds its requirer to a standalone target too', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'web', dependencies: { db: { onRemove: 'cascade' } } }),
        instSpec({ name: 'db' }),
      ]);
      const requiring = await relationshipResolver.findCascadeWorkloadsRequiring('db');
      expect(requiring.map((a) => a.name)).to.eql(['web']);
    });

    it('a detach edge does not cascade — the author chose to outlive the dependency', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'web', dependencies: { db: { onRemove: 'detach' } } }),
        instSpec({ name: 'db' }),
      ]);
      const requiring = await relationshipResolver.findCascadeWorkloadsRequiring('db');
      expect(requiring).to.eql([]);
    });

    it('a detach hop breaks a cascade chain', async () => {
      // a -detach-> b -cascade-> c: removing c cascades b; a stays and degrades,
      // which was its author's explicit choice.
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'a', dependencies: { b: { onRemove: 'detach' } } }),
        instSpec({ name: 'b', dependencies: { c: { onRemove: 'cascade' } } }),
        instSpec({ name: 'c' }),
      ]);
      const requiring = await relationshipResolver.findCascadeWorkloadsRequiring('c');
      expect(requiring.map((a) => a.name)).to.eql(['b']);
    });
  });

  describe('getRequiredDependencyNamesForNode', () => {
    function placementStub(matches) {
      return {
        hasTargets: () => true,
        matchesTarget: sinon.stub().returns(matches),
        isPinnedTo(nodeInfo) { return this.hasTargets() && this.matchesTarget(nodeInfo); },
      };
    }

    it('computes the closure over global apps whose placement targets this node', async () => {
      appsRepositoryStub.listGlobalAppInfo.resolves([
        instSpec({ name: 'game', dependencies: linkedTo('collector'), placement: placementStub(true) }),
        follower({ name: 'collector', placement: placementStub(true) }),
        instSpec({ name: 'elsewhere', dependencies: linkedTo('othercol'), placement: placementStub(false) }),
        follower({ name: 'othercol', placement: placementStub(false) }),
      ]);
      const required = await relationshipResolver.getRequiredDependencyNamesForNode({ ip: '7.7.7.7:16127' });
      expect(required.has('collector')).to.equal(true);
      expect(required.has('othercol')).to.equal(false);
    });

    it('returns an empty set when no node identity is known', async () => {
      const required = await relationshipResolver.getRequiredDependencyNamesForNode({});
      expect(required.size).to.equal(0);
      sinon.assert.notCalled(appsRepositoryStub.listGlobalAppInfo);
    });
  });

  describe('findUnrequiredInstalledDependencies', () => {
    function placementStub(matches) {
      return {
        hasTargets: () => true,
        matchesTarget: sinon.stub().returns(matches),
        isPinnedTo(nodeInfo) { return this.hasTargets() && this.matchesTarget(nodeInfo); },
      };
    }

    it('returns only self-cleaning apps that no workload requires', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'game', dependencies: linkedTo('datadog') }),
        follower({ name: 'datadog' }),
        follower({ name: 'orphaned' }),
        instSpec({ name: 'persistent', activation: { standalone: false, stopWhenUnneeded: false } }),
      ]);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies();
      expect(orphans.map((a) => a.name)).to.eql(['orphaned']);
    });

    it('orphans the follower once its last workload is gone', async () => {
      appsRepositoryStub.listInstalledApps.resolves([follower({ name: 'datadog' })]);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies();
      expect(orphans.map((a) => a.name)).to.eql(['datadog']);
    });

    it('reaps an unheld (standalone: true, stopWhenUnneeded: true) app when its placement does not pin it here', async () => {
      // The cell the v8 model could not express: a shared app an operator can
      // stand up by hand, that also self-cleans when it arrived purely as a
      // dependency. The self-hold is judged from the signed placement, not
      // persisted install provenance.
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({
          name: 'shareddb',
          activation: { standalone: true, stopWhenUnneeded: true },
          placement: placementStub(false),
        }),
      ]);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies({
        nodeIdentity: { ip: '7.7.7.7:16127' },
      });
      expect(orphans.map((a) => a.name)).to.eql(['shareddb']);
    });

    it('keeps a (true, true) app whose own placement pins it to this node — it holds itself', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({
          name: 'shareddb',
          activation: { standalone: true, stopWhenUnneeded: true },
          placement: placementStub(true),
        }),
      ]);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies({
        nodeIdentity: { ip: '7.7.7.7:16127' },
      });
      expect(orphans).to.eql([]);
    });

    it('keeps a (true, true) app while a workload requires it, pinned or not', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'game', dependencies: linkedTo('shareddb') }),
        instSpec({
          name: 'shareddb',
          activation: { standalone: true, stopWhenUnneeded: true },
          placement: placementStub(false),
        }),
      ]);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies({
        nodeIdentity: { ip: '7.7.7.7:16127' },
      });
      expect(orphans).to.eql([]);
    });

    it('never reaps a standalone app without node identity — fail toward keeping', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({
          name: 'shareddb',
          activation: { standalone: true, stopWhenUnneeded: true },
          placement: placementStub(false),
        }),
      ]);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies();
      expect(orphans).to.eql([]);
    });

    it('a stopWhenUnneeded: false app is never reap-eligible, orphaned or not', async () => {
      appsRepositoryStub.listInstalledApps.resolves([
        instSpec({ name: 'pulledonce', activation: { standalone: false, stopWhenUnneeded: false } }),
      ]);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies({
        nodeIdentity: { ip: '7.7.7.7:16127' },
      });
      expect(orphans).to.eql([]);
    });
  });

  describe('graph reads the decrypted spec view', () => {
    it('keeps a follower required by an ENCRYPTED consumer (sealed view would reap it)', async () => {
      const encWorkload = instSpec({ name: 'game', dependencies: linkedTo('collector'), encrypted: true });
      appsRepositoryStub.listInstalledApps.resolves([encWorkload, follower({ name: 'collector' })]);
      // This node holds the key, so the encrypted consumer resolves to its real
      // spec and its edge to the collector is visible; the sealed accessor
      // (encWorkload.linkedAppNames()) reports none.
      specCutoverStub.resolveInstantiatedSpec.withArgs(encWorkload).resolves(encWorkload.spec);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies();
      expect(orphans.map((a) => a.name)).to.eql([]);
    });

    it('orders orphans consumer-first, including an ENCRYPTED consumer', async () => {
      // The edge deciding the order lives in the sealed body, so ordering on the
      // sealed accessor put encrypted orphans in no particular order — and the
      // consumer could be torn down after the app it consumes.
      const datadog = follower({ name: 'datadog', dependencies: linkedTo('alloy'), encrypted: true });
      const alloy = follower({ name: 'alloy' });
      appsRepositoryStub.listInstalledApps.resolves([alloy, datadog]);
      specCutoverStub.resolveInstantiatedSpec.withArgs(datadog).resolves(datadog.spec);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies();
      expect(orphans.map((a) => a.name)).to.eql(['datadog', 'alloy']);
    });

    it('reaps an orphaned ENCRYPTED follower once its spec resolves', async () => {
      // The follower's own activation is only readable through the resolved
      // view. While it was read off the sealed container every encrypted app
      // looked standalone, so an orphaned one was never reaped.
      const encFollower = follower({ name: 'collector', encrypted: true });
      appsRepositoryStub.listInstalledApps.resolves([encFollower]);
      specCutoverStub.resolveInstantiatedSpec.withArgs(encFollower).resolves(encFollower.spec);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies();
      expect(orphans.map((a) => a.name)).to.eql(['collector']);
    });

    it('does not reap when spec visibility is incomplete (undecryptable app)', async () => {
      const encWorkload = instSpec({ name: 'game', encrypted: true });
      appsRepositoryStub.listInstalledApps.resolves([encWorkload, follower({ name: 'orphaned' })]);
      specCutoverStub.resolveInstantiatedSpec.withArgs(encWorkload).resolves(null);
      const orphans = await relationshipResolver.findUnrequiredInstalledDependencies();
      expect(orphans).to.eql([]);
    });

    it('refuses the required-set (falls back to not suppressing) when an assigned app is undecryptable', async () => {
      const enc = instSpec({ name: 'game', encrypted: true, placement: { hasTargets: () => true, matchesTarget: () => true, isPinnedTo: () => true } });
      appsRepositoryStub.listGlobalAppInfo.resolves([enc]);
      specCutoverStub.resolveInstantiatedSpec.withArgs(enc).resolves(null);
      await expect(relationshipResolver.getRequiredDependencyNamesForNode({ ip: '7.7.7.7:16127' })).to.be.rejected;
    });
  });
});
