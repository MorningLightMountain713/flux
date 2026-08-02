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

      await clock.tickAsync(10000);

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
      await clock.tickAsync(10000);

      expect(dockerGetEvents.callCount).to.equal(2);
      subscription.stop();
    });
  });

  it('ignores a late signal from a stream it has already replaced', async () => {
    await withFakeTimers(async (clock) => {
      const { subscription, streams, events, dockerGetEvents } = build();
      await subscription.start();

      streams[0].emit('end');
      await clock.tickAsync(10000);
      expect(dockerGetEvents.callCount).to.equal(2);

      // The dead stream speaks again: it must neither deliver events nor take
      // down the successor that replaced it.
      streams[0].emit('data', Buffer.from('{"id":"stale"}\n'));
      streams[0].emit('error', new Error('late'));
      await clock.tickAsync(10000);

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

      await clock.tickAsync(10000);
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
      await clock.tickAsync(10000);

      expect(onReconnect.calledOnce).to.equal(true);
      subscription.stop();
    });
  });

  it('stop cancels a pending resubscribe', async () => {
    await withFakeTimers(async (clock) => {
      const { subscription, streams, dockerGetEvents } = build();
      await subscription.start();

      streams[0].emit('end');
      subscription.stop();
      await clock.tickAsync(60000);

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
