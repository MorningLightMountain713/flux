import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitToNode, gateRefusal } from '../framework/gated-fetch.js';

const refusal = (capability) => new Response(
  JSON.stringify({ status: 'error', data: { name: 'ServiceUnavailable', code: 503, message: `Node is still scanning the chain (${capability} is not up)` } }),
  { status: 503, headers: { 'retry-after': '30' } },
);
const ok = () => new Response(JSON.stringify({ status: 'success', data: { ok: true } }), { status: 200 });
const noSleep = async () => {};

test('a gate refusal is the 503 the node names ServiceUnavailable, nothing else', () => {
  assert.ok(gateRefusal(503, JSON.stringify({ status: 'error', data: { name: 'ServiceUnavailable', message: 'x' } })));
  assert.equal(gateRefusal(503, JSON.stringify({ status: 'error', data: { name: 'Error', message: 'x' } })), null);
  assert.equal(gateRefusal(200, JSON.stringify({ status: 'error', data: { name: 'ServiceUnavailable' } })), null);
  assert.equal(gateRefusal(503, 'not json'), null);
});

test('sends again while the gate refuses and hands back the first other answer', async () => {
  const answers = [refusal('explorerSynced'), refusal('explorerSynced'), ok()];
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init.body); return answers.shift(); };
  const res = await submitToNode('http://node/apps/appregister', { method: 'POST', body: 'spec' }, { fetchImpl, sleep: noSleep });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'success', data: { ok: true } });
  assert.deepEqual(calls, ['spec', 'spec', 'spec']);
});

test('pauses no longer than the cap however long the node asks', async () => {
  const answers = [refusal('explorerSynced'), ok()];
  const pauses = [];
  await submitToNode('http://node/x', {}, { fetchImpl: async () => answers.shift(), sleep: async (ms) => { pauses.push(ms); }, maxPauseMs: 250 });
  assert.deepEqual(pauses, [250]);
});

test('returns a 503 that is not the gate, readable as the caller expects', async () => {
  const other = new Response(JSON.stringify({ status: 'error', data: { name: 'Overloaded', message: 'busy' } }), { status: 503 });
  let calls = 0;
  const res = await submitToNode('http://node/x', {}, { fetchImpl: async () => { calls += 1; return other; }, sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: 'error', data: { name: 'Overloaded', message: 'busy' } });
});

test('gives up at the budget with the gate\'s own message', async () => {
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    await assert.rejects(
      submitToNode('http://node/apps/appregister', {}, {
        fetchImpl: async () => refusal('chainStateConsistent'),
        sleep: async (ms) => { now += ms; },
        timeout: 3000,
        maxPauseMs: 1000,
      }),
      /refused for 3000ms: Node is still scanning the chain \(chainStateConsistent is not up\)/,
    );
  } finally {
    Date.now = realNow;
  }
});
