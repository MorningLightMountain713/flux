import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityStates, capabilityState, waitForCapabilityState } from '../framework/capability-state.js';

function fakeNode(states) {
  const reads = [];
  const client = {
    ip: '198.18.0.10',
    url: 'http://198.18.0.10:16127',
    zelidauth: 'team-session',
    async getAuthed(path, zelidauth, opts) {
      reads.push({ path, zelidauth, opts });
      if (zelidauth === 'expired') return { error: { code: 'UNAUTHORIZED', message: 'no' } };
      return { data: { capabilities: Object.entries(states).map(([name, state]) => ({ name, state })) }, meta: {} };
    },
  };
  return { client, reads };
}

test('reads every capability\'s state from the boot route with the team session the client holds', async () => {
  const { client, reads } = fakeNode({ explorerSynced: 'up', appRegistryConsistent: 'coming-up' });
  const states = await capabilityStates(client);
  assert.equal(states.get('explorerSynced').state, 'up');
  assert.equal(await capabilityState(client, 'appRegistryConsistent'), 'coming-up');
  assert.equal(reads[0].path, '/v2/node/boot');
  assert.equal(reads[0].zelidauth, 'team-session');
  assert.equal(reads[0].opts.noCache, true);
});

test('a name the node does not hold is an error, not a state', async () => {
  const { client } = fakeNode({ explorerSynced: 'up' });
  await assert.rejects(capabilityState(client, 'explorerSynce'), /holds no capability named explorerSynce/);
});

test('logs in again once when the session the client holds is refused', async () => {
  const { client, reads } = fakeNode({ explorerSynced: 'up' });
  client.zelidauth = 'expired';
  const logins = [];
  const login = async (url) => { logins.push(url); return { zelidauth: 'fresh' }; };
  assert.equal(await capabilityState(client, 'explorerSynced', { login }), 'up');
  assert.deepEqual(logins, [client.url]);
  assert.deepEqual(reads.map((r) => r.zelidauth), ['expired', 'fresh']);
});

test('waits on the state the node reports now, not on an edge it published before', async () => {
  const states = { explorerSynced: 'down' };
  const { client } = fakeNode(states);
  setTimeout(() => { states.explorerSynced = 'up'; }, 30);
  assert.equal(await waitForCapabilityState(client, 'explorerSynced', 'up', { timeout: 2000, interval: 10 }), true);
});
