'use strict';

/* eslint-disable no-underscore-dangle */
const sinon = require('sinon');
const objectHash = require('object-hash');
const WebSocket = require('ws');
const { expect } = require('chai');
const { MongoNetworkTimeoutError } = require('mongodb');
const log = require('../../ZelBack/src/lib/log');
const { Privilege, authOf } = require('../../ZelBack/src/services/utils/privileges');
const { FluxTTLCache } = require('../../ZelBack/src/services/utils/cacheManager');
const fluxCommunication = require('../../ZelBack/src/services/fluxCommunication');
const fluxCommunicationMessagesSender = require('../../ZelBack/src/services/fluxCommunicationMessagesSender');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const { requireMongo } = require('./dbTestHelper');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const nodeConfirmationService = require('../../ZelBack/src/services/nodeConfirmationService');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const generalService = require('../../ZelBack/src/services/generalService');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const networkStateService = require('../../ZelBack/src/services/networkStateService');
const verifyPool = require('../../ZelBack/src/services/utils/verifyPool');
const registryManager = require('../../ZelBack/src/services/appDatabase/registryManager');
const { peerManager } = require('../../ZelBack/src/services/utils/peerState');
const nodeDownService = require('../../ZelBack/src/services/nodeDownService');
const { appSyncEvents, EVENTS: SYNC_EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');
const { PEER_SOURCE, CLOSE_CODES } = require('../../ZelBack/src/services/utils/FluxPeerSocket');
const rateLimit = require('../../ZelBack/src/services/utils/rateLimit');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');

let localWsServer;
let localWsUrl;

const connectWs = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(localWsUrl);
  ws.onopen = () => {
    resolve(ws);
  };
  ws.onerror = (err) => {
    reject(err);
  };
});

/**
 * Poll until predicate returns true, or timeout.
 * @param {Function} predicate - returns truthy when condition is met
 * @param {number} [timeout=3000]
 * @param {number} [interval=10]
 */
function waitFor(predicate, timeout = 3000, interval = 10) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor timed out'));
      return setTimeout(check, interval);
    };
    check();
  });
}

