'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const log = require('../../ZelBack/src/lib/log');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const clockDrift = require('../../ZelBack/src/services/clockDrift');

describe('clockDrift tests', () => {
  describe('parseChronyOffset tests', () => {
    it('should parse slow offset', () => {
      const output = 'System time     : 0.000012345 seconds slow of NTP time';
      expect(clockDrift.parseChronyOffset(output)).to.equal(-0.000_012_345);
    });

    it('should parse fast offset', () => {
      const output = 'System time     : 0.000054321 seconds fast of NTP time';
      expect(clockDrift.parseChronyOffset(output)).to.equal(0.000_054_321);
    });

    it('should return null for unparseable output', () => {
      expect(clockDrift.parseChronyOffset('garbage')).to.equal(null);
    });
  });

  describe('parseTimesyncOffset tests', () => {
    it('should parse millisecond offset', () => {
      const output = 'Offset: +1.234ms';
      expect(clockDrift.parseTimesyncOffset(output)).to.be.closeTo(0.001_234, 1e-9);
    });

    it('should parse microsecond offset', () => {
      const output = 'Offset: -567us';
      expect(clockDrift.parseTimesyncOffset(output)).to.be.closeTo(-0.000_567, 1e-9);
    });

    it('should parse second offset', () => {
      const output = 'Offset: +2.5s';
      expect(clockDrift.parseTimesyncOffset(output)).to.equal(2.5);
    });

    it('should return null for unparseable output', () => {
      expect(clockDrift.parseTimesyncOffset('garbage')).to.equal(null);
    });
  });

  describe('getClockDrift tests', () => {
    let runCommandStub;

    beforeEach(() => {
      clockDrift.resetNtpSource();
      sinon.stub(log, 'info');
      runCommandStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return chrony offset when chrony is available', async () => {
      runCommandStub.resolves({
        error: null,
        stdout: 'System time     : 0.000003456 seconds fast of NTP time',
      });

      const result = await clockDrift.getClockDrift();

      expect(result.source).to.equal('chrony');
      expect(result.offset).to.equal(0.000_003_456);
      expect(result.time).to.be.a('number');
      // detection call + drift call
      sinon.assert.calledTwice(runCommandStub);
      sinon.assert.alwaysCalledWith(runCommandStub, 'chronyc', sinon.match.object);
    });

    it('should fall back to timesyncd when chrony is not available', async () => {
      runCommandStub.withArgs('chronyc', sinon.match.any).resolves({
        error: new Error('command not found'),
        stdout: '',
      });
      runCommandStub.withArgs('timedatectl', sinon.match.any).resolves({
        error: null,
        stdout: 'Offset: +1.234ms',
      });

      const result = await clockDrift.getClockDrift();

      expect(result.source).to.equal('timesyncd');
      expect(result.offset).to.be.closeTo(0.001_234, 1e-9);
    });

    it('should return source none when neither is available', async () => {
      runCommandStub.resolves({
        error: new Error('command not found'),
        stdout: '',
      });

      const result = await clockDrift.getClockDrift();

      expect(result.source).to.equal('none');
      expect(result.offset).to.equal(null);
    });

    it('should cache the NTP source and only detect once', async () => {
      runCommandStub.resolves({
        error: null,
        stdout: 'System time     : 0.000001000 seconds slow of NTP time',
      });

      await clockDrift.getClockDrift();
      await clockDrift.getClockDrift();

      // detection (1 call) + 2 drift queries = 3 calls, all to chronyc
      sinon.assert.calledThrice(runCommandStub);
      sinon.assert.alwaysCalledWith(runCommandStub, 'chronyc', sinon.match.object);
    });

    it('should return null offset if chrony output is unparseable', async () => {
      runCommandStub.resolves({
        error: null,
        stdout: 'Reference ID    : some garbage',
      });

      const result = await clockDrift.getClockDrift();

      // detection succeeds (no error) so source is chrony, but offset parse fails
      expect(result.source).to.equal('chrony');
      expect(result.offset).to.equal(null);
    });
  });

  describe('clockDrift API handler tests', () => {
    let runCommandStub;
    let res;

    beforeEach(() => {
      clockDrift.resetNtpSource();
      sinon.stub(log, 'info');
      runCommandStub = sinon.stub(serviceHelper, 'runCommand');
      res = { json: sinon.stub() };
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return success response with drift data', async () => {
      runCommandStub.resolves({
        error: null,
        stdout: 'System time     : 0.000005000 seconds fast of NTP time',
      });

      await clockDrift.clockDrift(null, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('success');
      expect(response.data.source).to.equal('chrony');
      expect(response.data.offset).to.equal(0.000_005);
      expect(response.data.time).to.be.a('number');
    });

    it('should return none when both sources fail', async () => {
      runCommandStub.resolves({
        error: new Error('command not found'),
        stdout: '',
      });

      await clockDrift.clockDrift(null, res);

      sinon.assert.calledOnce(res.json);
      const response = res.json.firstCall.args[0];
      expect(response.status).to.equal('success');
      expect(response.data.source).to.equal('none');
      expect(response.data.offset).to.equal(null);
    });
  });
});
