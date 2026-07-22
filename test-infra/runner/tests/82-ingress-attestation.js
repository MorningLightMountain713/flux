import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import {
  buildAppSpec, registerAndConfirm, signAppSpec,
} from '../framework/app-helper.js';
import { authenticate } from '../auth.js';
import { nodeKey, fluxTeamKey, userKey } from '../framework/keys.js';
import { waitFor } from '../framework/wait.js';

// Ingress attestations record WHERE a register/update entered the network (the source
// address the ingress node observed), gossip that record to every peer as a standalone
// fluxteam-only object, and — for a node that was away — backfill via the confirmed-set
// anti-entropy reconcile. This suite exercises all of it end to end:
//   1. capture at the ingress node + byte-identical gossip to every peer,
//   2. fluxteam-only visibility (never on the public API, denied to other identities),
//   3. the second ingress point (/apps/appupdate) emits its own attestation,
//   4. a partitioned node backfills the attestation after the partition heals.
//
// Topology: a 5-node ring is the minimum for minOutgoing:2 (needs >= 2*k+1 nodes), and
// minIncoming:1 keeps the submission gate satisfiable when a peer drops. ingressRefreshBlocks
// is compressed so the block-cadence anti-entropy refresh fires quickly for the heal test,
// and appSyncDegradedThreshold:0 keeps the isolated node READY (so its refresh runs).
//
// NOTE: login sessions are node-local (each node's own loggedUsers), so fluxteam auth is
// obtained per node — a session from one node 401s on another (which is the gate working).

const MAJORITY = [0, 1, 2, 3];
const ISOLATED = 4;

function getAttestations(node, hash, zelidauth) {
  return node.getAuthed(`/apps/ingressattestations/${hash}`, zelidauth, { noCache: true });
}

async function submitUpdate(node, adminKeypair, spec) {
  const auth = await authenticate(node.url, adminKeypair);
  const signed = await signAppSpec(spec, 'fluxappupdate');
  return node.post('/apps/appupdate', signed, { 'Content-Type': 'text/plain', zelidauth: auth.zelidauth });
}