describe('fluxCommunication tests', () => {
  before((done) => {
    localWsServer = new WebSocket.Server({ port: 0 }, () => {
      const { port } = localWsServer.address();
      localWsUrl = `ws://127.0.0.1:${port}`;
      done();
    });
  });

  after((done) => {
    // Force-close any lingering client connections (tests override ws.close with a no-op)
    localWsServer.clients.forEach((client) => client.terminate());
    localWsServer.close(done);
  });

  describe('addOutgoingPeer tests', () => {
    const listed = { ip: '127.0.0.1:16127', pubkey: '02ownkey' };
    const ask = (ip) => {
      const res = { json: sinon.fake((body) => body) };
      return fluxCommunication.addOutgoingPeer({ params: { ip }, query: {}, ip: '127.0.0.1' }, res).then(() => res.json.firstCall.args[0]);
    };

    beforeEach(() => {
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxCommunicationUtils, 'deterministicFluxList').resolves([listed]);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('connects to a listed node at the address its own move leads to', async () => {
      sinon.stub(registryManager, 'listedNodeMovedTo').resolves(listed);

      const answer = await ask('127.0.0.1:1');

      expect(answer.status).to.equal('success');
      sinon.assert.calledWith(registryManager.listedNodeMovedTo, '127.0.0.1:1', [listed]);
    });

    it('refuses an address no listed node is at or moved to', async () => {
      sinon.stub(registryManager, 'listedNodeMovedTo').resolves(null);

      const answer = await ask('127.0.0.1:1');

      expect(answer.status).to.equal('error');
      expect(answer.data.message).to.contain('is not confirmed on the network');
    });
  });

  describe('initializeDiscovery tests', () => {
    // Being confirmed is not the same as being ready to peer. Every message an
    // inbound peer sends is checked against the node list, so a peer admitted
    // before the list arrives is refused however legitimate it is. Measured at
    // 1391ms on a live node holding 6091 nodes - short, but it is the whole of
    // the window the node was turning real peers away in.
    let onConfirmationChange;
    let onReady;
    let allowConnections;
    let disconnectAll;

    beforeEach(() => {
      onConfirmationChange = sinon.stub(nodeConfirmationService, 'onConfirmationChange');
      onReady = sinon.stub(networkStateService, 'onReady');
      allowConnections = sinon.stub(peerManager, 'allowConnections');
      disconnectAll = sinon.stub(peerManager, 'disconnectAll');
      sinon.stub(log, 'info');
    });

    afterEach(() => {
      sinon.restore();
    });

    // Runs initializeDiscovery and hands back the confirmation callback it
    // registered, which is the only way into this code.
    function confirmationHandler() {
      fluxCommunication.initializeDiscovery();

      expect(onConfirmationChange.calledOnce).to.equal(true);

      return onConfirmationChange.firstCall.args[0];
    }

    it('does not accept peers on confirmation alone', () => {
      const confirmed = confirmationHandler();

      confirmed(true);

      expect(onReady.calledOnce).to.equal(true);
      expect(allowConnections.called).to.equal(false);
    });

    it('accepts peers once the node list has arrived', () => {
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);

      const confirmed = confirmationHandler();

      confirmed(true);
      onReady.firstCall.args[0]();

      expect(allowConnections.calledOnce).to.equal(true);
    });

    it('does not re-open after confirmation is lost while waiting for the list', () => {
      // onReady fires whenever the list lands, which can be after a
      // disconnectAll. Without the re-check this hands the door straight back.
      const isConfirmed = sinon.stub(nodeConfirmationService, 'isConfirmed');
      const confirmed = confirmationHandler();

      confirmed(true);

      isConfirmed.returns(false);
      confirmed(false);

      onReady.firstCall.args[0]();

      expect(disconnectAll.calledOnce).to.equal(true);
      expect(allowConnections.called).to.equal(false);
    });

    it('disconnects every peer when confirmation is lost, without consulting the list', () => {
      const confirmed = confirmationHandler();

      confirmed(false);

      expect(disconnectAll.calledOnce).to.equal(true);
      expect(onReady.called).to.equal(false);
      expect(allowConnections.called).to.equal(false);
    });
  });

  describe('handleAppMessages tests', () => {
    const privateKey = 'KxA2iy4aVuVKXsK8pBnJGM9vNm4z6PLNRTzsPuSFBw6vWL5StbqD';
    const ownerAddress = '13ienDRfUwFEgfZxm5dk4drTQsmj5hDGwL';
    let announceSpy;

    before(requireMongo);

    beforeEach(async () => {
      peerManager.reset();
      await dbHelper.initiateDB();
      announceSpy = sinon.stub(peerManager, 'broadcastHash');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should announce a valid app message to peers', async () => {
      sinon.stub(messageStore, 'storeAppTemporaryMessage').resolves({ rebroadcast: true });
      const fromIp = '127.0.0.5';
      const port = '16127';
      const appSpecifications = {
        name: 'website',
        commands: [
          '--chain',
          'kusama',
        ],
        containerData: '/chaindata',
        cpu: 0.8,
        description: 'This is my test app',
        domains: [
          'testing.runonflux.io',
          'testing.runonflux.io',
          'testing.runonflux.io',
        ],
        enviromentParameters: [],
        hdd: 20,
        owner: ownerAddress,
        ram: 1800,
        repotag: 'yurinnick/folding-at-home:latest',
        tiered: false,
        containerPorts: [
          '30333',
          '9933',
          '9944',
        ],
        ports: [
          '31113',
          '31112',
          '31111',
        ],
        version: 2,
      };
      const type = 'fluxappregister';
      const version = 1;
      const timestamp = 1_592_988_806_887;
      const messageToSign = type + version + JSON.stringify(appSpecifications) + timestamp;
      const signature = verificationHelper.signMessage(messageToSign, privateKey);
      const messageToHash = type + version + JSON.stringify(appSpecifications) + timestamp + signature;
      const hash = await generalService.messageHash(messageToHash);
      const message = {
        data:
        {
          type,
          version,
          appSpecifications,
          timestamp,
          signature,
          hash,
        },
      };

      const wsOutgoing = await connectWs();
      wsOutgoing.ip = '127.8.8.1';
      wsOutgoing.port = port;
      wsOutgoing._socket = {
        remoteAddress: '127.8.8.1',
        end: sinon.fake(() => true),
      };
      wsOutgoing.on = sinon.stub();
      peerManager.add(wsOutgoing, wsOutgoing.ip, port, { source: PEER_SOURCE.RANDOM });

      const wsIncoming = await connectWs();
      wsIncoming.ip = '127.8.8.1';
      wsIncoming.port = port;
      wsIncoming._socket = {
        remoteAddress: '::ffff:127.8.8.1',
        end: sinon.fake(() => true),
      };
      wsIncoming.on = sinon.stub();
      peerManager.add(wsIncoming, wsIncoming.ip, port, { source: PEER_SOURCE.INBOUND });

      await fluxCommunication.handleAppMessages(message, fromIp, port);

      sinon.assert.calledOnceWithExactly(announceSpy, objectHash(message.data), `${fromIp}:${port}`);
    }).timeout(10_000);

    it('should not send broadcast if signature is invalid', async () => {
      const fromIp = '127.0.0.5';
      const port = '16127';
      const appSpecifications = {
        name: 'website',
        commands: [
          '--chain',
          'kusama',
        ],
        containerData: '/chaindata',
        cpu: 0.8,
        description: 'This is my test app',
        domains: [
          'testing.runonflux.io',
          'testing.runonflux.io',
          'testing.runonflux.io',
        ],
        enviromentParameters: [],
        hdd: 20,
        owner: ownerAddress,
        ram: 1800,
        repotag: 'yurinnick/folding-at-home:latest',
        tiered: false,
        containerPorts: [
          '30333',
          '9933',
          '9944',
        ],
        ports: [
          '31113',
          '31112',
          '31111',
        ],
        version: 2,
      };
      const type = 'fluxappregister';
      const version = 1;
      const timestamp = 1_592_988_806_887;
      const signature = 'testing1234invalidsignature';
      const messageToHash = type + version + JSON.stringify(appSpecifications) + timestamp + signature;
      const hash = await generalService.messageHash(messageToHash);
      const message = {
        data:
        {
          type,
          version,
          appSpecifications,
          timestamp,
          signature,
          hash,
        },
      };

      await fluxCommunication.handleAppMessages(message, fromIp, port);

      sinon.assert.notCalled(announceSpy);
    });

    it('should not send broadcast if app data is invalid', async () => {
      const fromIp = '127.0.0.5';
      const port = '16127';
      const appSpecifications = {
        name: 'website',
        randomProperty: 'testing1',
      };
      const type = 'fluxappregister';
      const version = 1;
      const timestamp = 1_592_988_806_887;
      const messageToSign = type + version + JSON.stringify(appSpecifications) + timestamp;
      const signature = verificationHelper.signMessage(messageToSign, privateKey);
      const messageToHash = type + version + JSON.stringify(appSpecifications) + timestamp + signature;
      const hash = await generalService.messageHash(messageToHash);
      const message = {
        data:
        {
          type,
          version,
          appSpecifications,
          timestamp,
          signature,
          hash,
        },
      };

      await fluxCommunication.handleAppMessages(message, fromIp, port);

      sinon.assert.notCalled(announceSpy);
    });
  });

  describe('handleAppRunningMessage tests', () => {
    let announceSpy;

    before(requireMongo);

    beforeEach(async () => {
      peerManager.reset();
      await dbHelper.initiateDB();
      announceSpy = sinon.stub(peerManager, 'broadcastHash');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should broadcast the app message if a proper data is given', async () => {
      // relay is gated on the event log saying the announcement was news
      sinon.stub(messageStore, 'releaseInstallingClaims').resolves({ released: 0 });
      sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: true });
      const fromIp = '127.0.0.5';
      const port = '16127';
      const type = 'fluxappregister';
      const name = 'myApp';
      const version = 1;
      const timestamp = Date.now();
      const broadcastedAt = Date.now();
      const messageToHash = type + version + name + timestamp;
      const hash = await generalService.messageHash(messageToHash);
      const message = {
        data:
        {
          type,
          name,
          broadcastedAt,
          version,
          hash,
          ip: fromIp,
        },
        timestamp,
      };

      await fluxCommunication.handleAppRunningMessage(message, fromIp, port);

      sinon.assert.calledOnceWithExactly(announceSpy, objectHash(message.data), `${fromIp}:${port}`);
    }).timeout(10_000);

    it('should not send broadcast if message is older than 3900 seconds', async () => {
      const fromIp = '127.0.0.5';
      const port = '16127';
      const type = 'fluxappregister';
      const name = 'myApp';
      const version = 1;
      const timestamp = 1_592_988_806_887;
      const broadcastedAt = Date.now() - (80 * 60 * 1000);
      const messageToHash = type + version + name + timestamp;
      const hash = await generalService.messageHash(messageToHash);
      const message = {
        data:
        {
          type,
          name,
          broadcastedAt,
          version,
          timestamp,
          hash,
          ip: fromIp,
        },
      };

      const wsOutgoing = await connectWs();
      wsOutgoing.ip = '127.8.8.1';
      wsOutgoing.port = port;
      wsOutgoing._socket = {
        remoteAddress: '127.8.8.1',
        end: sinon.fake(() => true),
      };
      wsOutgoing.on = sinon.stub();
      peerManager.add(wsOutgoing, wsOutgoing.ip, port, { source: PEER_SOURCE.RANDOM });

      const wsIncoming = await connectWs();
      wsIncoming.ip = '127.8.8.1';
      wsIncoming.port = port;
      wsIncoming._socket = {
        remoteAddress: '::ffff:127.8.8.1',
        end: sinon.fake(() => true),
      };
      wsIncoming.on = sinon.stub();
      peerManager.add(wsIncoming, wsIncoming.ip, port, { source: PEER_SOURCE.INBOUND });

      await fluxCommunication.handleAppRunningMessage(message, fromIp, port);

      sinon.assert.notCalled(announceSpy);
    }).timeout(5000);

    const runningMessage = () => ({
      data: {
        type: 'fluxapprunning', version: 2, apps: [{ name: 'myApp', hash: 'myapphash' }], broadcastedAt: Date.now(), ip: '203.0.113.31:16127',
      },
      timestamp: Date.now(),
    });
    const apprunningPublished = (publish) => publish.getCalls().filter((call) => call.args[0] === 'network:apprunning');

    it('publishes nothing for a message that wrote, refused, cleared and relayed nothing', async () => {
      sinon.stub(messageStore, 'storeAppRunningMessage').resolves({
        stored: false, rebroadcast: false, written: [], refused: [], cleared: false,
      });
      sinon.stub(messageStore, 'storeAppStateEvent');
      const publish = sinon.stub(fluxEventBus, 'publish');

      await fluxCommunication.handleAppRunningMessage(runningMessage(), '127.0.0.5', '16127');

      expect(apprunningPublished(publish)).to.have.lengthOf(0);
    });

    it('publishes the names it refused, though it wrote and relayed nothing', async () => {
      sinon.stub(messageStore, 'storeAppRunningMessage').resolves({
        stored: false, rebroadcast: false, written: [], refused: ['unhashed'], cleared: false,
      });
      sinon.stub(messageStore, 'storeAppStateEvent');
      const publish = sinon.stub(fluxEventBus, 'publish');

      await fluxCommunication.handleAppRunningMessage(runningMessage(), '127.0.0.5', '16127');

      const [call] = apprunningPublished(publish);
      expect(call.args[1]).to.deep.equal({
        ip: '203.0.113.31:16127', apps: [], refused: ['unhashed'], cleared: false, relayed: false,
      });
    });

    // A refused message is logged where it arrived, and goes no further.
    it('logs a message its store refuses, and does not relay it', async () => {
      const broadcastHashSpy = sinon.stub(peerManager, 'broadcastHash');
      sinon.stub(messageStore, 'storeAppRunningMessage').resolves(new Error('Invalid Flux App Running message for storing'));
      sinon.stub(messageStore, 'storeAppStateEvent');
      const warn = sinon.stub(log, 'warn');
      const fromIp = '127.0.0.5';
      const port = '16127';
      const message = {
        data: {
          type: 'fluxapprunning', version: 2, apps: 'not an array', broadcastedAt: Date.now(), ip: '203.0.113.30:16127',
        },
        timestamp: Date.now(),
      };

      await fluxCommunication.handleAppRunningMessage(message, fromIp, port);

      sinon.assert.notCalled(broadcastHashSpy);
      sinon.assert.calledWithMatch(warn, /handleAppRunningMessage - not stored, from 127\.0\.0\.5:16127 for 203\.0\.113\.30:16127: Invalid Flux App Running message for storing/);
    });
  });

  describe('the installing claim handlers', () => {
    // Each handler records the claim, stores the signed broadcast this node serves
    // to peers syncing from it, and relays the claim only once both are recorded.
    const handlers = [
      {
        name: 'handleAppInstallingMessage',
        type: 'fluxappinstalling',
        storeClaim: 'storeAppInstallingMessage',
        storeSigned: 'storeSignedAppInstallingBroadcast',
      },
      {
        name: 'handleAppInstallingErrorMessage',
        type: 'fluxappinstallingerror',
        storeClaim: 'storeAppInstallingErrorMessage',
        storeSigned: 'storeSignedAppInstallingErrorBroadcast',
      },
    ];
    const fromIp = '127.0.0.5';
    const port = '16127';
    const claim = (type) => ({
      timestamp: Date.now(),
      data: {
        type, version: 1, name: 'claimedapp', ip: '127.0.0.9:16127', broadcastedAt: Date.now(),
      },
    });
    let broadcastHash;

    beforeEach(() => {
      broadcastHash = sinon.stub(peerManager, 'broadcastHash');
      sinon.stub(log, 'error');
    });

    afterEach(() => {
      sinon.restore();
    });

    handlers.forEach(({
      name, type, storeClaim, storeSigned,
    }) => {
      describe(name, () => {
        beforeEach(() => {
          sinon.stub(messageStore, storeClaim).resolves(true);
        });

        it('a canary: relays a claim whose signed broadcast is stored', async () => {
          sinon.stub(messageStore, storeSigned).resolves();
          const message = claim(type);

          await fluxCommunication[name](message, fromIp, port);

          sinon.assert.calledOnceWithExactly(broadcastHash, objectHash(message.data), `${fromIp}:${port}`);
        });

        it('does not relay a claim whose signed broadcast could not be stored', async () => {
          const storeSignedStub = sinon.stub(messageStore, storeSigned).rejects(new MongoNetworkTimeoutError('connection timed out'));

          await fluxCommunication[name](claim(type), fromIp, port);

          sinon.assert.calledOnce(storeSignedStub);
          sinon.assert.notCalled(broadcastHash);
        });
      });
    });
  });


  describe('connectedPeers tests', () => {
    const generateResponse = () => {
      const res = { test: 'testing' };
      res.status = sinon.stub().returns(res);
      res.json = sinon.fake((param) => param);
      return res;
    };

    beforeEach(() => {
      peerManager.reset();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return connected peers\' ips', async () => {
      const port = '16127';
      const wsOutgoing1 = await connectWs();
      wsOutgoing1.ip = '127.8.8.1';
      wsOutgoing1.port = port;
      wsOutgoing1._socket = { remoteAddress: '127.8.8.1', end: sinon.fake(() => true) };
      wsOutgoing1.on = sinon.stub();
      peerManager.add(wsOutgoing1, wsOutgoing1.ip, port, { source: PEER_SOURCE.RANDOM });

      const wsOutgoing2 = await connectWs();
      wsOutgoing2.ip = '127.8.8.2';
      wsOutgoing2.port = port;
      wsOutgoing2._socket = { remoteAddress: '127.8.8.2', end: sinon.fake(() => true) };
      wsOutgoing2.on = sinon.stub();
      peerManager.add(wsOutgoing2, wsOutgoing2.ip, port, { source: PEER_SOURCE.RANDOM });

      const expectedResult = { status: 'success', data: ['127.8.8.1', '127.8.8.2'] };

      const res = generateResponse();

      await fluxCommunication.connectedPeers(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
    }).timeout(5000);

    it('should empty list if no peers are connected', async () => {
      const res = generateResponse();
      const expectedResult = { status: 'success', data: [] };

      await fluxCommunication.connectedPeers(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
    });
  });

  describe('connectedPeersInfo tests', () => {
    const generateResponse = () => {
      const res = { test: 'testing' };
      res.status = sinon.stub().returns(res);
      res.json = sinon.fake((param) => param);
      return res;
    };

    beforeEach(() => {
      peerManager.reset();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return connected connected websockets', async () => {
      // peerManager.add creates FluxPeerSocket objects whose toPeerInfo() returns
      // { ip, port, latency: null, lastPingTime: null } for outbound peers
      const ws1 = await connectWs();
      ws1.ip = '127.0.3.1';
      ws1.port = '16127';
      ws1.on = sinon.stub();
      peerManager.add(ws1, '127.0.3.1', '16127', { source: PEER_SOURCE.RANDOM });

      const ws2 = await connectWs();
      ws2.ip = '192.168.0.0';
      ws2.port = '16127';
      ws2.on = sinon.stub();
      peerManager.add(ws2, '192.168.0.0', '16127', { source: PEER_SOURCE.RANDOM });

      const expectedResult = {
        status: 'success',
        data: [
          {
            ip: '127.0.3.1',
            port: '16127',
            latency: null,
            lastPingTime: null,
          },
          {
            ip: '192.168.0.0',
            port: '16127',
            latency: null,
            lastPingTime: null,
          },
        ],
      };

      const res = generateResponse();

      await fluxCommunication.connectedPeersInfo(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
    });

    it('should empty list if no peers are connected', async () => {
      const res = generateResponse();
      const expectedResult = { status: 'success', data: [] };

      await fluxCommunication.connectedPeersInfo(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
    });
  });

  describe('removePeer tests', () => {
    let verificationHelperStub;

    beforeEach(async () => {
      peerManager.reset();

      // Add two outbound peers via peerManager
      const ws1 = await connectWs();
      ws1.ip = '127.0.3.1';
      ws1.port = '16127';
      ws1.close = () => true;
      ws1.on = sinon.stub();
      peerManager.add(ws1, '127.0.3.1', '16127', { source: PEER_SOURCE.RANDOM });

      const ws2 = await connectWs();
      ws2.ip = '192.168.0.0';
      ws2.port = '16137';
      ws2.close = () => true;
      ws2.on = sinon.stub();
      peerManager.add(ws2, '192.168.0.0', '16137', { source: PEER_SOURCE.RANDOM });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should close the connection with ip given in params if it exists', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const expectedResult = {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: 'Outgoing connection to 127.0.3.1:16127 closed',
        },
      };
      const req = {
        params: {
          ip: '127.0.3.1',
          port: 16_127,
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removePeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    }).timeout(5000);

    it('should close the connection with ip given in query if it exists', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const expectedResult = {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: 'Outgoing connection to 127.0.3.1:16127 closed',
        },
      };
      const req = {
        params: {
          test: 'test',
        },
        query: {
          ip: '127.0.3.1',
          port: 16_127,
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removePeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should issue a warning if a connection does not exist', async () => {
      // Clear peers so none exist
      peerManager.reset();
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const expectedResult = {
        status: 'warning',
        data: {
          code: undefined,
          name: undefined,
          message: 'Connection to 127.0.3.1:16127 does not exists.',
        },
      };
      const req = {
        params: {
          ip: '127.0.3.1',
          port: 16_127,
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removePeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should issue an error message if ip is not provided', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const expectedResult = {
        status: 'error',
        data: {
          code: undefined,
          name: undefined,
          message: 'Unparsable `ip` parameter',
        },
      };
      const req = {
        params: {
          test: 'test1',
        },
        query: {
          test2: 'test3',
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removePeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should issue an error message if user is unauthorized', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(false);
      const expectedResult = {
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      };
      const req = {
        params: {
          ip: '127.0.3.1',
          port: 16_127,
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removePeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
    });
  });

  describe('removeIncomingPeer tests', () => {
    let verificationHelperStub;

    beforeEach(async () => {
      peerManager.reset();

      const port = '16127';

      const wsIncoming1 = await connectWs();
      wsIncoming1.ip = '127.0.3.1';
      wsIncoming1.port = port;
      wsIncoming1.close = () => true;
      wsIncoming1.on = sinon.stub();
      peerManager.add(wsIncoming1, '127.0.3.1', port, { source: PEER_SOURCE.INBOUND });

      const wsIncoming2 = await connectWs();
      wsIncoming2.ip = '192.168.0.0';
      wsIncoming2.port = port;
      wsIncoming2.close = () => true;
      wsIncoming2.on = sinon.stub();
      peerManager.add(wsIncoming2, '192.168.0.0', port, { source: PEER_SOURCE.INBOUND });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should close the connection with ip given in params if it exists', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const expectedResult = {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: 'Incoming connection to 127.0.3.1:16127 closed',
        },
      };
      const req = {
        params: {
          ip: '127.0.3.1',
          port: 16_127,
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removeIncomingPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    }).timeout(5000);

    it('should close the connection with ip given in query if it exists', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const expectedResult = {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: 'Incoming connection to 127.0.3.1:16127 closed',
        },
      };
      const req = {
        params: {
          test: 'test',
        },
        query: {
          ip: '127.0.3.1',
          port: 16_127,
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removeIncomingPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    }).timeout(5000);

    it('should issue a warning if a connection does not exist', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const expectedResult = {
        status: 'warning',
        data: {
          code: undefined,
          name: undefined,
          message: 'Connection from 127.0.4.1:16127 does not exists.',
        },
      };
      const req = {
        params: {
          ip: '127.0.4.1',
          port: 16_127,
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removeIncomingPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should issue an error message if ip is not provided', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const expectedResult = {
        status: 'error',
        data: {
          code: undefined,
          name: undefined,
          message: 'Unparsable `ip` parameter',
        },
      };
      const req = {
        params: {
          test: 'test1',
        },
        query: {
          test2: 'test3',
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removeIncomingPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should issue an error message if user is unauthorized', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(false);
      const expectedResult = {
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      };
      const req = {
        params: {
          ip: '127.0.3.1',
        },
      };

      const generateResponse = () => ({
        status: sinon.stub(),
        json: sinon.stub(),
      });

      const res = generateResponse();

      await fluxCommunication.removeIncomingPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });
  });

  describe('initiateAndHandleConnection refuses this node itself', () => {
    let selfRefusalServer;

    beforeEach(() => {
      peerManager.reset();
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').returns('44.192.51.11:16127');
    });

    afterEach(() => {
      if (selfRefusalServer) {
        selfRefusalServer.close();
        selfRefusalServer = null;
      }
      sinon.restore();
      peerManager.reset();
    });

    // Every outbound dial arrives here - manual, deterministic, reconnect and
    // random - and only one of those callers filtered its own address before
    // calling. The reconnect queue in particular re-dials whatever it holds
    // without asking whose address it is. A self-connection is not just a wasted
    // socket: it takes a peer slot, is offered back as a peer to gossip and to
    // sync from, and answers every question with what this node already knows.
    it('refuses to connect to this node\'s own address', async () => {
      peerManager.reset();

      await fluxCommunication.initiateAndHandleConnection('44.192.51.11:16127');

      expect(peerManager.outboundCount).to.equal(0);
      expect(peerManager.isPending('44.192.51.11:16127'), 'left itself marked pending').to.equal(false);
    });

    // The control: without it, "refuses its own address" passes just as well on
    // a node that refuses EVERY address.
    //
    // Against a server this process started, not a public one. It used to dial
    // 44.192.51.12:16127 - a real address on the internet - and then assert only
    // that this node had not marked ITSELF, which is true whether the dial
    // connected, was refused, or never happened. A local server makes the
    // control say what it means: the other node is actually connected to.
    it('still connects to a different node at the same port', async () => {
      peerManager.reset();
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: false, height: 0 } });
      // An ephemeral port on 127.0.0.1, because 127.0.0.2 is not bound by
      // default on macOS. The guard allows any port THIS process is listening
      // on, which is the whole point of dialling our own server.
      selfRefusalServer = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
      await new Promise((resolve) => { selfRefusalServer.on('listening', resolve); });
      const target = `127.0.0.1:${selfRefusalServer.address().port}`;

      await fluxCommunication.initiateAndHandleConnection(target);
      await waitFor(() => peerManager.outboundCount === 1);

      expect(peerManager.has(target), 'a different node was refused too').to.equal(true);
      expect(peerManager.has('44.192.51.11:16127'), 'connected to itself after all').to.equal(false);
    });

  });

  // Where the dial gets that address from. Asking benchmark is an uncached RPC
  // and this runs on every attempt - discovery's deterministic loop, the
  // reconnect queue, the random draw, the manual add and /flux/addpeer - so it
  // asks the peer manager, which is told every refresh by the one place the node
  // learns what it is, and already answers this same question for the sync draw.
  describe('initiateAndHandleConnection asks the owner for this node\'s address', () => {
    let fetched;

    beforeEach(() => {
      peerManager.reset();
      peerManager.setOwnSocketAddress(null);
      fetched = sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('44.192.51.11:16127');
    });

    afterEach(() => {
      sinon.restore();
      peerManager.reset();
      peerManager.setOwnSocketAddress(null);
    });

    it('does not ask benchmark once the node has been told its own address', async () => {
      peerManager.setOwnSocketAddress('44.192.51.11:16127');

      await fluxCommunication.initiateAndHandleConnection('44.192.51.11:16127');

      sinon.assert.notCalled(fetched);
      expect(peerManager.outboundCount, 'dialled itself').to.equal(0);
    });

    // The value the owner holds is the one that decides, so a dial refuses
    // itself on it - not on whatever benchmark would have said.
    it('refuses this node on the address the owner holds', async () => {
      peerManager.setOwnSocketAddress('44.192.51.99:16127');

      await fluxCommunication.initiateAndHandleConnection('44.192.51.99:16127');

      sinon.assert.notCalled(fetched);
      expect(peerManager.isPending('44.192.51.99:16127'), 'left itself marked pending').to.equal(false);
    });

    // A dial can arrive before the first refresh has happened. Asking once then
    // is right; asking every time is what this replaces.
    it('asks once when the node has not been told yet', async () => {
      await fluxCommunication.initiateAndHandleConnection('44.192.51.11:16127');

      sinon.assert.calledOnce(fetched);
      expect(peerManager.outboundCount).to.equal(0);
    });
  });

  describe('the crossing-dial rule: the pair keeps the connection the lower address dialed', () => {
    let port;
    let key;
    let held;

    beforeEach(async () => {
      peerManager.reset();
      peerManager.setOwnSocketAddress(null);
      sinon.stub(rateLimit, 'lruRateLimit').returns(true);
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: false, height: 0 } });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').returns('44.192.51.11:16127');
      ({ port } = localWsServer.address());
      key = `127.0.0.1:${port}`;
      // The pair's other connection, held as the far end's inbound dial.
      held = await connectWs();
      held.on = sinon.stub();
    });

    afterEach(() => {
      sinon.restore();
      peerManager.reset();
      peerManager.setOwnSocketAddress(null);
    });

    // The dial's own socket, as the server accepted it.
    const nextServerSocket = () => new Promise((resolve) => {
      localWsServer.once('connection', (ws) => resolve(ws));
    });

    // Both ends can dial the same pair at once, and each then holds the other's
    // dial when its own opens. Both ends keep the connection the lower address
    // dialed; until this node knows its own address it cannot order the pair,
    // and the held connection stays.
    it('a dial opening into a live held pair closes itself while this node cannot order the pair', async () => {
      const dialAccepted = nextServerSocket();
      const dial = fluxCommunication.initiateAndHandleConnection(key, PEER_SOURCE.DETERMINISTIC);
      // Land the held connection while the dial is still handshaking.
      peerManager.add(held, '127.0.0.1', port, { source: PEER_SOURCE.INBOUND });
      const original = peerManager.get(key);
      expect(original, 'the held connection is in place before the dial opens').to.not.equal(undefined);

      await dial;
      const dialSocket = await dialAccepted;
      // Settled one way or the other: the dial closed itself, or it was held.
      await waitFor(() => dialSocket.readyState === WebSocket.CLOSED || peerManager.outboundCount > 0, 5000);

      expect(peerManager.get(key), 'the held connection is still the one held').to.equal(original);
      expect(peerManager.get(key).direction).to.equal('inbound');
      expect(held.readyState, 'the held connection was never closed').to.equal(WebSocket.OPEN);
      expect(dialSocket.readyState, 'the dial that lost the race is closed').to.equal(WebSocket.CLOSED);
      expect(peerManager.outboundCount).to.equal(0);
      expect(peerManager.inboundCount).to.equal(1);
    });

    it('a dial opening into a live held inbound replaces it when this node has the lower address', async () => {
      peerManager.setOwnSocketAddress('1.1.1.1:16127');
      const resolve = sinon.spy(peerManager, 'resolveCrossing');
      const dialAccepted = nextServerSocket();
      const dial = fluxCommunication.initiateAndHandleConnection(key, PEER_SOURCE.DETERMINISTIC);
      peerManager.add(held, '127.0.0.1', port, { source: PEER_SOURCE.INBOUND });
      const original = peerManager.get(key);

      await dial;
      await dialAccepted;
      await waitFor(() => peerManager.outboundCount === 1, 5000);

      expect(peerManager.get(key)).to.not.equal(original);
      expect(peerManager.get(key).direction).to.equal('outbound');
      expect(peerManager.inboundCount).to.equal(0);
      sinon.assert.calledOnceWithExactly(resolve, original, 'outbound');
      await waitFor(() => held.readyState === WebSocket.CLOSED, 5000);
    });

    it('a dial opening into a live held inbound closes itself when the peer has the lower address', async () => {
      peerManager.setOwnSocketAddress('200.1.1.1:16127');
      const resolve = sinon.spy(peerManager, 'resolveCrossing');
      const dialAccepted = nextServerSocket();
      const dial = fluxCommunication.initiateAndHandleConnection(key, PEER_SOURCE.DETERMINISTIC);
      peerManager.add(held, '127.0.0.1', port, { source: PEER_SOURCE.INBOUND });
      const original = peerManager.get(key);

      await dial;
      const dialSocket = await dialAccepted;
      await waitFor(() => dialSocket.readyState === WebSocket.CLOSED || peerManager.outboundCount > 0, 5000);

      expect(peerManager.get(key)).to.equal(original);
      expect(peerManager.get(key).direction).to.equal('inbound');
      expect(held.readyState).to.equal(WebSocket.OPEN);
      expect(dialSocket.readyState).to.equal(WebSocket.CLOSED);
      sinon.assert.calledOnceWithExactly(resolve, original, 'outbound');
    });

    it('a dial completing into a dead held connection replaces it', async () => {
      const dialAccepted = nextServerSocket();
      const dial = fluxCommunication.initiateAndHandleConnection(key, PEER_SOURCE.DETERMINISTIC);
      peerManager.add(held, '127.0.0.1', port, { source: PEER_SOURCE.INBOUND });
      const original = peerManager.get(key);
      held.terminate();
      expect(original.isAlive, 'the held connection reads as dead').to.equal(false);

      await dial;
      await dialAccepted;
      await waitFor(() => peerManager.outboundCount === 1, 5000);

      expect(peerManager.get(key)).to.not.equal(original);
      expect(peerManager.get(key).direction).to.equal('outbound');
      expect(peerManager.inboundCount).to.equal(0);
    });
  });

  describe('initiateAndHandleConnection tests', () => {
    it('a locked-out node dials nobody, whoever asks: the dial settles as no dial before any socket is opened', async () => {
      const locked = sinon.stub(nodeDownService, 'isLockedOut').returns(true);
      try {
        const onSettle = sinon.stub();
        await fluxCommunication.initiateAndHandleConnection('10.0.0.5:16127', 'deterministic', { onSettle });
        sinon.assert.calledOnceWithExactly(onSettle, null);
      } finally {
        locked.restore();
      }
    });

    before(function () { if (process.platform !== 'linux') this.skip(); });

    let wsserver;
    let logSpy;
    let lruRateLimitStub;
    let daemonServiceMiscRpcsStub;
    let ensureObjectSpy;

    beforeEach(() => {
      logSpy = sinon.spy(log, 'info');
      lruRateLimitStub = sinon.stub(rateLimit, 'lruRateLimit').returns(true);
      ensureObjectSpy = sinon.spy(serviceHelper, 'ensureObject');
      peerManager.reset();
      daemonServiceMiscRpcsStub = sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced');
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').returns('44.192.51.11:16127');
    });

    afterEach(() => {
      sinon.restore();
      if (wsserver && typeof wsserver.close === 'function') {
        wsserver.close();
      }
    });

    it('Should add server to outgoing connections after connection have been established', async () => {
      const waitForWsConnected = (wss) => new Promise((resolve, reject) => {
        wss.on('connection', () => {
          resolve();
        });
        // eslint-disable-next-line no-param-reassign
        wss.onerror = (err) => {
          reject(err);
        };
      });
      const ip = '127.0.0.2';
      wsserver = new WebSocket.Server({ host: '127.0.0.2', port: 16_127 });
      daemonServiceMiscRpcsStub.returns({
        data:
        {
          synced: false,
          height: 0,
        },
      });
      await fluxCommunication.initiateAndHandleConnection(ip);

      await waitForWsConnected(wsserver);
      await waitFor(() => peerManager.outboundCount === 1);

      const peer = peerManager.get(`${ip}:16127`);
      expect(peer).to.not.be.undefined;
      expect(peer.ip).to.equal(ip);
    });

    it('should remove peer if server has closed', async () => {
      const waitForWsConnected = (wss) => new Promise((resolve, reject) => {
        wss.on('connection', (ws) => {
          // Close the websocket connection from server side
          setTimeout(() => {
            ws.close();
            wss.close();
          }, 100);
          resolve();
        });
        // eslint-disable-next-line no-param-reassign
        wss.onerror = (err) => {
          reject(err);
        };
      });
      const ip = '127.0.0.2';
      wsserver = new WebSocket.Server({ host: '127.0.0.2', port: 16_127 });
      daemonServiceMiscRpcsStub.returns({
        data:
        {
          synced: false,
          height: 0,
        },
      });

      await fluxCommunication.initiateAndHandleConnection(ip);

      await waitForWsConnected(wsserver);

      // Wait for the close event to be processed
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (peerManager.outboundCount === 0) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
        // Timeout after 3 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 3000);
      });

      expect(peerManager.outboundCount).to.equal(0);
      sinon.assert.calledWith(logSpy, 'Outgoing connection to 127.0.0.2:16127 closed with code 1005');
      sinon.assert.calledWith(logSpy, 'Connection 127.0.0.2:16127 removed from peerManager (outbound, code: 1005)');
    }).timeout(5000);

    it('should not react to the message if rate limit is exceeded', async () => {
      const message = JSON.stringify({
        timestamp: Date.now(),
        pubKey: '1234asd',
        data: {
          type: 'fluxapprunning',
        },
      });
      const waitForWsConnected = (wss) => new Promise((resolve, reject) => {
        wss.on('connection', (ws) => {
          ws.send(message);
          resolve();
        });
        // eslint-disable-next-line no-param-reassign
        wss.onerror = (err) => {
          reject(err);
        };
      });
      const ip = '127.0.0.2';
      wsserver = new WebSocket.Server({ host: '127.0.0.2', port: 16_127 });
      daemonServiceMiscRpcsStub.returns({
        data:
        {
          synced: false,
          height: 0,
        },
      });
      lruRateLimitStub.returns(false);
      const checkObjectSpy = sinon.spy(fluxCommunicationUtils, 'verifyOriginalFluxBroadcast');
      await fluxCommunication.initiateAndHandleConnection(ip);

      await waitForWsConnected(wsserver);
      await waitFor(() => peerManager.outboundCount === 1);

      sinon.assert.notCalled(checkObjectSpy);
    });

    it('should close the connection if peer is added to blockedList', async () => {
      const message = JSON.stringify({
        timestamp: Date.now(),
        pubKey: '1234asd',
        signature: 'blabla',
        version: 1,
        data: {
          type: 'fluxapprunning',
        },
      });
      const waitForWsConnected = (wss) => new Promise((resolve, reject) => {
        wss.on('connection', (ws) => {
          ws.send(message);
          resolve();
        });
        // eslint-disable-next-line no-param-reassign
        wss.onerror = (err) => {
          reject(err);
        };
      });
      const ip = '127.0.0.2';
      wsserver = new WebSocket.Server({ host: '127.0.0.2', port: 16_127 });
      daemonServiceMiscRpcsStub.returns({
        data:
        {
          synced: false,
          height: 0,
        },
      });
      lruRateLimitStub.returns(true);
      const hasCacheStub = sinon.stub(FluxTTLCache.prototype, 'has');
      hasCacheStub.withArgs('1234asd').returns(true);
      const websocketCloseSpy = sinon.spy(WebSocket.prototype, 'close');

      await fluxCommunication.initiateAndHandleConnection(ip);

      await waitForWsConnected(wsserver);
      // Wait for the full close cycle: close() → onclose → remove()
      await waitFor(() => logSpy.calledWith('Connection 127.0.0.2:16127 removed from peerManager (outbound, code: 4006)'));

      sinon.assert.calledWithExactly(ensureObjectSpy, message);
      sinon.assert.calledWithExactly(websocketCloseSpy, 4006, 'blocked list');
      sinon.assert.calledWith(logSpy, 'Closing outbound connection, peer is on blockedList');
      sinon.assert.calledWith(logSpy, 'Outgoing connection to 127.0.0.2:16127 closed with code 4006');
      sinon.assert.calledWith(logSpy, 'Connection 127.0.0.2:16127 removed from peerManager (outbound, code: 4006)');
    });

    const appRequestCommands = ['fluxapprequest'];
    // eslint-disable-next-line no-restricted-syntax
    for (const command of appRequestCommands) {
      // eslint-disable-next-line no-loop-func
      it(`should handle the ${command} message properly`, async () => {
        const message = JSON.stringify({
          timestamp: Date.now(),
          pubKey: '1234asd',
          signature: 'blabla',
          version: 1,
          data: {
            type: `${command}`,
          },
        });
        const waitForWsConnected = (wss) => new Promise((resolve, reject) => {
          wss.on('connection', (ws) => {
            ws.send(message);
            resolve();
          });
          // eslint-disable-next-line no-param-reassign
          wss.onerror = (err) => {
            reject(err);
          };
        });
        const ip = '127.0.0.2';
        wsserver = new WebSocket.Server({ host: '127.0.0.2', port: 16_127 });
        lruRateLimitStub.returns(true);
        sinon.stub(FluxTTLCache.prototype, 'has').returns(false);
        const verifyFluxBroadcastStub = sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast').returns({ result: fluxCommunicationUtils.VerifyResult.OK, announcer: null });
        sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
        const respondWithAppMessageStub = sinon.stub(fluxCommunicationMessagesSender, 'respondWithAppMessage').returns(true);
        daemonServiceMiscRpcsStub.returns({
          data:
          {
            synced: false,
            height: 0,
          },
        });
        await fluxCommunication.initiateAndHandleConnection(ip);

        await waitForWsConnected(wsserver);
        await waitFor(() => respondWithAppMessageStub.called);

        sinon.assert.calledOnceWithExactly(verifyFluxBroadcastStub, JSON.parse(message), undefined, sinon.match.number);
        sinon.assert.calledWith(respondWithAppMessageStub, JSON.parse(message));
      });
    }

    const registerUpdateAppList = ['zelappregister', 'zelappupdate', 'fluxappregister', 'fluxappupdate'];
    // eslint-disable-next-line no-restricted-syntax
    for (const command of registerUpdateAppList) {
      // eslint-disable-next-line no-loop-func
      it(`should handle the ${command} message properly`, async () => {
        const message = JSON.stringify({
          timestamp: Date.now(),
          pubKey: '1234asd',
          signature: 'blabla',
          version: 1,
          data: {
            type: `${command}`,
          },
        });
        const waitForWsConnected = (wss) => new Promise((resolve, reject) => {
          wss.on('connection', (ws) => {
            ws.send(message);
            resolve();
          });
          // eslint-disable-next-line no-param-reassign
          wss.onerror = (err) => {
            reject(err);
          };
        });
        const ip = '127.0.0.2';
        wsserver = new WebSocket.Server({ host: '127.0.0.2', port: 16_127 });
        lruRateLimitStub.returns(true);
        sinon.stub(FluxTTLCache.prototype, 'has').returns(false);
        const verifyFluxBroadcast = sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast').returns({ result: fluxCommunicationUtils.VerifyResult.OK, announcer: null });
        sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
        const storeAppTemporaryMessageStub = sinon.stub(messageStore, 'storeAppTemporaryMessage').returns(false);
        daemonServiceMiscRpcsStub.returns({
          data:
          {
            synced: false,
            height: 0,
          },
        });
        await fluxCommunication.initiateAndHandleConnection(ip);

        await waitForWsConnected(wsserver);
        await waitFor(() => storeAppTemporaryMessageStub.called);

        sinon.assert.calledOnceWithExactly(verifyFluxBroadcast, JSON.parse(message), undefined, sinon.match.number);
        sinon.assert.calledOnceWithExactly(storeAppTemporaryMessageStub, JSON.parse(message).data);
      });
    }

    const appRunningMessageList = ['fluxapprunning'];
    // eslint-disable-next-line no-restricted-syntax
    for (const command of appRunningMessageList) {
      // eslint-disable-next-line no-loop-func
      it(`should handle the ${command} message properly`, async () => {
        const message = JSON.stringify({
          timestamp: Date.now(),
          pubKey: '1234asd',
          signature: 'blabla',
          version: 1,
          data: {
            type: `${command}`,
          },
        });
        const waitForWsConnected = (wss) => new Promise((resolve, reject) => {
          wss.on('connection', (ws) => {
            ws.send(message);
            resolve();
          });
          // eslint-disable-next-line no-param-reassign
          wss.onerror = (err) => {
            reject(err);
          };
        });
        const ip = '127.0.0.2';
        wsserver = new WebSocket.Server({ host: '127.0.0.2', port: 16_127 });
        lruRateLimitStub.returns(true);
        sinon.stub(FluxTTLCache.prototype, 'has').returns(false);
        const verifyFluxBroadcast = sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast').returns({ result: fluxCommunicationUtils.VerifyResult.OK, announcer: null });
        sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
        // the announcement is recorded on the event log (37376a976); the log's
        // answer is what gates the relay, and this one advances nothing
        const storeAppStateEventStub = sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: false });
        sinon.stub(messageStore, 'releaseInstallingClaims').resolves({ released: 0 });
        daemonServiceMiscRpcsStub.returns({
          data:
          {
            synced: false,
            height: 0,
          },
        });
        await fluxCommunication.initiateAndHandleConnection(ip);

        await waitForWsConnected(wsserver);
        await waitFor(() => storeAppStateEventStub.called);

        sinon.assert.calledOnceWithExactly(verifyFluxBroadcast, JSON.parse(message), undefined, sinon.match.number);
        sinon.assert.calledOnceWithExactly(
          storeAppStateEventStub,
          messageStore.APP_STATE_EVENT_TYPES.APPRUNNING,
          { signedBroadcast: JSON.parse(message), announcer: null },
        );
      });
    }
  });

  describe('addPeer tests', () => {
    const generateResponse = () => ({
      status: sinon.stub(),
      json: sinon.stub(),
    });

    beforeEach(() => {
      peerManager.reset();
      // A queued connection resolves this node's address first, which
      // unstubbed is a real RPC to the benchmark daemon.
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves('44.192.51.11:16127');
      // addPeer answers, then opens the socket from a setImmediate. It gates on
      // `has`, so marking peers pending leaves the response under test intact
      // while stopping the fixture IP from actually being dialled.
      sinon.stub(peerManager, 'isPending').returns(true);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return an error message if ip is undefined', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);

      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };

      const res = generateResponse();

      const expectedResult = {
        status: 'error',
        data: {
          code: undefined,
          message: 'Unparsable `ip` parameter',
          name: undefined,
        },
      };

      await fluxCommunication.addPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
    });

    it('should return an error message if ip is null', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);

      const req = {
        params: {
          ip: null,
        },
        query: {
          ip: null,
        },
      };

      const res = generateResponse();

      const expectedResult = {
        status: 'error',
        data: {
          code: undefined,
          message: 'Unparsable `ip` parameter',
          name: undefined,
        },
      };

      await fluxCommunication.addPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
    });

    it('should return error message if peer is already added', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);

      const ip = '123.4.1.1';
      const port = '16127';

      const req = {
        params: {
          ip,
          port,
        },
      };

      const expectedResult = {
        status: 'error',
        data: {
          code: undefined,
          message: `Already connected to ${ip}:${port}`,
          name: undefined,
        },
      };

      // Add the peer via peerManager so addPeer sees it as already connected
      const socket = await connectWs();
      socket.ip = ip;
      socket.port = port;
      socket.on = sinon.stub();
      peerManager.add(socket, ip, port, { source: PEER_SOURCE.RANDOM });

      const res = generateResponse();

      await fluxCommunication.addPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
    });

    it('should return error message if user is unauthorized', async () => {
      const ip = '123.4.1.1';
      const port = '16127';
      const req = {
        params: {
          ip,
          port,
        },
      };

      const res = generateResponse();

      const expectedMessage = {
        status: 'error',
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
      };

      sinon.stub(verificationHelper, 'verifyPrivilege').returns(false);

      await fluxCommunication.addPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedMessage);
    });

    it('should return success message if connection can be initiated', async () => {
      const ip = '123.4.1.1';
      const port = '16127';
      const req = {
        params: {
          ip,
          port,
        },
      };

      const res = generateResponse();

      const expectedMessage = {
        status: 'success',
        data: {
          code: undefined,
          message: 'Outgoing connection to 123.4.1.1:16127 initiated',
          name: undefined,
        },
      };

      const verificationStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);

      await fluxCommunication.addPeer(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedMessage);
      sinon.assert.calledOnceWithExactly(verificationStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });
  });

  describe('initializeDiscovery', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('gives the peer manager the fleet size from the network state', () => {
      sinon.stub(nodeConfirmationService, 'onConfirmationChange');
      sinon.stub(networkStateService, 'nodeCount').returns(1234);

      fluxCommunication.initializeDiscovery();

      expect(peerManager.numberOfFluxNodes).to.equal(1234);
    });
  });

  // Completion is counted per peer, so a completion that does not say which
  // peer it came from cannot be counted at all. These handlers have had the key
  // in scope all along - they log it, and publish it on sync:chunkVerified two
  // lines earlier - and this is what makes them hand it on.
  // A synced state event is recorded under its own broadcast time, and the order it
  // arrives in says nothing about when it was sent: a restart replays every
  // unexpired event, so a node's old sigterm routinely lands after its newer
  // apprunning. What it changes belongs to messageStore; the handler has to hand
  // over the event as it was sent for that to work.
  describe('a synced state event is applied by its own broadcast time', () => {
    const PEER_SOCKET = { key: '10.0.0.9:16127', connectionId: 7 };
    const SENDER = '203.0.113.7:16127';
    const envelope = { version: 1, timestamp: 1, pubKey: 'PUB', signature: 'SIG' };
    beforeEach(() => {
      sinon.stub(peerManager, 'isSyncResponseWanted').returns(true);
      sinon.stub(networkStateService, 'getFluxnodeBySocketAddress').resolves({ pubkey: 'PUB' });
      sinon.stub(verifyPool, 'verify').callsFake(async (items) => items.map(() => true));
      sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      sinon.stub(messageStore, 'storeIPChangedMessage').resolves(true);
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({ collection: () => ({}) }) });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('hands a sigterm to messageStore with the time it was sent', async () => {
      const broadcastedAt = Date.now() - 90 * 60 * 1000;
      const data = { type: 'fluxnodesigterm', ip: SENDER, broadcastedAt };

      await fluxCommunication.handleAppRunningSyncResponse({
        data: { type: 'fluxapprunningsync', messages: [{ type: 'sigterm', ip: SENDER, envelope, data }], done: true },
      }, PEER_SOCKET);

      sinon.assert.calledOnceWithExactly(messageStore.storeAppStateEvent, 'sigterm', { message: data, envelope });
    });

    it('hands an appremoved to messageStore with the app and the time it was sent', async () => {
      const broadcastedAt = Date.now() - 30 * 60 * 1000;
      const data = { type: 'fluxappremoved', version: 1, appName: 'app', ip: SENDER, broadcastedAt };

      await fluxCommunication.handleAppRunningSyncResponse({
        data: { type: 'fluxapprunningsync', messages: [{ type: 'appremoved', ip: SENDER, envelope, data }], done: true },
      }, PEER_SOCKET);

      sinon.assert.calledOnceWithExactly(messageStore.storeAppStateEvent, 'appremoved', { message: data, envelope });
    });

    it('records a synced move, as a move that arrives by gossip is', async () => {
      const NEW = '198.51.100.40:16127';
      const data = {
        type: 'fluxipchanged', version: 1, oldIP: SENDER, newIP: NEW, broadcastedAt: Date.now() - 60_000,
      };

      await fluxCommunication.handleAppRunningSyncResponse({
        data: { type: 'fluxapprunningsync', messages: [{ type: 'ipchanged', ip: SENDER, envelope, data }], done: true },
      }, PEER_SOCKET);

      sinon.assert.calledOnceWithExactly(messageStore.storeAppStateEvent, 'ipchanged', { message: data, envelope });
    });

    it('drops a synced move away from an address listed under another key, though the signer is listed at the new one', async () => {
      const NEW = '198.51.100.40:16127';
      networkStateService.getFluxnodeBySocketAddress.callsFake(async (address) => (address === NEW ? { pubkey: 'PUB' } : { pubkey: 'OTHER' }));
      const data = {
        type: 'fluxipchanged', version: 1, oldIP: SENDER, newIP: NEW, broadcastedAt: Date.now() - 60_000,
      };

      await fluxCommunication.handleAppRunningSyncResponse({
        data: { type: 'fluxapprunningsync', messages: [{ type: 'ipchanged', ip: SENDER, envelope, data }], done: true },
      }, PEER_SOCKET);

      sinon.assert.notCalled(messageStore.storeAppStateEvent);
      sinon.assert.notCalled(messageStore.storeIPChangedMessage);
    });

    it('hands an eviction to messageStore with the time it was made', async () => {
      const evictStub = sinon.stub(messageStore, 'applyEviction').resolves();
      const createdAt = new Date(Date.now() - 45 * 60 * 1000);

      await fluxCommunication.handleAppRunningSyncResponse({
        data: {
          type: 'fluxapprunningsync',
          messages: [{ type: 'evicted', ip: SENDER, dedupKey: 'evicted', createdAt: createdAt.toISOString() }],
          done: true,
        },
      }, PEER_SOCKET);

      sinon.assert.calledOnceWithExactly(evictStub, SENDER, createdAt.getTime());
    });

    it('hands an eviction without a time over as unreadable, for messageStore to take as now', async () => {
      const evictStub = sinon.stub(messageStore, 'applyEviction').resolves();

      await fluxCommunication.handleAppRunningSyncResponse({
        data: { type: 'fluxapprunningsync', messages: [{ type: 'evicted', ip: SENDER }], done: true },
      }, PEER_SOCKET);

      sinon.assert.calledOnce(evictStub);
      expect(evictStub.firstCall.args[0]).to.equal(SENDER);
      expect(Number.isNaN(evictStub.firstCall.args[1])).to.equal(true);
    });
  });

  describe('a sync response says which peer completed it, and whether it declined', () => {
    const PEER = '198.51.100.7:16127';
    // The handlers are given the SOCKET, because a response is an answer to a
    // request written into one connection - not to whatever holds that address
    // next. `wanted` stands in for the orchestrator's request record.
    const PEER_SOCKET = { key: PEER, connectionId: 41 };
    let wanted;
    let completions;
    let refusals;
    let progress;
    let handler;
    let refusedHandler;
    let progressHandler;

    beforeEach(() => {
      completions = [];
      refusals = [];
      progress = [];
      handler = (syncType, peerKey) => completions.push({ syncType, peerKey });
      refusedHandler = (syncType, peerKey) => refusals.push({ syncType, peerKey });
      progressHandler = (peerKey) => progress.push(peerKey);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, handler);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_REFUSED, refusedHandler);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_PROGRESS, progressHandler);
      wanted = (socket) => socket === PEER_SOCKET;
      sinon.stub(peerManager, 'isSyncResponseWanted').callsFake((socket) => wanted(socket));
      // The dispatcher verifies the envelope before it reaches a handler, and
      // these fixtures carry no signature. Stubbed so the chain under test is
      // arrival -> queue -> handler rather than the envelope check.
      sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
        .resolves(fluxCommunicationUtils.VerifyResult.OK);
      // An empty final batch is the whole path here: processInSlices does nothing.
      // (The location prune that used to need a store here is gone: messageStore no
      // longer maintains the materialized cache.)
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({ collection: () => ({}) }) });
    });

    afterEach(() => {
      appSyncEvents.removeListener(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, handler);
      appSyncEvents.removeListener(SYNC_EVENTS.EPHEMERAL_SYNC_REFUSED, refusedHandler);
      appSyncEvents.removeListener(SYNC_EVENTS.EPHEMERAL_SYNC_PROGRESS, progressHandler);
      sinon.restore();
    });

    // All four streams a request asks for. The peer is credited once every one
    // of them has ended, so each has to name the peer it came from and each has
    // to tell a refusal from an empty survey - the temp stream included, which
    // used to report neither and left the peer credited on three.
    const cases = [
      ['apprunning', 'fluxapprunningsync', 'handleAppRunningSyncResponse'],
      ['appinstalling', 'fluxappinstallingsync', 'handleAppInstallingSyncResponse'],
      ['apperrors', 'fluxappinstallingerrorssync', 'handleAppInstallingErrorsSyncResponse'],
      ['apptemp', 'fluxapptempsync', 'handleTempSyncResponse'],
    ];

    cases.forEach(([syncType, wireType, fn]) => {
      it(`names the peer on the ${syncType} completion`, async () => {
        await fluxCommunication[fn]({ data: { type: wireType, messages: [], done: true } }, PEER_SOCKET);

        expect(completions).to.deep.equal([{ syncType, peerKey: PEER }]);
      });

      it(`says nothing until the ${syncType} response is done`, async () => {
        await fluxCommunication[fn]({ data: { type: wireType, messages: [], done: false } }, PEER_SOCKET);

        expect(completions).to.deep.equal([]);
      });

      // Declining is an answer, and it is not a completion. Counting it was the
      // defect: three booting peers could tell a node the network was empty.
      it(`reports a declined ${syncType} response as a refusal, not a completion`, async () => {
        await fluxCommunication[fn]({ data: { type: wireType, messages: [], done: true, refused: true } }, PEER_SOCKET);

        expect(refusals).to.deep.equal([{ syncType, peerKey: PEER }]);
        expect(completions, 'a refusal was counted as a completed survey').to.deep.equal([]);
      });

      // A network with nothing running answers with an empty list, and that IS
      // a survey. If it read as a refusal such a fleet would never sync.
      it(`counts an empty ${syncType} response as a completion`, async () => {
        await fluxCommunication[fn]({ data: { type: wireType, messages: [], done: true } }, PEER_SOCKET);

        expect(completions).to.deep.equal([{ syncType, peerKey: PEER }]);
        expect(refusals).to.deep.equal([]);
      });

      // Progress is announced where a response ARRIVES, so a handler that has
      // not run yet - or is slow - cannot make a peer look silent. Asserted
      // through the dispatcher, because that is where arrival happens; calling
      // the handler directly skips the very step under test.
      it(`reports every ${syncType} arrival as progress, not only the last`, async () => {
        const dispatch = peerManager.syncResponseDispatcher;
        await dispatch({ data: { type: wireType, messages: [], done: false } }, PEER_SOCKET);
        await dispatch({ data: { type: wireType, messages: [], done: false } }, PEER_SOCKET);
        await dispatch({ data: { type: wireType, messages: [], done: true } }, PEER_SOCKET);

        expect(progress).to.deep.equal([PEER, PEER, PEER]);
        expect(completions, 'a mid-answer batch was counted as a completion').to.deep.equal([{ syncType, peerKey: PEER }]);
      });

      it(`reports no ${syncType} progress for a refusal`, async () => {
        const dispatch = peerManager.syncResponseDispatcher;
        await dispatch({ data: { type: wireType, messages: [], done: true, refused: true } }, PEER_SOCKET);

        expect(progress, 'a refusal kept its request alive as though it were working').to.deep.equal([]);
      });

      // THE DEADLINE EXISTS TO TAKE THE SLOT BACK. Credited on arrival alone,
      // unverifiable bytes renewed it: a peer sending rubbish inside every stall
      // window held one of the answers this node needs for the whole attempt
      // while never answering at all, and the deadline that would have offered
      // its slot to someone else could not fire.
      it(`credits no ${syncType} progress for a chunk that fails verification`, async () => {
        fluxCommunicationUtils.verifyFluxBroadcast
          .resolves(fluxCommunicationUtils.VerifyResult.MALFORMED);
        const dispatch = peerManager.syncResponseDispatcher;

        await dispatch({ data: { type: wireType, messages: [], done: false } }, PEER_SOCKET);

        expect(progress, 'unverifiable bytes renewed the deadline that reclaims the slot')
          .to.deep.equal([]);
        expect(completions, 'an unverifiable chunk was counted as an answer').to.deep.equal([]);
      });

      // ip:port names a node; the request was written into a connection. A peer
      // that dropped and dialled back in has not answered anything, and
      // crediting it would let a reconnect complete a survey it never made.
      it(`ignores a ${syncType} response arriving on a connection nobody asked`, async () => {
        const reconnected = { key: PEER, connectionId: PEER_SOCKET.connectionId + 1 };

        await fluxCommunication[fn]({ data: { type: wireType, messages: [], done: true } }, reconnected);

        expect(completions, 'an unasked connection completed a sync under an asked peer\'s name').to.deep.equal([]);
        expect(progress).to.deep.equal([]);
      });
    });

    // THE QUEUE IS THE ORDER. Chunks carry meaning by position - the sender
    // sorts by timestamp and an eviction carries none, so evictions arrive in
    // the FIRST chunk and clear a node's locations outright, and `done` means
    // "nothing after this". A chunk taking its place in the queue only once its
    // envelope check came back put the order in the hands of whichever check
    // finished first.
    // A response whose writes failed is not all recorded here: the peer has not
    // answered, so another is asked. Credited, the node goes authoritative on a
    // partial view and serves it to its own peers as complete.
    describe('a response whose writes failed', () => {
      const broadcast = () => ({
        version: 1, timestamp: Date.now(), pubKey: '04key', signature: 'sig',
        data: { ip: '1.2.3.4:16127', name: 'a', broadcastedAt: Date.now() },
      });

      beforeEach(() => {
        sinon.stub(fluxCommunicationUtils, 'verifyBroadcasts')
          .callsFake(async (items) => items.map(() => ({ result: fluxCommunicationUtils.VerifyResult.OK })));
      });

      it('is not counted as a completed appinstalling survey', async () => {
        sinon.stub(messageStore, 'storeBatchAppInstallingMessages').resolves({ stored: 1, writeFailed: true });

        await fluxCommunication.handleAppInstallingSyncResponse({ data: { type: 'fluxappinstallingsync', messages: [broadcast()], done: true } }, PEER_SOCKET);

        expect(messageStore.storeBatchAppInstallingMessages.called, 'the fixture never reached the store').to.be.true;
        expect(completions).to.deep.equal([]);
      });

      it('is not counted as a completed apperrors survey', async () => {
        sinon.stub(messageStore, 'storeBatchAppInstallingErrorMessages').resolves({ stored: 1, writeFailed: true });

        await fluxCommunication.handleAppInstallingErrorsSyncResponse({ data: { type: 'fluxappinstallingerrorssync', messages: [broadcast()], done: true } }, PEER_SOCKET);

        expect(messageStore.storeBatchAppInstallingErrorMessages.called, 'the fixture never reached the store').to.be.true;
        expect(completions).to.deep.equal([]);
      });

      it('is not counted as a completed apprunning survey', async () => {
        sinon.stub(messageStore, 'storeBatchAppRunningEvents').resolves({ stored: 1, writeFailed: true });
        const event = {
          type: 'apprunning',
          envelope: { version: 1, timestamp: Date.now(), pubKey: '04key', signature: 'sig' },
          data: { version: 2, ip: '1.2.3.4:16127', broadcastedAt: Date.now(), apps: [{ name: 'a' }] },
        };

        await fluxCommunication.handleAppRunningSyncResponse({ data: { type: 'fluxapprunningsync', messages: [event], done: true } }, PEER_SOCKET);

        expect(messageStore.storeBatchAppRunningEvents.called, 'the fixture never reached the store').to.be.true;
        expect(completions).to.deep.equal([]);
      });

      it('a canary: the same response written in full is counted', async () => {
        sinon.stub(messageStore, 'storeBatchAppInstallingMessages').resolves({ stored: 1, writeFailed: false });

        await fluxCommunication.handleAppInstallingSyncResponse({ data: { type: 'fluxappinstallingsync', messages: [broadcast()], done: true } }, PEER_SOCKET);

        expect(completions).to.deep.equal([{ syncType: 'appinstalling', peerKey: PEER }]);
      });

      // An answer comes as several messages and only the last says done, so the
      // request ends at the message whose writes failed, wherever it falls.
      describe('ends the peer\'s request at a message before its last', () => {
        let writeFailures;
        const onWriteFailed = (peerKey) => writeFailures.push(peerKey);
        const running = () => ({
          type: 'apprunning',
          envelope: { version: 1, timestamp: Date.now(), pubKey: '04key', signature: 'sig' },
          data: { version: 2, ip: '1.2.3.4:16127', broadcastedAt: Date.now(), apps: [{ name: 'a' }] },
        });

        beforeEach(() => {
          writeFailures = [];
          appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_WRITE_FAILED, onWriteFailed);
        });

        afterEach(() => {
          appSyncEvents.removeListener(SYNC_EVENTS.EPHEMERAL_SYNC_WRITE_FAILED, onWriteFailed);
        });

        [
          ['appinstalling', 'storeBatchAppInstallingMessages', 'handleAppInstallingSyncResponse', 'fluxappinstallingsync', broadcast],
          ['apperrors', 'storeBatchAppInstallingErrorMessages', 'handleAppInstallingErrorsSyncResponse', 'fluxappinstallingerrorssync', broadcast],
          ['apprunning', 'storeBatchAppRunningEvents', 'handleAppRunningSyncResponse', 'fluxapprunningsync', running],
        ].forEach(([syncType, store, handler, type, event]) => {
          it(`for ${syncType}`, async () => {
            sinon.stub(messageStore, store).resolves({ stored: 1, writeFailed: true });

            await fluxCommunication[handler]({ data: { type, messages: [event()], done: false } }, PEER_SOCKET);

            expect(messageStore[store].called, 'the fixture never reached the store').to.be.true;
            expect(writeFailures).to.deep.equal([PEER]);
          });

          it(`a canary: a ${syncType} message written in full ends nothing`, async () => {
            sinon.stub(messageStore, store).resolves({ stored: 1, writeFailed: false });

            await fluxCommunication[handler]({ data: { type, messages: [event()], done: false } }, PEER_SOCKET);

            expect(messageStore[store].called, 'the fixture never reached the store').to.be.true;
            expect(writeFailures).to.deep.equal([]);
          });
        });
      });
    });

    // A call that throws part way through a message loses the rest of it, so the
    // answer is not all recorded: the peer's request ends and another is asked,
    // and the done that follows is not counted.
    describe('a response whose calls threw', () => {
      let writeFailures;
      let verdict;
      const onWriteFailed = (peerKey) => writeFailures.push(peerKey);
      const envelope = () => ({ version: 1, timestamp: Date.now(), pubKey: '04key', signature: 'sig' });
      const broadcast = () => ({ ...envelope(), data: { ip: '1.2.3.4:16127', name: 'a', broadcastedAt: Date.now() } });
      const running = () => ({
        type: 'apprunning', envelope: envelope(), data: { version: 2, ip: '1.2.3.4:16127', broadcastedAt: Date.now(), apps: [{ name: 'a' }] },
      });
      const sigterm = () => ({ type: 'sigterm', envelope: envelope(), data: { ip: '1.2.3.4:16127', broadcastedAt: Date.now() } });
      const respond = (handler, type, messages, done) => fluxCommunication[handler]({ data: { type, messages, done } }, PEER_SOCKET);

      beforeEach(() => {
        writeFailures = [];
        verdict = fluxCommunicationUtils.VerifyResult.OK;
        appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_WRITE_FAILED, onWriteFailed);
        sinon.stub(fluxCommunicationUtils, 'verifyBroadcasts').callsFake(async (items) => items.map(() => ({ result: verdict })));
        sinon.stub(messageStore, 'storeBatchAppRunningEvents').resolves({ stored: 1, writeFailed: false });
        sinon.stub(messageStore, 'storeBatchAppInstallingMessages').resolves({ stored: 1, writeFailed: false });
        sinon.stub(messageStore, 'storeBatchAppInstallingErrorMessages').resolves({ stored: 1, writeFailed: false });
        sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      });

      afterEach(() => {
        appSyncEvents.removeListener(SYNC_EVENTS.EPHEMERAL_SYNC_WRITE_FAILED, onWriteFailed);
      });

      [
        ['appinstalling', 'handleAppInstallingSyncResponse', 'fluxappinstallingsync', broadcast],
        ['apperrors', 'handleAppInstallingErrorsSyncResponse', 'fluxappinstallingerrorssync', broadcast],
        ['apprunning', 'handleAppRunningSyncResponse', 'fluxapprunningsync', running],
      ].forEach(([syncType, handler, type, event]) => {
        it(`ends the ${syncType} request when a broadcast it sent cannot be verified for want of the database`, async () => {
          verdict = fluxCommunicationUtils.VerifyResult.UNREADABLE;

          await respond(handler, type, [event()], true);

          expect(writeFailures, 'a response the node could not verify left the request open').to.deep.equal([PEER]);
          expect(completions, 'a response the node could not verify was counted').to.deep.equal([]);
        });

        it(`a canary: the same ${syncType} response verified and stored is counted`, async () => {
          await respond(handler, type, [event()], true);

          expect(writeFailures).to.deep.equal([]);
          expect(completions).to.deep.equal([{ syncType, peerKey: PEER }]);
        });
      });

      it('ends the appinstalling request when its store throws', async () => {
        messageStore.storeBatchAppInstallingMessages.rejects(new Error('operation exceeded time limit'));

        await respond('handleAppInstallingSyncResponse', 'fluxappinstallingsync', [broadcast()], true);

        expect(writeFailures).to.deep.equal([PEER]);
        expect(completions).to.deep.equal([]);
      });

      it('ends the apprunning request when storing a state event throws', async () => {
        messageStore.storeAppStateEvent.rejects(new Error('operation exceeded time limit'));

        await respond('handleAppRunningSyncResponse', 'fluxapprunningsync', [running(), sigterm()], true);

        expect(messageStore.storeAppStateEvent.called, 'the fixture never reached the state event').to.be.true;
        expect(writeFailures).to.deep.equal([PEER]);
        expect(completions).to.deep.equal([]);
      });

      it('a canary: the same apprunning response with its state event stored is counted', async () => {
        await respond('handleAppRunningSyncResponse', 'fluxapprunningsync', [running(), sigterm()], true);

        expect(messageStore.storeAppStateEvent.called, 'the fixture never reached the state event').to.be.true;
        expect(writeFailures).to.deep.equal([]);
        expect(completions).to.deep.equal([{ syncType: 'apprunning', peerKey: PEER }]);
      });

      describe('a pending registration', () => {
        const temp = () => ({
          type: 'fluxappregister', version: 1, signature: 'sig', timestamp: Date.now(), hash: 'h1', appSpecifications: { name: 'a' },
        });

        it('this node\'s database could not store ends the apptemp request', async () => {
          sinon.stub(messageStore, 'storeAppTemporaryMessage').rejects(new MongoNetworkTimeoutError('connection timed out'));

          await respond('handleTempSyncResponse', 'fluxapptempsync', [temp(), temp()], true);

          expect(writeFailures, 'a response the node could not store left the request open').to.deep.equal([PEER]);
          expect(completions, 'a response the node could not store was counted').to.deep.equal([]);
          sinon.assert.calledOnce(messageStore.storeAppTemporaryMessage);
        });

        it('that fails its own checks is skipped, and the rest of the answer counted', async () => {
          sinon.stub(messageStore, 'storeAppTemporaryMessage')
            .onFirstCall().rejects(new Error('Invalid Flux App specifications'))
            .onSecondCall().resolves(true);

          await respond('handleTempSyncResponse', 'fluxapptempsync', [temp(), temp()], true);

          expect(writeFailures, 'a message the peer got wrong ended the request').to.deep.equal([]);
          expect(completions).to.deep.equal([{ syncType: 'apptemp', peerKey: PEER }]);
          sinon.assert.calledTwice(messageStore.storeAppTemporaryMessage);
        });
      });

      // The request this answer belonged to ended while it was being stored - the
      // peer reconnected and was asked again - so a failure here ends nothing.
      it('ends nothing when the request it answered has already ended', async () => {
        messageStore.storeBatchAppInstallingMessages.callsFake(async () => {
          wanted = () => false;
          throw new Error('operation exceeded time limit');
        });

        await respond('handleAppInstallingSyncResponse', 'fluxappinstallingsync', [broadcast()], true);

        expect(messageStore.storeBatchAppInstallingMessages.called, 'the fixture never reached the store').to.be.true;
        expect(writeFailures, 'a failure ended a request it did not belong to').to.deep.equal([]);
      });
    });

    describe('a chunk takes its place in the queue when it arrives', () => {
      const chunkFor = (marker) => ({
        data: { type: 'fluxapprunningsync', messages: [{ marker }], done: false },
      });

      let processed;

      beforeEach(() => {
        processed = [];
        sinon.stub(serviceHelper, 'processInSlices').callsFake(async (messages) => {
          processed.push(messages[0].marker);
        });
      });

      it('processes chunks in arrival order when a later check finishes first', async () => {
        const dispatch = peerManager.syncResponseDispatcher;
        let admitFirst;
        fluxCommunicationUtils.verifyFluxBroadcast
          .onFirstCall().returns(new Promise((resolve) => { admitFirst = resolve; }));

        const first = dispatch(chunkFor('a'), PEER_SOCKET);
        await dispatch(chunkFor('b'), PEER_SOCKET);

        expect(processed, 'a chunk was processed while an earlier one was still being checked')
          .to.deep.equal([]);

        admitFirst(fluxCommunicationUtils.VerifyResult.OK);
        await first;

        expect(processed, 'the second chunk overtook the first because its check finished first')
          .to.deep.equal(['a', 'b']);
      });

      // A HOLE IS NOT A SURVEY. Stepping over the chunk left the node counting a
      // peer as having surveyed the network out of an answer it knows part of is
      // missing - and it cannot say which part, because the chunk it could not
      // attribute is the one it cannot read.
      it('ends the request on a chunk it cannot verify, and processes no more of the stream', async () => {
        const dispatch = peerManager.syncResponseDispatcher;
        const unverified = [];
        const onUnverified = (peerKey) => unverified.push(peerKey);
        appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, onUnverified);
        let admitFirst;
        fluxCommunicationUtils.verifyFluxBroadcast
          .onFirstCall().returns(new Promise((resolve) => { admitFirst = resolve; }));
        fluxCommunicationUtils.verifyFluxBroadcast
          .onSecondCall().resolves(fluxCommunicationUtils.VerifyResult.BAD_SIGNATURE);

        try {
          const first = dispatch(chunkFor('a'), PEER_SOCKET);
          await dispatch(chunkFor('b'), PEER_SOCKET);
          admitFirst(fluxCommunicationUtils.VerifyResult.OK);
          await first;
        } finally {
          appSyncEvents.removeListener(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, onUnverified);
        }

        expect(processed, 'the stream carried on past a chunk that could not be verified')
          .to.deep.equal(['a']);
        expect(unverified, 'a stream with a hole in it did not end the request').to.deep.equal([PEER]);
      });

      // A drain serves ONE connection. A backlog left behind by a connection
      // that has since been replaced still runs, and a failure in it says
      // nothing about the peer that dialled back in - which by then holds a
      // request of its own, or none at all.
      it('reports no failure for a connection it is no longer serving', async () => {
        const dispatch = peerManager.syncResponseDispatcher;
        const reconnected = { key: PEER, connectionId: PEER_SOCKET.connectionId + 1 };
        const unverified = [];
        const onUnverified = (peerKey) => unverified.push(peerKey);
        appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, onUnverified);
        let admitFirst;
        fluxCommunicationUtils.verifyFluxBroadcast
          .onFirstCall().returns(new Promise((resolve) => { admitFirst = resolve; }));
        fluxCommunicationUtils.verifyFluxBroadcast
          .onSecondCall().resolves(fluxCommunicationUtils.VerifyResult.BAD_SIGNATURE);

        try {
          const stale = dispatch(chunkFor('a'), PEER_SOCKET);
          await dispatch(chunkFor('bad'), PEER_SOCKET);
          wanted = (socket) => socket === reconnected;
          admitFirst(fluxCommunicationUtils.VerifyResult.OK);
          await stale;
        } finally {
          appSyncEvents.removeListener(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, onUnverified);
        }

        expect(unverified, 'a dead connection\'s bad chunk was reported against the peer at that address')
          .to.deep.equal([]);
      });

      it('credits no progress and ends the request when the first chunk cannot be verified', async () => {
        const dispatch = peerManager.syncResponseDispatcher;
        const unverified = [];
        const onUnverified = (peerKey) => unverified.push(peerKey);
        appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, onUnverified);
        fluxCommunicationUtils.verifyFluxBroadcast
          .resolves(fluxCommunicationUtils.VerifyResult.MALFORMED);

        try {
          await dispatch(chunkFor('a'), PEER_SOCKET);
        } finally {
          appSyncEvents.removeListener(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, onUnverified);
        }

        expect(processed).to.deep.equal([]);
        expect(progress, 'unverifiable bytes renewed the deadline that reclaims the slot').to.deep.equal([]);
        expect(unverified).to.deep.equal([PEER]);
      });
    });

    // THE DEADLINE IS A STATEMENT ABOUT THE PEER, and processing time is a
    // statement about us. Everything one peer sends goes through a single
    // queue, one chunk at a time, and the temp-message stream re-verifies every
    // pending registration it is given. A peer that answered all four requests
    // at once went unheard for as long as WE took on the first of them, was
    // recorded as having said nothing, and had the answers already queued
    // behind it thrown away with the record.
    //
    // Driven per stream because the first slow step is a different call in
    // each: the three surveys hand a batch to processInSlices, the temp stream
    // stores one message at a time. The boundary is the same either way -
    // whether the peer SIGNED this is about the peer and is settled at arrival,
    // storing what it sent is about us - and anything below it is on our clock.
    const arrivalCases = [
      ['apprunning', 'fluxapprunningsync', [], () => [serviceHelper, 'processInSlices']],
      ['appinstalling', 'fluxappinstallingsync', [], () => [serviceHelper, 'processInSlices']],
      ['apperrors', 'fluxappinstallingerrorssync', [], () => [serviceHelper, 'processInSlices']],
      ['apptemp', 'fluxapptempsync', [{ hash: 'abc' }], () => [messageStore, 'storeAppTemporaryMessage']],
    ];

    arrivalCases.forEach(([syncType, wireType, messages, slowStep]) => {
      it(`announces a ${syncType} arrival before anything processes it`, async () => {
        const dispatch = peerManager.syncResponseDispatcher;
        let progressAtWork = null;
        const [owner, method] = slowStep();
        sinon.stub(owner, method).callsFake(async () => {
          progressAtWork = [...progress];
          return true;
        });

        await dispatch({ data: { type: wireType, messages, done: false } }, PEER_SOCKET);

        expect(progressAtWork, 'the peer was still silent when its own answer was already in hand')
          .to.deep.equal([PEER]);
      });
    });
  });
  describe('sync chunk where every broadcast fails node lookup', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('still completes the sync round', async () => {
      // A peer sending events for nodes this node does not have in its list yet
      // - normal while the network view is still loading - leaves nothing to
      // verify. That path used to hand callers a bare array instead of the
      // { verified, announcers } pair, so reading `verified.length` threw, the
      // handler's catch swallowed it, and everything below was skipped:
      // the state events went unstored and the round was never marked done.
      // The handlers gate on isSyncResponseWanted(socket), not on the ephemeral
      // isSyncRequested(key) this test was written against - see the REBASE-ADAPTER
      // note in serviceManager, which is the only place the two are bridged.
      sinon.stub(peerManager, 'isSyncResponseWanted').returns(true);
      sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
        .resolves({ result: fluxCommunicationUtils.VerifyResult.OK });
      // no node is listed at any address the chunk names
      sinon.stub(networkStateService, 'getFluxnodeBySocketAddress').resolves(null);

      const peerKey = '10.20.30.40:16127';
      const msgObj = {
        data: {
          type: 'fluxapprunningsync',
          done: true,
          messages: [{
            type: 'apprunning',
            envelope: {
              version: 1, pubKey: 'unknownnodepubkey', timestamp: 1_700_000_000_000, signature: 'sig',
            },
            data: { type: 'fluxapprunning', name: 'someapp', ip: '1.2.3.4' },
          }],
        },
      };

      const completed = [];
      const onComplete = (...args) => completed.push(args);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, onComplete);
      try {
        // The handler directly, as the block above does: syncResponseDispatcher is
        // null until the peer manager is wired at boot, so driving through it here
        // would test nothing at all.
        await fluxCommunication.handleAppRunningSyncResponse(msgObj, { key: peerKey });
      } finally {
        appSyncEvents.off(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, onComplete);
      }

      expect(completed).to.deep.equal([['apprunning', peerKey]]);
    });
  });

  describe('a sync response is admitted on the verdict of its envelope check', () => {
    afterEach(() => {
      sinon.restore();
    });

    function recordSyncEvents() {
      const seen = { progress: [], unverified: [], completed: [] };
      const onProgress = (key) => seen.progress.push(key);
      const onUnverified = (key) => seen.unverified.push(key);
      const onComplete = (...args) => seen.completed.push(args);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_PROGRESS, onProgress);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, onUnverified);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, onComplete);
      const stop = () => {
        appSyncEvents.off(SYNC_EVENTS.EPHEMERAL_SYNC_PROGRESS, onProgress);
        appSyncEvents.off(SYNC_EVENTS.EPHEMERAL_SYNC_UNVERIFIED, onUnverified);
        appSyncEvents.off(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, onComplete);
      };
      return { seen, stop };
    }

    // Nobody asked for it: no request to this connection is open, so it is dropped
    // before it is queued, and the drop is said rather than silent.
    it('drops a response nobody asked for, and says so', async () => {
      sinon.stub(peerManager, 'isSyncResponseWanted').returns(false);
      const verify = sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast');
      const warn = sinon.stub(log, 'warn');
      const chunk = { data: { type: 'fluxapprunningsync', done: true, messages: [] } };
      const { seen, stop } = recordSyncEvents();
      try {
        await fluxCommunication.dispatchSyncResponse(chunk, { key: '10.20.30.43:16127', direction: 'inbound' });
      } finally {
        stop();
      }
      sinon.assert.notCalled(verify);
      expect(seen.progress, 'an unasked answer counted as progress').to.deep.equal([]);
      sinon.assert.calledWithMatch(warn, /Unsolicited fluxapprunningsync from inbound peer 10\.20\.30\.43:16127/);
    });

    it('a chunk whose envelope verifies is progress, and its stream is handled', async () => {
      sinon.stub(peerManager, 'isSyncResponseWanted').returns(true);
      sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
        .resolves({ result: fluxCommunicationUtils.VerifyResult.OK, announcer: null });
      const peerKey = '10.20.30.42:16127';
      const chunk = { data: { type: 'fluxapptempsync', done: true, messages: [] } };
      const { seen, stop } = recordSyncEvents();
      try {
        await fluxCommunication.dispatchSyncResponse(chunk, { key: peerKey });
      } finally {
        stop();
      }
      expect(seen.progress).to.deep.equal([peerKey]);
      expect(seen.unverified).to.deep.equal([]);
      expect(seen.completed).to.deep.equal([['apptemp', peerKey]]);
    });

    it('a chunk whose envelope does not verify ends the request, and its stream is not handled', async () => {
      sinon.stub(peerManager, 'isSyncResponseWanted').returns(true);
      sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
        .resolves({ result: fluxCommunicationUtils.VerifyResult.BAD_SIGNATURE, announcer: null });
      const peerKey = '10.20.30.43:16127';
      const chunk = { data: { type: 'fluxapptempsync', done: true, messages: [] } };
      const { seen, stop } = recordSyncEvents();
      try {
        await fluxCommunication.dispatchSyncResponse(chunk, { key: peerKey });
      } finally {
        stop();
      }
      expect(seen.progress).to.deep.equal([]);
      expect(seen.unverified).to.deep.equal([peerKey]);
      expect(seen.completed).to.deep.equal([]);
    });
  });

  describe('recordOwnAddressMove tests', () => {
    const OLD = '72.89.45.236:16137';
    const NEW = '108.6.236.4:16137';
    let storeEvent;
    let storeMove;

    beforeEach(() => {
      storeEvent = sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      storeMove = sinon.stub(messageStore, 'storeIPChangedMessage').resolves(true);
    });
    afterEach(() => {
      sinon.restore();
    });

    it('stores its own move as the signed ipchanged event its peers store, and carries its rows to the new address', async () => {
      sinon.stub(fluxCommunicationMessagesSender, 'serialiseAndSignFluxBroadcast').callsFake(async (data) => JSON.stringify({
        version: 1, timestamp: 1_791_698_455_000, pubKey: '04own', signature: 'sig', data,
      }));

      await fluxCommunication.recordOwnAddressMove(OLD, NEW, 1_791_698_450_000);

      sinon.assert.calledOnce(storeEvent);
      const [type, { message, envelope }] = storeEvent.firstCall.args;
      expect(type).to.equal(messageStore.APP_STATE_EVENT_TYPES.IPCHANGED);
      expect(message).to.deep.equal({
        type: 'fluxipchanged', version: 1, oldIP: OLD, newIP: NEW, broadcastedAt: 1_791_698_450_000,
      });
      expect(envelope).to.deep.equal({
        version: 1, timestamp: 1_791_698_455_000, pubKey: '04own', signature: 'sig',
      });
      sinon.assert.calledOnceWithExactly(storeMove, message);
    });

    describe('handleOwnAddressMove', () => {
      const AT = 1_791_698_450_000;
      let drop;

      beforeEach(() => {
        sinon.stub(fluxCommunicationMessagesSender, 'serialiseAndSignFluxBroadcast').callsFake(async (data) => JSON.stringify({
          version: 1, timestamp: AT, pubKey: '04own', signature: 'sig', data,
        }));
        drop = sinon.stub(peerManager, 'dropAllConnections').returns(0);
      });

      afterEach(() => {
        peerManager.listeners('peerConnected').forEach((listener) => {
          if (listener.name === 'sendOwnMovesTo') peerManager.off('peerConnected', listener);
        });
        fluxCommunication.noteOwnMoveHeardBack(objectHash({
          type: 'fluxipchanged', version: 1, oldIP: OLD, newIP: NEW, broadcastedAt: AT,
        }));
      });

      it('records and announces a move it has not recorded', async () => {
        sinon.stub(registryManager, 'addressMovesFrom').resolves(new Map());

        await fluxCommunication.handleOwnAddressMove(OLD, NEW, AT);

        sinon.assert.calledOnce(storeEvent);
        sinon.assert.calledOnce(drop);
      });

      it('leaves a move it has already recorded at that time as it is: no second record, no connections dropped again', async () => {
        sinon.stub(registryManager, 'addressMovesFrom').resolves(new Map([[OLD, { to: NEW, at: AT, signer: '04own' }]]));

        await fluxCommunication.handleOwnAddressMove(OLD, NEW, AT);

        sinon.assert.notCalled(storeEvent);
        sinon.assert.notCalled(storeMove);
        sinon.assert.notCalled(drop);
      });
    });

    it('records nothing when this node cannot sign as itself', async () => {
      sinon.stub(fluxCommunicationMessagesSender, 'serialiseAndSignFluxBroadcast').resolves(null);

      await fluxCommunication.recordOwnAddressMove(OLD, NEW, Date.now());

      sinon.assert.notCalled(storeEvent);
      sinon.assert.notCalled(storeMove);
    });
  });

  describe('handleIPChangedMessage tests', () => {
    const message = {
      version: 1,
      timestamp: Date.now(),
      pubKey: '04peer',
      signature: 'sig',
      data: {
        type: 'fluxipchanged', version: 1, oldIP: '72.89.45.236:16137', newIP: '108.6.236.4:16137', broadcastedAt: Date.now(),
      },
    };
    let relayed;

    beforeEach(() => {
      sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
      relayed = sinon.stub(peerManager, 'broadcastHash');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('passes on a move it applied', async () => {
      sinon.stub(messageStore, 'storeIPChangedMessage').resolves(true);

      await fluxCommunication.handleIPChangedMessage(message, '10.0.0.9', '16127');

      sinon.assert.calledOnce(relayed);
    });

    it('does not pass on a move it refused', async () => {
      sinon.stub(messageStore, 'storeIPChangedMessage').resolves(new Error('Invalid Flux IP Changed message for storing version 2 not supported'));

      await fluxCommunication.handleIPChangedMessage(message, '10.0.0.9', '16127');

      sinon.assert.notCalled(relayed);
    });
  });

  describe('handleAppRemovedMessage tests', () => {
    const message = {
      version: 1,
      timestamp: Date.now(),
      pubKey: '04peer',
      signature: 'sig',
      data: {
        type: 'fluxappremoved', version: 1, appName: 'someapp', ip: '72.89.45.236:16137', broadcastedAt: Date.now(),
      },
    };
    let relayed;

    beforeEach(() => {
      sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
      relayed = sinon.stub(peerManager, 'broadcastHash');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('passes on a removal it applied', async () => {
      sinon.stub(messageStore, 'storeAppRemovedMessage').resolves(true);

      await fluxCommunication.handleAppRemovedMessage(message, '10.0.0.9', '16127');

      sinon.assert.calledOnce(relayed);
    });

    it('does not pass on a removal it refused', async () => {
      sinon.stub(messageStore, 'storeAppRemovedMessage').resolves(new Error('Invalid Flux App Removed message appName cannot be empty'));

      await fluxCommunication.handleAppRemovedMessage(message, '10.0.0.9', '16127');

      sinon.assert.notCalled(relayed);
    });
  });

  describe('announcing this node\'s own move', () => {
    const OLD = '72.89.45.236:16137';
    const NEW = '108.6.236.4:16137';
    let drop;
    let peers;
    let clock;

    // A peer that has just connected, and what it was sent.
    const connect = async (key) => {
      peers[key] = { send: sinon.stub().returns(true) };
      peerManager.emit('peerConnected', key, 1);
      await new Promise((resolve) => { setImmediate(resolve); });
      await new Promise((resolve) => { setImmediate(resolve); });
      return peers[key].send.getCalls().map((call) => JSON.parse(call.args[0]).data)
        .filter((data) => data.type === 'fluxipchanged')
        .map(({ oldIP: oldIp, newIP: newIp }) => `${oldIp}>${newIp}`);
    };
    const sentData = (key) => JSON.parse(peers[key].send.firstCall.args[0]).data;

    beforeEach(() => {
      peers = {};
      clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
      sinon.stub(fluxCommunicationMessagesSender, 'serialiseAndSignFluxBroadcast').callsFake(async (data) => JSON.stringify({
        version: 1, timestamp: Date.now(), pubKey: '04own', signature: 'sig', data,
      }));
      drop = sinon.stub(peerManager, 'dropAllConnections').returns(0);
      sinon.stub(peerManager, 'get').callsFake((key) => peers[key]);
      sinon.stub(registryManager, 'addressMovesTo').resolves(new Map());
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').resolves(NEW);
      sinon.stub(fluxNetworkHelper, 'getFluxNodePublicKey').resolves('04own');
    });

    afterEach(() => {
      // a move left pending by a test would go on listening into the next one
      peerManager.listeners('peerConnected').forEach((listener) => {
        if (listener.name === 'sendOwnMovesTo') peerManager.off('peerConnected', listener);
      });
      sinon.restore();
    });

    const heardBack = (key) => fluxCommunication.noteOwnMoveHeardBack(objectHash(sentData(key)));

    it('drops every connection at once and sends the move to each peer as it connects', async () => {
      fluxCommunication.announceOwnAddressMove(OLD, NEW, Date.now());

      sinon.assert.calledOnce(drop);
      expect(await connect('10.0.0.1:16127')).to.deep.equal([`${OLD}>${NEW}`]);
      expect(await connect('10.0.0.2:16127')).to.deep.equal([`${OLD}>${NEW}`]);
      heardBack('10.0.0.1:16127');
    });

    it('stops once a peer announces the move back', async () => {
      fluxCommunication.announceOwnAddressMove(OLD, NEW, Date.now());
      await connect('10.0.0.1:16127');

      expect(heardBack('10.0.0.1:16127')).to.equal(true);

      expect(await connect('10.0.0.2:16127')).to.deep.equal([]);
    });

    it('stops once a peer relays the move itself back', async () => {
      sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      sinon.stub(messageStore, 'storeIPChangedMessage').resolves(true);
      sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(false);
      fluxCommunication.announceOwnAddressMove(OLD, NEW, Date.now());
      await connect('10.0.0.1:16127');

      await fluxCommunication.handleIPChangedMessage({
        version: 1, timestamp: Date.now(), pubKey: '04own', signature: 'sig', data: sentData('10.0.0.1:16127'),
      }, '10.0.0.9', '16127');

      expect(await connect('10.0.0.2:16127')).to.deep.equal([]);
    });

    it('stops once a peer announces the move\'s hash, the way gossip relays it', async () => {
      sinon.stub(peerManager, 'sendHashRequest');
      fluxCommunication.announceOwnAddressMove(OLD, NEW, Date.now());
      await connect('10.0.0.1:16127');
      const relayer = {
        ip: '10.0.0.9', port: '16127', key: '10.0.0.9:16127', direction: 'outgoing', msgMap: new Map([['newHash', 0]]), close: () => {},
      };

      await peerManager.messageDispatcher({ messageHashPresent: objectHash(sentData('10.0.0.1:16127')) }, relayer);
      await new Promise((resolve) => { setImmediate(resolve); });

      expect(await connect('10.0.0.2:16127')).to.deep.equal([]);
    });

    it('signs the move afresh once half the relay window has passed, keeping the time it was made', async () => {
      fluxCommunication.announceOwnAddressMove(OLD, NEW, Date.now());
      await connect('10.0.0.1:16127');
      clock.tick(121 * 1000);
      await connect('10.0.0.2:16127');

      const envelope = (key) => JSON.parse(peers[key].send.firstCall.args[0]);
      expect(envelope('10.0.0.2:16127').timestamp).to.be.above(envelope('10.0.0.1:16127').timestamp);
      expect(sentData('10.0.0.2:16127')).to.deep.equal(sentData('10.0.0.1:16127'));
      expect(heardBack('10.0.0.2:16127')).to.equal(true);
      expect(await connect('10.0.0.3:16127')).to.deep.equal([]);
    });

    it('stops sending a move once it is too old to be applied', async () => {
      fluxCommunication.announceOwnAddressMove(OLD, NEW, Date.now());
      expect(await connect('10.0.0.1:16127')).to.deep.equal([`${OLD}>${NEW}`]);
      clock.tick(messageStore.IP_CHANGED_VALIDITY_MS);

      expect(await connect('10.0.0.2:16127')).to.deep.equal([]);
      expect(peerManager.listeners('peerConnected').some((listener) => listener.name === 'sendOwnMovesTo')).to.equal(false);
    });

    it('sends each of two moves, and stops each on its own echo', async () => {
      fluxCommunication.announceOwnAddressMove('10.0.0.1:16127', '10.0.0.2:16127', Date.now());
      fluxCommunication.announceOwnAddressMove('10.0.0.2:16127', '10.0.0.3:16127', Date.now());

      expect(await connect('10.9.0.1:16127')).to.deep.equal(['10.0.0.1:16127>10.0.0.2:16127', '10.0.0.2:16127>10.0.0.3:16127']);
      fluxCommunication.noteOwnMoveHeardBack(objectHash(JSON.parse(peers['10.9.0.1:16127'].send.firstCall.args[0]).data));

      expect(await connect('10.9.0.2:16127')).to.deep.equal(['10.0.0.2:16127>10.0.0.3:16127']);
      fluxCommunication.noteOwnMoveHeardBack(objectHash(JSON.parse(peers['10.9.0.2:16127'].send.firstCall.args[0]).data));
    });

    it('sends a port-only move like any other', async () => {
      fluxCommunication.announceOwnAddressMove('198.51.100.40:16127', '198.51.100.40:16157', Date.now());

      expect(await connect('10.0.0.1:16127')).to.deep.equal(['198.51.100.40:16127>198.51.100.40:16157']);
      heardBack('10.0.0.1:16127');
    });

    it('at startup, sends the moves it signed to the address it holds now, as they were made, and no others', async () => {
      const at = Date.now() - 60_000;
      registryManager.addressMovesTo.withArgs(NEW).resolves(new Map([
        [OLD, { to: NEW, at, signer: '04own' }],
        ['72.89.45.237:16137', { to: NEW, at: at - 1000, signer: '04previous' }],
      ]));

      fluxCommunication.announceRecordedOwnMovesWhenConnected();

      expect(await connect('10.0.0.1:16127')).to.deep.equal([`${OLD}>${NEW}`]);
      expect(sentData('10.0.0.1:16127').broadcastedAt).to.equal(at);
      heardBack('10.0.0.1:16127');
    });

    it('at startup, sends a move that is both recorded and pending once', async () => {
      registryManager.addressMovesTo.withArgs(NEW).resolves(new Map([[OLD, { to: NEW, at: Date.now() - 60_000, signer: '04own' }]]));

      fluxCommunication.announceRecordedOwnMovesWhenConnected();
      fluxCommunication.announceOwnAddressMove(OLD, NEW, Date.now());

      expect(await connect('10.0.0.1:16127')).to.deep.equal([`${OLD}>${NEW}`]);
      heardBack('10.0.0.1:16127');
    });

    it('at startup, reads the recorded moves again on the next connection when the read fails', async () => {
      registryManager.addressMovesTo.withArgs(NEW).onFirstCall().rejects(new Error('connection timed out'));
      registryManager.addressMovesTo.withArgs(NEW).onSecondCall().resolves(new Map([[OLD, { to: NEW, at: Date.now() - 60_000, signer: '04own' }]]));

      fluxCommunication.announceRecordedOwnMovesWhenConnected();

      expect(await connect('10.0.0.1:16127')).to.deep.equal([]);
      expect(peerManager.listeners('peerConnected').some((listener) => listener.name === 'sendOwnMovesTo')).to.equal(true);
      expect(await connect('10.0.0.2:16127')).to.deep.equal([`${OLD}>${NEW}`]);
      heardBack('10.0.0.2:16127');
    });

    it('at startup with nothing recorded, stops listening after the first connection', async () => {
      fluxCommunication.announceRecordedOwnMovesWhenConnected();

      expect(await connect('10.0.0.1:16127')).to.deep.equal([]);
      expect(peerManager.listeners('peerConnected').some((listener) => listener.name === 'sendOwnMovesTo')).to.equal(false);
    });
  });

  describe('the crossing-dial rule: the connection the lower address dialed survives', () => {
    afterEach(() => {
      peerManager.setOwnSocketAddress(null);
      peerManager.reset();
      sinon.restore();
    });

    it('a dial completing into a pair the lower address already dialed is refused, and its duty is met', async () => {
      // Reciprocal duties make both ends dial the same pair at once. Both ends
      // keep the connection the lower address dialed (peerManager.resolveCrossing),
      // so they agree however the race went. Here the peer is the lower address,
      // so its inbound connection survives and this node's dial loses - settled
      // HELD, because the survivor carries the duty it was dialed for.
      sinon.stub(rateLimit, 'lruRateLimit').returns(true);
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: false, height: 0 } });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').returns('44.192.51.11:16127');
      peerManager.reset();
      peerManager.setOwnSocketAddress('200.1.1.1:16127');

      const { port } = localWsServer.address();
      const key = `127.0.0.1:${port}`;

      // Start the dial, then land the pair's other connection mid-handshake.
      const settled = [];
      fluxCommunication.initiateAndHandleConnection(key, PEER_SOURCE.DETERMINISTIC, {
        onSettle: (v) => settled.push(v),
      });
      const held = await connectWs();
      held.ip = '127.0.0.1';
      held.port = String(port);
      held.on = sinon.stub();
      peerManager.add(held, '127.0.0.1', port, { source: PEER_SOURCE.INBOUND });
      const original = peerManager.get(key);
      expect(original).to.not.be.undefined;

      // The dial's handshake completes against the held pair: it must lose.
      await waitFor(() => settled.length === 1, 5000);
      await waitFor(() => !peerManager.isPending(key), 5000);

      expect(settled).to.deep.equal([true]); // the duty IS satisfied — by the survivor
      expect(peerManager.get(key)).to.equal(original); // the held connection survives
      expect(peerManager.get(key).direction).to.equal('inbound');
      expect(held.readyState).to.equal(WebSocket.OPEN); // never closed
      expect(peerManager.outboundCount).to.equal(0);
      expect(peerManager.inboundCount).to.equal(1);
    });

    it('a dial that completes after the stop began is closed with the stop code, and the duty learns nothing from it', async () => {
      // The stop announces itself on the held connections; a dial still in
      // flight would land after that and drop unannounced at exit. The
      // manager closes it with the stop code instead, the dial settles with
      // no evidence, and once the stop has begun no further dial is made.
      sinon.stub(rateLimit, 'lruRateLimit').returns(true);
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({ data: { synced: false, height: 0 } });
      sinon.stub(fluxNetworkHelper, 'getLocalSocketAddress').returns('44.192.51.11:16127');
      peerManager.reset();

      const { port } = localWsServer.address();
      const key = `127.0.0.1:${port}`;
      const settled = [];
      // past the gate before the stop, its handshake completes after it
      fluxCommunication.initiateAndHandleConnection(key, PEER_SOURCE.DETERMINISTIC, {
        onSettle: (v) => settled.push(v),
      });
      await peerManager.closeAllForStop(CLOSE_CODES.RESTARTING, { flushMs: 10 });

      await waitFor(() => settled.length === 1, 5000);
      expect(settled).to.deep.equal([null]);
      expect(peerManager.has(key)).to.equal(false);
      expect(peerManager.isPending(key)).to.equal(false);

      const again = [];
      await fluxCommunication.initiateAndHandleConnection(key, PEER_SOURCE.DETERMINISTIC, {
        onSettle: (v) => again.push(v),
      });
      expect(again).to.deep.equal([null]);
      expect(peerManager.isPending(key)).to.equal(false);
    });
  });

  describe('nodedown certificates over the app-state sync stream', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('routes them through the certificate intake, never the unverified store', async () => {
      // A booting node catches up on stored certificates over sync. The rows
      // are self-proving (jury signatures inside), so they bypass the envelope
      // filter — a locally-assembled row has no envelope at all — and must
      // reach the same verifying intake as gossip, never the plain app-state
      // store that takes an envelope check as sufficient.
      // The handlers gate on isSyncResponseWanted(socket), not on the ephemeral
      // isSyncRequested(key) this test was written against - see the REBASE-ADAPTER
      // (D12) note in serviceManager. Same adaptation as the block at :2119.
      sinon.stub(peerManager, 'isSyncResponseWanted').returns(true);
      sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
        .resolves({ result: fluxCommunicationUtils.VerifyResult.OK });
      const intake = sinon.stub(nodeDownService, 'onCertificateSyncEvent')
        .resolves({ accepted: true, rebroadcast: false, reason: 'stored' });
      const stateStore = sinon.stub(messageStore, 'storeAppStateEvent').resolves();

      const peerKey = '10.20.30.41:16127';
      const bare = {
        type: 'nodedown',
        subject: 'aa:0',
        broadcastedAt: '2026-08-30T00:00:00.000Z',
        data: { certificate: { subject: 'aa:0', height: 100, fingerprint: 'fp', verdicts: [] } },
        envelope: null,
      };
      const enveloped = {
        ...bare,
        subject: 'bb:0',
        data: { certificate: { subject: 'bb:0', height: 100, fingerprint: 'fp', verdicts: [] } },
        envelope: {
          version: 1, pubKey: 'pk', timestamp: 1_700_000_000_000, signature: 'sig',
        },
      };

      const completed = [];
      const onComplete = (...args) => completed.push(args);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, onComplete);
      try {
        // The handler directly, as the block above does: syncResponseDispatcher is
        // null until the peer manager is wired at boot, so driving through it here
        // would test nothing at all.
        await fluxCommunication.handleAppRunningSyncResponse(
          { data: { type: 'fluxapprunningsync', done: true, messages: [bare, enveloped] } },
          { key: peerKey },
        );
      } finally {
        appSyncEvents.off(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, onComplete);
      }

      expect(intake.callCount).to.equal(2);
      expect(intake.firstCall.args[0]).to.deep.equal(bare);
      expect(intake.secondCall.args[0]).to.deep.equal(enveloped);
      expect(stateStore.callCount).to.equal(0);
      expect(completed).to.deep.equal([['apprunning', peerKey]]);
    });

    it('an event without an envelope that is not a certificate is dropped: nothing unsigned reaches the store', async () => {
      // The certificate is the only self-proving row. Every other event must
      // carry the envelope of the node that produced it, or it is not stored —
      // there is no type the intake takes on the relaying peer's say-so. (The
      // eviction event was exactly that, and it is gone.)
      //
      // The gate is isSyncResponseWanted(socket), as its two siblings above say:
      // isSyncRequested(key) is the ephemeral one, so the handler returned before
      // any of this and the round was never marked done.
      sinon.stub(peerManager, 'isSyncResponseWanted').returns(true);
      sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
        .resolves({ result: fluxCommunicationUtils.VerifyResult.OK });
      const intake = sinon.stub(nodeDownService, 'onCertificateSyncEvent').resolves();
      const stateStore = sinon.stub(messageStore, 'storeAppStateEvent').resolves();
      const batchStore = sinon.stub(messageStore, 'storeBatchAppRunningEvents').resolves({ stored: 0 });

      const peerKey = '10.20.30.42:16127';
      const unsigned = [
        { type: 'evicted', ip: '1.2.3.4', createdAt: '2026-09-05T00:00:00.000Z', envelope: null },
        { type: 'appremoved', ip: '1.2.3.4', data: { appName: 'a', broadcastedAt: 1_700_000_000_000 } },
        { type: 'apprunning', ip: '1.2.3.4', data: { apps: [{ name: 'a', hash: 'h' }] } },
      ];

      const completed = [];
      const onComplete = (...args) => completed.push(args);
      appSyncEvents.on(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, onComplete);
      try {
        // The handler directly, as its siblings above do: syncResponseDispatcher
        // is null until the peer manager is wired at boot, so driving through it
        // here reached nothing.
        await fluxCommunication.handleAppRunningSyncResponse(
          { data: { type: 'fluxapprunningsync', done: true, messages: unsigned } },
          { key: peerKey },
        );
      } finally {
        appSyncEvents.off(SYNC_EVENTS.EPHEMERAL_SYNC_COMPLETE, onComplete);
      }

      expect(stateStore.callCount).to.equal(0);
      expect(batchStore.callCount).to.equal(0);
      expect(intake.callCount).to.equal(0);
      expect(completed).to.deep.equal([['apprunning', peerKey]]);
    });
  });
});

