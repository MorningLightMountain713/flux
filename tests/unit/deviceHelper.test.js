const chai = require('chai');

const { expect } = chai;
const sinon = require('sinon');

const serviceHelper = require('../../ZelBack/src/services/serviceHelper');

const deviceHelper = require('../../ZelBack/src/services/deviceHelper');

describe('deviceHelper tests', () => {
  let runCmdStub;

  beforeEach(() => {
    runCmdStub = sinon.stub(serviceHelper, 'runCommand');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('Should return true if mount target has quota option', async () => {
    const findmnt = `TARGET SOURCE    FSTYPE OPTIONS
    /      /dev/sda2 xfs   rw,relatime,attr2,inode64,logbufs=8,logbsize=32k,prjquota`;

    runCmdStub.resolves({ stdout: findmnt });

    const response = await deviceHelper.hasQuotaOptionForMountTarget('/var/lib/docker');
    expect(response).to.eql(true);
    sinon.assert.calledWithExactly(runCmdStub, 'findmnt', { logError: false, params: ['--target', '/var/lib/docker', '--options', 'prjquota'] });
  });

  it('Should return false if mount target has no quota option', async () => {
    runCmdStub.resolves({ stdout: '' });

    const response = await deviceHelper.hasQuotaOptionForMountTarget('/var/lib/docker');
    expect(response).to.eql(false);
    sinon.assert.calledWithExactly(runCmdStub, 'findmnt', { logError: false, params: ['--target', '/var/lib/docker', '--options', 'prjquota'] });
  });

  describe('listMountedFilesystems tests', () => {
    // A real `findmnt --real --list --bytes --json` tree from an Arcane node: the /dev/*
    // disks plus the loop-backed app volumes, flat (no mount-tree nesting).
    const findmntJson = JSON.stringify({
      filesystems: [
        {
          source: '/dev/mapper/os_crypt', target: '/mnt/root', fstype: 'ext4', size: 16780226560, used: 5301342208, avail: 10603954176, 'use%': '32%',
        },
        {
          source: '/dev/mapper/flux_crypt', target: '/dat', fstype: 'xfs', size: 926165774336, used: 349526016000, avail: 576639758336, 'use%': '38%',
        },
        {
          source: '/dev/loop2', target: '/dat/var/lib/fluxos/flux-apps/fluxnode_PresearchNode1', fstype: 'ext4', size: 2040373248, used: 565248, avail: 1915658240, 'use%': '0%',
        },
      ],
    });

    it('parses findmnt JSON into byte-level filesystem records', async () => {
      runCmdStub.resolves({ stdout: findmntJson });

      const response = await deviceHelper.listMountedFilesystems();

      sinon.assert.calledWithExactly(runCmdStub, 'findmnt', {
        logError: false,
        params: ['--real', '--list', '--bytes', '--json', '--output', 'SOURCE,TARGET,FSTYPE,SIZE,USED,AVAIL,USE%'],
      });
      expect(response).to.eql([
        {
          source: '/dev/mapper/os_crypt', target: '/mnt/root', fstype: 'ext4', sizeBytes: 16780226560, usedBytes: 5301342208, availableBytes: 10603954176, usePercent: 32,
        },
        {
          source: '/dev/mapper/flux_crypt', target: '/dat', fstype: 'xfs', sizeBytes: 926165774336, usedBytes: 349526016000, availableBytes: 576639758336, usePercent: 38,
        },
        {
          source: '/dev/loop2', target: '/dat/var/lib/fluxos/flux-apps/fluxnode_PresearchNode1', fstype: 'ext4', sizeBytes: 2040373248, usedBytes: 565248, availableBytes: 1915658240, usePercent: 0,
        },
      ]);
    });

    it('returns an empty list when findmnt reports no filesystems', async () => {
      runCmdStub.resolves({ stdout: '{}' });

      const response = await deviceHelper.listMountedFilesystems();
      expect(response).to.eql([]);
    });

    it('throws when findmnt fails', async () => {
      runCmdStub.resolves({ error: new Error('findmnt: command not found'), stdout: '' });

      let thrown;
      try {
        await deviceHelper.listMountedFilesystems();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).to.be.an('error');
      expect(thrown.message).to.include('findmnt --real --list failed');
    });
  });
});