describe('82 ingress attestation - capture, gossip, gating, backfill', function () {
  let env;
  let fluxTeamAuth; // per-node zelidauth (sessions are node-local)
  let userAuth;

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 5,
      tickerAutostart: false,
      configOverrides: {
        fluxapps: {
          minOutgoing: 2,
          minIncoming: 1,
          ingressRefreshBlocks: 3,
          appSyncDegradedThreshold: 0,
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 2, minInbound: 1, pricing: true });
    fluxTeamAuth = await Promise.all(env.clients.map(async (c) => (await authenticate(c.url, fluxTeamKey())).zelidauth));
    userAuth = (await authenticate(env.clients[0].url, userKey())).zelidauth;
  });

  after(async function () {
    this.timeout(30000);
    await env?.teardown();
  });

  it('records the source at the ingress node and gossips it byte-identical to every peer', async function () {
    this.timeout(300000);
    const spec = buildAppSpec({ name: 'e2eIngressReg' });
    const reg = await registerAndConfirm(env.clients[0].url, nodeKey(1), spec, env.clients);
    expect(reg.status).to.equal('success');
    const { appHash } = reg;

    // The ingress node recorded exactly one attestation carrying the observed source address.
    const ingress = await getAttestations(env.clients[0], appHash, fluxTeamAuth[0]);
    expect(ingress.status).to.equal('success');
    expect(ingress.data).to.have.length(1);
    const record = ingress.data[0];
    expect(record.hash).to.equal(appHash);
    expect(record.node).to.be.a('string').with.length.greaterThan(0);
    expect(record.signature).to.be.a('string').with.length.greaterThan(0);
    expect(record.observed.ip).to.be.a('string').with.length.greaterThan(0);

    // It gossiped to every peer, byte-identical (same ingress node, same observed IP, same signature).
    for (const i of [1, 2, 3, 4]) {
      const client = env.clients[i];
      // eslint-disable-next-line no-await-in-loop
      await client.waitForEvent('network:ingressattestation', (d) => d.hash === appHash, 60000);
      // eslint-disable-next-line no-await-in-loop
      const peer = await getAttestations(client, appHash, fluxTeamAuth[i]);
      expect(peer.status, `node ${i} serves the attestation`).to.equal('success');
      expect(peer.data, `node ${i} holds exactly the ingress record`).to.have.length(1);
      expect(peer.data[0], `node ${i} record matches the ingress record`).to.deep.equal(record);
    }
  });

  it('keeps the source fluxteam-only - never on the public API, denied to other identities', async function () {
    this.timeout(180000);
    const spec = buildAppSpec({ name: 'e2eIngressGate' });
    const reg = await registerAndConfirm(env.clients[0].url, nodeKey(1), spec, env.clients);
    expect(reg.status).to.equal('success');
    const { appHash } = reg;

    // fluxteam sees it, and learns the source IP...
    const authed = await getAttestations(env.clients[0], appHash, fluxTeamAuth[0]);
    expect(authed.status).to.equal('success');
    expect(authed.data).to.have.length(1);
    const sourceIp = authed.data[0].observed.ip;

    // ...an ordinary user identity does not (401)...
    const asUser = await getAttestations(env.clients[0], appHash, userAuth);
    expect(asUser.status).to.equal('error');
    expect(asUser.data.code).to.equal(401);

    // ...and an unauthenticated caller does not.
    const anon = await env.clients[0].get(`/apps/ingressattestations/${appHash}`, { noCache: true });
    expect(anon.status).to.equal('error');
    expect(anon.data.code).to.equal(401);

    // The public message endpoints carry the app message but never the source address.
    const perm = await env.clients[0].getPermanentMessages();
    const msg = (perm.data || []).find((m) => m.hash === appHash);
    expect(msg, 'permanent message present on the public API').to.exist;
    expect(msg).to.not.have.property('observed');
    expect(msg).to.not.have.property('ingress');
    expect(JSON.stringify(msg), 'source IP absent from the public wire').to.not.include(sourceIp);

    const temp = await env.clients[0].getTempMessages(appHash);
    expect(JSON.stringify(temp.data || []), 'source IP absent from public temp messages').to.not.include(sourceIp);
  });

  it('emits its own attestation for an update - the second ingress point (/apps/appupdate)', async function () {
    this.timeout(300000);
    const spec = buildAppSpec({ name: 'e2eIngressUpd' });
    const reg = await registerAndConfirm(env.clients[0].url, nodeKey(1), spec, env.clients);
    expect(reg.status).to.equal('success');
    const registerHash = reg.appHash;

    // Submit an update through the second ingress endpoint. Its HTTP self-poll is timing-
    // sensitive (existing submitAppUpdate behaviour), so drive the assertion off the emitted
    // attestation event, not the response status.
    const cursor = env.clients[0].getLastEventId();
    await submitUpdate(env.clients[0], nodeKey(1), { ...spec, description: 'updated by the ingress attestation e2e suite' });

    // The update emitted its own attestation, keyed by a new (update) hash.
    const evt = await env.clients[0].waitForEvent('network:ingressattestation', (d) => d.hash !== registerHash, 60000, { afterId: cursor });
    const updateHash = evt.data.hash;
    expect(updateHash).to.not.equal(registerHash);

    const onNode0 = await getAttestations(env.clients[0], updateHash, fluxTeamAuth[0]);
    expect(onNode0.status).to.equal('success');
    expect(onNode0.data).to.have.length(1);
    expect(onNode0.data[0].hash).to.equal(updateHash);

    // and it propagated to a peer.
    await env.clients[1].waitForEvent('network:ingressattestation', (d) => d.hash === updateHash, 60000);
    const onPeer = await getAttestations(env.clients[1], updateHash, fluxTeamAuth[1]);
    expect(onPeer.status).to.equal('success');
    expect(onPeer.data).to.have.length(1);
  });

  it('backfills a partitioned node via anti-entropy once the partition heals', async function () {
    this.timeout(420000);
    const majority = MAJORITY.map((i) => env.clients[i]);
    const isolated = env.clients[ISOLATED];

    // Isolate node 4 (partial partition - it stays daemon-confirmed and observable), then
    // register+confirm on the majority so node 4 misses the live attestation gossip.
    await env.partitionGroups([ISOLATED], MAJORITY);
    const spec = buildAppSpec({ name: 'e2eIngressHeal' });
    const reg = await registerAndConfirm(env.clients[0].url, nodeKey(1), spec, majority);
    expect(reg.status).to.equal('success');
    const { appHash } = reg;

    // The majority holds the attestation; the isolated node has nothing for this hash.
    const onMajority = await getAttestations(env.clients[0], appHash, fluxTeamAuth[0]);
    expect(onMajority.data).to.have.length(1);
    const isolatedBefore = await getAttestations(isolated, appHash, fluxTeamAuth[ISOLATED]);
    expect(isolatedBefore.data, 'isolated node missed the live gossip').to.have.length(0);

    const backstopAfter = isolated.getLastEventId();

    // Heal and re-peer. Having never degraded, node 4 runs no boot/recovery resync - only the
    // block-cadence anti-entropy refresh can converge it, and the ticker keeps the clock moving.
    await env.healPartition([ISOLATED], MAJORITY);
    await env.startDiscovery();

    // The reconcile backfills the confirmed attestation into node 4 (fires the store event).
    await isolated.waitForEvent('network:ingressattestation', (d) => d.hash === appHash, 240000, { afterId: backstopAfter });

    await waitFor(async () => {
      const res = await getAttestations(isolated, appHash, fluxTeamAuth[ISOLATED]);
      return res.status === 'success' && res.data.length === 1;
    }, { timeout: 60000, interval: 2000, label: 'node 4 backfilled the ingress attestation' });

    const healed = await getAttestations(isolated, appHash, fluxTeamAuth[ISOLATED]);
    expect(healed.data[0], 'backfilled record matches the majority record').to.deep.equal(onMajority.data[0]);
  });
});