describe('fluxnodedownverdict wire contract', () => {
  // A verdict rides only an ephemeral connection. One arriving down a
  // peering must be silently ignored - otherwise the gossip plane can be
  // used to inject verdicts.
  const makePeerSocket = (source) => ({
    ip: '44.44.44.44',
    port: '16127',
    key: '44.44.44.44:16127',
    direction: 'inbound',
    source,
    closeCodes: { invalidMsg: 4016, blocked: 4003 },
    close: sinon.stub(),
    badMessageTimestamps: [],
    msgMap: new Map([['requestHash', 0], ['newHash', 0]]),
  });
  const makeMsg = (marker) => ({
    timestamp: Date.now(),
    pubKey: 'pubkey',
    signature: 'sig',
    version: 1,
    data: { type: 'fluxnodedownverdict', verdict: { subject: `s:${marker}` } },
  });

  let onVerdictStub;

  beforeEach(() => {
    sinon.stub(FluxTTLCache.prototype, 'has').returns(false);
    sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
      .resolves({ result: fluxCommunicationUtils.VerifyResult.OK, announcer: null });
    sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
    onVerdictStub = sinon.stub(nodeDownService, 'onVerdictMessage');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('dispatches a verdict arriving on an ephemeral connection', async () => {
    await peerManager.messageDispatcher(makeMsg(1), makePeerSocket(PEER_SOURCE.EPHEMERAL));
    await new Promise((resolve) => { setImmediate(resolve); });
    sinon.assert.calledOnce(onVerdictStub);
  });

  it('ignores a verdict arriving down a peering, and says so once per connection', async () => {
    const warn = sinon.stub(log, 'warn');
    const onPeering = () => warn.args.map(([line]) => line).filter((line) => line.includes('arrived on a inbound peering')).length;
    const socket = makePeerSocket(PEER_SOURCE.INBOUND);
    await peerManager.messageDispatcher(makeMsg(2), socket);
    await peerManager.messageDispatcher(makeMsg(3), socket);
    await new Promise((resolve) => { setImmediate(resolve); });
    sinon.assert.notCalled(onVerdictStub);
    expect(onPeering(), 'two verdicts on one peering, one line').to.equal(1);
    // a second connection is its own edge
    await peerManager.messageDispatcher(makeMsg(4), makePeerSocket(PEER_SOURCE.INBOUND));
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(onPeering()).to.equal(2);
  });

  it('a repeated verdict message is dropped and said once per sender, again only after a fresh one', async () => {
    FluxTTLCache.prototype.has.restore();
    const has = sinon.stub(FluxTTLCache.prototype, 'has');
    const warn = sinon.stub(log, 'warn');
    const repeats = () => warn.args.map(([line]) => line).filter((line) => line.includes('already seen')).length;
    has.returns(true);
    await peerManager.messageDispatcher(makeMsg(5), makePeerSocket(PEER_SOURCE.EPHEMERAL));
    await peerManager.messageDispatcher(makeMsg(5), makePeerSocket(PEER_SOURCE.EPHEMERAL));
    await new Promise((resolve) => { setImmediate(resolve); });
    sinon.assert.notCalled(onVerdictStub);
    expect(repeats(), 'two repeats, one line').to.equal(1);
    has.returns(false);
    await peerManager.messageDispatcher(makeMsg(6), makePeerSocket(PEER_SOURCE.EPHEMERAL));
    await new Promise((resolve) => { setImmediate(resolve); });
    sinon.assert.calledOnce(onVerdictStub);
    has.returns(true);
    await peerManager.messageDispatcher(makeMsg(6), makePeerSocket(PEER_SOURCE.EPHEMERAL));
    expect(repeats(), 'a fresh one re-arms the edge').to.equal(2);
  });
});

describe('the dispatcher hands each type to the handler the route table declares', () => {
  // eslint-disable-next-line global-require
  const policyStore = require('../../ZelBack/src/services/policyStore');
  const makeSocket = () => ({
    ip: '49.49.49.49',
    port: '16127',
    key: '49.49.49.49:16127',
    direction: 'outbound',
    source: PEER_SOURCE.OUTBOUND,
    closeCodes: { invalidMsg: 4016, blocked: 4003 },
    close: sinon.stub(),
    send: sinon.stub(),
    sendNak: sinon.stub(),
    badMessageTimestamps: [],
    msgMap: new Map([['requestHash', 0], ['newHash', 0]]),
  });
  const signed = (data) => ({
    timestamp: Date.now(), pubKey: 'pubkey', signature: 'sig', version: 1, data,
  });
  const announcer = { collateral: 'txid:0', pubkey: 'pubkey' };
  const settle = () => new Promise((resolve) => { setImmediate(resolve); });

  beforeEach(() => {
    sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
      .resolves({ result: fluxCommunicationUtils.VerifyResult.OK, announcer });
    sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
  });

  afterEach(() => sinon.restore());

  it('offers a policy bundle to the store, from the peer that sent it', async () => {
    const offer = sinon.stub(policyStore, 'offerBundle').resolves();
    const socket = makeSocket();
    await peerManager.messageDispatcher(signed({ type: 'fluxpolicy', bundle: { seq: 7 }, correlationId: 'c1' }), socket);
    await settle();
    sinon.assert.calledOnceWithExactly(offer, { seq: 7 }, socket.key, 'c1');
  });

  it('notes a peer\'s policy sequence', async () => {
    const note = sinon.stub(policyStore, 'notePeerSeq');
    const socket = makeSocket();
    await peerManager.messageDispatcher(signed({ type: 'fluxpolicyseq', seq: 7, correlationId: 'c2' }), socket);
    await settle();
    sinon.assert.calledOnceWithExactly(note, 7, socket.key, 'c2');
  });

  it('answers a policy request on the socket it came from', async () => {
    const respond = sinon.stub(fluxCommunicationMessagesSender, 'respondWithPolicy').resolves();
    const socket = makeSocket();
    const message = signed({ type: 'fluxpolicyrequest', correlationId: 'c3' });
    await peerManager.messageDispatcher(message, socket);
    await settle();
    sinon.assert.calledOnceWithExactly(respond, message, socket);
  });

  // The announcer is resolved once, by the signature check, and the event log records it.
  ['fluxapprunning', 'fluxmasterlease'].forEach((type) => {
    it(`hands ${type} the announcer its signature check resolved`, async () => {
      const store = sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: false });
      sinon.stub(messageStore, 'releaseInstallingClaims').resolves({ released: 0 });
      await peerManager.messageDispatcher(signed({ type, name: `app-${type}`, ip: '50.50.50.50:16127' }), makeSocket());
      await settle();
      await settle();
      sinon.assert.calledOnce(store);
      expect(store.firstCall.args[1].announcer).to.equal(announcer);
    });
  });

  // A question carries nothing but itself, so two peers asking it are byte-identical,
  // and each of them is owed the answer.
  it('answers the same question from two peers', async () => {
    const respond = sinon.stub(fluxCommunicationMessagesSender, 'respondWithManifestIndex').resolves();
    const first = makeSocket();
    const second = { ...makeSocket(), key: '51.51.51.51:16127', ip: '51.51.51.51' };
    const question = signed({ type: 'fluxappcontentmanifestindexrequest' });
    await peerManager.messageDispatcher(question, first);
    await peerManager.messageDispatcher({ ...question }, second);
    await settle();
    expect(respond.getCalls().map((call) => call.args[0])).to.deep.equal([first, second]);
  });

  // The reconcile services key a round by the peer they asked, so the answer has to
  // arrive under that peer's key.
  [
    ['fluxappcontentmanifestindex', { index: ['a'] }, 'contentManifestSyncService', 'depositIndex', ['a']],
    ['fluxappingressindex', { digests: ['d'] }, 'ingressAttestationSyncService', 'depositDigests', ['d']],
  ].forEach(([type, body, serviceName, method, deposited]) => {
    it(`deposits a ${type} answer under the key of the peer that sent it`, async () => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const service = require(`../../ZelBack/src/services/appMessaging/${serviceName}`);
      sinon.stub(service, 'isPeerInActiveRound').returns(true);
      const deposit = sinon.stub(service, method);
      const socket = makeSocket();
      await peerManager.syncResponseDispatcher(signed({ type, ...body, done: true }), socket);
      await settle();
      await settle();
      sinon.assert.calledOnceWithExactly(deposit, socket.key, deposited);
    });
  });

  it('says an ordered type reaching the gossip pipeline is unsolicited, and runs nothing', async () => {
    const warn = sinon.stub(log, 'warn');
    await peerManager.messageDispatcher(signed({ type: 'fluxappingresssync', messages: [], done: true }), makeSocket());
    await settle();
    expect(warn.args.some(([line]) => line.includes('Unsolicited fluxappingresssync'))).to.equal(true);
  });
});

