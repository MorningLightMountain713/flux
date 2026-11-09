// The endpoints that reset a store are a Flux team operation, never a node
// operator's: the explorer's reindex and rescan rebuild the chain data every app
// payment is read from, and the location reindex, which has nothing to rebuild
// since locations are derived from the app state events, answers only the team.
//
// The explorer reset covers chain data only. Its apps flag would drop the app
// messages, which come from the network rather than the chain, and the
// registry, which follows the decisions on them; it is refused.

const { expect } = require('chai');
const sinon = require('sinon');

const dbHelper = require('../../ZelBack/src/services/dbHelper');

const explorerService = require('../../ZelBack/src/services/explorerService');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const { Privilege } = require('../../ZelBack/src/services/utils/privileges');

describe('endpoints that reset a store', () => {
  let asked;

  beforeEach(() => {
    asked = [];
    sinon.stub(verificationHelper, 'verifyPrivilege').callsFake(async (privilege) => {
      asked.push(privilege);
      return false;
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  [
    { name: 'explorer reindex', handler: () => explorerService.reindexExplorerApi },
    { name: 'explorer rescan', handler: () => explorerService.rescanExplorerApi },
    { name: 'global apps location reindex', handler: () => registryManager.reindexGlobalAppsLocationAPI },
  ].forEach(({ name, handler }) => {
    it(`${name} asks for the Flux team and nothing wider, and refuses anyone else`, async () => {
      const res = { json: sinon.stub() };
      await handler()({ params: {}, headers: { zelidauth: 'operator' } }, res);

      expect(asked).to.deep.equal([Privilege.FLUX_TEAM]);
      expect(res.json.calledOnce).to.equal(true);
      expect(res.json.firstCall.args[0].status).to.equal('error');
    });
  });
});

describe('the explorer reset\'s apps flag', () => {
  let writes;

  beforeEach(() => {
    sinon.stub(verificationHelper, 'verifyPrivilege').resolves(true);
    writes = [
      sinon.stub(dbHelper, 'dropCollection').resolves(true),
      sinon.stub(dbHelper, 'updateOneInDatabase').resolves(true),
      sinon.stub(dbHelper, 'findOneInDatabase').resolves({ generalScannedHeight: 1000 }),
    ];
  });

  afterEach(() => {
    sinon.restore();
  });

  const response = () => {
    const res = { json: sinon.stub() };
    res.status = sinon.stub().returns(res);
    return res;
  };

  [
    { name: 'explorer reindex', handler: () => explorerService.reindexExplorerApi, params: { reindexapps: 'true' } },
    { name: 'explorer reindex, flag in the query', handler: () => explorerService.reindexExplorerApi, query: { reindexapps: 'true' } },
    { name: 'explorer reindex, flag in the query by the rescan\'s name', handler: () => explorerService.reindexExplorerApi, query: { rescanapps: 'true' } },
    { name: 'explorer rescan', handler: () => explorerService.rescanExplorerApi, params: { blockheight: '100', rescanapps: 'true' } },
  ].forEach(({
    name, handler, params = {}, query = {},
  }) => {
    it(`${name} refuses the apps flag with a 400 saying the registry needs no rebuild, and touches nothing`, async () => {
      const res = response();
      await handler()({ params, query, headers: { zelidauth: 'team' } }, res);

      expect(res.status.calledOnceWithExactly(400)).to.equal(true);
      expect(res.json.firstCall.args[0].data.message).to.include('needs no rebuild');
      writes.forEach((write) => sinon.assert.notCalled(write));
    });
  });
});
