'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const zmq = require('zeromq');

const { createFluxdSubscriber } = require('../../ZelBack/src/services/utils/fluxdSubscriber');

/**
 * These run against a real publisher rather than a stubbed library, because the
 * behaviour worth testing — multipart framing, topic filtering, sequence handling —
 * lives in the socket, not in our wrapper. A stub would only assert our own mock.
 */

const WARMUP_SEQ = 1000;

function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function hashBlockHeightPayload(height, seed = 0xab) {
  return Buffer.concat([Buffer.alloc(32, seed), uint32(height)]);
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return false;
}

describe('fluxdSubscriber tests', () => {
  let publisher;
  let subscriber;
  let endpoint;
  let received;
  let gaps;

  beforeEach(async () => {
    received = [];
    gaps = [];

    publisher = new zmq.Publisher();
    await publisher.bind('tcp://127.0.0.1:0');
    endpoint = publisher.lastEndpoint;
  });

  afterEach(async () => {
    if (subscriber) subscriber.stop();
    subscriber = null;
    if (publisher) await publisher.close();
    publisher = null;
  });

  function publish(topic, payload, seq) {
    return publisher.send([topic, payload, uint32(seq)]);
  }

  /**
   * PUB drops anything sent before a subscription has propagated, so a test that
   * publishes once immediately after start() is a coin toss. Send one at a time until
   * one lands, then drain the rest so warm-up traffic cannot arrive mid-assertion.
   *
   * Warm-up leaves the sequence tracker at WARMUP_SEQ, so tests begin their own
   * sequences at WARMUP_SEQ + 1 to avoid a spurious gap.
   */
  async function startAndSettle(options = {}) {
    subscriber = createFluxdSubscriber({
      endpoint,
      topics: ['hashblockheight'],
      onMessage: (topic, decoded, seq) => received.push({ topic, decoded, seq }),
      onGap: (topic, missed) => gaps.push({ topic, missed }),
      ...options,
    });

    subscriber.start();

    let warmups = 0;
    let settled = false;

    while (warmups < 200 && !settled) {
      // eslint-disable-next-line no-await-in-loop
      await publish('hashblockheight', hashBlockHeightPayload(1), WARMUP_SEQ);
      warmups += 1;
      // eslint-disable-next-line no-await-in-loop
      settled = await waitFor(() => received.length > 0, 25);
    }

    expect(settled, `subscription never settled after ${warmups} attempts`).to.equal(true);

    // Every warm-up carried the same sequence, so any still in flight is treated as a
    // restart and cannot add a gap; wait for the tail before clearing.
    let previous = -1;
    while (previous !== received.length) {
      previous = received.length;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }

    received.length = 0;
    gaps.length = 0;
    return warmups;
  }

  it('should decode and dispatch a subscribed topic', async () => {
    await startAndSettle();

    await publish('hashblockheight', hashBlockHeightPayload(2837899, 0x0c), WARMUP_SEQ + 1);

    expect(await waitFor(() => received.length === 1)).to.equal(true);
    expect(received[0].topic).to.equal('hashblockheight');
    expect(received[0].seq).to.equal(WARMUP_SEQ + 1);
    expect(received[0].decoded).to.eql({ hash: '0c'.repeat(32), height: 2837899 });
  });

  it('should report the number of messages missed on a sequence gap', async () => {
    await startAndSettle();

    await publish('hashblockheight', hashBlockHeightPayload(10), WARMUP_SEQ + 1);
    expect(await waitFor(() => received.length === 1)).to.equal(true);

    await publish('hashblockheight', hashBlockHeightPayload(11), WARMUP_SEQ + 5);
    expect(await waitFor(() => received.length === 2)).to.equal(true);

    expect(gaps).to.eql([{ topic: 'hashblockheight', missed: 3 }]);
  });

  it('should not report a gap for contiguous sequences', async () => {
    await startAndSettle();

    await publish('hashblockheight', hashBlockHeightPayload(10), WARMUP_SEQ + 1);
    await publish('hashblockheight', hashBlockHeightPayload(11), WARMUP_SEQ + 2);
    await publish('hashblockheight', hashBlockHeightPayload(12), WARMUP_SEQ + 3);

    expect(await waitFor(() => received.length === 3)).to.equal(true);
    expect(gaps).to.eql([]);
  });

  it('should treat a rewound sequence as a daemon restart, not lost messages', async () => {
    await startAndSettle();

    await publish('hashblockheight', hashBlockHeightPayload(10), WARMUP_SEQ + 1);
    expect(await waitFor(() => received.length === 1)).to.equal(true);

    await publish('hashblockheight', hashBlockHeightPayload(11), 0);
    expect(await waitFor(() => received.length === 2)).to.equal(true);

    expect(gaps).to.eql([]);
  });

  it('should keep consuming after a payload fails to decode', async () => {
    await startAndSettle();

    await publish('hashblockheight', Buffer.alloc(12), WARMUP_SEQ + 1);
    await publish('hashblockheight', hashBlockHeightPayload(99), WARMUP_SEQ + 2);

    expect(await waitFor(() => received.length === 1)).to.equal(true);
    expect(received[0].decoded.height).to.equal(99);
  });

  it('should not deliver topics it did not subscribe to', async () => {
    await startAndSettle();

    await publish('chainreorg', Buffer.alloc(108), WARMUP_SEQ + 1);
    await publish('hashblockheight', hashBlockHeightPayload(7), WARMUP_SEQ + 2);

    expect(await waitFor(() => received.length === 1)).to.equal(true);
    expect(received.every((m) => m.topic === 'hashblockheight')).to.equal(true);
  });

  it('should track elapsed time since the last message from the monotonic clock', async () => {
    await startAndSettle();

    await publish('hashblockheight', hashBlockHeightPayload(1), WARMUP_SEQ + 1);
    expect(await waitFor(() => received.length === 1)).to.equal(true);

    const elapsed = subscriber.elapsedSinceMessageMs();
    expect(elapsed).to.be.a('number');
    expect(elapsed).to.be.at.least(0);
    expect(elapsed).to.be.below(3000);
  });

  it('should report no elapsed time before any message arrives', () => {
    subscriber = createFluxdSubscriber({
      endpoint,
      topics: ['hashblockheight'],
      onMessage: () => {},
    });

    expect(subscriber.elapsedSinceMessageMs()).to.equal(null);
  });

  it('should stop delivering once stopped', async () => {
    await startAndSettle();

    subscriber.stop();
    await publish('hashblockheight', hashBlockHeightPayload(1), WARMUP_SEQ + 1);

    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(received).to.eql([]);
  });

  it('should survive a handler that throws', async () => {
    let calls = 0;
    await startAndSettle({
      onMessage: (topic, decoded, seq) => {
        calls += 1;
        received.push({ topic, decoded, seq });
        if (calls === 1) throw new Error('test: handler blew up');
      },
    });

    await publish('hashblockheight', hashBlockHeightPayload(1), WARMUP_SEQ + 1);
    expect(await waitFor(() => received.length === 1)).to.equal(true);

    await publish('hashblockheight', hashBlockHeightPayload(2), WARMUP_SEQ + 2);
    expect(await waitFor(() => received.length === 2)).to.equal(true);
  });

  it('should require at least one topic', () => {
    expect(() => createFluxdSubscriber({ endpoint, topics: [], onMessage: () => {} }))
      .to.throw('At least one topic is mandatory');
  });

  it('should require a message handler', () => {
    expect(() => createFluxdSubscriber({ endpoint, topics: ['hashblockheight'] }))
      .to.throw('An onMessage handler is mandatory');
  });

  describe('socket tuning tests', () => {
    // The one place a stub is the right tool: these are values handed to libzmq and
    // never read back, so the only way to prove the configured ones arrive rather
    // than the defaults is to look at what the constructor was given.
    function optionsFrom(overrides) {
      let seen = null;
      class FakeSubscriber {
        constructor(options) {
          seen = options;
        }

        // eslint-disable-next-line class-methods-use-this
        connect() { /* the socket is never driven in this test */ }

        // eslint-disable-next-line class-methods-use-this
        subscribe() { /* as above */ }

        // eslint-disable-next-line class-methods-use-this
        close() { /* as above */ }

        get events() { return (async function* noEvents() { /* nothing */ }()); }

        [Symbol.asyncIterator]() { return (async function* noMessages() { /* nothing */ }()); }
      }

      const { createFluxdSubscriber: create } = proxyquire('../../ZelBack/src/services/utils/fluxdSubscriber', {
        zeromq: { Subscriber: FakeSubscriber, '@noCallThru': true },
      });

      const sub = create({
        endpoint: 'tcp://127.0.0.1:1', topics: ['hashblockheight'], onMessage: () => {}, ...overrides,
      });
      sub.start();
      sub.stop();
      return seen;
    }

    it('should hand libzmq the configured heartbeat and reconnect values', () => {
      const seen = optionsFrom({
        heartbeatIntervalMs: 250,
        heartbeatTimeoutMs: 750,
        reconnectIntervalMs: 10,
        reconnectMaxIntervalMs: 40,
        connectTimeoutMs: 100,
        receiveHighWaterMark: 7,
      });

      expect(seen.heartbeatInterval).to.equal(250);
      expect(seen.heartbeatTimeout).to.equal(750);
      expect(seen.reconnectInterval).to.equal(10);
      expect(seen.reconnectMaxInterval).to.equal(40);
      expect(seen.connectTimeout).to.equal(100);
      expect(seen.receiveHighWaterMark).to.equal(7);
    });

    it('should fall back to the defaults for anything not configured', () => {
      const seen = optionsFrom({ heartbeatIntervalMs: 250 });

      expect(seen.heartbeatInterval, 'the configured value still wins').to.equal(250);
      expect(seen.heartbeatTimeout, 'and the rest are defaults').to.equal(20_000);
      expect(seen.reconnectInterval).to.equal(500);
      expect(seen.reconnectMaxInterval).to.equal(15_000);
      expect(seen.connectTimeout).to.equal(3_000);
    });
  });
});
