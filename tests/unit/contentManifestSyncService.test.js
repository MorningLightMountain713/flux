const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

function load() {
  return proxyquire('../../ZelBack/src/services/appMessaging/contentManifestSyncService', {
    config: { fluxapps: {} },
    '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    '../serviceHelper': { delay: sinon.stub().resolves() },
    '../appDatabase/appsRepository': { listConfirmedContentManifestVersions: sinon.stub().resolves([]) },
    '../utils/fluxBroadcastHelper': { serialiseAndSignFluxBroadcast: sinon.stub().callsFake(async (m) => m) },
  });
}

describe('contentManifestSyncService', () => {
  afterEach(() => sinon.restore());

  describe('unionTarget', () => {
    it('takes the highest version per app across every peer index', () => {
      const svc = load();
      const indexes = new Map([
        ['p1', [{ appName: 'a', version: 2 }, { appName: 'b', version: 5 }]],
        ['p2', [{ appName: 'a', version: 4 }, { appName: 'c', version: 1 }]],
      ]);
      const target = svc.unionTarget(indexes);
      expect([...target.entries()]).to.have.deep.members([['a', 4], ['b', 5], ['c', 1]]);
    });

    it('ignores malformed entries', () => {
      const svc = load();
      const indexes = new Map([['p1', [{ appName: 'a' }, { version: 3 }, null, { appName: 'b', version: 2 }]]]);
      const target = svc.unionTarget(indexes);
      expect([...target.entries()]).to.deep.equal([['b', 2]]);
    });
  });

  describe('computeNeeded', () => {
    it('returns apps the local register is missing or stale on', () => {
      const svc = load();
      const target = new Map([['a', 4], ['b', 5], ['c', 1]]);
      const local = new Map([['a', 4], ['b', 3]]); // a current, b stale, c absent
      expect(svc.computeNeeded(target, local).sort()).to.deep.equal(['b', 'c']);
    });
  });

  describe('depositIndex / isPeerInActiveRound', () => {
    it('ignores a deposit when there is no active round', () => {
      const svc = load();
      expect(svc.isPeerInActiveRound('p1')).to.equal(false);
      svc.depositIndex('p1', [{ appName: 'a', version: 1 }]); // no throw, no-op
    });
  });

  describe('reconcile', () => {
    // A peer whose send synchronously simulates the response: an index request deposits
    // the peer's canned index; a fetch request "stores" the requested apps at a high
    // version (so the next gap check finds them present).
    function makePeer(svc, key, index, store) {
      const peer = { key };
      peer.send = sinon.stub().callsFake((msg) => {
        if (msg.type === 'fluxappcontentmanifestindexrequest') {
          expect(svc.isPeerInActiveRound(key)).to.equal(true); // solicited mid-round
          svc.depositIndex(key, index);
        } else if (msg.type === 'fluxappcontentmanifestrequest') {
          for (const appName of msg.appNames) store.set(appName, 9999);
        }
      });
      return peer;
    }

    it('is a no-op with no peers', async () => {
      const svc = load();
      const result = await svc.reconcile([]);
      expect(result).to.deep.equal({ peers: 0, indexesReceived: 0, fetched: 0 });
    });

    it('runs the two-step exchange: index from all peers, fetch only the missing/stale', async () => {
      const svc = load();
      const store = new Map([['a', 4]]); // locally current on a, missing b and c
      const getLocalVersions = sinon.stub().callsFake(async () => [...store].map(([appName, version]) => ({ appName, version })));
      const p1 = makePeer(svc, 'p1', [{ appName: 'a', version: 4 }, { appName: 'b', version: 5 }], store);
      const p2 = makePeer(svc, 'p2', [{ appName: 'c', version: 1 }], store);

      const result = await svc.reconcile([p1, p2], { getLocalVersions });

      expect(result.peers).to.equal(2);
      expect(result.indexesReceived).to.equal(2);
      // b (stale 4<5) and c (absent) are fetched; a is current and not refetched.
      expect(result.fetched).to.equal(2);

      // Both peers got an index request.
      expect(p1.send.firstCall.args[0].type).to.equal('fluxappcontentmanifestindexrequest');
      expect(p2.send.firstCall.args[0].type).to.equal('fluxappcontentmanifestindexrequest');
      // The first peer's fetch carried exactly the needed apps; the second peer is not
      // asked again because the first already closed the gap (fetch-each-body-once).
      const p1Fetch = p1.send.getCalls().find((c) => c.args[0].type === 'fluxappcontentmanifestrequest');
      expect(p1Fetch.args[0].appNames.sort()).to.deep.equal(['b', 'c']);
      const p2Fetch = p2.send.getCalls().find((c) => c.args[0].type === 'fluxappcontentmanifestrequest');
      expect(p2Fetch).to.equal(undefined);

      // The round is closed afterwards.
      expect(svc.isPeerInActiveRound('p1')).to.equal(false);
    });

    it('sends no fetch when the local register already matches the union', async () => {
      const svc = load();
      const store = new Map([['a', 4]]);
      const getLocalVersions = sinon.stub().callsFake(async () => [...store].map(([appName, version]) => ({ appName, version })));
      const p1 = makePeer(svc, 'p1', [{ appName: 'a', version: 4 }], store);

      const result = await svc.reconcile([p1], { getLocalVersions });
      expect(result.fetched).to.equal(0);
      const fetch = p1.send.getCalls().find((c) => c.args[0].type === 'fluxappcontentmanifestrequest');
      expect(fetch).to.equal(undefined);
    });

    it('falls to the next peer for bodies the first peer did not supply', async () => {
      const svc = load();
      const store = new Map(); // missing both a and b
      const getLocalVersions = sinon.stub().callsFake(async () => [...store].map(([appName, version]) => ({ appName, version })));
      // p1 advertises a+b but its fetch only stores 'a'; p2 fills 'b'.
      const p1 = { key: 'p1' };
      p1.send = sinon.stub().callsFake((msg) => {
        if (msg.type === 'fluxappcontentmanifestindexrequest') svc.depositIndex('p1', [{ appName: 'a', version: 2 }, { appName: 'b', version: 2 }]);
        else if (msg.type === 'fluxappcontentmanifestrequest') store.set('a', 9999); // only delivers a
      });
      const p2 = { key: 'p2' };
      p2.send = sinon.stub().callsFake((msg) => {
        if (msg.type === 'fluxappcontentmanifestindexrequest') svc.depositIndex('p2', [{ appName: 'b', version: 2 }]);
        else if (msg.type === 'fluxappcontentmanifestrequest') { for (const n of msg.appNames) store.set(n, 9999); }
      });

      const result = await svc.reconcile([p1, p2], { getLocalVersions });
      expect(result.fetched).to.equal(2); // a from p1, b from p2
      const p2Fetch = p2.send.getCalls().find((c) => c.args[0].type === 'fluxappcontentmanifestrequest');
      expect(p2Fetch.args[0].appNames).to.deep.equal(['b']); // only the still-missing one
    });
  });
});
