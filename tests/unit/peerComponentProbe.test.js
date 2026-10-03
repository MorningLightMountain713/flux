'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const axios = require('axios');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');
const peerFolderLiveness = require('../../ZelBack/src/services/appMonitoring/peerFolderLiveness');
const peerComponentProbe = require('../../ZelBack/src/services/appLifecycle/peerComponentProbe');

describe('peerComponentProbe tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('peerComponentState - what stops a second writer', () => {
    const APP_ID = 'fluxweb_gapp';
    const ask = (liveness = { localConnectivity: () => ({ connected: true }) }) => peerComponentProbe.peerComponentState({
      appId: APP_ID,
      identifier: 'web_gapp',
      appName: 'gapp',
      peerSocketAddr: '203.0.113.7:16127',
      label: 'index 1',
      liveness,
    });
    const { PeerComponent } = peerComponentProbe;

    const held = (list) => ({ data: { status: 'success', data: list } });
    const heldUrl = (c) => c.args[0].includes('/apps/heldcomponents');
    const runningUrl = (c) => c.args[0].includes('/apps/listrunningapps');

    it('asks what the peer HOLDS, not what it is running', async () => {
      const get = sinon.stub(axios, 'get').resolves(held([]));

      await ask();

      // The promotion path commits, chowns, and only then starts a container. In
      // that window listrunningapps truthfully answers "free" for a component the
      // peer has already claimed.
      expect(get.getCalls().some(heldUrl), 'heldcomponents must be asked first').to.be.true;
      expect(get.getCalls().some(runningUrl), 'and the container list not consulted when it answers').to.be.false;
    });

    it('holds the start when the peer holds the component', async () => {
      sinon.stub(axios, 'get').resolves(held([APP_ID, 'fluxother_app']));
      const count = sinon.stub(fluxEventBus, 'count');
      expect(await ask()).to.equal(PeerComponent.RUNNING);
      sinon.assert.calledWithExactly(count, 'masterSlave:decision', 'web_gapp', 'heldOnPeer');
    });

    it('clears the start only when the peer answers and does not hold it', async () => {
      sinon.stub(axios, 'get').resolves(held(['fluxother_app']));
      expect(await ask()).to.equal(PeerComponent.NOT_RUNNING);
    });

    // A peer that has not moved the app onto its identity, or runs 8.x, holds a
    // component of an app registered before v9 under its 8.x name.
    it('holds the start when the peer holds the component under its 8.x name, by the held list or by the container list', async () => {
      const askByIdentity = () => peerComponentProbe.peerComponentState({
        appId: 'web_bident', folderId: 'fluxweb_gapp', aliases: ['fluxweb_gapp'], identifier: 'web_bident', appName: 'gapp', peerSocketAddr: '203.0.113.7:16127', label: 'index 1', liveness: { localConnectivity: () => ({ connected: true }) },
      });
      sinon.stub(axios, 'get').resolves(held(['fluxweb_gapp']));
      expect(await askByIdentity()).to.equal(PeerComponent.RUNNING);
      sinon.restore();

      const get = sinon.stub(axios, 'get');
      get.withArgs(sinon.match('/apps/heldcomponents'), sinon.match.any)
        .rejects(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
      get.withArgs(sinon.match('/apps/listrunningapps'), sinon.match.any)
        .resolves({ data: { status: 'success', data: [{ Names: ['/fluxweb_gapp'] }] } });
      expect(await askByIdentity()).to.equal(PeerComponent.RUNNING);
    });

    it('judges a silent peer by the folder id, not the container name', async () => {
      sinon.stub(axios, 'get').rejects(new Error('ECONNREFUSED'));
      const verdict = sinon.stub(peerFolderLiveness, 'silenceVerdict').resolves(peerFolderLiveness.SilenceVerdict.GONE);
      const liveness = { localConnectivity: () => ({ connected: true }) };
      expect(await peerComponentProbe.peerComponentState({
        appId: 'web_bident', folderId: 'fluxweb_gapp', identifier: 'web_bident', appName: 'gapp', peerSocketAddr: '203.0.113.7:16127', label: 'index 1', liveness,
      })).to.equal(PeerComponent.NOT_RUNNING);
      sinon.assert.calledOnceWithExactly(verdict, 'fluxweb_gapp', '203.0.113.7:16127', liveness);
    });

    it('falls back to the container list for a peer too old for the route', async () => {
      const get = sinon.stub(axios, 'get');
      // A STATUS is an answer: the peer is alive, merely too old for the route.
      get.withArgs(sinon.match('/apps/heldcomponents'), sinon.match.any)
        .rejects(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
      get.withArgs(sinon.match('/apps/listrunningapps'), sinon.match.any)
        .resolves({ data: { status: 'success', data: [{ Names: [`/${APP_ID}`] }] } });

      expect(await ask()).to.equal(PeerComponent.RUNNING);
      expect(get.getCalls().some(runningUrl)).to.be.true;
    });

    // Alive and unreadable is UNKNOWN. Falling through to the container list would
    // answer from a source that cannot see the durable stop lock at all, so a
    // primary its owner stopped to work on reads as free.
    it('holds the start when the peer says it cannot answer what it holds', async () => {
      const get = sinon.stub(axios, 'get').resolves({ data: { status: 'error', data: { message: 'nope' } } });

      expect(await ask()).to.equal(PeerComponent.UNKNOWN);
      expect(get.getCalls().some(runningUrl), 'and must not ask a question it just said it cannot answer').to.be.false;
    });

    it('holds the start when the peer answers with something unreadable', async () => {
      sinon.stub(axios, 'get').resolves({ data: { status: 'success', data: 'not a list' } });
      expect(await ask()).to.equal(PeerComponent.UNKNOWN);
    });

    it('holds the start when the peer returns an error status', async () => {
      sinon.stub(axios, 'get').rejects(Object.assign(new Error('boom'), { response: { status: 500 } }));
      expect(await ask()).to.equal(PeerComponent.UNKNOWN);
    });

    describe('what clears the start', () => {
      const { anyPeerHoldsComponent } = peerComponentProbe;

      it('clears only when EVERY peer definitely does not have it', () => {
        expect(anyPeerHoldsComponent([PeerComponent.NOT_RUNNING, PeerComponent.NOT_RUNNING])).to.equal(false);
      });

      it('holds when any peer is running it', () => {
        expect(anyPeerHoldsComponent([PeerComponent.NOT_RUNNING, PeerComponent.RUNNING])).to.equal(true);
      });

      // The one-token difference. Read as `some(v => v === RUNNING)` this line
      // treats every UNKNOWN as a clearance - which is the behaviour that put a
      // second writer on a shared volume.
      it('holds when any peer is UNKNOWN, exactly as if it were running', () => {
        expect(anyPeerHoldsComponent([PeerComponent.NOT_RUNNING, PeerComponent.UNKNOWN])).to.equal(true);
      });
    });

    describe('silence', () => {
      // THE CASE THIS EXISTS FOR. Silence used to count as not-running and start.
      // FluxOS and the container fail independently: a node whose API is down
      // still holds its volume and still writes to it.
      beforeEach(() => {
        sinon.stub(axios, 'get').rejects(new Error('ECONNREFUSED'));
      });

      it('holds the start on silence with no evidence the peer is gone', async () => {
        sinon.stub(peerFolderLiveness, 'silenceVerdict').resolves(peerFolderLiveness.SilenceVerdict.NO_EVIDENCE);
        expect(await ask()).to.equal(PeerComponent.UNKNOWN);
      });

      it('holds the start on silence while the syncthing connection is still alive', async () => {
        sinon.stub(peerFolderLiveness, 'silenceVerdict').resolves(peerFolderLiveness.SilenceVerdict.CONNECTION_ALIVE);
        expect(await ask()).to.equal(PeerComponent.UNKNOWN);
      });

      // A node whose peers have ALL gone quiet is the one that fell over, and the
      // peer is very likely still serving on the other side of the split.
      it('holds the start on silence when this node cannot see the fleet', async () => {
        sinon.stub(peerFolderLiveness, 'silenceVerdict').resolves(peerFolderLiveness.SilenceVerdict.LOCALLY_ISOLATED);
        expect(await ask()).to.equal(PeerComponent.UNKNOWN);
      });

      it('clears the start only with evidence the peer is gone', async () => {
        sinon.stub(peerFolderLiveness, 'silenceVerdict').resolves(peerFolderLiveness.SilenceVerdict.GONE);
        expect(await ask()).to.equal(PeerComponent.NOT_RUNNING);
      });
    });
  });
});
