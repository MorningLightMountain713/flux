'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');

const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const enterpriseNodesService = require('../../ZelBack/src/services/enterpriseNodesService');
const { v8Spec, v9Spec, instantiatedSpec } = require('./fixtures/fluxSpec');
const { stubRegistry } = require('./fixtures/appRecords');

describe('enterpriseNodesService', () => {
  const TXHASH = 'a'.repeat(64);
  const node = (fields) => ({
    tier: 'CUMULUS', payment_address: 't1pay', pubkey: 'pub', activesince: Math.floor(Date.now() / 1000) - 86_400, ...fields,
  });

  afterEach(() => sinon.restore());

  it('counts against a node every app the registry says is pinned to it, by its address or its collateral outpoint, whatever the spec version', async () => {
    sinon.stub(fluxCommunicationUtils, 'deterministicFluxList').resolves([
      node({ ip: '1.2.3.4', txhash: TXHASH, outidx: 0 }),
      node({ ip: '5.6.7.8', txhash: 'b'.repeat(64), outidx: 1 }),
    ]);
    const byAddress = await instantiatedSpec(await v9Spec({ name: 'byaddress', placement: { targetIps: ['1.2.3.4'] } }), { hash: 'h1' });
    const byOutpoint = await instantiatedSpec(await v8Spec({ name: 'byoutpoint', nodes: [`${TXHASH}:0`] }, { encrypted: true }), { hash: 'h2' });
    expect(byOutpoint.placement.targetOutpoints, 'the legacy node list names the outpoint').to.deep.equal([`${TXHASH}:0`]);
    stubRegistry().pinned.resolves([byAddress, byOutpoint]);

    const list = await enterpriseNodesService.getEnterpriseList();

    expect(Object.fromEntries(list.map((entry) => [entry.ip, entry.enterpriseApps]))).to.deep.equal({ '1.2.3.4': 2, '5.6.7.8': 0 });
  });
});
