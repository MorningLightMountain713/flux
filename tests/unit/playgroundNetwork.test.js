const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const CONFIG = { fluxapps: { playgroundNetworkOctet: 255, playgroundNetworkPrefix: 27 } };

describe('playgroundNetwork', () => {
  let stubs;
  let net;

  function load(opts = {}) {
    stubs = {
      listNetworks: sinon.stub().resolves(opts.networks ?? []),
      createNetwork: sinon.stub().resolves('created'),
      ensurePolicy: sinon.stub().resolves(opts.policyInForce ?? true),
      shapeBridge: sinon.stub().resolves(opts.shaped ?? true),
      removeNetwork: sinon.stub().resolves('removed'),
    };

    net = proxyquire.load('../../ZelBack/src/services/appPlayground/playgroundNetwork', {
      config: CONFIG,
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(),
      },
      '../dockerService': {
        dockerListNetworksByLabel: stubs.listNetworks,
        createFluxAppDockerNetwork: stubs.createNetwork,
        forceRemoveFluxAppDockerNetwork: stubs.removeNetwork,
      },
      './playgroundEgress': {
        BRIDGE_PREFIX: 'flxpg',
        ensureEgressPolicy: stubs.ensurePolicy,
        shapeBridge: stubs.shapeBridge,
      },
    });
    return net;
  }

  const occupied = (...slots) => slots.map((s) => ({
    Options: { 'com.docker.network.bridge.name': `flxpg${s}` },
  }));

  beforeEach(() => { load(); });
  afterEach(() => { sinon.restore(); });

  describe('slot arithmetic', () => {
    // One reserved octet carved into /27s. Reserving whole /24s instead would
    // cost eight octets out of the 255 a node shares with maxAppsPerNode apps.
    it('fits eight sessions in the reserved octet', () => {
      expect(net.slotCount()).to.equal(8);
    });

    it('spaces the subnets so they cannot overlap', () => {
      const bases = [...Array(net.slotCount()).keys()].map((i) => net.slotBase(i));
      expect(bases).to.deep.equal([0, 32, 64, 96, 128, 160, 192, 224]);
    });

    // A /27 is 32 addresses: network, gateway, broadcast and 29 usable. flux-spec
    // hard-caps a spec at 10 components, so that is comfortable.
    it('holds the ten components flux-spec allows, with room over', () => {
      const usable = 32 - 3;
      expect(usable).to.be.greaterThan(10);
    });

    it('names each slot bridge predictably, so the rules can be static', () => {
      expect(net.bridgeFor(0)).to.equal('flxpg0');
      expect(net.bridgeFor(7)).to.equal('flxpg7');
    });
  });

  describe('allocateSlot', () => {
    it('takes the lowest free slot', async () => {
      load({ networks: occupied(0, 1) });
      expect(await net.allocateSlot()).to.equal(2);
    });

    it('fills a gap left by a finished session', async () => {
      load({ networks: occupied(0, 2, 3) });
      expect(await net.allocateSlot()).to.equal(1);
    });

    // Read from docker, not from memory: a restart must not hand out a slot
    // whose network is still there.
    it('reads occupancy from docker rather than from process state', async () => {
      load({ networks: occupied(0) });
      await net.allocateSlot();
      expect(stubs.listNetworks.calledOnce).to.equal(true);
    });

    it('ignores networks that are not playground bridges', async () => {
      load({
        networks: [
          { Options: { 'com.docker.network.bridge.name': 'br-abc123' } },
          { Options: {} },
          {},
        ],
      });
      expect(await net.allocateSlot()).to.equal(0);
    });

    it('reports exhaustion rather than colliding', async () => {
      load({ networks: occupied(0, 1, 2, 3, 4, 5, 6, 7) });
      expect(await net.allocateSlot()).to.equal(null);
    });
  });

  describe('createSessionNetwork', () => {
    it('creates the network on the allocated slot with its own bridge name', async () => {
      const result = await net.createSessionNetwork('op_sess1');

      expect(result).to.deep.equal({
        slot: 0, bridge: 'flxpg0', networkName: 'fluxPlayground_op_sess1', subnet: '172.23.255.0/27',
      });
      const [appName, octet, options] = stubs.createNetwork.firstCall.args;
      // Named and stamped for the SESSION. An app-namespaced name is adopted
      // rather than refused when it already exists, so a session sharing a
      // running app's name would silently share its network - in either
      // direction, and the loser's teardown removes it from under the other.
      expect(appName).to.equal(null);
      expect(octet).to.equal(255);
      expect(options).to.deep.equal({
        prefix: 27,
        base: 0,
        bridgeName: 'flxpg0',
        networkName: 'fluxPlayground_op_sess1',
        labels: { 'io.runonflux.playground': 'op_sess1' },
      });
    });

    it('places a second session on its own subnet and bridge', async () => {
      load({ networks: occupied(0) });
      const result = await net.createSessionNetwork('other');
      expect(result.bridge).to.equal('flxpg1');
      expect(result.subnet).to.equal('172.23.255.32/27');
    });

    // The order is the point: a guest's container must never be attachable to a
    // network whose egress policy is not yet in force.
    it('puts the egress policy in force before creating the network', async () => {
      await net.createSessionNetwork('demoapp');
      expect(stubs.ensurePolicy.calledBefore(stubs.createNetwork)).to.equal(true);
    });

    it('refuses to run a session at all when the egress policy cannot be applied', async () => {
      load({ policyInForce: false });
      let threw = null;
      await net.createSessionNetwork('demoapp').catch((e) => { threw = e; });
      expect(threw).to.be.an('error');
      expect(threw.message).to.include('egress policy');
      expect(stubs.createNetwork.called).to.equal(false);
    });

    it('refuses when every slot is taken, and says to try another node', async () => {
      load({ networks: occupied(0, 1, 2, 3, 4, 5, 6, 7) });
      let threw = null;
      await net.createSessionNetwork('demoapp').catch((e) => { threw = e; });
      expect(threw.kind).to.equal('busy');
      expect(threw.message).to.include('another node');
    });

    it('shapes the bridge it just created', async () => {
      await net.createSessionNetwork('demoapp');
      expect(stubs.shapeBridge.calledOnceWith('flxpg0')).to.equal(true);
    });

    // A failed rate cap is not fatal — containment is the egress policy's job,
    // and the duty cycle still bounds the session.
    it('runs on without a rate cap rather than failing the session', async () => {
      load({ shaped: false });
      const result = await net.createSessionNetwork('demoapp');
      expect(result.bridge).to.equal('flxpg0');
    });
  });

  // The app debris sweep used to collect these incidentally, while a session
  // network was named like an app's and read as unowned. It cannot see them any
  // more, and a leaked one holds its bridge slot for the life of the node — so
  // the playground has to sweep its own.
  describe('reapOrphanNetworks', () => {
    const labelled = (...ids) => ids.map((id) => ({
      Name: `fluxPlayground_${id}`,
      Labels: { 'io.runonflux.playground': id },
    }));

    it('removes the networks no live session claims', async () => {
      load({ networks: labelled('op_gone') });
      const result = await net.reapOrphanNetworks(new Set());

      expect(result.removed).to.equal(1);
      expect(stubs.removeNetwork.calledOnceWith(null, { networkName: 'fluxPlayground_op_gone' })).to.equal(true);
    });

    it('leaves a live session alone', async () => {
      load({ networks: labelled('op_live') });
      const result = await net.reapOrphanNetworks(new Set(['op_live']));

      expect(result.removed).to.equal(0);
      expect(stubs.removeNetwork.called).to.equal(false);
    });

    // Sessions live only in memory, so after a restart nothing is live and every
    // labelled network is by definition abandoned.
    it('collects the lot after a restart, when nothing is live', async () => {
      load({ networks: labelled('op_a', 'op_b', 'op_c') });
      const result = await net.reapOrphanNetworks(new Set());
      expect(result.removed).to.equal(3);
    });

    it('keeps going when one removal fails', async () => {
      load({ networks: labelled('op_a', 'op_b') });
      stubs.removeNetwork.onFirstCall().rejects(new Error('in use'));

      const result = await net.reapOrphanNetworks(new Set());
      expect(result.removed).to.equal(1);
    });

    it('never throws when docker cannot list networks', async () => {
      load();
      stubs.listNetworks.rejects(new Error('docker down'));
      expect(await net.reapOrphanNetworks(new Set())).to.deep.equal({ removed: 0, networks: [] });
    });
  });
});
