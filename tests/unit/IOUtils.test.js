// Set NODE_CONFIG_DIR before any requires
process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');

const IOUtils = require('../../ZelBack/src/services/IOUtils');
const deviceHelper = require('../../ZelBack/src/services/deviceHelper');
const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');

describe('IOUtils getVolumeInfo tests', () => {
  // findmnt (listMountedFilesystems) records: the node disks plus the loop-backed
  // app volumes whose mount path ends with flux<component>_<appname>.
  const filesystems = [
    {
      source: '/dev/mapper/flux_crypt', target: '/dat', fstype: 'xfs', sizeBytes: 926165774336, usedBytes: 349526016000, availableBytes: 576639758336, usePercent: 38,
    },
    {
      source: '/dev/loop2', target: '/dat/var/lib/fluxos/flux-apps/fluxweb_myapp', fstype: 'ext4', sizeBytes: 2000000000, usedBytes: 500000000, availableBytes: 1500000000, usePercent: 25,
    },
    {
      source: '/dev/loop3', target: '/dat/var/lib/fluxos/flux-apps/fluxdb_myapp', fstype: 'ext4', sizeBytes: 4000000000, usedBytes: 1000000000, availableBytes: 3000000000, usePercent: 25,
    },
    {
      source: '/dev/loop4', target: '/dat/var/lib/fluxos/flux-apps/fluxsingleapp', fstype: 'ext4', sizeBytes: 1000000000, usedBytes: 250000000, availableBytes: 750000000, usePercent: 25,
    },
  ];

  let listStub;

  beforeEach(() => {
    listStub = sinon.stub(deviceHelper, 'listMountedFilesystems').resolves(filesystems);
    // Volume paths are now built FORWARD from the app's stored identity rather
    // than decoded back out of the mount table. These fixtures are pre-mint apps,
    // whose identity is their own name.
    sinon.stub(appsRepository, 'getInstalledApp').callsFake(async (name) => ({ name, identity: null }));
    sinon.stub(appsRepository, 'listInstalledIdentities').resolves([null]);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('resolves a single component volume by its mount path (mount field only)', async () => {
    const result = await IOUtils.getVolumeInfo('myapp', 'web', 'B', 0, 'mount');

    sinon.assert.calledOnce(listStub);
    expect(result).to.eql([{ mount: '/dat/var/lib/fluxos/flux-apps/fluxweb_myapp' }]);
  });

  it('matches only the requested component, not a sibling of the same app', async () => {
    const result = await IOUtils.getVolumeInfo('myapp', 'db', 'B', 0, 'mount');
    expect(result).to.eql([{ mount: '/dat/var/lib/fluxos/flux-apps/fluxdb_myapp' }]);
  });

  it("matches a single-component app when component is 'null'", async () => {
    const result = await IOUtils.getVolumeInfo('singleapp', 'null', 'B', 0, 'mount');
    expect(result).to.eql([{ mount: '/dat/var/lib/fluxos/flux-apps/fluxsingleapp' }]);
  });

  it('returns full usage in MB with capacity as a fraction when no fields filter is given', async () => {
    const result = await IOUtils.getVolumeInfo('myapp', 'web', 'MB', '0', '');
    expect(result).to.eql([{
      filesystem: '/dev/loop2',
      size: 2000,
      used: 500,
      available: 1500,
      capacity: 0.25,
      mount: '/dat/var/lib/fluxos/flux-apps/fluxweb_myapp',
      // Reported so a co-located app's rows can be told apart: this route
      // answers for every identity of the component, and two rows that differ
      // only by which replica owns them are useless without it.
      replica: null,
    }]);
  });

  it('reports raw bytes for the B multiplier', async () => {
    const result = await IOUtils.getVolumeInfo('myapp', 'web', 'B', 0, 'size,available');
    expect(result).to.eql([{ size: 2000000000, available: 1500000000 }]);
  });

  it('returns false when no mount matches', async () => {
    const result = await IOUtils.getVolumeInfo('absent', 'web', 'B', 0, 'mount');
    expect(result).to.equal(false);
  });

  it('returns false when listMountedFilesystems throws', async () => {
    listStub.rejects(new Error('findmnt failed'));
    const result = await IOUtils.getVolumeInfo('myapp', 'web', 'B', 0, 'mount');
    expect(result).to.equal(false);
  });
});
