'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const realConfig = require('config');

// trackTerminalSession reports which container a terminal was opened into. It
// used to take the app and component separately and rebuild
// `${component}_${appName}`, dropping the replica segment — so two co-located
// siblings reported their sessions under one target and could not be told
// apart. It now takes the identifier the caller already holds.
describe('analyticsService: terminal session identity', () => {
  let analyticsService;
  let postStub;

  // Events buffer and flush at a threshold; the unit config has no analytics
  // section at all, so without a url nothing is ever recorded and any
  // assertion here would pass while testing nothing.
  const FLUSH_THRESHOLD = 15;

  function endpointsSent() {
    return postStub.getCalls().flatMap((call) => (call.args[1]?.events || []).map((event) => event.apiEndpoint));
  }

  function fillBuffer(target, count) {
    for (let i = 0; i < count; i += 1) {
      analyticsService.trackTerminalSession('auth', target, 'open', '1.2.3.4');
    }
  }

  beforeEach(() => {
    postStub = sinon.stub().resolves({ data: {} });
    analyticsService = proxyquire('../../ZelBack/src/services/analyticsService', {
      axios: { post: postStub },
      config: { ...realConfig, analytics: { url: 'http://analytics.test' } },
      // Startup stamps the node's address on every event; unstubbed that is a
      // real RPC to the benchmark daemon.
      './fluxNetworkHelper': { getLocalSocketAddress: sinon.stub().resolves('127.0.0.1:16127') },
    });
    analyticsService.startFlushTimer();
  });

  afterEach(() => {
    sinon.restore();
  });

  it('sends the identifier verbatim, without rebuilding it', async () => {
    fillBuffer('web_myapp_s1', FLUSH_THRESHOLD);
    await Promise.resolve();

    const endpoints = endpointsSent();
    expect(endpoints.length, 'the buffer must have flushed, or this asserts nothing').to.be.greaterThan(0);
    expect(endpoints[0]).to.equal('/terminal/open/web_myapp_s1');
  });

  it('keeps co-located replicas as distinct targets', async () => {
    fillBuffer('web_myapp_s1', 8);
    fillBuffer('web_myapp_s2', 7);
    await Promise.resolve();

    const endpoints = endpointsSent();
    expect(endpoints.length, 'the buffer must have flushed, or this asserts nothing').to.be.greaterThan(0);
    expect(endpoints).to.include('/terminal/open/web_myapp_s1');
    expect(endpoints).to.include('/terminal/open/web_myapp_s2');
  });
});
