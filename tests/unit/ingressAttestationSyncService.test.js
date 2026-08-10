'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const setReconciler = require('../../ZelBack/src/services/appMessaging/setReconciler');

function load() {
  return proxyquire('../../ZelBack/src/services/appMessaging/ingressAttestationSyncService', {
    config: { fluxapps: {} },
    '../serviceHelper': { delay: sinon.stub().resolves() },
    './setReconciler': setReconciler,
    '../appDatabase/appsRepository': { listIngressAttestationDigests: sinon.stub().resolves([]) },
    '../utils/fluxBroadcastHelper': { serialiseAndSignFluxBroadcast: sinon.stub().callsFake(async (m) => m) },
  });
}

const idOf = (r) => `${r.hash}|${r.node}`;
const digestsOf = (records) => setReconciler.bucketDigests(records, { identityOf: idOf });

describe('ingressAttestationSyncService', () => {
  afterEach(() => sinon.restore());

  describe('depositDigests / isPeerInActiveRound', () => {
    it('ignores a deposit when there is no active round', () => {
      const svc = load();
      expect(svc.isPeerInActiveRound('p1')).to.equal(false);
      svc.depositDigests('p1', digestsOf([{ hash: 'h1', node: 'nA' }])); // no throw, no-op
    });
  });

  describe('reconcile', () => {
    // A peer that simulates the wire: a digest request deposits its bucket digests;
    // a fetch request delivers its records that fall in the requested buckets.
    function makePeer(svc, key, peerRecords, store) {
      const peer = { key };
      peer.send = sinon.stub().callsFake((msg) => {
        if (msg.type === 'fluxappingressindexrequest') {
          expect(svc.isPeerInActiveRound(key)).to.equal(true); // solicited mid-round
          svc.depositDigests(key, digestsOf(peerRecords));
        } else if (msg.type === 'fluxappingressrequest') {
          const wanted = new Set(msg.buckets);
          const have = new Set(store.map(idOf));
          for (const r of peerRecords) {
            if (wanted.has(setReconciler.bucketOf(idOf(r))) && !have.has(idOf(r))) store.push(r);
          }
        }
      });
      return peer;
    }

    const localDigestsFrom = (store) => sinon.stub().callsFake(async () => digestsOf(store));

    it('is a no-op with no peers', async () => {
      const svc = load();
      expect(await svc.reconcile([])).to.deep.equal({ peers: 0, indexesReceived: 0, fetched: 0 });
    });

    it('fetches only the differing buckets and converges the set', async () => {
      const svc = load();
      const store = [{ hash: 'h1', node: 'nA' }]; // missing h2/nB and h3/nC
      const getLocalDigests = localDigestsFrom(store);
      const peerRecords = [{ hash: 'h1', node: 'nA' }, { hash: 'h2', node: 'nB' }, { hash: 'h3', node: 'nC' }];
      const p1 = makePeer(svc, 'p1', peerRecords, store);

      const result = await svc.reconcile([p1], { getLocalDigests });

      expect(result.peers).to.equal(1);
      expect(result.indexesReceived).to.equal(1);
      expect(result.fetched).to.be.greaterThan(0);
      // The store converged to the peer's set.
      expect(store.map(idOf).sort()).to.deep.equal(['h1|nA', 'h2|nB', 'h3|nC']);

      // A digest request then a bucket fetch for exactly the divergent buckets.
      expect(p1.send.firstCall.args[0].type).to.equal('fluxappingressindexrequest');
      const fetch = p1.send.getCalls().find((c) => c.args[0].type === 'fluxappingressrequest');
      expect(fetch.args[0].buckets.sort((a, b) => a - b))
        .to.deep.equal([setReconciler.bucketOf('h2|nB'), setReconciler.bucketOf('h3|nC')].sort((a, b) => a - b));
      expect(svc.isPeerInActiveRound('p1')).to.equal(false); // round closed
    });

    it('sends no fetch when the local set already matches the peer', async () => {
      const svc = load();
      const store = [{ hash: 'h1', node: 'nA' }];
      const getLocalDigests = localDigestsFrom(store);
      const p1 = makePeer(svc, 'p1', [{ hash: 'h1', node: 'nA' }], store);

      const result = await svc.reconcile([p1], { getLocalDigests });
      expect(result.fetched).to.equal(0);
      const fetch = p1.send.getCalls().find((c) => c.args[0].type === 'fluxappingressrequest');
      expect(fetch).to.equal(undefined);
    });

    it('fetches a missing node even when the hash is already partly held', async () => {
      const svc = load();
      const store = [{ hash: 'h1', node: 'nA' }]; // has nA; peer also has nB for the same hash
      const getLocalDigests = localDigestsFrom(store);
      const p1 = makePeer(svc, 'p1', [{ hash: 'h1', node: 'nA' }, { hash: 'h1', node: 'nB' }], store);

      const result = await svc.reconcile([p1], { getLocalDigests });
      expect(result.fetched).to.be.greaterThan(0);
      expect(store.map(idOf).sort()).to.deep.equal(['h1|nA', 'h1|nB']);
    });
  });
});
