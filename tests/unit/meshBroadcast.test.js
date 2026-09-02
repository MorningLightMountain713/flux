'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('meshBroadcast', () => {
  let meshBroadcast;
  let stubs;

  const ANCHOR = { height: 2843890, hash: '7413fd279058ad2088b061d719fbf59d90cd5e509a08ab0d11746b91d7c01c4c' };
  const UUID = '5db6f53acbbd9b38e949307e96601e573bd6437ddec08707e76a33f771b358ea';
  const TXHASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  const meshApp = { name: 'myblog', uuid: UUID, identity: 'ab12cd34ef56' };
  const plainApp = { name: 'plain', uuid: null, identity: null };
  const views = (meshNames) => new Map(
    [meshApp, plainApp].map((inst) => [
      inst.name,
      { network: { mesh: meshNames.includes(inst.name) } },
    ]),
  );

  beforeEach(() => {
    stubs = {
      collateral: sinon.stub().resolves({ txhash: TXHASH, txindex: 0 }),
      anchor: sinon.stub().resolves(ANCHOR),
      mint: sinon.stub().resolves('voucher-b64'),
      bundle: sinon.stub().resolves('CA-PEM'),
      getPort: sinon.stub().resolves(16230),
    };
    meshBroadcast = proxyquire('../../ZelBack/src/services/appMesh/meshBroadcast', {
      '../generalService': { obtainNodeCollateralInformation: stubs.collateral },
      './meshVoucher': { fetchVoucherAnchor: stubs.anchor, mintVoucher: stubs.mint },
      './meshCertificates': { authorityBundle: stubs.bundle },
      './meshPorts': { getPort: stubs.getPort },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
  });

  afterEach(() => sinon.restore());

  it('returns no anchor and no fields when nothing is mesh-enabled', async () => {
    const result = await meshBroadcast.meshBroadcastFields([plainApp], views([]));
    expect(result.anchor).to.equal(null);
    expect(result.perApp.size).to.equal(0);
    expect(stubs.anchor.called).to.equal(false);
  });

  it('publishes the bundle, a fresh voucher over the anchor, and the port', async () => {
    const result = await meshBroadcast.meshBroadcastFields([meshApp, plainApp], views(['myblog']));
    expect(result.anchor).to.deep.equal(ANCHOR);
    expect(result.perApp.get('myblog')).to.deep.equal({
      meshCa: 'CA-PEM', meshVoucher: 'voucher-b64', meshPort: 16230,
    });
    expect(result.perApp.has('plain')).to.equal(false);
    expect(stubs.mint.firstCall.args[0]).to.deep.equal({
      meshCa: 'CA-PEM', appUuid: UUID, outpoint: `${TXHASH}:0`, blockHash: ANCHOR.hash,
    });
  });

  it('announces without mesh fields while no port is secured, and drops the anchor', async () => {
    stubs.getPort.resolves(null);
    const result = await meshBroadcast.meshBroadcastFields([meshApp], views(['myblog']));
    expect(result.perApp.size).to.equal(0);
    expect(result.anchor).to.equal(null);
  });

  it('one failing app does not block another', async () => {
    const second = { name: 'other', uuid: UUID.replace('5', '6'), identity: 'ff00ff00ff00' };
    const twoViews = new Map([
      ['myblog', { network: { mesh: true } }],
      ['other', { network: { mesh: true } }],
    ]);
    stubs.bundle.withArgs('ab12cd34ef56').rejects(new Error('No mesh authority exists'));
    const result = await meshBroadcast.meshBroadcastFields([meshApp, second], twoViews);
    expect(result.perApp.has('myblog')).to.equal(false);
    expect(result.perApp.get('other')).to.include({ meshPort: 16230 });
    expect(result.anchor).to.deep.equal(ANCHOR);
  });

  it('skips every mesh field this cycle when the tip is unavailable', async () => {
    stubs.anchor.rejects(new Error('daemon down'));
    const result = await meshBroadcast.meshBroadcastFields([meshApp], views(['myblog']));
    expect(result.anchor).to.equal(null);
    expect(result.perApp.size).to.equal(0);
  });
});
