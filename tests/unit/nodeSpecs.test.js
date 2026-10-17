'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('nodeSpecs tests', () => {
  let getBenchmarks;
  let logError;

  function load() {
    getBenchmarks = sinon.stub().resolves({ value: { ssd: 480 } });
    logError = sinon.stub();
    return proxyquire('../../ZelBack/src/services/appRequirements/nodeSpecs', {
      os: { cpus: () => new Array(8), totalmem: () => 16 * 1024 * 1024 * 1024 },
      '../benchmarkService': { getBenchmarks },
      '../../lib/log': { info: sinon.stub(), error: logError },
    });
  }

  it('reads cores and RAM from the host and the SSD from the benchmark', async () => {
    const nodeSpecs = load();
    expect(await nodeSpecs.getNodeSpecs()).to.deep.equal({ cpuCores: 8, ram: 16_384, ssdStorage: 480 });
  });

  it('reads the benchmark once', async () => {
    const nodeSpecs = load();
    await nodeSpecs.getNodeSpecs();
    await nodeSpecs.getNodeSpecs();
    sinon.assert.calledOnce(getBenchmarks);
  });

  it('leaves the SSD unread and asks again next time when the benchmark cannot answer', async () => {
    const nodeSpecs = load();
    getBenchmarks.resolves({ value: null, reason: 'benchmark down' });
    expect((await nodeSpecs.getNodeSpecs()).ssdStorage).to.equal(0);
    sinon.assert.calledOnce(logError);
    getBenchmarks.resolves({ value: { ssd: 480 } });
    expect((await nodeSpecs.getNodeSpecs()).ssdStorage).to.equal(480);
  });
});
