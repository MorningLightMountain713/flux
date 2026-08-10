const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// The allocator is what stops a co-located node hijacking a neighbour's
// transport port, so the tests drive the router's misbehaviours directly: a
// silent overwrite instead of an error, a mapping handed to someone else
// between sweeps, a router that cannot enumerate at all.
describe('meshPortAllocator', () => {
  let allocator;
  let upnp;
  let ports;

  const MY_ADDR = '192.168.1.50';
  const NEIGHBOUR = '192.168.1.60';
  const udpMapping = (port, host) => ({ public: { port }, private: { host, port }, protocol: 'udp' });

  beforeEach(() => {
    const registry = new Map();
    ports = {
      registry,
      getPort: sinon.stub().callsFake(async (i) => registry.get(i) ?? null),
      setPort: sinon.stub().callsFake(async (i, p) => registry.set(i, p)),
      removePort: sinon.stub().callsFake(async (i) => registry.delete(i)),
      allPorts: sinon.stub().callsFake(async () => Object.fromEntries(registry)),
    };
    upnp = {
      isUPNP: sinon.stub().returns(true),
      mapUpnpPort: sinon.stub().resolves(true),
      removeMapUpnpPort: sinon.stub().resolves(true),
      getUpnpMappings: sinon.stub().resolves([]),
      getLocalGatewayAddress: sinon.stub().resolves(MY_ADDR),
    };
    allocator = proxyquire('../../ZelBack/src/services/appMesh/meshPortAllocator', {
      '../upnpService': upnp,
      './meshPorts': ports,
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
    // The map call itself makes the mapping appear on the router unless a
    // test overrides the behaviour — mirroring a well-behaved IGD.
    upnp.mapUpnpPort.callsFake(async (port) => {
      const existing = (await upnp.getUpnpMappings()) || [];
      if (!existing.some((m) => m.public.port === port)) {
        upnp.getUpnpMappings.resolves([...existing, udpMapping(port, MY_ADDR)]);
      }
      return true;
    });
  });

  afterEach(() => sinon.restore());

  it('without UPnP, allocates the lowest free local port and keeps it', async () => {
    upnp.isUPNP.returns(false);
    ports.registry.set('other', 16226);
    const port = await allocator.ensureTransportPort('ab12cd34ef56');
    expect(port).to.equal(16227);
    expect(await allocator.ensureTransportPort('ab12cd34ef56')).to.equal(16227);
    expect(upnp.mapUpnpPort.called).to.equal(false);
  });

  it('maps a free pool port, verifies it points at this node, then records it', async () => {
    upnp.getUpnpMappings.resolves([udpMapping(16226, NEIGHBOUR)]);
    const port = await allocator.ensureTransportPort('ab12cd34ef56', { startOffset: 0 });
    expect(port).to.equal(16227);
    expect(ports.registry.get('ab12cd34ef56')).to.equal(16227);
    expect(upnp.mapUpnpPort.calledWith(16227, 'Flux_Mesh_ab12cd34ef56')).to.equal(true);
  });

  it('a silent overwrite is not ownership: tries the next port, never removes theirs', async () => {
    // Router claims success but the mapping stays the neighbour's.
    upnp.mapUpnpPort.callsFake(async (port) => {
      if (port === 16226) {
        upnp.getUpnpMappings.resolves([udpMapping(16226, NEIGHBOUR)]);
        return true;
      }
      upnp.getUpnpMappings.resolves([udpMapping(16226, NEIGHBOUR), udpMapping(port, MY_ADDR)]);
      return true;
    });
    const port = await allocator.ensureTransportPort('ab12cd34ef56', { startOffset: 0 });
    expect(port).to.equal(16227);
    expect(upnp.removeMapUpnpPort.called).to.equal(false);
  });

  it('an existing verified allocation is kept and refreshed in place', async () => {
    ports.registry.set('ab12cd34ef56', 16240);
    upnp.getUpnpMappings.resolves([udpMapping(16240, MY_ADDR)]);
    const port = await allocator.ensureTransportPort('ab12cd34ef56');
    expect(port).to.equal(16240);
    expect(upnp.mapUpnpPort.calledWith(16240, 'Flux_Mesh_ab12cd34ef56')).to.equal(true);
  });

  it('a hijacked allocation is replaced with a NEW port and the old left alone', async () => {
    ports.registry.set('ab12cd34ef56', 16240);
    upnp.getUpnpMappings.resolves([udpMapping(16240, NEIGHBOUR)]);
    const port = await allocator.ensureTransportPort('ab12cd34ef56', { startOffset: 0 });
    expect(port).to.equal(16226);
    expect(upnp.removeMapUpnpPort.called).to.equal(false);
    const refreshed = await allocator.refreshTransportPorts();
    expect(refreshed).to.deep.equal([]);
  });

  it('the refresh sweep reports which instances had to move', async () => {
    ports.registry.set('appa', 16240);
    ports.registry.set('appb', 16250);
    upnp.getUpnpMappings.resolves([
      udpMapping(16240, MY_ADDR),
      udpMapping(16250, NEIGHBOUR),
    ]);
    const changed = await allocator.refreshTransportPorts();
    expect(changed).to.deep.equal(['appb']);
    expect(ports.registry.get('appa')).to.equal(16240);
    expect(ports.registry.get('appb')).to.not.equal(16250);
  });

  it('a router that cannot enumerate degrades to unverified mapping, loudly', async () => {
    upnp.getUpnpMappings.rejects(new Error('GetGenericPortMappingEntry not supported'));
    upnp.mapUpnpPort.resolves(true);
    const port = await allocator.ensureTransportPort('ab12cd34ef56', { startOffset: 3 });
    expect(port).to.equal(16229);
    expect(ports.registry.get('ab12cd34ef56')).to.equal(16229);
  });

  it('throws when the pool is exhausted rather than fighting for a mapping', async () => {
    const full = [];
    for (let p = 16226; p <= 16299; p += 1) full.push(udpMapping(p, NEIGHBOUR));
    upnp.getUpnpMappings.resolves(full);
    upnp.mapUpnpPort.resolves(true);
    try {
      await allocator.ensureTransportPort('ab12cd34ef56', { startOffset: 0 });
      expect.fail('should throw');
    } catch (error) {
      expect(error.message).to.include('exhausted');
    }
  });

  it('release unmaps only a mapping that is still ours', async () => {
    ports.registry.set('ab12cd34ef56', 16240);
    upnp.getUpnpMappings.resolves([udpMapping(16240, NEIGHBOUR)]);
    await allocator.releaseTransportPort('ab12cd34ef56');
    expect(upnp.removeMapUpnpPort.called).to.equal(false);
    expect(ports.registry.has('ab12cd34ef56')).to.equal(false);

    ports.registry.set('other', 16250);
    upnp.getUpnpMappings.resolves([udpMapping(16250, MY_ADDR)]);
    await allocator.releaseTransportPort('other');
    expect(upnp.removeMapUpnpPort.calledWith(16250)).to.equal(true);
  });

  it('allocatedInstances lists every instance holding a port', async () => {
    expect(await allocator.allocatedInstances()).to.deep.equal([]);
    ports.registry.set('ab12cd34ef56', 16230);
    ports.registry.set('ffeeddccbbaa', 16240);
    expect((await allocator.allocatedInstances()).sort())
      .to.deep.equal(['ab12cd34ef56', 'ffeeddccbbaa']);
  });
});
