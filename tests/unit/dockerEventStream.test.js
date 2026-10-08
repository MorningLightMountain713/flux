'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const EventEmitter = require('events');

function makeStream() {
  const stream = new EventEmitter();
  stream.destroy = sinon.stub();
  return stream;
}

function load(dockerGetEvents) {
  return proxyquire('../../ZelBack/src/services/utils/dockerEventStream', {
    '../dockerService': { dockerGetEvents },
    '../../lib/log': {
      info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
    },
  });
}

// Lets a test advance the resubscribe timer without waiting on it.
function withFakeTimers(fn) {
  const clock = sinon.useFakeTimers();
  return Promise.resolve()
    .then(() => fn(clock))
    .finally(() => clock.restore());
}

describe('dockerEventStream', () => {
  const FILTERS = { type: ['container'], event: ['die'] };

  function build(overrides = {}) {
    const streams = [];
    const dockerGetEvents = sinon.stub().callsFake(async () => {
      const stream = makeStream();
      streams.push(stream);
      return stream;
    });
    const events = [];
    const { createDockerEventStream } = load(dockerGetEvents);
    const subscription = createDockerEventStream({
      label: 'test',
      filters: FILTERS,
      onEvent: (event) => events.push(event),
      ...overrides,
    });

    return {
      subscription, streams, events, dockerGetEvents,
    };
  }

  afterEach(() => {
    sinon.restore();
  });

  it('passes its filters through to docker verbatim', async () => {
    const { subscription, dockerGetEvents } = build();
    await subscription.start();

    expect(dockerGetEvents.firstCall.args[0]).to.deep.equal({ filters: FILTERS });
    subscription.stop();
  });

  it('reassembles an event split across chunk boundaries', async () => {
    // Docker's stream is bytes, not lines. A naive reader loses or mangles any
    // event that straddles a chunk.
    const { subscription, streams, events } = build();
    await subscription.start();

    streams[0].emit('data', Buffer.from('{"Action":"die","id":"a'));
    expect(events).to.have.lengthOf(0);

    streams[0].emit('data', Buffer.from('bc"}\n'));
    expect(events).to.deep.equal([{ Action: 'die', id: 'abc' }]);

    subscription.stop();
  });

  it('delivers several events arriving in one chunk', async () => {
    const { subscription, streams, events } = build();
    await subscription.start();

    streams[0].emit('data', Buffer.from('{"id":"1"}\n{"id":"2"}\n'));

    expect(events).to.deep.equal([{ id: '1' }, { id: '2' }]);
    subscription.stop();
  });

  it('survives an unparseable line and keeps reading', async () => {
    const { subscription, streams, events } = build();
    await subscription.start();

    streams[0].emit('data', Buffer.from('not json\n{"id":"2"}\n'));

    expect(events).to.deep.equal([{ id: '2' }]);
    subscription.stop();
  });

  it('does not let a rejecting handler escape', async () => {
    const { subscription, streams } = build({ onEvent: () => Promise.reject(new Error('boom')) });
    await subscription.start();

    streams[0].emit('data', Buffer.from('{"id":"1"}\n'));
    // Give the rejection a turn to surface as unhandled if it were going to.
    await new Promise((resolve) => { setImmediate(resolve); });

    subscription.stop();
  });

  it('resubscribes ONCE when error and end both fire for one outage', async () => {
    // The defect this closes: resubscribing per signal doubles the stream, and
    // every subsequent event is then handled twice.
    await withFakeTimers(async (clock) => {
      const { subscription, streams, dockerGetEvents } = build();
      await subscription.start();

      streams[0].emit('error', new Error('dropped'));
      streams[0].emit('end');
      streams[0].emit('close');

      await clock.tickAsync(10_000);

      expect(dockerGetEvents.callCount).to.equal(2);
      subscription.stop();
    });
  });

  it('resubscribes after a close with no error or end', async () => {
    // A raw socket teardown emits only 'close'.
    await withFakeTimers(async (clock) => {
      const { subscription, streams, dockerGetEvents } = build();
      await subscription.start();

      streams[0].emit('close');
      await clock.tickAsync(10_000);

      expect(dockerGetEvents.callCount).to.equal(2);
      subscription.stop();
    });
  });

  it('ignores a late signal from a stream it has already replaced', async () => {
    await withFakeTimers(async (clock) => {
      const { subscription, streams, events, dockerGetEvents } = build();
      await subscription.start();

      streams[0].emit('end');
      await clock.tickAsync(10_000);
      expect(dockerGetEvents.callCount).to.equal(2);

      // The dead stream speaks again: it must neither deliver events nor take
      // down the successor that replaced it.
      streams[0].emit('data', Buffer.from('{"id":"stale"}\n'));
      streams[0].emit('error', new Error('late'));
      await clock.tickAsync(10_000);

      expect(events).to.have.lengthOf(0);
      expect(dockerGetEvents.callCount).to.equal(2);
      subscription.stop();
    });
  });

  it('retries when the initial subscribe fails', async () => {
    await withFakeTimers(async (clock) => {
      const dockerGetEvents = sinon.stub();
      dockerGetEvents.onFirstCall().rejects(new Error('docker down'));
      dockerGetEvents.onSecondCall().resolves(makeStream());
      const { createDockerEventStream } = load(dockerGetEvents);
      const subscription = createDockerEventStream({
        label: 'test', filters: FILTERS, onEvent: () => {},
      });

      await subscription.start();
      expect(subscription.connected()).to.equal(false);

      await clock.tickAsync(10_000);
      expect(subscription.connected()).to.equal(true);
      subscription.stop();
    });
  });

  it('calls onReconnect on a re-connection, never the first connection', async () => {
    await withFakeTimers(async (clock) => {
      const onReconnect = sinon.stub();
      const { subscription, streams } = build({ onReconnect });
      await subscription.start();

      expect(onReconnect.called).to.equal(false);

      streams[0].emit('end');
      await clock.tickAsync(10_000);

      expect(onReconnect.calledOnce).to.equal(true);
      subscription.stop();
    });
  });

  it('reports connected on every connection and disconnected once per outage, whatever signals it sends', async () => {
    await withFakeTimers(async (clock) => {
      const onConnected = sinon.stub();
      const onDisconnected = sinon.stub();
      const { subscription, streams } = build({ onConnected, onDisconnected });
      await subscription.start();
      expect(onConnected.calledOnce, 'the first connection is reported').to.equal(true);
      expect(onDisconnected.called).to.equal(false);

      streams[0].emit('error', new Error('dropped'));
      streams[0].emit('end');
      streams[0].emit('close');
      expect(onDisconnected.calledOnce, 'one outage, one report').to.equal(true);
      expect(onDisconnected.firstCall.args[0]).to.equal('errored');

      await clock.tickAsync(1000);
      expect(onConnected.calledTwice, 'the reconnection is reported').to.equal(true);
      subscription.stop();
    });
  });

  it('reports disconnected when the first subscription fails, and connected once a retry lands', async () => {
    await withFakeTimers(async (clock) => {
      const dockerGetEvents = sinon.stub();
      dockerGetEvents.onFirstCall().rejects(new Error('docker down'));
      dockerGetEvents.onSecondCall().resolves(makeStream());
      const { createDockerEventStream } = load(dockerGetEvents);
      const onConnected = sinon.stub();
      const onDisconnected = sinon.stub();
      const subscription = createDockerEventStream({
        label: 'test', filters: FILTERS, onEvent: () => {}, onConnected, onDisconnected,
      });

      await subscription.start();
      expect(onDisconnected.calledOnce).to.equal(true);
      expect(onConnected.called).to.equal(false);

      await clock.tickAsync(1000);
      expect(onConnected.calledOnce).to.equal(true);
      subscription.stop();
    });
  });

  it('retries from one second and doubles while docker stays away, capped, and a connection resets it', async () => {
    await withFakeTimers(async (clock) => {
      const dockerGetEvents = sinon.stub();
      const { createDockerEventStream } = load(dockerGetEvents);
      const onDisconnected = sinon.stub();
      const subscription = createDockerEventStream({
        label: 'test', filters: FILTERS, onEvent: () => {}, onDisconnected,
      });
      const first = makeStream();
      dockerGetEvents.onCall(0).resolves(first);
      dockerGetEvents.onCall(1).rejects(new Error('down'));
      dockerGetEvents.onCall(2).rejects(new Error('down'));
      dockerGetEvents.onCall(3).rejects(new Error('down'));
      dockerGetEvents.onCall(4).rejects(new Error('down'));
      dockerGetEvents.onCall(5).rejects(new Error('down'));
      const second = makeStream();
      dockerGetEvents.onCall(6).resolves(second);
      dockerGetEvents.onCall(7).resolves(makeStream());

      await subscription.start();
      first.emit('close');
      // retries at 1s, +2s, +4s, +8s, +10s, +10s: the ladder doubles to the cap
      const expectedCalls = [2, 3, 4, 5, 6, 7];
      const delays = [1000, 2000, 4000, 8000, 10_000, 10_000];
      for (let i = 0; i < delays.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await clock.tickAsync(delays[i] - 1);
        expect(dockerGetEvents.callCount, `no retry before ${delays[i]}ms`).to.equal(expectedCalls[i] - 1);
        // eslint-disable-next-line no-await-in-loop
        await clock.tickAsync(1);
        expect(dockerGetEvents.callCount, `a retry at ${delays[i]}ms`).to.equal(expectedCalls[i]);
      }
      expect(subscription.connected()).to.equal(true);
      expect(onDisconnected.calledOnce, 'the failed retries are the same outage').to.equal(true);

      // connected again: the next loss retries from one second, not the cap
      second.emit('close');
      await clock.tickAsync(999);
      expect(dockerGetEvents.callCount).to.equal(7);
      await clock.tickAsync(1);
      expect(dockerGetEvents.callCount).to.equal(8);
      subscription.stop();
    });
  });

  it('stop cancels a pending resubscribe', async () => {
    await withFakeTimers(async (clock) => {
      const { subscription, streams, dockerGetEvents } = build();
      await subscription.start();

      streams[0].emit('end');
      subscription.stop();
      await clock.tickAsync(60_000);

      expect(dockerGetEvents.callCount).to.equal(1);
    });
  });

  it('stop destroys the live stream and silences it', async () => {
    const { subscription, streams, events } = build();
    await subscription.start();

    subscription.stop();

    expect(streams[0].destroy.calledOnce).to.equal(true);
    streams[0].emit('data', Buffer.from('{"id":"after"}\n'));
    expect(events).to.have.lengthOf(0);
  });

  it('discards a stream that opened after stop was called', async () => {
    // stop() during the subscribe await would otherwise leave a live stream
    // with nothing holding a reference to it.
    let release;
    const opened = makeStream();
    const dockerGetEvents = sinon.stub().returns(new Promise((resolve) => { release = () => resolve(opened); }));
    const { createDockerEventStream } = load(dockerGetEvents);
    const subscription = createDockerEventStream({
      label: 'test', filters: FILTERS, onEvent: () => {},
    });

    const starting = subscription.start();
    subscription.stop();
    release();
    await starting;

    expect(opened.destroy.calledOnce).to.equal(true);
    expect(subscription.connected()).to.equal(false);
  });
});
