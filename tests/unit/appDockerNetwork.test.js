const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Ported from development's ensureAppDockerNetwork suite (PR #1769), which lived in
// appInstaller.test.js before the function moved to appNetwork/appDockerNetwork.js.
// These pin the invariants the allocator exists for; the octet scan itself is covered
// separately in dockerService.test.js.
const makeDockerServiceStub = (overrides = {}) => ({
  dockerNetworkState: sinon.stub().resolves('absent'),
  getFreeFluxAppNetworkOctet: sinon.stub().resolves(1),
  createFluxAppDockerNetwork: sinon.stub().resolves('network-created'),
  getFluxDockerNetworkPhysicalInterfaceNames: sinon.stub().resolves([]),
  ...overrides,
});

describe('appDockerNetwork tests', () => {
  let appDockerNetwork;
  let dockerServiceStub;
  let removeAccessStub;

  beforeEach(() => {
    dockerServiceStub = makeDockerServiceStub({ getFreeFluxAppNetworkOctet: sinon.stub().resolves(7) });
    removeAccessStub = sinon.stub().resolves(true);
    appDockerNetwork = proxyquire('../../ZelBack/src/services/appNetwork/appDockerNetwork', {
      '../serviceHelper': { ensureString: sinon.stub().returnsArg(0) },
      '../dockerService': dockerServiceStub,
      '../fluxNetworkHelper': { removeDockerContainerAccessToNonRoutable: removeAccessStub },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('returns early (no create, no firewall rebuild) when the network already exists', async () => {
    dockerServiceStub.dockerNetworkState.resolves('exists');

    const result = await appDockerNetwork.ensureAppDockerNetwork('myapp');

    expect(dockerServiceStub.getFreeFluxAppNetworkOctet.called).to.be.false;
    expect(dockerServiceStub.createFluxAppDockerNetwork.called).to.be.false;
    // intact network: its interface is already in DOCKER-USER, so no iptables churn
    expect(dockerServiceStub.getFluxDockerNetworkPhysicalInterfaceNames.called).to.be.false;
    expect(removeAccessStub.called).to.be.false;
    expect(result).to.include('already exists');
  });

  it('creates the network on the lowest free octet when absent', async () => {
    dockerServiceStub.getFreeFluxAppNetworkOctet.resolves(7);

    await appDockerNetwork.ensureAppDockerNetwork('myapp');

    expect(dockerServiceStub.createFluxAppDockerNetwork.calledOnceWithExactly('myapp', 7)).to.be.true;
    expect(removeAccessStub.calledOnce).to.be.true;
  });

  it('re-scans for the next free octet when a create collides', async () => {
    dockerServiceStub.getFreeFluxAppNetworkOctet.onFirstCall().resolves(7);
    dockerServiceStub.getFreeFluxAppNetworkOctet.onSecondCall().resolves(8);
    dockerServiceStub.createFluxAppDockerNetwork.onFirstCall().resolves(undefined); // collision
    dockerServiceStub.createFluxAppDockerNetwork.onSecondCall().resolves('network-created');

    await appDockerNetwork.ensureAppDockerNetwork('myapp');

    expect(dockerServiceStub.createFluxAppDockerNetwork.getCall(0).args).to.deep.equal(['myapp', 7]);
    expect(dockerServiceStub.createFluxAppDockerNetwork.getCall(1).args).to.deep.equal(['myapp', 8]);
    // the lost octet is excluded from the next allocation so it never re-picks it
    expect([...dockerServiceStub.getFreeFluxAppNetworkOctet.secondCall.args[0]]).to.include(7);
  });

  it('throws a clear error when no free subnet is available', async () => {
    dockerServiceStub.getFreeFluxAppNetworkOctet.resolves(null);
    let err;
    try {
      await appDockerNetwork.ensureAppDockerNetwork('myapp');
    } catch (e) { err = e; }

    expect(err).to.be.an('error');
    expect(err.message).to.include('No free 172.23.x.0/24 subnet available');
    expect(dockerServiceStub.createFluxAppDockerNetwork.called).to.be.false;
  });

  it('pins the octet by name for legacy gateway-assignment apps', async () => {
    // 'fdm' is in appsThatMightBeUsingOldGatewayIpAssignment; octet = 'm'.charCodeAt
    await appDockerNetwork.ensureAppDockerNetwork('fdm');

    expect(dockerServiceStub.getFreeFluxAppNetworkOctet.called).to.be.false;
    expect(dockerServiceStub.createFluxAppDockerNetwork.calledOnceWithExactly('fdm', 'm'.charCodeAt(0))).to.be.true;
  });

  it('advances through EVERY free octet and gives up only on exhaustion, not a fixed count', async () => {
    // Simulate a nearly-full node: octets 1..FREE are free, every create loses. Drive
    // the allocator off the real exclude set so it must try all FREE octets before the
    // space is exhausted. FREE is deliberately larger than any plausible fixed retry cap:
    // a reintroduced cap would throw early and fail callCount.
    const FREE = 20;
    dockerServiceStub.getFreeFluxAppNetworkOctet = sinon.stub().callsFake(async (excluded = new Set()) => {
      for (let octet = 1; octet <= FREE; octet += 1) {
        if (!excluded.has(octet)) return octet;
      }
      return null;
    });
    dockerServiceStub.createFluxAppDockerNetwork.resolves(undefined); // every create loses
    let err;
    try {
      await appDockerNetwork.ensureAppDockerNetwork('myapp');
    } catch (e) { err = e; }

    // it attempted all FREE octets (never re-picking one) and only threw at true exhaustion
    expect(dockerServiceStub.createFluxAppDockerNetwork.callCount).to.equal(FREE);
    const attemptedOctets = dockerServiceStub.createFluxAppDockerNetwork.getCalls().map((c) => c.args[1]);
    expect(attemptedOctets).to.deep.equal(Array.from({ length: FREE }, (_, i) => i + 1));
    expect(err).to.be.an('error');
    expect(err.message).to.include('No free 172.23.x.0/24 subnet available');
  });

  it('treats an unknown network state as not-present and attempts a create', async () => {
    // dockerNetworkState returns 'unknown' on a transient docker glitch; the guard
    // is `=== exists`, so unknown must fall through to an (idempotent) create rather
    // than be mistaken for an existing network (which would skip the heal recreate).
    dockerServiceStub.dockerNetworkState.resolves('unknown');
    dockerServiceStub.getFreeFluxAppNetworkOctet.resolves(7);

    await appDockerNetwork.ensureAppDockerNetwork('myapp');

    expect(dockerServiceStub.createFluxAppDockerNetwork.calledOnceWithExactly('myapp', 7)).to.be.true;
  });

  it('legacy app throws if its pinned octet cannot be created', async () => {
    dockerServiceStub.createFluxAppDockerNetwork.resolves(undefined);
    let err;
    try {
      await appDockerNetwork.ensureAppDockerNetwork('fdm');
    } catch (e) { err = e; }

    expect(dockerServiceStub.getFreeFluxAppNetworkOctet.called).to.be.false;
    expect(err).to.be.an('error');
    expect(err.message).to.include('Not possible to create docker application network');
  });

  it('reserves the legacy-pinned octets so a non-legacy app cannot squat one', async () => {
    dockerServiceStub.getFreeFluxAppNetworkOctet.resolves(7);

    await appDockerNetwork.ensureAppDockerNetwork('myapp');

    // the legacy octets are seeded into the exclude set on the very first allocation
    // so the free-octet scan never hands one out: 'fdm'->'m'(109), 'health'->'h'(104),
    // 'Jetpack2'->'2'(50).
    const excluded = [...dockerServiceStub.getFreeFluxAppNetworkOctet.firstCall.args[0]];
    expect(excluded).to.include('m'.charCodeAt(0));
    expect(excluded).to.include('h'.charCodeAt(0));
    expect(excluded).to.include('2'.charCodeAt(0));
  });

  // v9 contract: install-status goes to an onStatus callback, never an express res.
  it('reports an already-exists status through onStatus on the early-return path', async () => {
    dockerServiceStub.dockerNetworkState.resolves('exists');
    const statuses = [];

    await appDockerNetwork.ensureAppDockerNetwork('myapp', { onStatus: (s) => statuses.push(s) });

    expect(statuses.some((s) => s && s.status && s.status.includes('already exists'))).to.be.true;
  });

  it('runs without a status sink, which is how the reconciler heal path calls it', async () => {
    dockerServiceStub.getFreeFluxAppNetworkOctet.resolves(7);

    await appDockerNetwork.ensureAppDockerNetwork('myapp');

    expect(dockerServiceStub.createFluxAppDockerNetwork.calledOnce).to.be.true;
  });
});
