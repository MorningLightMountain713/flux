// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const Dockerode = require('dockerode');
const sinon = require('sinon');
const path = require('path');
const { PassThrough } = require('stream');
const dockerService = require('../../ZelBack/src/services/dockerService');
const operationRegistry = require('../../ZelBack/src/services/utils/operationRegistry');
const appVolumeService = require('../../ZelBack/src/services/appLifecycle/appVolumeService');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');

chai.use(chaiAsPromised);
const { expect } = chai;

// Almost everything here reaches docker only to turn a name into a container
// handle - getDockerContainer lists containers and matches on Names[0] - and
// then asserts something we own: which docker call was made, how a lease was
// held, how an error was classified. Those need a container to EXIST, not a
// container to be RUNNING, so the listing is stubbed and the suite no longer
// depends on a fixture container started by the npm script.
//
// The few tests whose subject really is docker's own behaviour say so, and
// stub only as far as the boundary they are testing.
const FIXTURE_ID = '46274c58c9a969e93c1f91a057f0a371c7b952e31a7aec73839afe1433fdee94';
const FIXTURE_NAME = 'fluxwebsite';

/** One entry, shaped as docker lists it, for the container the tests name. */
function fixtureListing(overrides = {}) {
  return [{
    Id: FIXTURE_ID,
    Names: [`/${FIXTURE_NAME}`],
    Image: 'runonflux/website',
    State: 'running',
    ...overrides,
  }];
}

/**
 * Set what docker reports, whether or not the listing is already stubbed - the
 * suite-wide hook below gets there first, and a test wanting its own listing
 * must be able to say so without tripping over it.
 */
function stubListing(entries) {
  const { listContainers } = Dockerode.prototype;
  if (listContainers.restore) return listContainers.resolves(entries);
  return sinon.stub(Dockerode.prototype, 'listContainers').resolves(entries);
}

