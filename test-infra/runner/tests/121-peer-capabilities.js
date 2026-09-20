// fleet: 6
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { waitFor } from '../framework/wait.js';
import { partition, healPartition } from '../framework/partition.js';
import { getSubnetConfig } from '../framework/subnet-config.js';

// The set the fleet declares, so this suite covers whatever is in it rather
// than whatever somebody remembered to write a case for.
const require = createRequire(import.meta.url);
const { FLUX_CAPABILITIES } = require('../../../ZelBack/src/services/utils/peerCapabilities.js');

// MSG_TYPE.REQUEST_APP_RUNNING — one of the four types a signed sync request
// carries, and the one every node answers whatever else it holds.
const REQUEST_APP_RUNNING = 0x21;

const MODERN_STUB = 4;
const LEGACY_STUB = 5;
const REAL_NODES = [0, 1, 2, 3];

let env;

describe('Peer capabilities', function () {

  before(async function () {
    this.timeout(300000);
    env = await createTestEnv({ hookCtx: this,
      nodes: 6,
      stubPeers: [MODERN_STUB, LEGACY_STUB],
      // One peer that claims syncSigV2 and one that claims nothing, which is the
      // only pairing that matters here. A fleet runs one image, so a peer whose
      // claim differs from the fleet's exists nowhere else.
      //
      // Neither claims a capability it does not implement. A stub advertising
      // binaryMessages is answered in a frame it never decodes, and one
      // advertising appStateSync is asked a question it never answers - which
      // reads as the node failing to respond.
      stubCapabilities: {
        [MODERN_STUB]: ['peerExchange', 'syncSigV2'],
        [LEGACY_STUB]: ['peerExchange'],
      },
      // A node stamps its per-peer response throttle on arrival, before the
      // signature is checked, so a refused request spends the slot its
      // successor needs. Each case here sends two requests seconds apart and
      // reads the answer to the second, which the throttle would swallow.
      configOverrides: { fluxapps: { syncResponseThrottleMs: 0 } },
    });
    await bootAndPeer(env);
    await waitFor(
      async () => await env.stubPeerClients.get(MODERN_STUB).connectedNodes() > 0
        && await env.stubPeerClients.get(LEGACY_STUB).connectedNodes() > 0,
      { timeout: 180000, label: 'both stubs dialled by the fleet' },
    );
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  // What a node records about a peer decides what it sends that peer, so a name
  // that does not survive the handshake silently disables its own behaviour.
  describe('the handshake', function () {

    it('carries every capability this build declares', async function () {
      this.timeout(60000);
      // A real node's own header, not a stub's: a stub advertises whatever this
      // suite told it to, and only a fleet node proves the declared list
      // survives the wire intact. It cannot catch a wrong list - both ends read
      // the same constant - only one that arrives short.
      //
      // Whichever node holds a fleet peer: which ones peer with which is a dial
      // race, and this is a claim about the header, not about node 0.
      const stubIps = [MODERN_STUB, LEGACY_STUB].map((i) => env.stubPeerClients.get(i).ip);
      let fleetPeer = null;
      for (const i of REAL_NODES) {
        const peers = (await env.clients[i].getPeerDetails()).data;
        fleetPeer = peers.find((p) => !stubIps.includes(p.ip));
        if (fleetPeer) break;
      }

      expect(fleetPeer, 'no fleet node holds another fleet node').to.exist;
      expect([...fleetPeer.capabilities].sort()).to.deep.equal([...FLUX_CAPABILITIES].sort());
    });

    it('records what the peer advertised, not what this node supports', async function () {
      this.timeout(60000);
      // Whichever node dialled it: peering decides that, and this is a claim
      // about the handshake rather than about a particular node.
      const legacyIp = env.stubPeerClients.get(LEGACY_STUB).ip;
      let legacy = null;
      for (const i of REAL_NODES) {
        const peers = (await env.clients[i].getPeerDetails()).data;
        legacy = peers.find((p) => p.ip === legacyIp);
        if (legacy) break;
      }

      expect(legacy, 'no fleet node holds the legacy stub').to.exist;
      expect(legacy.capabilities).to.deep.equal(['peerExchange']);
      expect(legacy.capabilities).to.not.include('syncSigV2');
    });
  });

  // Which payload a sync request is signed over is settled by the peer's
  // advertisement. Each case sends the contradicting form first and the claimed
  // one second: the answer to the second is what proves the exchange works at
  // all, without which a refusal of the first says nothing.
  describe('a signed sync request', function () {

    // One answer per node holding this peer, so the expected count is what the
    // request reached rather than one.
    async function answers(stubIndex, accepted, refused) {
      const stub = env.stubPeerClients.get(stubIndex);
      const before = await stub.syncResponsesReceived();

      await stub.requestSync({ type: REQUEST_APP_RUNNING, form: refused });
      const { sent } = await stub.requestSync({ type: REQUEST_APP_RUNNING, form: accepted });

      // A peer with no open socket signs, sends to an empty set and answers 200.
      // Without this the wait below times out over a fleet nobody asked.
      expect(sent, 'the stub reached no node').to.be.greaterThan(0);

      await waitFor(async () => (await stub.syncResponsesReceived()) - before >= sent,
        { timeout: 60000, label: `stub ${stubIndex} answered by all ${sent}` });

      // Responses travel the socket the requests arrived on, so answers to the
      // refused request are already counted by the time the accepted one's are.
      return { answered: (await stub.syncResponsesReceived()) - before, sent };
    }

    it('is answered in the form the peer claimed, and only that form', async function () {
      this.timeout(120000);
      const { answered, sent } = await answers(MODERN_STUB, 'v2', 'legacy');
      expect(answered).to.equal(sent);
    });

    it('holds a peer that claims nothing to the run-together form', async function () {
      this.timeout(120000);
      const { answered, sent } = await answers(LEGACY_STUB, 'legacy', 'v2');
      expect(answered).to.equal(sent);
    });

    // The fleet asking ITSELF, which is what a stub cannot stand in for: a stub
    // signs whichever form the suite names, so it exercises the verifier and
    // never the sender's own choice of form. A node that picks the wrong one
    // for every peer is refused by every peer, and nothing above would notice.
    it('is accepted when one fleet node asks another', async function () {
      this.timeout(60000);
      const stubIps = [MODERN_STUB, LEGACY_STUB].map((i) => env.stubPeerClients.get(i).ip);
      const answeredAFleetNode = REAL_NODES.some((i) => env.nodeLogLines(i).some(
        (line) => line.includes('Sending final')
          && !stubIps.some((ip) => line.includes(ip)),
      ));

      expect(answeredAFleetNode, 'no fleet node answered another fleet node').to.equal(true);
    });

    // The SECOND place a peer is handed to the sync orchestrator. A peer that
    // comes back is asked to fill the gap over a projection built separately
    // from the one the boot round uses, so a field carried through one and not
    // the other leaves this path signing a form its peer refuses - and every
    // case above would still pass.
    it('is accepted when a peer that dropped is asked to fill the gap', async function () {
      this.timeout(300000);
      const cfg = getSubnetConfig();
      const stubIps = [MODERN_STUB, LEGACY_STUB].map((i) => env.stubPeerClients.get(i).ip);
      const dropped = REAL_NODES[REAL_NODES.length - 1];
      const droppedIp = cfg.nodeIp(dropped + 1);
      // Anchored, because the buffer already holds reconnect requests from the
      // peer churn at boot: an unanchored wait is answered by one of those and
      // never requires this partition to have caused anything.
      const anchors = REAL_NODES.map((i) => env.clients[i].getLastEventId());

      // The drop has to land before it is healed, or nothing is ever lost and
      // no reconnect is ever pulled. Not swallowed: a partition that did not
      // take means this case proved nothing.
      await partition(env, [dropped]);
      await waitFor(
        async () => !(await env.clients[0].getPeers()).data
          .some((peer) => String(peer).includes(droppedIp)),
        { timeout: 120000, label: `node 0 lost ${droppedIp}` },
      );
      await healPartition(env, [dropped]);

      // Held to a pull aimed at a FLEET node: a pull at a stub proves nothing
      // about the form, because a stub verifies nothing.
      const pull = await Promise.race(REAL_NODES.map(
        (i, n) => env.clients[i].waitForEvent(
          'ephemeralSync:reconnectRequested',
          (data) => !stubIps.some((ip) => String(data.peer).includes(ip)),
          180000,
          { afterId: anchors[n] },
        ).then((event) => ({ asker: i, peer: String(event.data.peer) })),
      ));

      const askerIp = cfg.nodeIp(pull.asker + 1);
      const target = REAL_NODES.find((i) => pull.peer.includes(cfg.nodeIp(i + 1)));
      expect(target, `reconnect pull aimed at ${pull.peer}, which is no fleet node`).to.not.equal(undefined);

      const linesFrom = (needle) => env.nodeLogLines(target)
        .filter((line) => line.includes(needle) && line.includes(askerIp)).length;
      const answeredBefore = linesFrom('Sending final');
      const refusedBefore = linesFrom('rejected: bad signature');

      // THE EVENT SAYS THE REQUEST LEFT, NOT THAT IT LANDED. The verdict is the
      // peer's, taken after the frame crosses the wire, so reading the refusal
      // count the moment the event fires reads it before it could exist.
      await waitFor(() => linesFrom('Sending final') > answeredBefore
        || linesFrom('rejected: bad signature') > refusedBefore,
      { timeout: 120000, label: `node ${target} acted on the reconnect pull from ${askerIp}` });

      expect(linesFrom('rejected: bad signature'), 'the reconnect pull was refused').to.equal(refusedBefore);
      expect(linesFrom('Sending final')).to.be.greaterThan(answeredBefore);
    });

    it('refuses a peer whose signature contradicts its own advertisement', async function () {
      this.timeout(60000);
      // Named, because a bad signature from ANYONE satisfies the bare line -
      // including a node refusing every peer it has, which is the failure this
      // suite exists to catch. Only a refusal of the stub that contradicted
      // itself says the rule fired for the stated reason.
      const stubIps = [MODERN_STUB, LEGACY_STUB].map((i) => env.stubPeerClients.get(i).ip);
      const refusedTheStub = REAL_NODES.some((i) => env.nodeLogLines(i).some(
        (line) => line.includes('rejected: bad signature')
          && stubIps.some((ip) => line.includes(ip)),
      ));

      expect(refusedTheStub, 'no node refused the contradicting stub').to.equal(true);
    });
  });
});