describe('hash request/response rides the arrival socket', () => {
  // Hash-sync requests arrive on ephemeral connections that are never in
  // the peer map — the reply must go down the socket the question came on.
  // A map lookup by ip:port answered nobody, silently, and the symptom
  // (zero hashes resolved) surfaced two subsystems away.
  const makeSocket = () => ({
    ip: '45.45.45.45',
    port: '16127',
    key: '45.45.45.45:16127',
    direction: 'inbound',
    source: PEER_SOURCE.EPHEMERAL,
    closeCodes: { invalidMsg: 4016 },
    close: sinon.stub(),
    send: sinon.stub(),
    remoteCapabilities: new Set(),
    badMessageTimestamps: [],
    msgMap: new Map([['requestHash', 0], ['newHash', 0]]),
  });

  afterEach(() => sinon.restore());

  it('answers a hash request from a socket that is not in the peer map', async () => {
    const hash = 'a'.repeat(40);
    const cached = {
      timestamp: 1, pubKey: 'k', signature: 's', version: 1, data: { type: 'x' },
    };
    sinon.stub(FluxTTLCache.prototype, 'has').returns(true);
    sinon.stub(FluxTTLCache.prototype, 'get').returns(cached);
    const socket = makeSocket();

    await peerManager.messageDispatcher({ requestMessageHash: hash }, socket);
    await new Promise((resolve) => { setImmediate(resolve); });

    sinon.assert.calledOnce(socket.send);
    expect(socket.send.firstCall.args[0]).to.include('"pubKey":"k"');
  });

  it('asks for an announced hash on the socket that announced it', async () => {
    const hash = 'b'.repeat(40);
    sinon.stub(FluxTTLCache.prototype, 'has').returns(false);
    const socket = makeSocket();

    await peerManager.messageDispatcher({ messageHashPresent: hash }, socket);
    await new Promise((resolve) => { setImmediate(resolve); });

    sinon.assert.calledOnce(socket.send);
    expect(socket.send.firstCall.args[0]).to.equal(JSON.stringify({ requestMessageHash: hash }));
  });
  describe('addOutgoingPeer — a dial-back reads the node-down stand-down', () => {
    afterEach(() => sinon.restore());

    it('refuses a dial-back to a node the plane holds out, before any dial', async () => {
      sinon.stub(nodeConfirmationService, 'isConfirmed').returns(true);
      sinon.stub(fluxCommunicationUtils, 'deterministicFluxList').resolves([{ ip: '10.0.0.5:16127' }]);
      const mayDialBack = sinon.stub(nodeDownService, 'mayDialBack').resolves({ allowed: false, reason: 'stood_down', subject: 'x:0' });
      const req = {
        params: { ip: '10.0.0.5:16127' }, ip: '10.0.0.5', headers: {}, connection: {}, socket: {},
      };
      const res = { json: sinon.stub() };
      await fluxCommunication.addOutgoingPeer(req, res);
      sinon.assert.calledOnceWithExactly(mayDialBack, '10.0.0.5:16127');
      const answer = res.json.firstCall.args[0];
      expect(answer.status).to.equal('error');
      expect(answer.data.message).to.match(/held out of the network \(stood_down\)/);
    });
  });
});

