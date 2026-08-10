'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();


describe('playgroundWatcher', () => {
  let stubs;
  let createSessionWatcher;

  function load() {
    stubs = {
      inspect: sinon.stub().resolves(null),
      subscription: {
        start: sinon.stub().resolves(),
        stop: sinon.stub(),
        connected: () => true,
      },
    };
    stubs.createDockerEventStream = sinon.stub().callsFake((options) => {
      stubs.options = options;
      return stubs.subscription;
    });

    ({ createSessionWatcher } = proxyquire(
      '../../ZelBack/src/services/appPlayground/playgroundWatcher',
      {
        '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        '../dockerService': { dockerContainerInspect: stubs.inspect },
        '../utils/dockerEventStream': { createDockerEventStream: stubs.createDockerEventStream },
      },
    ));
  }

  const runningInfo = (overrides = {}) => ({
    State: { Running: true, ...overrides },
    NetworkSettings: { Networks: { flxpg0: { IPAddress: '172.23.255.5' } } },
  });

  const event = (action, name, attributes = {}) => ({
    Action: action,
    Actor: { Attributes: { name, ...attributes } },
  });

  beforeEach(load);
  afterEach(() => sinon.restore());

  describe('subscription', () => {
    it('watches only this session, filtered at the daemon by its label', async () => {
      // Not filtered in JS after the fact: the reconciler's containers must
      // never reach this subscription at all.
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp']);

      expect(stubs.options.filters.label).to.deep.equal([`io.runonflux.playground=sess-1`]);
      expect(stubs.options.filters.type).to.deep.equal(['container']);
      expect(stubs.options.filters.event).to.have.members(['start', 'die', 'destroy', 'health_status']);
    });

    it('subscribes BEFORE it inspects', async () => {
      // The race this closes: a container that dies in the gap fires its event
      // into nothing, and the session waits out its deadline for a verdict that
      // already happened.
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp']);

      expect(stubs.subscription.start.calledBefore(stubs.inspect)).to.equal(true);
    });

    it('seeds its state from the snapshot', async () => {
      stubs.inspect.resolves(runningInfo({ Health: { Status: 'starting' } }));
      const watcher = createSessionWatcher('sess-1');

      await watcher.start(['web_demoapp']);

      const state = watcher.state('web_demoapp');
      expect(state.known).to.equal(true);
      expect(state.running).to.equal(true);
      expect(state.health).to.equal('starting');
      expect(state.hasHealthCheck).to.equal(true);
      expect(state.address).to.equal('172.23.255.5');
    });

    it('reads a missing container as gone', async () => {
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp']);

      expect(watcher.state('web_demoapp').gone).to.equal(true);
    });

    it('re-reads everything when the stream reconnects', async () => {
      // Events during the outage are gone, so silence cannot be taken to mean
      // nothing happened.
      stubs.inspect.resolves(runningInfo());
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp', 'db_demoapp']);
      const afterStart = stubs.inspect.callCount;

      await stubs.options.onReconnect();

      expect(stubs.inspect.callCount).to.equal(afterStart + 2);
    });

    it('stops its subscription', async () => {
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp']);

      watcher.stop();

      expect(stubs.subscription.stop.calledOnce).to.equal(true);
    });
  });

  describe('what the events say', () => {
    async function watching() {
      stubs.inspect.resolves(runningInfo());
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp']);
      return watcher;
    }

    it('takes the exit code straight from the die event', async () => {
      // No inspect needed: docker puts it in the event, and by the time we
      // could ask, a removed container has no answer.
      const watcher = await watching();
      const before = stubs.inspect.callCount;

      await stubs.options.onEvent(event('die', 'web_demoapp', { exitCode: '137' }));

      expect(watcher.state('web_demoapp')).to.include({ running: false, exitCode: 137 });
      expect(stubs.inspect.callCount, 'a die needs no inspect').to.equal(before);
    });

    it('reads a die with an unreadable exit code as unknown, not zero', async () => {
      const watcher = await watching();

      await stubs.options.onEvent(event('die', 'web_demoapp', { exitCode: 'nonsense' }));

      expect(watcher.state('web_demoapp').exitCode).to.equal(null);
    });

    it('marks a destroyed container gone', async () => {
      const watcher = await watching();

      await stubs.options.onEvent(event('destroy', 'web_demoapp'));

      expect(watcher.state('web_demoapp')).to.include({ gone: true, running: false });
    });

    it('re-inspects on a health transition rather than parsing the action text', async () => {
      // Docker carries the status only as a free-form Action suffix with no
      // structured field, so the authoritative value comes from an inspect -
      // the same rule containerEventBridge follows.
      const watcher = await watching();
      stubs.inspect.resolves(runningInfo({ Health: { Status: 'unhealthy' } }));

      await stubs.options.onEvent(event('health_status: unhealthy', 'web_demoapp'));

      expect(watcher.state('web_demoapp').health).to.equal('unhealthy');
    });

    it('ignores an event for a container it is not watching', async () => {
      const watcher = await watching();

      await stubs.options.onEvent(event('die', 'somethingelse', { exitCode: '1' }));

      expect(watcher.state('web_demoapp').running).to.equal(true);
    });
  });

  describe('waiting', () => {
    it('wakes the moment something changes', async () => {
      stubs.inspect.resolves(runningInfo());
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp']);

      // A timeout far beyond the test: only the event can resolve this.
      const waited = watcher.changedOr(60_000);
      await stubs.options.onEvent(event('die', 'web_demoapp', { exitCode: '0' }));

      await waited;
    });

    it('gives up after its timeout when nothing happens', async () => {
      stubs.inspect.resolves(runningInfo());
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp']);

      await watcher.changedOr(5);
    });

    it('reports whether anything is still up', async () => {
      stubs.inspect.resolves(runningInfo());
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp', 'db_demoapp']);

      expect(watcher.anyRunning(['web_demoapp', 'db_demoapp'])).to.equal(true);

      await stubs.options.onEvent(event('die', 'web_demoapp', { exitCode: '0' }));
      expect(watcher.anyRunning(['web_demoapp', 'db_demoapp'])).to.equal(true);

      await stubs.options.onEvent(event('die', 'db_demoapp', { exitCode: '0' }));
      expect(watcher.anyRunning(['web_demoapp', 'db_demoapp'])).to.equal(false);
    });

    it('releases a waiter when the watcher stops, so nothing hangs on teardown', async () => {
      stubs.inspect.resolves(runningInfo());
      const watcher = createSessionWatcher('sess-1');
      await watcher.start(['web_demoapp']);

      const waited = watcher.changedOr(60_000);
      watcher.stop();

      await waited;
    });
  });
});
