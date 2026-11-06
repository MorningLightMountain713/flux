// fleet: 3
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { crashFluxos, moveNodeAddress, stopAppContainer } from '../framework/container.js';
import {
  clearNodeAddress, holdRpc, releaseRpc, setNodeAddress,
} from '../framework/daemon-control.js';
import { clearMaster, resetFdm } from '../framework/fdm-control.js';
import { waitFor, waitForUp } from '../framework/wait.js';
import { dbClient } from '../framework/db-client.js';
import { socketAddr } from '../framework/state-events.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';
import { placeSilentPrimaryApp, A, B, C } from '../framework/silent-primary.js';
import { peerDeathMs } from '../framework/coupled-knobs.js';

// A primary moves, its peers hear it, and the machine dies before the node list
// names the new address. The connections it made from there drop at an address
// the list does not hold, which names nobody to its jurors, and its connections
// from the old address outlive the list's move. Once the list names it, the
// jurors' failed dials to that address are what certify it down, and the standby
// takes the app over.
//
// Peer liveness outlasts the detection budget, as in 2228, so the old connections
// are still held when the list moves.
//
// A = the standby, B = the primary, C = a bystander the discovery ring needs.

const SIGTERM_EXPIRY_S = 120;
const DETECTION_MS = 6 * 60 * 1000;
const ADDRESS_MOVE_PEERS = Object.freeze({ wsPingIntervalMs: 120000, wsMaxMissedPongs: 3 });
if (peerDeathMs(ADDRESS_MOVE_PEERS) <= DETECTION_MS) {
  throw new Error('2266: peer liveness must outlast the detection budget, or the move is noticed after its dead connections have closed');
}
// The jurors dial on a two-minute sweep and judge on the second failure in a row;
// then the standby's syncthing holds a dead connection until its own receive
// timeout, 5 minutes from the crash and not compressed by the harness.
const TAKEOVER_MS = 10 * 60 * 1000;

describe('a primary that died before the list caught up with its move is taken over', function () {
  let fleet;
  dumpLogsOnFailure(() => fleet?.env);
  const appName = `e2ediedmoving${Date.now()}`;
  const client = (i) => fleet.env.clients[i];
  let oldIp;
  let movedIp;

  before(async function () {
    this.timeout(900000);
    fleet = await placeSilentPrimaryApp({
      hookCtx: this, appName, sigtermExpiryS: SIGTERM_EXPIRY_S, peers: ADDRESS_MOVE_PEERS,
    });
    oldIp = client(B).ip;
    movedIp = oldIp.replace(/\.\d+$/, '.240');
  });

  after(async function () {
    this.timeout(60000);
    fleet?.stop();
    await releaseRpc(movedIp).catch(() => {});
    await clearNodeAddress(oldIp).catch(() => {});
    await resetFdm().catch(() => {});
    await fleet?.env.teardown();
  });

  it('is heard moving by every peer while the list still names its old address', async function () {
    this.timeout(DETECTION_MS + 300000);
    // The confirmation is what moves the list; held, the list stays at the old
    // address until this suite moves it.
    await holdRpc(movedIp, 'createconfirmationtransaction');
    await moveNodeAddress(client(B).container, movedIp, oldIp);
    const followed = await client(B).followTo(movedIp);
    await setNodeAddress(oldIp, movedIp, { scope: 'publicip' });
    const restarted = (d) => d.identifier === fleet.identifier && d.action === 'restarted';
    await client(B).waitForEvent('reconciler:actuated', restarted, DETECTION_MS, { afterId: followed });
    await setNodeAddress(oldIp, movedIp, { scope: 'benchmark' });

    const oldSocket = socketAddr(B + 1);
    const newSocket = `${movedIp}:16127`;
    const heldMove = async (i) => (await dbClient(i + 1).getAppStateEvents({ ip: oldSocket, type: 'ipchanged' }))
      .some((event) => event.data?.newIP === newSocket);
    await waitFor(async () => (await heldMove(A)) && (await heldMove(C)), {
      timeout: 240000, interval: 5000, label: 'every peer holds the move',
    });
  });

  it('is certified down and taken over by the standby once the list names the address it died at', async function () {
    this.timeout(TAKEOVER_MS + 180000);
    const standbyFrom = client(A).getLastEventId();

    await crashFluxos(client(B).container, { hold: true });
    await stopAppContainer(client(B).container, appName, appName);
    await fleet.env.disconnectNode(B);
    await clearMaster(appName);
    await setNodeAddress(oldIp, movedIp, { scope: 'all' });

    await client(A).waitForEvent('nodedown:assembled', () => true, TAKEOVER_MS, { afterId: standbyFrom });
    await client(A).waitForEvent('primaryRole:changed', (d) => d.identifier === fleet.identifier && d.to === 'promoting',
      TAKEOVER_MS, { afterId: standbyFrom });
    await waitForUp(client(A), appName, 'the standby runs the app', { timeout: 180000, interval: 3000 });
    expect(fleet.twoRan, 'moments when more than one node ran the component').to.deep.equal([]);
  });
});
