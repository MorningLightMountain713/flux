'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('processIdentity', () => {
  let identity;
  let stubs;

  beforeEach(() => {
    stubs = {
      getLocalSocketAddress: sinon.stub().resolves('1.2.3.4:16127'),
      sign: sinon.stub().callsFake(async (data) => JSON.stringify({ signed: data })),
      log: { warn: sinon.stub(), info: sinon.stub() },
    };
    identity = proxyquire('../../ZelBack/src/services/utils/processIdentity', {
      '../../lib/log': stubs.log,
      '../fluxNetworkHelper': { getLocalSocketAddress: stubs.getLocalSocketAddress },
      './fluxBroadcastHelper': { serialiseAndSignFluxBroadcast: stubs.sign },
    });
  });

  afterEach(() => sinon.restore());

  it('mints a random 128-bit process id at load, a new one per process', () => {
    expect(identity.processId).to.match(/^[0-9a-f]{32}$/);
    const other = proxyquire('../../ZelBack/src/services/utils/processIdentity', {
      '../../lib/log': stubs.log,
      '../fluxNetworkHelper': { getLocalSocketAddress: stubs.getLocalSocketAddress },
      './fluxBroadcastHelper': { serialiseAndSignFluxBroadcast: stubs.sign },
    });
    expect(other.processId).to.not.equal(identity.processId);
  });

  it('signs the stop with this node\'s address, its process id and the reason', async () => {
    const statement = await identity.stopStatement('restart');

    sinon.assert.calledOnceWithExactly(stubs.sign, {
      type: 'fluxprocessstop', version: 1, ip: '1.2.3.4:16127', processId: identity.processId, reason: 'restart',
    });
    expect(JSON.parse(statement).signed.type).to.equal('fluxprocessstop');
  });

  it('signs once per process: a later ask answers the same bytes, whatever reason it names', async () => {
    const first = await identity.stopStatement('restart');
    const second = await identity.stopStatement('shutdown');

    expect(second).to.equal(first);
    sinon.assert.calledOnce(stubs.sign);
  });

  it('answers null without a local address, and signs nothing', async () => {
    stubs.getLocalSocketAddress.resolves(null);

    expect(await identity.stopStatement('restart')).to.equal(null);
    sinon.assert.notCalled(stubs.sign);
  });

  it('answers null when signing fails', async () => {
    stubs.sign.rejects(new Error('no key'));

    expect(await identity.stopStatement('restart')).to.equal(null);
  });
});
