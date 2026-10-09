import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventLines } from '../framework/event-lines.js';

test('one line per event with its id and receipt time, a replay marked, a repeat written once', () => {
  const at = Date.UTC(2026, 9, 9, 16, 23, 5, 486);
  const lines = eventLines([
    { id: 7, at, event: 'block:processed', data: { height: 1 } },
    { id: 8, at: at + 10, event: 'orchestrator:stateChanged', data: { from: 'SYNCING', to: 'READY' } },
    { id: 7, at: at + 5000, replayed: true, event: 'block:processed', data: { height: 1 } },
    { id: 8, at: at + 5000, replayed: true, event: 'orchestrator:stateChanged', data: { from: 'SYNCING', to: 'READY' } },
    { id: 9, at: at + 5001, replayed: true, event: 'block:processed', data: { height: 2 } },
    { id: 10, event: 'peers:added', data: { ip: '1.2.3.4' } },
  ]);
  assert.deepEqual(lines, [
    '#7 2026-10-09T16:23:05.486Z block:processed: {"height":1}',
    '#8 2026-10-09T16:23:05.496Z orchestrator:stateChanged: {"from":"SYNCING","to":"READY"}',
    '#9 2026-10-09T16:23:10.487Z replay block:processed: {"height":2}',
    '#10 - peers:added: {"ip":"1.2.3.4"}',
  ]);
});
