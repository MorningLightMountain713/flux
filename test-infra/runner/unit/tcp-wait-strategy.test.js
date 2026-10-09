import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TcpPollWaitStrategy } from '../framework/tcp-wait-strategy.js';

const exited = { inspect: async () => ({ State: { Running: false, Status: 'exited', ExitCode: 2 } }) };
const running = { inspect: async () => ({ State: { Running: true, Status: 'running', ExitCode: 0 } }) };

test('a container that exited is reported at the first failed probe, with what docker recorded', async () => {
  const started = Date.now();
  const strategy = new TcpPollWaitStrategy('127.0.0.1', 1, { pollIntervalMs: 10, probeTimeoutMs: 200 }).withStartupTimeout(30000);
  await assert.rejects(strategy.waitUntilReady(exited), /container exited during boot \(status=exited exitCode=2\)/);
  assert.ok(Date.now() - started < 5000, 'reported in seconds, not at the deadline');
});

test('a running container is polled until its port answers', async () => {
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  server.close();
  await new Promise((resolve) => { server.once('close', resolve); });
  // Nothing listens for the first polls; then the port opens.
  const late = net.createServer();
  setTimeout(() => late.listen(port, '127.0.0.1'), 60);
  const strategy = new TcpPollWaitStrategy('127.0.0.1', port, { pollIntervalMs: 10, probeTimeoutMs: 200 }).withStartupTimeout(5000);
  await strategy.waitUntilReady(running);
  late.close();
});