describe('a relayed broadcast is handed to the peer that asks for it', () => {
  // A relay announces the hash; a peer that lacks the message asks for it by that
  // hash, and only this node's answer carries it one hop further.
  const makeSocket = () => ({
    ip: '46.46.46.46',
    port: '16127',
    key: '46.46.46.46:16127',
    direction: 'inbound',
    source: PEER_SOURCE.EPHEMERAL,
    closeCodes: { invalidMsg: 4016 },
    close: sinon.stub(),
    send: sinon.stub(),
    remoteCapabilities: new Set(),
    badMessageTimestamps: [],
    msgMap: new Map([['requestHash', 0], ['newHash', 0]]),
  });

  const broadcast = (type) => ({
    version: 1,
    timestamp: Date.now(),
    pubKey: `pubkey-${type}`,
    signature: `signature-${type}`,
    data: {
      type, version: 1, ip: '47.47.47.47:16127', name: `app-${type}`, broadcastedAt: Date.now(),
    },
  });

  const handlers = [
    ['fluxapptemp', () => sinon.stub(messageStore, 'storeAppTemporaryMessage').resolves({ rebroadcast: true }), fluxCommunication.handleAppMessages],
    ['fluxapprunning', () => {
      sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: true });
      sinon.stub(messageStore, 'releaseInstallingClaims').resolves({ released: 0 });
    }, fluxCommunication.handleAppRunningMessage],
    ['fluxappinstalling', () => {
      sinon.stub(messageStore, 'storeAppInstallingMessage').resolves(true);
      sinon.stub(messageStore, 'storeSignedAppInstallingBroadcast');
    }, fluxCommunication.handleAppInstallingMessage],
    ['fluxappinstallingerror', () => {
      sinon.stub(messageStore, 'storeAppInstallingErrorMessage').resolves(true);
      sinon.stub(messageStore, 'storeSignedAppInstallingErrorBroadcast');
    }, fluxCommunication.handleAppInstallingErrorMessage],
    ['fluxipchanged', () => {
      sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: true });
      sinon.stub(messageStore, 'storeIPChangedMessage').resolves(true);
    }, fluxCommunication.handleIPChangedMessage],
    ['fluxappremoved', () => {
      sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: true });
      sinon.stub(messageStore, 'storeAppRemovedMessage').resolves(true);
    }, fluxCommunication.handleAppRemovedMessage],
    ['fluxgrantgeneration', () => sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: true }), fluxCommunication.handleGrantGenerationMessage],
    ['fluxmasterlease', () => sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: true }), fluxCommunication.handleMasterleaseMessage],
    ['fluxnodedown', () => sinon.stub(nodeDownService, 'onCertificateBroadcast').resolves({ rebroadcast: true }), fluxCommunication.handleNodeDownMessage],
  ];

  beforeEach(() => {
    sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
  });

  afterEach(() => sinon.restore());

  handlers.forEach(([type, stubStore, handle]) => {
    it(`answers a request for the ${type} broadcast it announced`, async () => {
      stubStore();
      const announce = sinon.stub(peerManager, 'broadcastHash');
      const message = broadcast(type);

      await handle(message, '48.48.48.48', '16127');
      sinon.assert.calledOnce(announce);
      const [announcedHash] = announce.firstCall.args;

      const socket = makeSocket();
      await peerManager.messageDispatcher({ requestMessageHash: announcedHash }, socket);
      await new Promise((resolve) => { setImmediate(resolve); });

      sinon.assert.calledOnce(socket.send);
      expect(JSON.parse(socket.send.firstCall.args[0])).to.deep.equal(message);
    });
  });
});

