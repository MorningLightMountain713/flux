const { expect } = require('chai');
const proxyquire = require('proxyquire');
const sinon = require('sinon');

const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');

describe('daemonSubscriptionService tests', () => {
  let service;
  let subscriberStub;
  let livenessStub;
  let capturedSubscriberOptions;
  let capturedLivenessOptions;
  let getConfigValueStub;
  let publishStub;

  const ALL_TOPICS = ['hashblockheight', 'chainreorg', 'fluxnodelistdelta', 'fluxnodestatus'];

  function publishedAs(name) {
    return publishStub.getCalls().filter((call) => call.args[0] === name).map((call) => call.args[1]);
  }

  function loadService() {
    capturedSubscriberOptions = null;
    capturedLivenessOptions = null;
    publishStub = sinon.stub();

    subscriberStub = {
      start: sinon.stub(),
      stop: sinon.stub(),
      connected: sinon.stub().returns(true),
      elapsedSinceMessageMs: sinon.stub().returns(0),
      subscribedTopics: sinon.stub().returns([]),
    };

    livenessStub = {
      start: sinon.stub(),
      stop: sinon.stub(),
      alive: sinon.stub().returns(true),
      checkNow: sinon.stub().resolves(),
      lastProbeSucceeded: sinon.stub().returns(true),
    };

    return proxyquire('../../ZelBack/src/services/daemonService/daemonSubscriptionService', {
      '../utils/fluxdSubscriber': {
        createFluxdSubscriber: (options) => {
          capturedSubscriberOptions = options;
          return subscriberStub;
        },
        '@noCallThru': false,
      },
      '../utils/fluxdLiveness': {
        createFluxdLiveness: (options) => {
          capturedLivenessOptions = options;
          return livenessStub;
        },
        '@noCallThru': false,
      },
      '../utils/fluxEventBus': { publish: publishStub, '@noCallThru': false },
    });
  }

  beforeEach(() => {
    getConfigValueStub = sinon.stub(daemonServiceUtils, 'getConfigValue');
    getConfigValueStub.callsFake((key) => (
      ALL_TOPICS.some((t) => key === `zmqpub${t}`) ? 'tcp://127.0.0.1:16123' : undefined
    ));

    service = loadService();
  });

  afterEach(() => {
    service.resetForTesting();
    sinon.restore();
  });

  describe('capability detection tests', () => {
    it('should read availability from the daemon config key for each topic', () => {
      expect(service.isTopicAvailable('fluxnodelistdelta')).to.equal(true);
      sinon.assert.calledWith(getConfigValueStub, 'zmqpubfluxnodelistdelta');
    });

    it('should report a topic the daemon does not publish as unavailable', () => {
      getConfigValueStub.withArgs('zmqpubfluxnodestatus').returns(undefined);

      expect(service.isTopicAvailable('fluxnodestatus')).to.equal(false);
    });

    it('should subscribe only to topics the daemon publishes', () => {
      getConfigValueStub.withArgs('zmqpubfluxnodestatus').returns(undefined);

      expect(service.start()).to.equal(true);

      expect(capturedSubscriberOptions.topics).to.eql([
        'hashblockheight', 'chainreorg', 'fluxnodelistdelta',
      ]);
    });

    it('should not open a socket when the daemon publishes nothing we know', () => {
      getConfigValueStub.returns(undefined);

      expect(service.start()).to.equal(false);
      expect(capturedSubscriberOptions).to.equal(null);
      expect(service.availableTopics()).to.eql([]);
    });
  });

  describe('routing tests', () => {
    it('should deliver a decoded message to the topic handler', () => {
      const onMessage = sinon.stub();
      service.subscribe('hashblockheight', { onMessage });
      service.start();

      capturedSubscriberOptions.onMessage('hashblockheight', { height: 5 }, 42);

      sinon.assert.calledOnceWithExactly(onMessage, { height: 5 }, 42);
    });

    it('should deliver to every handler registered for a topic', () => {
      const first = sinon.stub();
      const second = sinon.stub();
      service.subscribe('chainreorg', { onMessage: first });
      service.subscribe('chainreorg', { onMessage: second });
      service.start();

      capturedSubscriberOptions.onMessage('chainreorg', { depth: 2 }, 1);

      sinon.assert.calledOnce(first);
      sinon.assert.calledOnce(second);
    });

    it('should not deliver a topic to another topic handler', () => {
      const onMessage = sinon.stub();
      service.subscribe('hashblockheight', { onMessage });
      service.start();

      capturedSubscriberOptions.onMessage('chainreorg', {}, 1);

      sinon.assert.notCalled(onMessage);
    });
  });

  describe('resync tests', () => {
    it('should ask only the affected topic to resync after a gap', () => {
      const gapped = sinon.stub();
      const other = sinon.stub();
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync: gapped });
      service.subscribe('hashblockheight', { onMessage: sinon.stub(), onResync: other });
      service.start();

      capturedSubscriberOptions.onGap('fluxnodelistdelta', 3);

      sinon.assert.calledOnce(gapped);
      sinon.assert.notCalled(other);
    });

    it('should ask every topic to resync after a reconnection', () => {
      const first = sinon.stub();
      const second = sinon.stub();
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync: first });
      service.subscribe('hashblockheight', { onMessage: sinon.stub(), onResync: second });
      service.start();

      capturedSubscriberOptions.onConnect({ reconnected: true });

      sinon.assert.calledOnce(first);
      sinon.assert.calledOnce(second);
    });

    it('should rebuild once for a flapping link, not once per reconnect', () => {
      const onResync = sinon.stub();
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync });
      service.start();

      capturedSubscriberOptions.onConnect({ reconnected: true });
      capturedSubscriberOptions.onConnect({ reconnected: true });
      capturedSubscriberOptions.onConnect({ reconnected: true });

      // Every rebuild is a full snapshot, so the second and third would be paying
      // again for an answer the first already has.
      sinon.assert.calledOnce(onResync);
      expect(publishedAs('daemon:resyncSkipped')).to.have.lengthOf(2);
    });

    it('should say which reconnects it declined to rebuild for', () => {
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync: sinon.stub() });
      service.start();

      capturedSubscriberOptions.onConnect({ reconnected: true });
      capturedSubscriberOptions.onConnect({ reconnected: true });

      const [skipped] = publishedAs('daemon:resyncSkipped');
      expect(skipped.reason).to.equal(service.RESYNC_REASONS.reconnected);
      expect(skipped.elapsedMs).to.be.a('number');
    });

    it('should still rebuild on a gap while a reconnect rebuild is throttled', () => {
      const onResync = sinon.stub();
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync });
      service.start();

      capturedSubscriberOptions.onConnect({ reconnected: true });
      capturedSubscriberOptions.onConnect({ reconnected: true });
      capturedSubscriberOptions.onGap('fluxnodelistdelta', 2);

      // The throttle is about repeated answers to the same question. A gap is a
      // different question and must not be swallowed by it.
      expect(onResync.callCount).to.equal(2);
      expect(onResync.secondCall.args[0]).to.equal(service.RESYNC_REASONS.messageGap);
    });

    it('should not ask for a resync on the first connection', () => {
      const onResync = sinon.stub();
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync });
      service.start();

      capturedSubscriberOptions.onConnect({ reconnected: false });

      sinon.assert.notCalled(onResync);
    });

    it('should not ask anything to rebuild when the socket merely drops', () => {
      // A drop is not a loss of state. libzmq reconnects on its own and the
      // reconnect asks for the rebuild; treating the drop itself as a reason would
      // discard a list that is still correct and pay for a snapshot to get it back.
      const onResync = sinon.stub();
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync });
      service.start();

      if (capturedSubscriberOptions.onDisconnect) capturedSubscriberOptions.onDisconnect();

      sinon.assert.notCalled(onResync);
      expect(publishedAs('daemon:resync')).to.have.lengthOf(0);
    });

    it('should keep what it holds across a drop and rebuild only on the reconnect', () => {
      const onResync = sinon.stub();
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync });
      service.start();

      if (capturedSubscriberOptions.onDisconnect) capturedSubscriberOptions.onDisconnect();
      sinon.assert.notCalled(onResync);

      capturedSubscriberOptions.onConnect({ reconnected: true });

      sinon.assert.calledOnce(onResync);
      expect(onResync.firstCall.args[0]).to.equal(service.RESYNC_REASONS.reconnected);
    });

    it('should tolerate a handler that registered no resync callback', () => {
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub() });
      service.start();

      expect(() => capturedSubscriberOptions.onGap('fluxnodelistdelta', 1)).to.not.throw();
    });

    it('should name a gap by its own token, not by the count that caused it', () => {
      const onResync = sinon.stub();
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync });
      service.start();

      capturedSubscriberOptions.onGap('fluxnodelistdelta', 3);

      expect(onResync.firstCall.args[0]).to.equal(service.RESYNC_REASONS.messageGap);
    });

    it('should announce a resync with the topic and the reason token', () => {
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync: sinon.stub() });
      service.start();

      capturedSubscriberOptions.onGap('fluxnodelistdelta', 3);

      expect(publishedAs('daemon:resync')).to.eql([
        { topic: 'fluxnodelistdelta', reason: 'message_gap' },
      ]);
    });

    it('should announce a resync for every topic a reconnection touched', () => {
      service.subscribe('fluxnodelistdelta', { onMessage: sinon.stub(), onResync: sinon.stub() });
      service.subscribe('hashblockheight', { onMessage: sinon.stub(), onResync: sinon.stub() });
      service.start();

      capturedSubscriberOptions.onConnect({ reconnected: true });

      expect(publishedAs('daemon:resync')).to.eql([
        { topic: 'fluxnodelistdelta', reason: 'reconnected' },
        { topic: 'hashblockheight', reason: 'reconnected' },
      ]);
    });

    it('should announce nothing for a topic nobody subscribed to', () => {
      service.start();

      capturedSubscriberOptions.onGap('chainreorg', 1);

      expect(publishedAs('daemon:resync')).to.eql([]);
    });
  });

  describe('observability tests', () => {
    it('should announce the endpoint and the topics it started on', () => {
      service.start();

      expect(publishedAs('daemon:subscriptionsStarted')).to.eql([
        { endpoint: 'tcp://127.0.0.1:16123', topics: ALL_TOPICS },
      ]);
    });

    it('should announce a start with no topics rather than stay silent', () => {
      // A suite has to be able to tell "started with nothing" from "never started".
      getConfigValueStub.returns(undefined);

      expect(service.start()).to.equal(false);

      expect(publishedAs('daemon:subscriptionsStarted')).to.eql([
        { endpoint: 'tcp://127.0.0.1:16123', topics: [] },
      ]);
    });

    it('should announce the start once however many times it is started', () => {
      service.start();
      service.start();

      expect(publishedAs('daemon:subscriptionsStarted')).to.have.lengthOf(1);
    });
  });

  describe('liveness tests', () => {
    it('should probe the daemon with a block count call', async () => {
      const executeCallStub = sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: 5 });

      const result = await service.probeDaemon();

      expect(result).to.equal(true);
      sinon.assert.calledOnceWithExactly(executeCallStub, 'getBlockCount', []);
    });

    it('should report a failed call as not answering', async () => {
      sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'error', data: { message: 'refused' } });

      expect(await service.probeDaemon()).to.equal(false);
    });

    it('should feed liveness from the subscriber elapsed time', () => {
      service.start();

      expect(capturedLivenessOptions.elapsedSinceMessageMs).to.equal(subscriberStub.elapsedSinceMessageMs);
    });

    it('should report alive before the subscription has started', () => {
      expect(service.daemonAlive()).to.equal(true);
    });

    it('should defer to the liveness verdict once started', () => {
      service.start();
      livenessStub.alive.returns(false);

      expect(service.daemonAlive()).to.equal(false);
    });
  });

  describe('liveness announcement tests', () => {
    it('should announce the daemon going unreachable and coming back', () => {
      service.start();

      capturedLivenessOptions.onChange(false);
      expect(publishedAs('daemon:unreachable')).to.have.lengthOf(1);
      expect(publishedAs('daemon:recovered')).to.have.lengthOf(0);

      capturedLivenessOptions.onChange(true);
      expect(publishedAs('daemon:recovered')).to.have.lengthOf(1);
    });

    it('should announce a dropped socket without calling it unreachable', () => {
      service.start();

      capturedSubscriberOptions.onDisconnect();

      expect(publishedAs('daemon:socketDropped')).to.have.lengthOf(1);
      // A drop is a transport event; whether the daemon is reachable is the
      // liveness verdict's to make, and it has not been asked.
      expect(publishedAs('daemon:unreachable')).to.have.lengthOf(0);
    });
  });

  describe('lifecycle tests', () => {
    it('should start the subscriber and liveness together', () => {
      service.start();

      sinon.assert.calledOnce(subscriberStub.start);
      sinon.assert.calledOnce(livenessStub.start);
    });

    it('should be idempotent on repeated starts', () => {
      service.start();
      service.start();

      sinon.assert.calledOnce(subscriberStub.start);
    });

    it('should stop both on stop', () => {
      service.start();
      service.stop();

      sinon.assert.calledOnce(subscriberStub.stop);
      sinon.assert.calledOnce(livenessStub.stop);
    });
  });

  describe('registration validation tests', () => {
    it('should reject an unknown topic', () => {
      expect(() => service.subscribe('rawblock', { onMessage: () => {} })).to.throw('Unknown topic rawblock');
    });

    it('should reject a handler with no onMessage', () => {
      expect(() => service.subscribe('chainreorg', {})).to.throw('needs an onMessage handler');
    });
  });
});
