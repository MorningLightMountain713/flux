// weight: light
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createRequire } from 'node:module';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { waitFor } from '../framework/wait.js';

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
      // One peer that claims everything this build claims, and one that claims
      // only what every release has always claimed. A fleet runs one image, so
      // this pairing is the only place a mixed release exists.
      stubCapabilities: {
        [MODERN_STUB]: FLUX_CAPABILITIES,
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
      // reaches the wire.
      const stubIps = [MODERN_STUB, LEGACY_STUB].map((i) => env.stubPeerClients.get(i).ip);
      const peers = (await env.clients[0].getPeerDetails()).data;
      const fleetPeer = peers.find((p) => !stubIps.includes(p.ip));

      expect(fleetPeer, 'node 0 holds no fleet peer').to.exist;
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

    it('refuses a peer whose signature contradicts its own advertisement', async function () {
      this.timeout(60000);
      // The stub asks every node holding it, so the refusal lands wherever the
      // contradicting request did. Both cases above sent one.
      const refused = REAL_NODES.some((i) => env.nodeHasLog(i, 'rejected: bad signature'));
      expect(refused, 'no node logged a refusal').to.equal(true);
    });
  });
});