describe('the flood filter cannot be talked out of deduplicating', () => {
  // eslint-disable-next-line global-require
  const { default: cacheManager } = require('../../ZelBack/src/services/utils/cacheManager');
  // eslint-disable-next-line global-require
  const policyStore = require('../../ZelBack/src/services/policyStore');

  // The dispatcher is not exported - the transport installs it on the peer manager as
  // it loads, which is the same object production calls.
  const peerSocket = {
    ip: '127.0.0.9',
    port: '16127',
    key: '127.0.0.9:16127',
    direction: 'outgoing',
    badMessageTimestamps: [],
    close: () => {},
    sendNak: () => {},
  };

  let verify;

  beforeEach(() => {
    cacheManager.announcementSeen.clear();
    verify = sinon.stub(fluxCommunicationUtils, 'verifyFluxBroadcast')
      .resolves({ result: fluxCommunicationUtils.VerifyResult.OK, announcer: null });
    sinon.stub(fluxCommunicationUtils, 'verifyTimestampInFluxBroadcast').returns(true);
    sinon.stub(peerManager, 'broadcastHash');
    sinon.stub(messageStore, 'storeAppStateEvent').resolves({ isNewer: false });
    sinon.stub(messageStore, 'storeIPChangedMessage').resolves(false);
    sinon.stub(policyStore, 'notePeerSeq');
  });

  afterEach(() => {
    sinon.restore();
  });

  const envelope = (data) => ({
    version: 1, pubKey: '0400', timestamp: Date.now(), signature: 'sig', data,
  });

  it('deduplicates an announce type that claims to be an ask', async () => {
    // A marker inside the signed payload survives every relay, so a node that could
    // sign one would otherwise have every honest node announce it onward again.
    const data = {
      type: 'fluxipchanged',
      version: 1,
      oldIP: '1.1.1.1',
      newIP: '2.2.2.2',
      broadcastedAt: Date.now(),
      intent: 'ask',
    };

    await peerManager.messageDispatcher(envelope(data), peerSocket);
    expect(cacheManager.announcementSeen.has(objectHash(data))).to.equal(true);
    expect(verify.callCount).to.equal(1);

    await peerManager.messageDispatcher(envelope(data), peerSocket);
    // The filter sits in front of verification, so a second copy costs nothing.
    expect(verify.callCount).to.equal(1);
  });

  it('still lets two peers answer the same question', async () => {
    // The other half, and the reason the marker exists: an answer carries no sender,
    // so two peers answering "seq 5" are byte-identical and a content filter would
    // deliver the first and drop the rest.
    const data = {
      type: 'fluxpolicyseq', version: 1, seq: 5, intent: 'answer', correlationId: 'abc',
    };

    await peerManager.messageDispatcher(envelope(data), peerSocket);
    await peerManager.messageDispatcher(envelope(data), peerSocket);

    expect(cacheManager.announcementSeen.has(objectHash(data))).to.equal(false);
    expect(verify.callCount).to.equal(2);
  });

  // AN UNMARKED POLICY ANNOUNCEMENT IS NOT FILTERED EITHER, for the reason the answer
  // above is not: it carries nothing about its sender, and the sender is the whole of
  // what it says. Two peers announcing the same sequence are two peers to ask, and the
  // type is never relayed - so a content filter cannot be discarding a second route to
  // one fact, only the second peer offering it.
  it('does not deduplicate an unmarked policy announcement either', async () => {
    const data = { type: 'fluxpolicyseq', version: 1, seq: 5 };

    await peerManager.messageDispatcher(envelope(data), peerSocket);
    await peerManager.messageDispatcher(envelope(data), peerSocket);

    expect(cacheManager.announcementSeen.has(objectHash(data))).to.equal(false);
    expect(verify.callCount, 'the second peer to announce it is still heard').to.equal(2);
  });

  // A message that never verified was never established as anything, so the fingerprint
  // it left behind must not stand as one this node has seen. Left there, it suppresses
  // the genuine message that hashes the same for the whole of the cache's ttl - which is
  // a forged copy of any announcement silencing the real one.
  it('gives the slot back when a message does not verify', async () => {
    const data = {
      type: 'fluxapprunning', version: 2, apps: [], ip: '1.2.3.4:16127', broadcastedAt: 1,
    };
    verify.resolves({ result: fluxCommunicationUtils.VerifyResult.NODE_NOT_FOUND });

    await peerManager.messageDispatcher(envelope(data), peerSocket);

    expect(
      cacheManager.announcementSeen.has(objectHash(data)),
      'a message that failed verification is holding the fingerprint',
    ).to.equal(false);
  });

  // The canary: the same type, verifying, DOES hold it - so the release above is the
  // verification failing and not the filter having been switched off.
  it('keeps the slot for a message that verifies', async () => {
    const data = {
      type: 'fluxapprunning', version: 2, apps: [], ip: '1.2.3.4:16127', broadcastedAt: 2,
    };

    await peerManager.messageDispatcher(envelope(data), peerSocket);

    expect(cacheManager.announcementSeen.has(objectHash(data))).to.equal(true);
  });
});