describe('dockerService tests', () => {
  beforeEach(() => {
    stubListing(fixtureListing());
  });

  // Suite-wide, because several nested suites had no restore of their own and a
  // stub leaking into the next test shows up as "already wrapped" somewhere
  // unrelated. Runs after any nested afterEach, and restoring twice is harmless.
  afterEach(() => {
    sinon.restore();
  });

  describe('getDockerContainerHandle tests', () => {
    it('should return a container with a proper ID', () => {
      const dockerContainer = dockerService.getDockerContainerHandle('46274c58c9a969e93c1f91a057f0a371c7b952e31a7aec73839afe1433fdee94');

      expect(dockerContainer.id).to.be.a('string');
      expect(dockerContainer.defaultOptions).to.exist;
      expect(dockerContainer.modem).to.exist;
    });
  });

  describe('getAppIdentifier tests', () => {
    it('should return the same name if starts with "flux"', async () => {
      const appName = 'fluxTesting';

      const result = dockerService.getAppIdentifier(appName);

      expect(result).to.equal(appName);
    });

    it('should add "flux" to app identifier with any other name', async () => {
      const appName = 'testing1234';
      const expected = 'fluxtesting1234';

      const result = dockerService.getAppIdentifier(appName);

      expect(result).to.equal(expected);
    });

    it('should handle empty app name', async () => {
      const appName = '';
      const expected = 'flux';

      const result = dockerService.getAppIdentifier(appName);

      expect(result).to.equal(expected);
    });
  });

  describe('getBaseAppName tests', () => {
    it('should strip the "flux" prefix', async () => {
      expect(dockerService.getBaseAppName('fluxdb_App')).to.equal('db_App');
    });

    it('should return a bare identifier unchanged', async () => {
      expect(dockerService.getBaseAppName('db_App')).to.equal('db_App');
    });

    it('should round-trip getAppIdentifier for compose and single-component names', async () => {
      ['db_App', 'testing1234', 'KadenaChainWebNode'].forEach((bare) => {
        expect(dockerService.getBaseAppName(dockerService.getAppIdentifier(bare))).to.equal(bare);
      });
    });
  });

  describe('getAppDockerNameIdentifier tests', () => {
    it('should add /flux/ if name starts with "/"', async () => {
      const appName = '/Testing';
      const expected = '/flux/Testing';

      const result = dockerService.getAppDockerNameIdentifier(appName);

      expect(result).to.equal(expected);
    });

    it('should add "/flux" to app identifier with any other name', async () => {
      const appName = 'testing1234';
      const expected = '/fluxtesting1234';

      const result = dockerService.getAppDockerNameIdentifier(appName);

      expect(result).to.equal(expected);
    });

    it('should handle empty app name', async () => {
      const appName = '';
      const expected = '/flux';

      const result = dockerService.getAppDockerNameIdentifier(appName);

      expect(result).to.equal(expected);
    });
  });

  describe('dockerCreateNetwork tests', () => {
    let network;
    const options = {
      name: 'Testnetwork',
    };

    afterEach(async () => {
      await dockerService.dockerRemoveNetwork(network);
    });

    it('Should create a network object', async () => {
      network = await dockerService.dockerCreateNetwork(options);

      expect(network).to.be.an('object');
      expect(network.id).to.be.a('string');
    });
  });

  describe('dockerRemoveNetwork tests', () => {
    let network;
    const options = {
      name: 'Testnetwork',
    };

    beforeEach(async () => {
      network = await dockerService.dockerCreateNetwork(options);
    });

    afterEach(async () => {
      try {
        await dockerService.dockerRemoveNetwork(network);
      } catch {
        // already removed by test
      }
    });

    it('should remove a network', async () => {
      const result = await dockerService.dockerRemoveNetwork(network);

      expect(result).to.be.instanceOf(Buffer);
      expect(result).to.be.empty;
    });
  });

  describe('dockerNetworkInspect tests', () => {
    let network;
    const options = {
      name: 'Testnetwork',
    };

    beforeEach(async () => {
      network = await dockerService.dockerCreateNetwork(options);
    });

    afterEach(async () => {
      await dockerService.dockerRemoveNetwork(network);
    });

    it('should return an inspect network object', async () => {
      const result = await dockerService.dockerNetworkInspect(network);

      expect(result.Name).to.equal(options.name);
      expect(result.Id).to.be.a('string');
      expect(result.EnableIPv6).to.be.false;
    });
  });

  describe('dockerListContainers tests', () => {
    it('should return a list of containers', async () => {
      let fluxContainer;

      const result = await dockerService.dockerListContainers();
      result.forEach((container) => {
        if (container.Image === 'runonflux/website') fluxContainer = container;
      });

      expect(fluxContainer.Id).to.be.a('string');
      expect(fluxContainer.Image).to.equal('runonflux/website');
      expect(fluxContainer.Names[0]).to.equal('/fluxwebsite');
      expect(fluxContainer.State).to.equal('running');
    });

    it('should return a list of containers with an option all = true', async () => {
      let fluxContainer;

      const result = await dockerService.dockerListContainers(true);
      result.forEach((container) => {
        if (container.Image === 'runonflux/website') fluxContainer = container;
      });

      expect(fluxContainer.Id).to.be.a('string');
      expect(fluxContainer.Image).to.equal('runonflux/website');
      expect(fluxContainer.Names[0]).to.equal('/fluxwebsite');
      expect(fluxContainer.State).to.equal('running');
    });
  });

  describe('dockerListImages tests', () => {
    it('should return a list of containers', async () => {
      let fluxImage;

      const result = await dockerService.dockerListImages();
      result.forEach((image) => {
        if (image.RepoTags.length && image.RepoTags[0].includes('runonflux/website')) fluxImage = image;
      });

      expect(fluxImage).to.exist;
      expect(fluxImage.RepoDigests[0]).to.include('runonflux/website');
      expect(fluxImage.Id).to.be.a('string');
    });
  });

  describe('dockerContainerInspect tests', () => {
    it('resolves the name to its container and returns what docker reports', async () => {
      // What this owns is the resolution and the hand-back. Asserting the shape
      // of docker's inspect payload would be testing dockerode, not us.
      const payload = { Id: FIXTURE_ID, State: { Status: 'running' }, Config: { Image: 'runonflux/website' } };
      const inspect = sinon.stub(Dockerode.Container.prototype, 'inspect').resolves(payload);

      const result = await dockerService.dockerContainerInspect('website');

      expect(result).to.equal(payload);
      expect(inspect.calledOnce).to.equal(true);
    });

    it('passes inspect options through untouched', async () => {
      const inspect = sinon.stub(Dockerode.Container.prototype, 'inspect').resolves({});

      await dockerService.dockerContainerInspect('website', { size: true });

      expect(inspect.firstCall.args[0]).to.deep.equal({ size: true });
    });

    it('should throw error if the container does not exist', async () => {
      const containerName = 'testing1234';

      const result = await dockerService.dockerContainerInspect(containerName);
      expect(result).to.be.null;
    });
  });

  describe('classifyContainerNetworkAttachment / isContainerDetachedFromNetwork tests', () => {
    it('reports attached when the managed network carries an IP', () => {
      const attachment = dockerService.classifyContainerNetworkAttachment({
        HostConfig: { NetworkMode: 'fluxDockerNetwork_appx' },
        State: { Running: true },
        NetworkSettings: { Networks: { fluxDockerNetwork_appx: { IPAddress: '172.23.0.5' } } },
      });

      expect(attachment).to.deep.equal({
        managed: true, running: true, networkMode: 'fluxDockerNetwork_appx', attached: true,
      });
      expect(dockerService.isContainerDetachedFromNetwork(attachment)).to.equal(false);
    });

    it('flags a running managed container with an empty Networks as detached', () => {
      const attachment = dockerService.classifyContainerNetworkAttachment({
        HostConfig: { NetworkMode: 'fluxDockerNetwork_appx' },
        State: { Running: true },
        NetworkSettings: { Networks: {} },
      });

      expect(attachment.managed).to.equal(true);
      expect(attachment.attached).to.equal(false);
      expect(dockerService.isContainerDetachedFromNetwork(attachment)).to.equal(true);
    });

    it('flags detached when the endpoint exists but has no IP (half-programmed)', () => {
      const attachment = dockerService.classifyContainerNetworkAttachment({
        HostConfig: { NetworkMode: 'fluxDockerNetwork_appx' },
        State: { Running: true },
        NetworkSettings: { Networks: { fluxDockerNetwork_appx: { IPAddress: '' } } },
      });

      expect(dockerService.isContainerDetachedFromNetwork(attachment)).to.equal(true);
    });

    it('does not flag a stopped container as detached', () => {
      const attachment = dockerService.classifyContainerNetworkAttachment({
        HostConfig: { NetworkMode: 'fluxDockerNetwork_appx' },
        State: { Running: false },
        NetworkSettings: { Networks: {} },
      });

      expect(attachment.running).to.equal(false);
      expect(dockerService.isContainerDetachedFromNetwork(attachment)).to.equal(false);
    });

    it('never flags a non-managed (host-networked) container as detached', () => {
      const attachment = dockerService.classifyContainerNetworkAttachment({
        HostConfig: { NetworkMode: 'host' },
        State: { Running: true },
        NetworkSettings: { Networks: {} },
      });

      expect(attachment.managed).to.equal(false);
      expect(dockerService.isContainerDetachedFromNetwork(attachment)).to.equal(false);
    });

    it('tolerates a partial/empty inspect object', () => {
      const attachment = dockerService.classifyContainerNetworkAttachment({});
      expect(attachment).to.deep.equal({
        managed: false, running: false, networkMode: null, attached: false,
      });
    });

    it('isContainerDetachedFromNetwork tolerates missing input', () => {
      expect(dockerService.isContainerDetachedFromNetwork(undefined)).to.equal(false);
      expect(dockerService.isContainerDetachedFromNetwork(null)).to.equal(false);
    });
  });

  describe('dockerNetworkState tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('reports exists when the network inspects cleanly', async () => {
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ inspect: sinon.stub().resolves({ Name: 'fluxDockerNetwork_appx' }) });

      await expect(dockerService.dockerNetworkState('fluxDockerNetwork_appx')).to.eventually.equal('exists');
    });

    it('reports absent only when docker itself confirms the network is not listed', async () => {
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ inspect: sinon.stub().rejects(new Error('no such network')) });
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves([{ Name: 'bridge' }, { Name: 'fluxDockerNetwork_other' }]);

      await expect(dockerService.dockerNetworkState('fluxDockerNetwork_appx')).to.eventually.equal('absent');
    });

    it('reports exists when the inspect failed transiently but the network IS listed', async () => {
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ inspect: sinon.stub().rejects(new Error('EAI_AGAIN')) });
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves([{ Name: 'fluxDockerNetwork_appx' }]);

      await expect(dockerService.dockerNetworkState('fluxDockerNetwork_appx')).to.eventually.equal('exists');
    });

    it('reports unknown (never absent) when docker cannot answer at all', async () => {
      // the caller destroys a container on "absent", so an unreachable daemon must
      // never be read as a missing network
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ inspect: sinon.stub().rejects(new Error('connect ENOENT /var/run/docker.sock')) });
      sinon.stub(Dockerode.prototype, 'listNetworks').rejects(new Error('connect ENOENT /var/run/docker.sock'));

      await expect(dockerService.dockerNetworkState('fluxDockerNetwork_appx')).to.eventually.equal('unknown');
    });
  });

  describe('getFreeFluxAppNetworkOctet tests', () => {
    const net = (subnet) => ({ Name: 'fluxDockerNetwork_x', IPAM: { Config: [{ Subnet: subnet }] } });

    afterEach(() => {
      sinon.restore();
    });

    it('returns the lowest free octet (1) when only the base network exists', async () => {
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves([net('172.23.0.0/24')]);

      await expect(dockerService.getFreeFluxAppNetworkOctet()).to.eventually.equal(1);
    });

    it('returns the first gap when low octets are already taken', async () => {
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves(
        ['172.23.0.0/24', '172.23.1.0/24', '172.23.2.0/24', '172.23.4.0/24'].map(net),
      );

      await expect(dockerService.getFreeFluxAppNetworkOctet()).to.eventually.equal(3);
    });

    it('ignores subnets outside the 172.23.x.0/24 app range', async () => {
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves(
        ['172.23.1.0/24', '10.0.0.0/24', null].map(net),
      );

      // only octet 1 is a used app subnet, so 2 is the lowest free
      await expect(dockerService.getFreeFluxAppNetworkOctet()).to.eventually.equal(2);
    });

    it('returns null when every 172.23.x.0/24 block is taken', async () => {
      const all = [];
      for (let octet = 0; octet <= 255; octet += 1) all.push(net(`172.23.${octet}.0/24`));
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves(all);

      await expect(dockerService.getFreeFluxAppNetworkOctet()).to.eventually.be.null;
    });

    it('counts NON-flux networks too (docker enforces global subnet uniqueness)', async () => {
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves([
        { Name: 'bridge', IPAM: { Config: [{ Subnet: '172.23.1.0/24' }] } },
        net('172.23.2.0/24'),
      ]);

      // octet 1 (a non-flux network) and 2 (flux) are both used -> 3 is lowest free
      await expect(dockerService.getFreeFluxAppNetworkOctet()).to.eventually.equal(3);
    });

    it('treats excluded octets as used (collision-retry advancement)', async () => {
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves([net('172.23.0.0/24')]);

      await expect(dockerService.getFreeFluxAppNetworkOctet(new Set([1, 2, 3]))).to.eventually.equal(4);
    });

    it('tolerates networks with no IPAM config', async () => {
      sinon.stub(Dockerode.prototype, 'listNetworks').resolves([
        { Name: 'host' },
        { Name: 'none', IPAM: {} },
        net('172.23.1.0/24'),
      ]);

      await expect(dockerService.getFreeFluxAppNetworkOctet()).to.eventually.equal(2);
    });
  });

  describe('dockerContainerStats tests', () => {
    it('asks for a single sample, not a stream, and returns it', async () => {
      // `stream: false` is the part that matters: asking without it hands back
      // an open stream and the caller waits forever.
      const payload = { name: `/${FIXTURE_NAME}`, cpu_stats: {}, memory_stats: {} };
      const stats = sinon.stub(Dockerode.Container.prototype, 'stats').resolves(payload);

      const result = await dockerService.dockerContainerStats('website');

      expect(result).to.equal(payload);
      expect(stats.firstCall.args[0]).to.include({ stream: false });
    });

    it('should throw error if the container does not exist', async () => {
      const containerName = 'test';

      const result = await dockerService.dockerContainerStats(containerName);
      expect(result).to.be.null;
    });
  });

  describe('dockerContainerChanges tests', () => {
    it('returns the filesystem changes docker reports', async () => {
      const payload = [{ Path: '/var/log/nginx', Kind: 0 }];
      sinon.stub(Dockerode.Container.prototype, 'changes').resolves(payload);

      const result = await dockerService.dockerContainerChanges('website');

      expect(result).to.equal(payload);
    });

    it('should throw error if the container does not exist', async () => {
      const containerName = 'test';

      const result = await dockerService.dockerContainerChanges(containerName);
      expect(result).to.be.null;
    });
  });

  describe('dockerContainerLogsStream tests', () => {
    // Docker multiplexes stdout and stderr down one connection, each write
    // prefixed with an 8-byte header: stream id, three zero bytes, then a
    // big-endian length. This is docker's wire format, not a convenience of the
    // test - feeding it is what makes the demux assertion mean anything.
    function dockerFrame(text, streamId = 1) {
      const payload = Buffer.from(text, 'utf8');
      const header = Buffer.alloc(8);
      header.writeUInt8(streamId, 0);
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    }

    function stubLogs() {
      const raw = new PassThrough();
      const logs = sinon.stub(Dockerode.Container.prototype, 'logs').resolves(raw);
      return { raw, logs };
    }

    function collect(stream) {
      return new Promise((resolve) => {
        let text = '';
        stream.on('data', (chunk) => { text += chunk.toString('utf8'); });
        stream.on('end', () => resolve(text));
      });
    }

    it('follows, and forwards the options it was given', async () => {
      const { logs } = stubLogs();

      const follow = await dockerService.dockerContainerLogsStream('website', { tail: 10, timestamps: true });

      expect(follow.stream).to.exist;
      expect(follow.stop).to.be.a('function');
      expect(logs.firstCall.args[0]).to.include({
        follow: true, stdout: true, stderr: true, tail: 10, timestamps: true,
      });
    });

    it('strips docker frame headers rather than passing them through', async () => {
      const { raw } = stubLogs();
      const follow = await dockerService.dockerContainerLogsStream('website');
      const collected = collect(follow.stream);

      raw.write(dockerFrame('hello from stdout\n'));
      raw.write(dockerFrame('and from stderr\n', 2));
      raw.end();

      const text = await collected;
      expect(text).to.equal('hello from stdout\nand from stderr\n');
    });

    it('ends its stream when docker ends the connection', async () => {
      // A short-lived container's log simply finishing is the normal case, not
      // a failure, so this has to surface as an end rather than an error.
      const { raw } = stubLogs();
      const follow = await dockerService.dockerContainerLogsStream('website');
      const collected = collect(follow.stream);

      raw.write(dockerFrame('done\n'));
      raw.end();

      expect(await collected).to.equal('done\n');
    });

    it('stop ends the stream, after what is already buffered', async () => {
      // stop() ends rather than destroys, so a consumer still receives whatever
      // had arrived - which also means the end only surfaces once something is
      // reading, exactly as any piped stream behaves.
      const { raw } = stubLogs();
      const follow = await dockerService.dockerContainerLogsStream('website');
      const collected = collect(follow.stream);

      raw.write(dockerFrame('last words\n'));
      follow.stop();

      expect(await collected).to.equal('last words\n');
    });

    it('rejects for a container that does not exist', async () => {
      // Unlike dockerContainerLogs, which answers null: there is no stream to
      // hand back, and a caller about to pipe one needs to know now.
      let error = null;
      try {
        await dockerService.dockerContainerLogsStream('testing1234');
      } catch (err) {
        error = err;
      }
      expect(error).to.be.an('error');
      expect(error.message).to.include('not found');
    });
  });

  describe('appDockerStart tests', () => {
    const appName = 'website';
    let dockerStub;
    let getContainerSpy;

    beforeEach(() => {
      dockerStub = sinon.stub(Dockerode.Container.prototype, 'start').returns(Promise.resolve('started'));
      getContainerSpy = sinon.spy(Dockerode.prototype, 'getContainer');
    });

    afterEach(() => {
      dockerStub.restore();
      getContainerSpy.restore();
    });

    it('should call a docker start command', async () => {
      const startResult = await dockerService.appDockerStart(appName);

      sinon.assert.calledOnce(dockerStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(startResult).to.equal('Flux App website successfully started.');
    });

    it('should throw error if app name is not correct or app does not exist', async () => {
      await expect(dockerService.appDockerStart('testing123')).to.eventually.be.rejectedWith('Container testing123 not found');
    });

    // A container that vanishes between the caller's state read and the start (an
    // out-of-band docker rm mid-pass) is not a crash of the workload: the tag lets
    // the reconciler skip recording a restart attempt (which would advance the
    // crash ladder for a removal the workload didn't cause).
    it('tags a vanished container ENOCONTAINER so callers treat it as gone, not crashed', async () => {
      const err = await dockerService.appDockerStart('testing123').catch((e) => e);
      expect(err.code).to.equal('ENOCONTAINER');
    });

    it('tags docker\'s removal-in-progress rejection ENOCONTAINER (the same rm window, caught by docker itself)', async () => {
      const conflict = new Error('(HTTP code 409) unexpected - removal of container website is already in progress');
      conflict.statusCode = 409;
      dockerStub.rejects(conflict);
      const err = await dockerService.appDockerStart(appName).catch((e) => e);
      expect(err.code).to.equal('ENOCONTAINER');
    });

    it('does not tag an unrelated start failure (a genuine crash must still walk the ladder)', async () => {
      dockerStub.rejects(new Error('oci runtime error: exec format error'));
      const err = await dockerService.appDockerStart(appName).catch((e) => e);
      expect(err.code).to.be.undefined;
    });

    // Docker answers a networking failure with a 404 worded as if the CONTAINER
    // were missing. It is not - it is right there, and its network is gone. Tagged
    // ENOCONTAINER this defers on a paced retry forever: never recording the
    // failure, never advancing the ladder, never fail-converging, so the app sits
    // down silently. This exact shape wedged an app in production.
    it('does not tag a start that failed to set up networking, however much its 404 reads like a missing container', async () => {
      const netErr = new Error('(HTTP code 404) no such container - failed to set up container networking: network 0177b93c28af not found ');
      netErr.statusCode = 404;
      dockerStub.rejects(netErr);
      const err = await dockerService.appDockerStart(appName).catch((e) => e);
      expect(err.code, 'a missing network is a real start failure, not a vanished container').to.be.undefined;
    });

    // The 'actuating' lease makes a start mutually exclusive with a concurrent
    // teardown's remove: held across the start (a die inside it is a real crash, NOT
    // swallowed) and released own-lease-only when it settles.
    it('holds the actuating lease during the start and releases it on completion', async () => {
      operationRegistry.clear();
      const leaseKey = dockerService.getAppIdentifier(appName);
      let leasedDuringStart = false;
      dockerStub.callsFake(async () => {
        leasedDuringStart = operationRegistry.get(leaseKey)?.type === 'actuating';
        return 'started';
      });

      await dockerService.appDockerStart(appName);

      expect(leasedDuringStart, 'the actuating lease must be held while the start is in flight').to.be.true;
      expect(operationRegistry.isHeld(leaseKey), 'the actuating lease must release when the start settles').to.be.false;
    });

    it('releases the actuating lease when the start throws', async () => {
      operationRegistry.clear();
      dockerStub.rejects(new Error('no such image'));

      await expect(dockerService.appDockerStart(appName)).to.eventually.be.rejected;
      expect(operationRegistry.isHeld(dockerService.getAppIdentifier(appName)), 'the lease must release even when the start throws').to.be.false;
    });

    // Fail-closed: a start must NEVER race a teardown that already holds the component
    // key. It throws a structured ETRANSITIONHELD (keyed on err.code, no string-match)
    // and touches neither docker nor the foreign lease.
    it('defers (throws ETRANSITIONHELD) and does not start when a teardown holds the removing lease', async () => {
      operationRegistry.clear();
      const leaseKey = dockerService.getAppIdentifier(appName);
      operationRegistry.acquire(leaseKey, 'removing', 'appUninstaller', 'test teardown');

      const err = await dockerService.appDockerStart(appName).then(() => null, (e) => e);
      expect(err, 'a start must reject while a removing lease is held').to.be.an('error');
      expect(err.code).to.equal('ETRANSITIONHELD');
      sinon.assert.notCalled(dockerStub);
      expect(operationRegistry.get(leaseKey)?.type, 'the foreign lease must be untouched (own-lease-only)').to.equal('removing');
      operationRegistry.clear();
    });
  });

  describe('appDockerStop tests', () => {
    const appName = 'website';
    let dockerStopStub;
    let dockerInspectStub;
    let getContainerSpy;

    beforeEach(() => {
      dockerStopStub = sinon.stub(Dockerode.Container.prototype, 'stop').returns(Promise.resolve('stopped'));
      dockerInspectStub = sinon.stub(Dockerode.Container.prototype, 'inspect').returns(Promise.resolve({ State: { Running: true } }));
      getContainerSpy = sinon.spy(Dockerode.prototype, 'getContainer');
    });

    afterEach(() => {
      dockerStopStub.restore();
      dockerInspectStub.restore();
      getContainerSpy.restore();
    });

    it('should call a docker stop command when container is running', async () => {
      const stopResult = await dockerService.appDockerStop(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.calledOnce(dockerStopStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(stopResult).to.equal('Flux App website successfully stopped.');
    });

    it('should not call docker stop when container is already stopped', async () => {
      dockerInspectStub.returns(Promise.resolve({ State: { Running: false } }));

      const stopResult = await dockerService.appDockerStop(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.notCalled(dockerStopStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(stopResult).to.equal('Flux App website is already stopped.');
    });

    it('should not call docker stop when container is in created state', async () => {
      dockerInspectStub.returns(Promise.resolve({ State: { Running: false, Status: 'created' } }));

      const stopResult = await dockerService.appDockerStop(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.notCalled(dockerStopStub);
      expect(stopResult).to.equal('Flux App website is already stopped.');
    });

    it('should stop container when in paused state (Running: true)', async () => {
      dockerInspectStub.returns(Promise.resolve({ State: { Running: true, Paused: true } }));

      const stopResult = await dockerService.appDockerStop(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.calledOnce(dockerStopStub);
      expect(stopResult).to.equal('Flux App website successfully stopped.');
    });

    it('should throw error if app name is not correct or app does not exist', async () => {
      await expect(dockerService.appDockerStop('testing123')).to.eventually.be.rejectedWith('Container testing123 not found');
    });

    // The stopping flag's lifetime is the STOP OPERATION's lifetime - held while
    // container.stop() is in flight (legitimately hours under v9 graceful
    // shutdown) and cleared when the operation settles. Clearing must never
    // depend on the docker die event being delivered: a lost event (stream down)
    // would otherwise leak the flag forever and permanently wedge the
    // reconciler's actuation for that component.
    it('holds the stopping lease during the stop and releases it on completion', async () => {
      operationRegistry.clear();
      const leaseKey = dockerService.getAppIdentifier(appName);
      let leasedDuringStop = false;
      dockerStopStub.callsFake(async () => {
        // the component 'stopping' lease is held for the duration of the stop so the
        // die handler swallows it and the reconciler defers
        leasedDuringStop = operationRegistry.get(leaseKey)?.type === 'stopping';
        return 'stopped';
      });

      await dockerService.appDockerStop(appName);

      expect(leasedDuringStop, 'the stopping lease must be held while the stop is in flight').to.be.true;
      expect(operationRegistry.isHeld(leaseKey), 'the stopping lease must release when the operation settles - the die event must not be its only janitor').to.be.false;
    });

    it('releases the stopping lease when the stop operation throws', async () => {
      operationRegistry.clear();
      dockerStopStub.rejects(new Error('socket hang up'));

      await expect(dockerService.appDockerStop(appName)).to.eventually.be.rejected;
      expect(operationRegistry.isHeld(dockerService.getAppIdentifier(appName)), 'the lease must release even when the stop throws').to.be.false;
    });

    // Fail-closed against a concurrent start: a stop must not race an 'actuating'
    // create/start (its old unconditional release used to clobber that lease). It
    // throws ETRANSITIONHELD and leaves docker + the foreign lease untouched.
    it('defers (throws ETRANSITIONHELD) and does not stop when a start holds the actuating lease', async () => {
      operationRegistry.clear();
      const leaseKey = dockerService.getAppIdentifier(appName);
      operationRegistry.acquire(leaseKey, 'actuating', 'appReconciler', 'test start');

      const err = await dockerService.appDockerStop(appName).then(() => null, (e) => e);
      expect(err, 'a stop must reject while an actuating lease is held').to.be.an('error');
      expect(err.code).to.equal('ETRANSITIONHELD');
      sinon.assert.notCalled(dockerStopStub);
      expect(operationRegistry.get(leaseKey)?.type, 'the foreign actuating lease must be untouched').to.equal('actuating');
      operationRegistry.clear();
    });
  });

  describe('appDockerRestart tests', () => {
    const appName = 'website';
    let dockerRestartStub;
    let dockerStartStub;
    let dockerInspectStub;
    let getContainerSpy;

    beforeEach(() => {
      dockerRestartStub = sinon.stub(Dockerode.Container.prototype, 'restart').returns(Promise.resolve('restarted'));
      dockerStartStub = sinon.stub(Dockerode.Container.prototype, 'start').returns(Promise.resolve('started'));
      dockerInspectStub = sinon.stub(Dockerode.Container.prototype, 'inspect').returns(Promise.resolve({ State: { Running: true } }));
      getContainerSpy = sinon.spy(Dockerode.prototype, 'getContainer');
    });

    afterEach(() => {
      dockerRestartStub.restore();
      dockerStartStub.restore();
      dockerInspectStub.restore();
      getContainerSpy.restore();
    });

    it('should call a docker restart command when container is running', async () => {
      const restartResult = await dockerService.appDockerRestart(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.calledOnce(dockerRestartStub);
      sinon.assert.notCalled(dockerStartStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(restartResult).to.equal('Flux App website successfully restarted.');
    });

    it('should call docker start instead of restart when container is stopped', async () => {
      dockerInspectStub.returns(Promise.resolve({ State: { Running: false } }));

      const restartResult = await dockerService.appDockerRestart(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.notCalled(dockerRestartStub);
      sinon.assert.calledOnce(dockerStartStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(restartResult).to.equal('Flux App website was stopped, successfully started.');
    });

    it('should call start when container is in created state (never started)', async () => {
      dockerInspectStub.returns(Promise.resolve({ State: { Running: false, Status: 'created' } }));

      const restartResult = await dockerService.appDockerRestart(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.notCalled(dockerRestartStub);
      sinon.assert.calledOnce(dockerStartStub);
      expect(restartResult).to.equal('Flux App website was stopped, successfully started.');
    });

    it('should call start when container is in exited state', async () => {
      dockerInspectStub.returns(Promise.resolve({ State: { Running: false, Status: 'exited', ExitCode: 0 } }));

      const restartResult = await dockerService.appDockerRestart(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.notCalled(dockerRestartStub);
      sinon.assert.calledOnce(dockerStartStub);
      expect(restartResult).to.equal('Flux App website was stopped, successfully started.');
    });

    it('should restart container when in paused state (Running: true)', async () => {
      dockerInspectStub.returns(Promise.resolve({ State: { Running: true, Paused: true } }));

      const restartResult = await dockerService.appDockerRestart(appName);

      sinon.assert.calledOnce(dockerInspectStub);
      sinon.assert.calledOnce(dockerRestartStub);
      sinon.assert.notCalled(dockerStartStub);
      expect(restartResult).to.equal('Flux App website successfully restarted.');
    });

    it('should throw error if app name is not correct or app does not exist', async () => {
      await expect(dockerService.appDockerRestart('testing123')).to.eventually.be.rejectedWith('Container testing123 not found');
    });
  });

  describe('appDockerKill tests', () => {
    const appName = 'website';
    let dockerStub;
    let getContainerSpy;

    beforeEach(() => {
      dockerStub = sinon.stub(Dockerode.Container.prototype, 'kill').returns(Promise.resolve('kiled'));
      getContainerSpy = sinon.spy(Dockerode.prototype, 'getContainer');
    });

    afterEach(() => {
      dockerStub.restore();
      getContainerSpy.restore();
    });

    it('should call a docker kill command', async () => {
      const killResult = await dockerService.appDockerKill(appName);

      sinon.assert.calledOnce(dockerStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(killResult).to.equal('Flux App website successfully killed.');
    });

    it('should throw error if app name is not correct or app does not exist', async () => {
      await expect(dockerService.appDockerKill('testing123')).to.eventually.be.rejectedWith('Container testing123 not found');
    });

    // same flag-lifetime contract as appDockerStop: held during the kill
    // operation, cleared when it settles, never reliant on the die event
    it('holds the stopping lease during the kill and releases it on completion', async () => {
      operationRegistry.clear();
      const leaseKey = dockerService.getAppIdentifier(appName);
      let leasedDuringKill = false;
      dockerStub.callsFake(async () => {
        leasedDuringKill = operationRegistry.get(leaseKey)?.type === 'stopping';
        return 'killed';
      });

      await dockerService.appDockerKill(appName);

      expect(leasedDuringKill, 'the stopping lease must be held while the kill is in flight').to.be.true;
      expect(operationRegistry.isHeld(leaseKey), 'the stopping lease must release when the operation settles').to.be.false;
    });
  });

  describe('appDockerRemove tests', () => {
    const appName = 'website';
    let dockerStub;
    let getContainerSpy;

    beforeEach(() => {
      dockerStub = sinon.stub(Dockerode.Container.prototype, 'remove').returns(Promise.resolve('removed'));
      getContainerSpy = sinon.spy(Dockerode.prototype, 'getContainer');
    });

    afterEach(() => {
      dockerStub.restore();
      getContainerSpy.restore();
    });

    it('should call a docker remove command', async () => {
      const removeResult = await dockerService.appDockerRemove(appName);

      sinon.assert.calledOnce(dockerStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(removeResult).to.equal('Flux App website successfully removed.');
    });

    it('should throw error if app name is not correct or app does not exist', async () => {
      await expect(dockerService.appDockerRemove('testing123')).to.eventually.be.rejectedWith('Container testing123 not found');
    });

    // Lease-free: the teardown owns the component 'removing' lease across the whole
    // stop->remove->cleanup, so appDockerRemove must NOT touch the registry — neither
    // acquire (that would conflict with the teardown's own hold) nor release (its old
    // unconditional release dropped it, re-opening the race).
    it('does not touch the component lease (the teardown owns removing)', async () => {
      operationRegistry.clear();
      const leaseKey = dockerService.getAppIdentifier(appName);
      const token = operationRegistry.acquire(leaseKey, 'removing', 'appUninstaller', 'test teardown');

      await dockerService.appDockerRemove(appName);

      sinon.assert.calledOnce(dockerStub);
      expect(operationRegistry.get(leaseKey)?.type, 'the removing lease the teardown holds must survive the remove').to.equal('removing');
      operationRegistry.release(leaseKey, token);
    });
  });

  describe('appDockerPause tests', () => {
    const appName = 'website';
    let dockerStub;
    let getContainerSpy;

    beforeEach(() => {
      dockerStub = sinon.stub(Dockerode.Container.prototype, 'pause').returns(Promise.resolve('paused'));
      getContainerSpy = sinon.spy(Dockerode.prototype, 'getContainer');
    });

    afterEach(() => {
      dockerStub.restore();
      getContainerSpy.restore();
    });

    it('should call a docker pause command', async () => {
      const pauseResult = await dockerService.appDockerPause(appName);

      sinon.assert.calledOnce(dockerStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(pauseResult).to.equal('Flux App website successfully paused.');
    });

    it('should throw error if app name is not correct or app does not exist', async () => {
      await expect(dockerService.appDockerPause('testing123')).to.eventually.be.rejectedWith('Container testing123 not found');
    });
  });

  describe('appDockerUnpause tests', () => {
    const appName = 'website';
    let dockerStub;
    let getContainerSpy;

    beforeEach(() => {
      dockerStub = sinon.stub(Dockerode.Container.prototype, 'unpause').returns(Promise.resolve('unpaused'));
      getContainerSpy = sinon.spy(Dockerode.prototype, 'getContainer');
    });

    afterEach(() => {
      dockerStub.restore();
      getContainerSpy.restore();
    });

    it('should call a docker unpause command', async () => {
      const unpauseResult = await dockerService.appDockerUnpause(appName);

      sinon.assert.calledOnce(dockerStub);
      sinon.assert.calledOnceWithExactly(getContainerSpy, sinon.match.string);
      expect(unpauseResult).to.equal('Flux App website successfully unpaused.');
    });

    it('should throw error if app name is not correct or app does not exist', async () => {
      await expect(dockerService.appDockerUnpause('testing123')).to.eventually.be.rejectedWith('Container testing123 not found');
    });
  });

  describe('appDockerImageRemove tests', () => {
    const appName = 'website';
    let dockerStub;
    let getImageSpy;

    beforeEach(() => {
      dockerStub = sinon.stub(Dockerode.Image.prototype, 'remove').returns(Promise.resolve('removed'));
      getImageSpy = sinon.spy(Dockerode.prototype, 'getImage');
    });

    afterEach(() => {
      dockerStub.restore();
      getImageSpy.restore();
    });

    it('should call a docker image remove command', async () => {
      const removeResult = await dockerService.appDockerImageRemove(appName);

      sinon.assert.calledOnce(dockerStub);
      sinon.assert.calledOnceWithExactly(getImageSpy, appName);
      expect(removeResult).to.equal('Flux App website image successfully removed.');
    });
  });

  describe('appDockerTop tests', () => {
    const appName = 'website';

    it('returns the process table docker reports', async () => {
      const payload = { Titles: ['PID', 'CMD'], Processes: [['1', 'nginx']] };
      sinon.stub(Dockerode.Container.prototype, 'top').resolves(payload);

      const dockerTopResult = await dockerService.appDockerTop(appName);

      expect(dockerTopResult).to.equal(payload);
    });

    it('should throw error if app name is not correct or app does not exist', async () => {
      const result = await dockerService.appDockerTop('testing123');
      expect(result).to.be.null;
    });
  });

  describe('createFluxDockerNetwork tests', () => {
    let network;
    const docker = new Dockerode();
    const fluxNetworkOptions = {
      Name: 'fluxDockerNetwork',
      IPAM: {
        Config: [{
          Subnet: '172.23.0.0/24',
          Gateway: '172.23.0.1',
        }],
      },
    };

    afterEach(async () => {
      try {
        await dockerService.dockerRemoveNetwork(network);
      } catch {
        console.log('Network does not exist');
      }
    });

    it('should create flux docker network if it does not exist', async () => {
      const createNetworkResponse = await dockerService.createFluxDockerNetwork();
      network = docker.getNetwork(fluxNetworkOptions.Name);
      const inspectResult = await dockerService.dockerNetworkInspect(network);

      expect(createNetworkResponse.id).to.be.a('string');
      expect(createNetworkResponse.modem).to.be.an('object');
      expect(inspectResult.Name).to.equal(fluxNetworkOptions.Name);
      expect(inspectResult.Id).to.be.a('string');
      expect(inspectResult.IPAM.Config).to.eql(fluxNetworkOptions.IPAM.Config);
    });

    it('should return a message if the network does exist', async () => {
      // Call the function twice to make sure it exists
      await dockerService.createFluxDockerNetwork();

      const createNetworkResponse = await dockerService.createFluxDockerNetwork();

      expect(createNetworkResponse).to.equal('Flux Network already exists.');
    });
  });

  describe('createFluxAppDockerNetwork tests', () => {
    let network;
    const docker = new Dockerode();
    const fluxNetworkOptions = {
      Name: 'fluxDockerNetwork_MyAppName',
      IPAM: {
        Config: [{
          Subnet: '172.23.52.0/24',
          Gateway: '172.23.52.1',
        }],
      },
    };

    afterEach(async () => {
      try {
        await dockerService.dockerRemoveNetwork(network);
      } catch {
        console.log('Network does not exist');
      }
    });

    it('should create flux app docker network if it does not exist', async () => {
      const createNetworkResponse = await dockerService.createFluxAppDockerNetwork('MyAppName', 52);
      network = docker.getNetwork(fluxNetworkOptions.Name);
      const inspectResult = await dockerService.dockerNetworkInspect(network);

      expect(createNetworkResponse.id).to.be.a('string');
      expect(createNetworkResponse.modem).to.be.an('object');
      expect(inspectResult.Name).to.equal(fluxNetworkOptions.Name);
      expect(inspectResult.Id).to.be.a('string');
      expect(inspectResult.IPAM.Config).to.eql(fluxNetworkOptions.IPAM.Config);
      // the ownership stamp management decisions key on (never name matching)
      expect(inspectResult.Labels).to.eql({ 'runonflux.app-network': 'MyAppName' });
    });

    it('isFluxAppNetwork is true for a labelled app network, false for docker defaults and missing networks', async () => {
      await dockerService.createFluxAppDockerNetwork('MyAppName', 52);
      network = docker.getNetwork(fluxNetworkOptions.Name);

      expect(await dockerService.isFluxAppNetwork(fluxNetworkOptions.Name)).to.equal(true);
      expect(await dockerService.isFluxAppNetwork('bridge')).to.equal(false);
      expect(await dockerService.isFluxAppNetwork('no_such_network_xyz')).to.equal(false);
    });

    it('should return a message if the flux app network does exist', async () => {
      // Call the function twice to make sure it exists
      await dockerService.createFluxAppDockerNetwork('MyAppName', 52);

      const createNetworkResponse = await dockerService.createFluxAppDockerNetwork('MyAppName', 52);

      expect(createNetworkResponse).to.equal('Flux App Network of MyAppName already exists.');
    });
  });

  describe('appDockerNetworkConnect tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    function stubInspectWithNetworks(networks) {
      const inspectStub = sinon.stub().resolves({ NetworkSettings: { Networks: networks } });
      sinon.stub(Dockerode.prototype, 'getContainer').returns({ inspect: inspectStub });
      return inspectStub;
    }

    function stubInspectThrows(error) {
      const inspectStub = sinon.stub().rejects(error);
      sinon.stub(Dockerode.prototype, 'getContainer').returns({ inspect: inspectStub });
      return inspectStub;
    }

    it('connects the container when not already attached', async () => {
      stubInspectWithNetworks({ bridge: {} });
      const connectStub = sinon.stub().resolves();
      const getNetworkStub = sinon.stub(Dockerode.prototype, 'getNetwork').returns({ connect: connectStub });

      await dockerService.appDockerNetworkConnect('fluxweb_myapp', 'fluxDockerNetwork_dep');

      sinon.assert.calledOnceWithExactly(getNetworkStub, 'fluxDockerNetwork_dep');
      sinon.assert.calledOnceWithExactly(connectStub, { Container: 'fluxweb_myapp' });
    });

    it('skips the connect call when the container is already attached', async () => {
      stubInspectWithNetworks({ fluxDockerNetwork_dep: {} });
      const connectStub = sinon.stub().resolves();
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ connect: connectStub });

      await dockerService.appDockerNetworkConnect('fluxweb_myapp', 'fluxDockerNetwork_dep');

      sinon.assert.notCalled(connectStub);
    });

    it('still attempts to connect when inspect fails', async () => {
      stubInspectThrows(new Error('inspect transient'));
      const connectStub = sinon.stub().resolves();
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ connect: connectStub });

      await dockerService.appDockerNetworkConnect('fluxweb_myapp', 'fluxDockerNetwork_dep');

      sinon.assert.calledOnceWithExactly(connectStub, { Container: 'fluxweb_myapp' });
    });

    it('swallows the race-window already-exists error from connect', async () => {
      stubInspectWithNetworks({ bridge: {} });
      const error = new Error('endpoint with name fluxweb_myapp already exists in network fluxDockerNetwork_dep');
      error.statusCode = 403;
      const connectStub = sinon.stub().rejects(error);
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ connect: connectStub });

      await expect(dockerService.appDockerNetworkConnect('fluxweb_myapp', 'fluxDockerNetwork_dep')).to.not.be.rejected;
    });

    it('rethrows generic connect errors (no message match)', async () => {
      stubInspectWithNetworks({ bridge: {} });
      const error = new Error('network fluxDockerNetwork_dep not found');
      error.statusCode = 404;
      const connectStub = sinon.stub().rejects(error);
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ connect: connectStub });

      await expect(dockerService.appDockerNetworkConnect('fluxweb_myapp', 'fluxDockerNetwork_dep')).to.be.rejectedWith('not found');
    });

    it('rethrows a generic 403 that is not already-exists', async () => {
      stubInspectWithNetworks({ bridge: {} });
      const error = new Error('operation not permitted on swarm-scoped network');
      error.statusCode = 403;
      const connectStub = sinon.stub().rejects(error);
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ connect: connectStub });

      await expect(dockerService.appDockerNetworkConnect('fluxweb_myapp', 'fluxDockerNetwork_dep')).to.be.rejectedWith('swarm-scoped');
    });

    it('normalises a bare component identifier to the docker name', async () => {
      const inspectStub = sinon.stub().resolves({ NetworkSettings: { Networks: { bridge: {} } } });
      const getContainerStub = sinon.stub(Dockerode.prototype, 'getContainer').returns({ inspect: inspectStub });
      const connectStub = sinon.stub().resolves();
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ connect: connectStub });

      await dockerService.appDockerNetworkConnect('web_myapp', 'fluxDockerNetwork_dep');

      sinon.assert.calledOnceWithExactly(getContainerStub, 'fluxweb_myapp');
      sinon.assert.calledOnceWithExactly(connectStub, { Container: 'fluxweb_myapp' });
    });
  });

  describe('appDockerNetworkDisconnect tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    function stubInspect(networksOrError) {
      const inspectStub = networksOrError instanceof Error
        ? sinon.stub().rejects(networksOrError)
        : sinon.stub().resolves({ NetworkSettings: { Networks: networksOrError } });
      sinon.stub(Dockerode.prototype, 'getContainer').returns({ inspect: inspectStub });
      return inspectStub;
    }

    it('disconnects an attached container, normalising a bare identifier', async () => {
      stubInspect({ fluxDockerNetwork_dep: {} });
      const disconnectStub = sinon.stub().resolves();
      const getNetworkStub = sinon.stub(Dockerode.prototype, 'getNetwork').returns({ disconnect: disconnectStub });

      await dockerService.appDockerNetworkDisconnect('web_myapp', 'fluxDockerNetwork_dep');

      sinon.assert.calledOnceWithExactly(getNetworkStub, 'fluxDockerNetwork_dep');
      sinon.assert.calledOnceWithExactly(disconnectStub, { Container: 'fluxweb_myapp' });
    });

    it('skips the disconnect call when the container is not attached', async () => {
      stubInspect({ bridge: {} });
      const disconnectStub = sinon.stub().resolves();
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ disconnect: disconnectStub });

      await dockerService.appDockerNetworkDisconnect('fluxweb_myapp', 'fluxDockerNetwork_dep');

      sinon.assert.notCalled(disconnectStub);
    });

    it('resolves without a disconnect call when the container is gone (404)', async () => {
      const gone = new Error('no such container');
      gone.statusCode = 404;
      stubInspect(gone);
      const disconnectStub = sinon.stub().resolves();
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ disconnect: disconnectStub });

      await dockerService.appDockerNetworkDisconnect('fluxweb_myapp', 'fluxDockerNetwork_dep');

      sinon.assert.notCalled(disconnectStub);
    });

    it('still attempts the disconnect when inspect fails transiently', async () => {
      stubInspect(new Error('inspect transient'));
      const disconnectStub = sinon.stub().resolves();
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ disconnect: disconnectStub });

      await dockerService.appDockerNetworkDisconnect('fluxweb_myapp', 'fluxDockerNetwork_dep');

      sinon.assert.calledOnceWithExactly(disconnectStub, { Container: 'fluxweb_myapp' });
    });

    it('swallows the race-window not-connected error from disconnect', async () => {
      stubInspect({ fluxDockerNetwork_dep: {} });
      const error = new Error('container fluxweb_myapp is not connected to network fluxDockerNetwork_dep');
      error.statusCode = 500;
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ disconnect: sinon.stub().rejects(error) });

      await expect(dockerService.appDockerNetworkDisconnect('fluxweb_myapp', 'fluxDockerNetwork_dep')).to.not.be.rejected;
    });

    it('swallows a 404 from disconnect (network vanished in the race window)', async () => {
      stubInspect({ fluxDockerNetwork_dep: {} });
      const error = new Error('network fluxDockerNetwork_dep not found');
      error.statusCode = 404;
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ disconnect: sinon.stub().rejects(error) });

      await expect(dockerService.appDockerNetworkDisconnect('fluxweb_myapp', 'fluxDockerNetwork_dep')).to.not.be.rejected;
    });

    it('rethrows a genuine disconnect failure', async () => {
      stubInspect({ fluxDockerNetwork_dep: {} });
      const error = new Error('driver failure');
      error.statusCode = 500;
      sinon.stub(Dockerode.prototype, 'getNetwork').returns({ disconnect: sinon.stub().rejects(error) });

      await expect(dockerService.appDockerNetworkDisconnect('fluxweb_myapp', 'fluxDockerNetwork_dep')).to.be.rejectedWith('driver failure');
    });
  });

  describe('getAppContainerNames tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('returns multi-component and legacy single-component containers, anchored to flux', async () => {
      stubListing([
        { Names: ['/fluxweb_myapp'] },
        { Names: ['/fluxapi_myapp'] },
        { Names: ['/fluxother_differentapp'] },
        { Names: ['/fluxmyapp'] },
        { Names: ['/someoneelse_myapp'] }, // missing flux prefix — must NOT match
      ]);

      const names = await dockerService.getAppContainerNames('myapp');

      expect(names).to.have.members(['fluxweb_myapp', 'fluxapi_myapp', 'fluxmyapp']);
      expect(names).to.not.include('fluxother_differentapp');
      expect(names).to.not.include('someoneelse_myapp');
    });

    it('escapes regex metacharacters in the app name', async () => {
      stubListing([
        { Names: ['/fluxweb_my-app'] },
      ]);

      const names = await dockerService.getAppContainerNames('my-app');

      expect(names).to.eql(['fluxweb_my-app']);
    });
  });

  describe('appDockerCreate tests', () => {
    let dockerStub;
    // Use the same path that dockerService will compute at runtime
    let volumeStub;
    const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
    const appsFolder = `${fluxDirPath}/ZelApps/`;

    function makeDeployComp(overrides = {}) {
      return {
        name: 'website',
        appName: 'fluxwebsite',
        identifier: 'website_fluxwebsite',
        image: 'runonflux/website',
        cpu: 0.8,
        memory: 1800,
        cmd: ['--chain', 'kusama'],
        mounts: [
          { Source: `${appsFolder}website_fluxwebsite/appdata`, Target: '/chaindata', Type: 'bind' },
        ],
        toDockerPortBindings: () => ({ '30333/tcp': [{ HostPort: '31113' }], '9933/tcp': [{ HostPort: '31112' }] }),
        toDockerExposedPorts: () => ({ '30333/tcp': {}, '9933/tcp': {} }),
        toDockerEnv: () => [],
        toDockerNanoCpus: () => 800000000,
        toDockerMemoryBytes: () => 1887436800,
        toDockerMemorySwapBytes: () => 1887436800 + (2 * 1024 * 1024 * 1024),
        restartPolicyName: () => 'unless-stopped',
        platformEnv: () => ({ FLUX_APP_NAME: 'fluxwebsite' }),
        ...overrides,
      };
    }

    beforeEach(() => {
      dockerStub = sinon.stub(Dockerode.prototype, 'createContainer').returns(Promise.resolve('created'));
      volumeStub = sinon.stub(appVolumeService, 'ensureMountSourcesExist').resolves();
      // appDockerCreate resolves this node's address for the platform env, and
      // unstubbed that is a real RPC to the benchmark daemon. Unknown by
      // default; the test that asserts FLUX_NODE_HOST_IP sets its own value.
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(null);
    });

    afterEach(() => {
      dockerStub.restore();
      volumeStub.restore();
      // Restores any per-test stubs (e.g. the node-address stub) too.
      sinon.restore();
    });

    it('should create a container with correct image and resource limits', async () => {
      const deployComp = makeDeployComp();

      await dockerService.appDockerCreate(deployComp);

      sinon.assert.calledOnce(dockerStub);
      const actualConfig = dockerStub.firstCall.args[0];

      expect(actualConfig.Image).to.equal('runonflux/website');
      expect(actualConfig.name).to.equal('fluxwebsite_fluxwebsite');
      expect(actualConfig.Hostname).to.equal('website');
      expect(actualConfig.HostConfig.NanoCPUs).to.equal(800000000);
      expect(actualConfig.HostConfig.Memory).to.equal(1887436800);
    });

    it('should set up mounts from DeploymentComponent', async () => {
      const deployComp = makeDeployComp();

      await dockerService.appDockerCreate(deployComp);

      const actualConfig = dockerStub.firstCall.args[0];
      expect(actualConfig.HostConfig.Mounts).to.have.lengthOf(1);
      expect(actualConfig.HostConfig.Mounts[0].Source).to.include('website_fluxwebsite/appdata');
      expect(actualConfig.HostConfig.Mounts[0].Target).to.equal('/chaindata');
    });

    it('overrides the image ENTRYPOINT when the component sets entrypoint', async () => {
      const deployComp = makeDeployComp({ entrypoint: ['/custom-entry', '--flag'] });

      await dockerService.appDockerCreate(deployComp);

      const actualConfig = dockerStub.firstCall.args[0];
      expect(actualConfig.Entrypoint).to.deep.equal(['/custom-entry', '--flag']);
    });

    it('leaves Entrypoint unset for an empty entrypoint so the image default is kept', async () => {
      const deployComp = makeDeployComp({ entrypoint: [] });

      await dockerService.appDockerCreate(deployComp);

      const actualConfig = dockerStub.firstCall.args[0];
      expect(actualConfig).to.not.have.property('Entrypoint');
    });

    it('runs the container under an init (tini) when init is true', async () => {
      const deployComp = makeDeployComp({ init: true });

      await dockerService.appDockerCreate(deployComp);

      const actualConfig = dockerStub.firstCall.args[0];
      expect(actualConfig.HostConfig.Init).to.equal(true);
    });

    it('does not run an init when init is false', async () => {
      const deployComp = makeDeployComp({ init: false });

      await dockerService.appDockerCreate(deployComp);

      const actualConfig = dockerStub.firstCall.args[0];
      expect(actualConfig.HostConfig.Init).to.equal(false);
    });

    it('wires a v9 livenessProbe into a docker Healthcheck, seconds to nanoseconds', async () => {
      const deployComp = makeDeployComp({
        livenessProbe: {
          cmd: ['pg_isready', '-U', 'app'],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 10,
        },
      });

      await dockerService.appDockerCreate(deployComp);

      const actualConfig = dockerStub.firstCall.args[0];
      expect(actualConfig.Healthcheck).to.deep.equal({
        Test: ['CMD', 'pg_isready', '-U', 'app'],
        Interval: 30000000000,
        Timeout: 5000000000,
        Retries: 3,
        StartPeriod: 10000000000,
      });
    });

    it('sets no Healthcheck when the component has no livenessProbe', async () => {
      const deployComp = makeDeployComp();

      await dockerService.appDockerCreate(deployComp);

      const actualConfig = dockerStub.firstCall.args[0];
      expect(actualConfig).to.not.have.property('Healthcheck');
    });

    it('should set up port bindings from DeploymentComponent', async () => {
      const deployComp = makeDeployComp();

      await dockerService.appDockerCreate(deployComp);

      const actualConfig = dockerStub.firstCall.args[0];
      expect(actualConfig.HostConfig.PortBindings).to.deep.equal({
        '30333/tcp': [{ HostPort: '31113' }],
        '9933/tcp': [{ HostPort: '31112' }],
      });
      expect(actualConfig.ExposedPorts).to.deep.equal({
        '30333/tcp': {},
        '9933/tcp': {},
      });
    });

    it('should throw error if deployComp is malformed', async () => {
      const badComp = { testing: 'testing' };

      await expect(dockerService.appDockerCreate(badComp)).to.eventually.be.rejected;
    });

    it('appends the platform env after user env (platform values authoritative)', async () => {
      const deployComp = makeDeployComp({
        toDockerEnv: () => ['MY_SETTING=user'],
        platformEnv: () => ({ FLUX_APP_NAME: 'fluxwebsite', FLUX_REPLICA: 's2', FLUX_PORT_game: '35001' }),
      });

      await dockerService.appDockerCreate(deployComp);

      const { Env } = dockerStub.firstCall.args[0];
      expect(Env.indexOf('MY_SETTING=user')).to.be.below(Env.indexOf('FLUX_APP_NAME=fluxwebsite'));
      expect(Env).to.include('FLUX_REPLICA=s2');
      expect(Env).to.include('FLUX_PORT_game=35001');
    });

    it('a LOG=SEND / LOG=COLLECT env is inert — every container gets json-file logging', async () => {
      // The GELF log-shipping rig is gone from v9: log shipping is the otlp
      // telemetry block's job. The old env DSL must mean nothing — no driver
      // swap, no collector resolution, just an ordinary user env var.
      const deployComp = makeDeployComp({
        toDockerEnv: () => ['LOG=SEND', 'LOG=COLLECT'],
      });

      await dockerService.appDockerCreate(deployComp);

      const { Env, HostConfig } = dockerStub.firstCall.args[0];
      expect(HostConfig.LogConfig.Type).to.equal('json-file');
      expect(Env).to.include('LOG=SEND');
    });

    it('resolves ${FLUX_*} references in user env against the platform map', async () => {
      const deployComp = makeDeployComp({
        toDockerEnv: () => [
          'ADVERTISE=${FLUX_PORT_game}',
          'WHOAMI=${FLUX_REPLICA}',
          'SHELLISH=${HOME}/data',
          'GHOST=${FLUX_PORT_ghost}',
        ],
        platformEnv: () => ({ FLUX_APP_NAME: 'fluxwebsite', FLUX_REPLICA: 's2', FLUX_PORT_game: '35001' }),
      });

      await dockerService.appDockerCreate(deployComp);

      const { Env } = dockerStub.firstCall.args[0];
      expect(Env).to.include('ADVERTISE=35001');
      expect(Env).to.include('WHOAMI=s2');
      // Not our namespace — untouched.
      expect(Env).to.include('SHELLISH=${HOME}/data');
      // Unresolvable stays verbatim (fail-visible), never silently emptied.
      expect(Env).to.include('GHOST=${FLUX_PORT_ghost}');
    });

    it('adds FLUX_NODE_HOST_IP when the node address is known', async () => {
      fluxNetworkHelper.getLocalSocketAddress.resolves('44.55.66.77:16127');
      const deployComp = makeDeployComp();

      await dockerService.appDockerCreate(deployComp);

      const { Env } = dockerStub.firstCall.args[0];
      expect(Env).to.include('FLUX_NODE_HOST_IP=44.55.66.77');
    });
  });

  describe('dockerPullStream (abortable pull + error propagation)', () => {
    // The module's docker.modem is an instance of docker-modem's Modem; reach its prototype
    // through a Dockerode instance so the stubs cover the module's docker without a direct
    // (extraneous) docker-modem dependency.
    const modemProto = Object.getPrototypeOf(new Dockerode().modem);

    it('propagates a followProgress error to the callback (a failed pull is NOT reported as success)', (done) => {
      const pullStub = sinon.stub(Dockerode.prototype, 'pull').callsFake((repoTag, opts, cb) => cb(null, 'STREAM'));
      const followStub = sinon.stub(modemProto, 'followProgress').callsFake((stream, onFinished) => onFinished(new Error('layer download failed')));
      dockerService.dockerPullStream({ repoTag: 'nginx:latest' }, null, (err) => {
        try {
          expect(err, 'the stream error reaches the callback, not a null success').to.be.an('error');
          expect(err.message).to.include('layer download failed');
          done();
        } catch (assertErr) {
          done(assertErr);
        } finally {
          pullStub.restore();
          followStub.restore();
        }
      });
    });

    it('fails the pull on an in-band {error} event in a cleanly-ended stream', (done) => {
      // docker reports a registry/blob failure (e.g. a CDN EOF mid-blob) as an
      // in-band error event and ends the stream cleanly - followProgress calls
      // onFinished with no error and the event in the output.
      const output = [
        { status: 'Downloading', id: 'layer1' },
        { errorDetail: { message: 'unexpected EOF' }, error: 'unexpected EOF' },
      ];
      const pullStub = sinon.stub(Dockerode.prototype, 'pull').callsFake((repoTag, opts, cb) => cb(null, 'STREAM'));
      const followStub = sinon.stub(modemProto, 'followProgress').callsFake((stream, onFinished) => onFinished(null, output));
      dockerService.dockerPullStream({ repoTag: 'nginx:latest' }, null, (err) => {
        try {
          expect(err, 'an in-band docker error is a failed pull, never success onto a missing image').to.be.an('error');
          expect(err.message).to.include('unexpected EOF');
          done();
        } catch (assertErr) {
          done(assertErr);
        } finally {
          pullStub.restore();
          followStub.restore();
        }
      });
    });

    it('chains the caller abortSignal into the signal docker.pull sees (abortable pull)', () => {
      const pullStub = sinon.stub(Dockerode.prototype, 'pull').callsFake((repoTag, opts, cb) => cb(null, 'STREAM'));
      const followStub = sinon.stub(modemProto, 'followProgress').callsFake((stream, onFinished) => onFinished(null, 'done'));
      try {
        const ac = new AbortController();
        dockerService.dockerPullStream({ repoTag: 'nginx:latest', abortSignal: ac.signal }, null, sinon.stub());
        expect(pullStub.calledOnce).to.be.true;
        const seenSignal = pullStub.firstCall.args[1].abortSignal;
        expect(seenSignal, 'docker.pull always gets a signal (the stall controller)').to.be.instanceOf(AbortSignal);
        expect(seenSignal.aborted).to.be.false;
        ac.abort();
        expect(seenSignal.aborted, 'a caller cancel aborts the transfer docker sees').to.be.true;
      } finally {
        pullStub.restore();
        followStub.restore();
      }
    });

    describe('stall watchdog', () => {
      let clock;
      let pullStub;
      let followStub;
      let onFinished;
      let onProgress;

      beforeEach(() => {
        clock = sinon.useFakeTimers();
        pullStub = sinon.stub(Dockerode.prototype, 'pull').callsFake((repoTag, opts, cb) => cb(null, 'STREAM'));
        // capture the handlers so the test drives the stream by hand
        followStub = sinon.stub(modemProto, 'followProgress').callsFake((stream, finished, progress) => {
          onFinished = finished;
          onProgress = progress;
        });
      });

      afterEach(() => {
        pullStub.restore();
        followStub.restore();
        clock.restore();
      });

      it('a silent stream stalls out: transient-tagged error, transfer aborted', () => {
        const cb = sinon.stub();
        dockerService.dockerPullStream({ repoTag: 'nginx:latest', stallMs: 50 }, null, cb);
        clock.tick(49);
        expect(cb.called).to.be.false;
        clock.tick(1);
        expect(cb.calledOnce).to.be.true;
        const err = cb.firstCall.args[0];
        expect(err).to.be.an('error');
        expect(err.message).to.include('stalled: no progress for');
        expect(err.registryErrorClass).to.equal('transient');
        expect(pullStub.firstCall.args[1].abortSignal.aborted, 'the dead transfer is aborted').to.be.true;
        // a late modem error after the stall settled must not double-fire the callback
        onFinished(new Error('aborted'));
        expect(cb.calledOnce).to.be.true;
      });

      it('progress events keep resetting the window - a slow pull outlives many windows', () => {
        const cb = sinon.stub();
        dockerService.dockerPullStream({ repoTag: 'nginx:latest', stallMs: 50 }, null, cb);
        for (let i = 0; i < 5; i += 1) {
          clock.tick(40);
          onProgress({ status: 'Downloading', id: 'layer1' });
        }
        clock.tick(40); // 240ms total elapsed, never 50ms silent
        expect(cb.called, 'no stall while progress flows').to.be.false;
        onFinished(null, 'done');
        expect(cb.calledOnceWith(null, 'done')).to.be.true;
      });

      it('a caller cancel keeps its own error shape (never stall-tagged)', () => {
        const cb = sinon.stub();
        const ac = new AbortController();
        dockerService.dockerPullStream({ repoTag: 'nginx:latest', stallMs: 50, abortSignal: ac.signal }, null, cb);
        clock.tick(20);
        ac.abort();
        onFinished(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' }));
        expect(cb.calledOnce).to.be.true;
        const err = cb.firstCall.args[0];
        expect(err.message).to.equal('aborted');
        expect(err.registryErrorClass, 'a cancel is not a registry verdict').to.equal(undefined);
      });
    });
  });

  describe('tagIfRegistryUnreachable tests', () => {
    it('tags daemon-reported connectivity failures transient', () => {
      const shapes = [
        Object.assign(new Error('Get "https://registry-1.docker.io/v2/": dial tcp: connection refused'), {}),
        Object.assign(new Error('net/http: TLS handshake timeout'), {}),
        Object.assign(new Error('toomanyrequests: You have reached your pull rate limit'), {}),
        Object.assign(new Error('request canceled while waiting for connection (Client.Timeout exceeded)'), {}),
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        Object.assign(new Error('registry 500'), { statusCode: 503 }),
      ];
      shapes.forEach((err) => {
        expect(dockerService.tagIfRegistryUnreachable(err).registryErrorClass, err.message).to.equal('transient');
      });
    });

    it('leaves image verdicts and cancels untagged (they read permanent downstream)', () => {
      const shapes = [
        new Error('manifest unknown: manifest unknown'),
        new Error('pull access denied for foo/bar, repository does not exist'),
        Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' }),
        Object.assign(new Error('not found'), { statusCode: 404 }),
      ];
      shapes.forEach((err) => {
        expect(dockerService.tagIfRegistryUnreachable(err).registryErrorClass, err.message).to.equal(undefined);
      });
    });
  });
});
