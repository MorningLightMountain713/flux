'use strict';

/* eslint-disable no-underscore-dangle */

const chai = require('chai');
const sinon = require('sinon');
const WebSocket = require('ws');
const chaiAsPromised = require('chai-as-promised');
const log = require('../../ZelBack/src/lib/log');
const proxyquire = require('proxyquire');
const { asConfig } = require('./fixtures/config');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const fluxCommunicationUtils = require('../../ZelBack/src/services/fluxCommunicationUtils');
const fluxNetworkHelper = require('../../ZelBack/src/services/fluxNetworkHelper');
const nodeDosState = require('../../ZelBack/src/services/nodeDosState');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const upnpService = require('../../ZelBack/src/services/upnpService');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const os = require('os');

/**
 * A UDP socket whose connect resolves to a source address, or fails.
 */
function fakeUdpSocket({ source = null, error = null }) {
  const fake = new EventEmitter();
  fake.connect = sinon.spy(function connect() {
    setImmediate(function settle() {
      if (error) fake.emit('error', error);
      else fake.emit('connect');
    });
  });
  fake.address = function address() { return { address: source, family: 'IPv4', port: 40_000 }; };
  fake.close = sinon.spy();
  return fake;
}

const net = require('node:net');

const { peerManager } = require('../../ZelBack/src/services/utils/peerState');
const { PEER_SOURCE } = require('../../ZelBack/src/services/utils/FluxPeerSocket');
const ufw = require('../../ZelBack/src/services/utils/ufw');
const fs = require('fs').promises;
const config = require('config');
const { Privilege, authOf } = require('../../ZelBack/src/services/utils/privileges');
const ufwHelper = require('../../ZelBack/src/services/utils/ufwHelper');
const fluxEventBus = require('../../ZelBack/src/services/utils/fluxEventBus');

chai.use(chaiAsPromised);
const { expect } = chai;

describe('fluxNetworkHelper tests', () => {
  // Global beforeEach to mock UPnP service for all tests
  beforeEach(() => {
    sinon.stub(upnpService, 'isUPNP').returns(false);
    sinon.stub(upnpService, 'removeMapUpnpPort').resolves(true);
    sinon.stub(upnpService, 'mapUpnpPort').resolves(true);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('checkFluxAvailability tests', () => {
    let stub;
    const axiosConfig = {
      timeout: 5000,
    };
    const fluxAvailabilitySuccessResponse = {
      data: {
        status: 'success',
        data: '8.2.0',
      },
    };
    Object.setPrototypeOf(fluxAvailabilitySuccessResponse.data, { // axios on home expects string
      includes() {
        return true;
      },
    });
    const fluxAvailabilityErrorResponse = {
      data: {
        status: 'error',
        data: '8.2.0',
      },
    };
    const generateResponse = () => {
      const res = { test: 'testing' };
      res.status = sinon.stub().returns(res);
      res.json = sinon.fake((param) => param);
      return res;
    };

    afterEach(() => {
      serviceHelper.axiosGet.restore();
      sinon.restore();
    });

    it('Should return success message if proper parameters are passed in params', async () => {
      const mockResponse = generateResponse();
      const req = {
        params: {
          test1: 'test1',
          ip: '127.0.0.1',
          port: '16127',
        },
        query: {
          test2: 'test2',
        },
      };
      stub = sinon.stub(serviceHelper, 'axiosGet').resolves(fluxAvailabilitySuccessResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      sinon.stub(net.Socket.prototype, 'connect').callsFake((_port, _ip, callback) => {
        callback();
      });
      const expectedAddress = 'http://127.0.0.1:16127/flux/version';
      const expectedAddressHome = 'http://127.0.0.1:16126/health';
      const expectedMessage = {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: 'Asking Flux is available',
        },
      };

      const checkFluxAvailabilityResult = await fluxNetworkHelper.checkFluxAvailability(req, mockResponse);

      sinon.assert.calledWithExactly(stub, expectedAddress, axiosConfig);
      sinon.assert.calledWithExactly(stub, expectedAddressHome, axiosConfig);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedMessage);
      expect(checkFluxAvailabilityResult).to.eql(expectedMessage);
    });

    it('Should return success message if proper parameters are passed in query', async () => {
      const mockResponse = generateResponse();
      const req = {
        params: {
          test1: 'test1',
        },
        query: {
          test2: 'test2',
          ip: '127.0.0.1',
          port: '16127',
        },
      };
      stub = sinon.stub(serviceHelper, 'axiosGet').resolves(fluxAvailabilitySuccessResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      sinon.stub(net.Socket.prototype, 'connect').callsFake((port, ip, callback) => {
        callback();
      });
      const expectedAddress = 'http://127.0.0.1:16127/flux/version';
      const expectedAddressHome = 'http://127.0.0.1:16126/health';
      const expectedMessage = {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: 'Asking Flux is available',
        },
      };
      sinon.stub(fluxNetworkHelper, 'isPortOpen').resolves(true);

      const checkFluxAvailabilityResult = await fluxNetworkHelper.checkFluxAvailability(req, mockResponse);

      sinon.assert.calledWithExactly(stub, expectedAddress, axiosConfig);
      sinon.assert.calledWithExactly(stub, expectedAddressHome, axiosConfig);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedMessage);
      expect(checkFluxAvailabilityResult).to.eql(expectedMessage);
    });

    it('Should return error message if flux is not available', async () => {
      const mockResponse = generateResponse();
      const req = {
        params: {
          test1: 'test1',
        },
        query: {
          test2: 'test2',
          ip: '127.0.0.1',
          port: '16127',
        },
      };
      stub = sinon.stub(serviceHelper, 'axiosGet').resolves(fluxAvailabilityErrorResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      const expectedAddress = 'http://127.0.0.1:16127/flux/version';
      const expectedMessage = {
        status: 'error',
        data: {
          code: undefined,
          name: undefined,
          message: 'Asking Flux is not available',
        },
      };

      const checkFluxAvailabilityResult = await fluxNetworkHelper.checkFluxAvailability(req, mockResponse);

      sinon.assert.calledWithExactly(stub, expectedAddress, axiosConfig);
      sinon.assert.calledWithExactly(mockResponse.json, expectedMessage);
      expect(checkFluxAvailabilityResult).to.eql(expectedMessage);
    });

    it('Should return error message if no ip is provided', async () => {
      const mockResponse = generateResponse();
      const req = {
        params: {
          test1: 'test1',
        },
        query: {
          test2: 'test2',
        },
      };
      stub = sinon.stub(serviceHelper, 'axiosGet').resolves(fluxAvailabilitySuccessResponse);
      const expectedMessage = {
        status: 'error',
        data: {
          code: undefined,
          name: undefined,
          message: 'No ip specified.',
        },
      };

      const checkFluxAvailabilityResult = await fluxNetworkHelper.checkFluxAvailability(req, mockResponse);

      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedMessage);
      expect(checkFluxAvailabilityResult).to.eql(expectedMessage);
    });
  });

  describe('getLocalSocketAddress tests', () => {
    let benchStub;

    beforeEach(() => {
      benchStub = sinon.stub(benchmarkService, 'getBenchmarks');
      // Reset the own-IP freshness cache so it never leaks across tests — a warm cache
      // would make getLocalSocketAddress skip the benchmark stub a test set up. Setting
      // null clears both the value and the freshness deadline.
      fluxNetworkHelper.setLocalSocketAddress(null);
    });

    afterEach(() => {
      benchStub.restore();
    });

    it('should return IP and Port if benchmark response is correct', async () => {
      const ip = '127.0.0.1:5050';
      const getBenchmarkResponseData = { value: { ipaddress: ip } };
      benchStub.resolves(getBenchmarkResponseData);

      const getIpResult = await fluxNetworkHelper.getLocalSocketAddress();

      expect(getIpResult).to.equal(ip);
      sinon.assert.calledOnce(benchStub);
    });

    it('should return null if daemon\'s response is invalid', async () => {
      const getBenchmarkResponseData = { value: null, reason: {} };
      benchStub.resolves(getBenchmarkResponseData);

      const getIpResult = await fluxNetworkHelper.getLocalSocketAddress();

      expect(getIpResult).to.be.null;
      sinon.assert.calledOnce(benchStub);
    });

    it('should return null if daemon\'s response IP is too short', async () => {
      const ip = '12734';
      const getBenchmarkResponseData = { value: JSON.stringify({ ipaddress: ip }) };
      benchStub.resolves(getBenchmarkResponseData);

      const getIpResult = await fluxNetworkHelper.getLocalSocketAddress();

      expect(getIpResult).to.be.null;
      sinon.assert.calledOnce(benchStub);
    });

    it('should normalize bare IP from old fluxbench to ip:port', async () => {
      const getBenchmarkResponseData = { value: { ipaddress: '85.159.213.248' } };
      benchStub.resolves(getBenchmarkResponseData);

      const result = await fluxNetworkHelper.getLocalSocketAddress();

      expect(result).to.equal('85.159.213.248:16127');
    });

    it('should return ip:port as-is from new fluxbench', async () => {
      const getBenchmarkResponseData = { value: { ipaddress: '85.159.213.248:16127' } };
      benchStub.resolves(getBenchmarkResponseData);

      const result = await fluxNetworkHelper.getLocalSocketAddress();

      expect(result).to.equal('85.159.213.248:16127');
    });

    it('should preserve non-default port from fluxbench', async () => {
      const getBenchmarkResponseData = { value: { ipaddress: '85.159.213.248:16147' } };
      benchStub.resolves(getBenchmarkResponseData);

      const result = await fluxNetworkHelper.getLocalSocketAddress();

      expect(result).to.equal('85.159.213.248:16147');
    });

    it('serves the cached own-IP without a second benchmark RPC while fresh', async () => {
      benchStub.resolves({ value: { ipaddress: '85.159.213.248:16127' } });

      const first = await fluxNetworkHelper.getLocalSocketAddress();
      const second = await fluxNetworkHelper.getLocalSocketAddress();

      expect(first).to.equal('85.159.213.248:16127');
      expect(second).to.equal('85.159.213.248:16127');
      // the freshness cache short-circuits the second call — a batch pays ONE RPC, not N
      sinon.assert.calledOnce(benchStub);
    });

    // A CALLER READING THE ABSENCE OF AN ANSWER IS PROBING THE DAEMON, not asking
    // this node's address, and the cache answers the second question only. Served
    // from memory, a daemon that has died inside the window still produces the last
    // address it ever gave, and the caller reads a dead daemon as a live one.
    it('asks the daemon when the caller wants it fresh, cache or no cache', async () => {
      benchStub.resolves({ value: { ipaddress: '85.159.213.248:16127' } });
      await fluxNetworkHelper.getLocalSocketAddress();

      await fluxNetworkHelper.getLocalSocketAddress({ fresh: true });

      sinon.assert.calledTwice(benchStub);
    });

    it('reports a daemon that stops answering, even inside the freshness window', async () => {
      benchStub.resolves({ value: { ipaddress: '85.159.213.248:16127' } });
      expect(await fluxNetworkHelper.getLocalSocketAddress()).to.equal('85.159.213.248:16127');

      benchStub.resolves({ value: null, reason: {} });

      expect(await fluxNetworkHelper.getLocalSocketAddress({ fresh: true })).to.equal(null);
    });

    it('re-benchmarks after the cache is invalidated (setLocalSocketAddress null)', async () => {
      benchStub.resolves({ value: { ipaddress: '85.159.213.248:16127' } });

      await fluxNetworkHelper.getLocalSocketAddress();
      fluxNetworkHelper.setLocalSocketAddress(null); // clears the value + the freshness deadline
      await fluxNetworkHelper.getLocalSocketAddress();

      sinon.assert.calledTwice(benchStub);
    });

    it('does not cache a null (unresolved) own-IP — keeps probing', async () => {
      benchStub.resolves({ value: null, reason: {} });

      const first = await fluxNetworkHelper.getLocalSocketAddress();
      const second = await fluxNetworkHelper.getLocalSocketAddress();

      expect(first).to.be.null;
      expect(second).to.be.null;
      // a null result is never cached, so every call re-probes until fluxbench resolves
      sinon.assert.calledTwice(benchStub);
    });
  });

  describe('fluxAvailability tests', () => {
    const versionResponse = { data: { status: 'success', data: '8.2.0' } };
    Object.setPrototypeOf(versionResponse.data, { // axios on home expects string
      includes() {
        return true;
      },
    });

    afterEach(() => {
      sinon.restore();
    });

    it('is AVAILABLE when the listed node answers on its api, ui and syncthing ports', async () => {
      sinon.stub(serviceHelper, 'axiosGet').resolves(versionResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      sinon.stub(net.Socket.prototype, 'connect').callsFake((_port, _ip, callback) => {
        callback();
      });

      expect(await fluxNetworkHelper.fluxAvailability('127.0.0.1', '16127')).to.equal(fluxNetworkHelper.FluxAvailability.AVAILABLE);
    });

    it('is NOT_LISTED, without probing, when the address is not on the deterministic list', async () => {
      const axiosGet = sinon.stub(serviceHelper, 'axiosGet').resolves(versionResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(false);

      expect(await fluxNetworkHelper.fluxAvailability('127.0.0.1', '16127')).to.equal(fluxNetworkHelper.FluxAvailability.NOT_LISTED);
      sinon.assert.notCalled(axiosGet);
    });

    it('is UNAVAILABLE when the listed node does not answer', async () => {
      sinon.stub(serviceHelper, 'axiosGet').rejects(new Error('Connection refused'));
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);

      expect(await fluxNetworkHelper.fluxAvailability('127.0.0.1', '16127')).to.equal(fluxNetworkHelper.FluxAvailability.UNAVAILABLE);
    });

    it('answers checkfluxavailability for an address it does not list as not listed', async () => {
      sinon.stub(serviceHelper, 'axiosGet').resolves(versionResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(false);
      const res = { json: sinon.fake((param) => param) };

      const answer = await fluxNetworkHelper.checkFluxAvailability({ params: { ip: '127.0.0.1', port: '16127' }, query: {} }, res);

      expect(answer.status).to.equal('error');
      expect(answer.data.message).to.equal(fluxNetworkHelper.NOT_LISTED_MESSAGE);
    });
  });

  describe('isFluxAvailable tests', () => {
    let stub;
    const ip = '127.0.0.1';
    const port = '16127';
    const axiosConfig = {
      timeout: 5000,
    };

    afterEach(() => {
      sinon.restore();
    });

    it('Should return true if node is running flux, port taken from config', async () => {
      const mockResponse = {
        data: {
          status: 'success',
          data: '8.2.0',
        },
      };
      Object.setPrototypeOf(mockResponse.data, { // axios on home expects string
        includes() {
          return true;
        },
      });
      stub = sinon.stub(serviceHelper, 'axiosGet').resolves(mockResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      sinon.stub(net.Socket.prototype, 'connect').callsFake((_port, _ip, callback) => {
        callback();
      });
      const expectedAddress = 'http://127.0.0.1:16127/flux/version';
      const expectedAddressHome = 'http://127.0.0.1:16126/health';

      const isFluxAvailableResult = await fluxNetworkHelper.isFluxAvailable(ip);

      sinon.assert.calledWithExactly(stub, expectedAddress, axiosConfig);
      sinon.assert.calledWithExactly(stub, expectedAddressHome, axiosConfig);
      expect(isFluxAvailableResult).to.equal(true);
    });

    it('Should return true if node is running flux, port provided explicitly', async () => {
      const mockResponse = {
        data: {
          status: 'success',
          data: '8.2.0',
        },
      };
      Object.setPrototypeOf(mockResponse.data, { // axios on home expects string
        includes() {
          return true;
        },
      });
      stub = sinon.stub(serviceHelper, 'axiosGet').resolves(mockResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      sinon.stub(net.Socket.prototype, 'connect').callsFake((_port, _ip, callback) => {
        callback();
      });
      const expectedAddress = 'http://127.0.0.1:16127/flux/version';
      const expectedAddressHome = 'http://127.0.0.1:16126/health';

      const isFluxAvailableResult = await fluxNetworkHelper.isFluxAvailable(ip, port);

      sinon.assert.calledWithExactly(stub, expectedAddress, axiosConfig);
      sinon.assert.calledWithExactly(stub, expectedAddressHome, axiosConfig);
      expect(isFluxAvailableResult).to.equal(true);
    });

    it('Should return false if node if flux version is lower than expected', async () => {
      const mockResponse = {
        data: {
          status: 'success',
          data: '2.01.0', // minimum allowed version is 3.19.0
        },
      };
      stub = sinon.stub(serviceHelper, 'axiosGet').resolves(mockResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      const expectedAddress = 'http://127.0.0.1:16127/flux/version';

      const isFluxAvailableResult = await fluxNetworkHelper.isFluxAvailable(ip, port);

      sinon.assert.calledWithExactly(stub, expectedAddress, axiosConfig);
      expect(isFluxAvailableResult).to.equal(false);
    });

    it('Should return false if response status is not success', async () => {
      const mockResponse = {
        data: {
          status: 'error',
        },
      };
      stub = sinon.stub(serviceHelper, 'axiosGet').resolves(mockResponse);
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      const expectedAddress = 'http://127.0.0.1:16127/flux/version';

      const isFluxAvailableResult = await fluxNetworkHelper.isFluxAvailable(ip, port);

      sinon.assert.calledWithExactly(stub, expectedAddress, axiosConfig);
      expect(isFluxAvailableResult).to.equal(false);
    });

    it('Should return false if axios request throws error', async () => {
      stub = sinon.stub(serviceHelper, 'axiosGet').throws();
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(true);
      const expectedAddress = 'http://127.0.0.1:16127/flux/version';

      const isFluxAvailableResult = await fluxNetworkHelper.isFluxAvailable(ip, port);

      sinon.assert.calledWithExactly(stub, expectedAddress, axiosConfig);
      expect(isFluxAvailableResult).to.equal(false);
    });

    it('Should return false if node is not a confirmed flux node', async () => {
      stub = sinon.stub(serviceHelper, 'axiosGet');
      sinon.stub(fluxCommunicationUtils, 'socketAddressInFluxList').resolves(false);

      const isFluxAvailableResult = await fluxNetworkHelper.isFluxAvailable(ip, port);

      sinon.assert.notCalled(stub);
      expect(isFluxAvailableResult).to.equal(false);
    });
  });

  describe('getFluxNodePrivateKey tests', () => {
    let daemonStub;
    let ensureStub;

    beforeEach(() => {
      daemonStub = sinon.stub(daemonServiceUtils, 'getConfigValue');
      ensureStub = sinon.stub(daemonServiceUtils, 'ensureConfigLoaded').resolves();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return the same private key as provided as an argument', async () => {
      const privateKey = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';

      const getKeyResult = await fluxNetworkHelper.getFluxNodePrivateKey(privateKey);

      expect(getKeyResult).to.equal(privateKey);
      sinon.assert.neverCalledWith(daemonStub);
    });

    it('should return a private key if argument was not provided', async () => {
      const mockedPrivKey = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
      daemonStub.resolves(mockedPrivKey);

      const getKeyResult = await fluxNetworkHelper.getFluxNodePrivateKey();

      expect(getKeyResult).to.equal(mockedPrivKey);
      sinon.assert.calledWithExactly(daemonStub, 'zelnodeprivkey');
    });

    it('reads flux.conf itself rather than waiting for something else to', async () => {
      // The key is on disk and needs no daemon. Before this it was available only once some
      // other code had made an RPC and parsed the config on the way past, so a node that had
      // its key all along looked like a node whose daemon was down.
      daemonStub.returns('5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh');

      await fluxNetworkHelper.getFluxNodePrivateKey();

      sinon.assert.calledOnce(ensureStub);
      expect(ensureStub.calledBefore(daemonStub), 'asked for the config before reading it')
        .to.equal(true);
    });

    it('does not read the config when it was handed a key', async () => {
      await fluxNetworkHelper.getFluxNodePrivateKey('5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh');

      sinon.assert.notCalled(ensureStub);
      sinon.assert.notCalled(daemonStub);
    });
  });

  describe('getFluxNodePublicKey tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('Should properly return publicKey if private key is provided', async () => {
      const privateKey = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
      const expectedPublicKey = '0474eb4690689bb408139249eda7f361b7881c4254ccbe303d3b4d58c2b48897d0f070b44944941998551f9ea0e1befd96f13adf171c07c885e62d0c2af56d3dab';

      const publicKey = await fluxNetworkHelper.getFluxNodePublicKey(privateKey);

      expect(publicKey).to.be.equal(expectedPublicKey);
    });

    it('Should properly return publicKey if private key is taken from config', async () => {
      const mockedPrivKey = '5JTeg79dTLzzHXoJPALMWuoGDM8QmLj4n5f6MeFjx8dzsirvjAh';
      const expectedPublicKey = '0474eb4690689bb408139249eda7f361b7881c4254ccbe303d3b4d58c2b48897d0f070b44944941998551f9ea0e1befd96f13adf171c07c885e62d0c2af56d3dab';
      const daemonStub = sinon.stub(daemonServiceUtils, 'getConfigValue').resolves(mockedPrivKey);

      const publicKey = await fluxNetworkHelper.getFluxNodePublicKey();

      expect(publicKey).to.be.equal(expectedPublicKey);
      sinon.assert.calledWithExactly(daemonStub, 'zelnodeprivkey');
    });

    it('Should answer null, not an Error, if the private key is invalid', async () => {
      const privateKey = 'asdf';

      const result = await fluxNetworkHelper.getFluxNodePublicKey(privateKey);

      // An Error here is the worst of both: truthy, so a guard on the value
      // passes, and `{}` once JSON.stringify reaches it - which is how a node
      // with a briefly unreadable key went on broadcasting messages every peer
      // silently refused.
      expect(result).to.be.null;
    });
  });

  describe('closeConnection tests', () => {
    before(() => {
      peerManager.reset();
    });

    const generateWebsocket = (ip, port, readyState) => {
      const ws = {};
      ws.port = String(port);
      ws.ip = ip;
      ws.readyState = readyState;
      ws.ping = sinon.stub().returns('pong');
      ws.close = sinon.stub().returns('okay');
      ws.on = sinon.stub();
      ws._socket = {
        remoteAddress: ip,
      };
      peerManager.add(ws, ip, String(port), { source: PEER_SOURCE.RANDOM });
      return ws;
    };

    afterEach(() => {
      peerManager.reset();
      sinon.restore();
    });

    it('should close outgoing connection properly if it exists', async () => {
      const ip = '127.9.9.1';
      const port = '16127';
      const successMessage = {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: `Outgoing connection to ${ip}:${port} closed`,
        },
      };
      const websocket = generateWebsocket(ip, port, WebSocket.OPEN);

      const closeConnectionResult = await fluxNetworkHelper.closeConnection(ip, port);

      sinon.assert.calledOnceWithExactly(websocket.close, 4009, 'purposefully closed');
      expect(closeConnectionResult).to.eql(successMessage);
    });

    it('should close outgoing connection properly if it exists and peer is not added to the list', async () => {
      const ip = '127.9.9.1';
      const port = '16127';
      const successMessage = {
        status: 'success',
        data: {
          code: undefined,
          name: undefined,
          message: `Outgoing connection to ${ip}:${port} closed`,
        },
      };
      const websocket = generateWebsocket(ip, port, WebSocket.OPEN);

      const closeConnectionResult = await fluxNetworkHelper.closeConnection(ip, port);

      sinon.assert.calledOnceWithExactly(websocket.close, 4009, 'purposefully closed');
      expect(closeConnectionResult).to.eql(successMessage);
    });

    it('should return warning message if the websocket does not exist', async () => {
      const ip = '127.9.9.1';
      const ip2 = '127.5.5.2';
      const port = '16127';
      const errorMessage = {
        status: 'warning',
        data: {
          code: undefined,
          name: undefined,
          message: `Connection to ${ip}:${port} does not exists.`,
        },
      };
      // Add a different peer so the target one is not found
      const ws2 = {
        ip: ip2, port, readyState: WebSocket.OPEN, close: sinon.stub(), ping: sinon.stub(), on: sinon.stub(),
      };
      peerManager.add(ws2, ip2, port, { source: PEER_SOURCE.RANDOM });

      const closeConnectionResult = await fluxNetworkHelper.closeConnection(ip, port);

      expect(closeConnectionResult).to.eql(errorMessage);
      expect(peerManager.outboundCount).to.equal(1);
    });

    it('should return warning message if ip is not provided', async () => {
      const ip2 = '127.5.5.2';
      const port = '16127';
      const errorMessage = {
        status: 'warning',
        data: {
          code: undefined,
          name: undefined,
          message: 'To close a connection please provide a proper IP number.',
        },
      };
      const ws = {
        ip: ip2, port, readyState: WebSocket.OPEN, close: sinon.stub(), ping: sinon.stub(), on: sinon.stub(),
      };
      peerManager.add(ws, ip2, port, { source: PEER_SOURCE.RANDOM });

      const closeConnectionResult = await fluxNetworkHelper.closeConnection();

      sinon.assert.notCalled(ws.close);
      expect(closeConnectionResult).to.eql(errorMessage);
      expect(peerManager.outboundCount).to.equal(1);
    });
  });

  describe('closeIncomingConnection tests', () => {
    before(() => {
      peerManager.reset();
    });

    afterEach(() => {
      peerManager.reset();
      sinon.restore();
    });

    it('should return warning message if the websocket does not exist', async () => {
      const ip2 = '127.5.5.2';
      const port = '16127';
      const errorMessage = {
        status: 'warning',
        data: {
          code: undefined,
          name: undefined,
          message: 'To close a connection please provide a proper IP number.',
        },
      };
      const ws = {
        ip: ip2, port, readyState: WebSocket.OPEN, close: sinon.stub(), ping: sinon.stub(), on: sinon.stub(),
      };
      peerManager.add(ws, ip2, port, { source: PEER_SOURCE.INBOUND });

      const closeConnectionResult = await fluxNetworkHelper.closeIncomingConnection();

      expect(closeConnectionResult).to.eql(errorMessage);
      expect(peerManager.inboundCount).to.equal(1);
    });
  });

  describe('getIncomingConnections tests', () => {
    const generateResponse = () => {
      const res = { test: 'testing' };
      res.status = sinon.stub().returns(res);
      res.json = sinon.fake((param) => param);
      return res;
    };

    afterEach(() => {
      peerManager.reset();
      sinon.restore();
    });

    it('should return success message with incoming connections\' ips', async () => {
      const ips = ['127.0.0.1', '127.0.0.2'];
      const port = '16127';
      ips.forEach((ip) => {
        const ws = {
          ip, port, readyState: WebSocket.OPEN, close: sinon.stub(), ping: sinon.stub(), on: sinon.stub(),
        };
        peerManager.add(ws, ip, port, { source: PEER_SOURCE.INBOUND });
      });

      const res = generateResponse();
      const expectedCallArgumeent = { status: 'success', data: ['127.0.0.1', '127.0.0.2'] };

      fluxNetworkHelper.getIncomingConnections(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedCallArgumeent);
    });

    it('should return success message with empty array if there are no incoming connections', async () => {
      const res = generateResponse();
      const expectedCallArgumeent = { status: 'success', data: [] };

      fluxNetworkHelper.getIncomingConnections(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedCallArgumeent);
    });
  });

  describe('getIncomingConnectionsInfo tests', () => {
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

    it('should return success message with incoming connections\' info', async () => {
      const ips = ['127.0.0.1', '127.0.0.2'];
      const port = '16127';
      ips.forEach((ip) => {
        const ws = {
          ip, port, readyState: WebSocket.OPEN, close: sinon.stub(), ping: sinon.stub(), on: sinon.stub(),
        };
        peerManager.add(ws, ip, port, { source: PEER_SOURCE.INBOUND });
      });
      const res = generateResponse();
      const expectedCallArgumeent = {
        status: 'success',
        data: [
          { ip: '127.0.0.1', port: '16127' },
          { ip: '127.0.0.2', port: '16127' },
        ],
      };

      fluxNetworkHelper.getIncomingConnectionsInfoAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedCallArgumeent);
    });

    it('should return success message with empty array if there are no incoming connections', async () => {
      const res = generateResponse();
      const expeectedCallArgumeent = { status: 'success', data: [] };

      fluxNetworkHelper.getIncomingConnectionsInfoAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, expeectedCallArgumeent);
    });
  });

  describe('checkFluxbenchVersionAllowed tests', () => {
    // minimumFluxBenchAllowedVersion = '6.2.0';
    let benchmarkInfoResponseStub;

    beforeEach(() => {
      benchmarkInfoResponseStub = sinon.stub(benchmarkService, 'getInfo');
      fluxNetworkHelper.setStoredFluxBenchAllowed(null);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return true if bench version is higher than minimal and stored in cache', async () => {
      fluxNetworkHelper.setStoredFluxBenchAllowed('6.3.0');

      const isFluxbenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();

      expect(isFluxbenchVersionAllowed).to.equal(true);
    });

    it('should return true if bench version is equal to minimal and stored in cache', async () => {
      fluxNetworkHelper.setStoredFluxBenchAllowed('6.2.0');

      const isFluxbenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();

      expect(isFluxbenchVersionAllowed).to.equal(true);
    });

    it('should return false if bench version is lower than minimal and is stored in cache', async () => {
      fluxNetworkHelper.setStoredFluxBenchAllowed('4.0.0');

      const isFluxbenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();

      expect(isFluxbenchVersionAllowed).to.equal(false);
    });

    it('should return true if the version is higher than minimal and is not set in cache', async () => {
      const benchmarkInfoResponse = { value: {
        version: '6.3.0',
      } };
      benchmarkInfoResponseStub.returns(benchmarkInfoResponse);

      const isFluxbenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();

      expect(isFluxbenchVersionAllowed).to.equal(true);
      expect(fluxNetworkHelper.getStoredFluxBenchAllowed()).to.equal('6.3.0');
    });

    it('should return true if the version is equal to minimal and is not set in cache', async () => {
      const benchmarkInfoResponse = { value: {
        version: '6.2.0',
      } };
      benchmarkInfoResponseStub.returns(benchmarkInfoResponse);

      const isFluxbenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();

      expect(isFluxbenchVersionAllowed).to.equal(true);
      expect(fluxNetworkHelper.getStoredFluxBenchAllowed()).to.equal('6.2.0');
    });

    it('should return false if the version is lower than minimal and is not set in cache', async () => {
      const benchmarkInfoResponse = { value: {
        version: '2.0.0',
      } };
      benchmarkInfoResponseStub.returns(benchmarkInfoResponse);

      const isFluxbenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();

      expect(isFluxbenchVersionAllowed).to.equal(false);
      expect(fluxNetworkHelper.getStoredFluxBenchAllowed()).to.equal('2.0.0');
    });

    it('should return false if the version is unattainable from benchmarkInfo', async () => {
      const benchmarkInfoResponse = { value: null, reason: {
        test: 'test',
      } };
      benchmarkInfoResponseStub.returns(benchmarkInfoResponse);

      const isFluxbenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();

      expect(isFluxbenchVersionAllowed).to.equal(false);
      expect(fluxNetworkHelper.getStoredFluxBenchAllowed()).to.equal(null);
    });

    it('should return false if benchmarkInfo throws error', async () => {
      benchmarkInfoResponseStub.throws();

      const isFluxbenchVersionAllowed = await fluxNetworkHelper.checkFluxbenchVersionAllowed();

      expect(isFluxbenchVersionAllowed).to.equal(false);
      expect(fluxNetworkHelper.getStoredFluxBenchAllowed()).to.equal(null);
    });
  });

  describe('getDOSState tests', () => {
    const generateResponse = () => {
      const res = { test: 'testing' };
      res.status = sinon.stub().returns(res);
      res.json = sinon.fake((param) => param);
      return res;
    };

    beforeEach(() => {
      nodeDosState.setDosMessage(null);
      nodeDosState.setDosStateValue(null);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return nulls by default', async () => {
      const expectedResult = {
        status: 'success',
        data: {
          dosState: null,
          dosMessage: null,
        },
      };

      const result = await fluxNetworkHelper.getDOSState();

      expect(result).to.eql(expectedResult);
    });

    it('should return nulls by default to the passed response', async () => {
      const res = generateResponse();
      const expectedResult = {
        status: 'success',
        data: {
          dosState: null,
          dosMessage: null,
        },
      };

      const result = await fluxNetworkHelper.getDOSState(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      expect(result).to.eql(expectedResult);
    });

    it('should return a proper message if no response was passed', async () => {
      const newDosState = 150;
      const newDosMessage = 'Hi! this is the new massage';
      nodeDosState.setDosMessage(newDosMessage);
      nodeDosState.setDosStateValue(newDosState);
      const expectedResult = {
        status: 'success',
        data: {
          dosState: newDosState,
          dosMessage: newDosMessage,
        },
      };

      const result = await fluxNetworkHelper.getDOSState();

      expect(result).to.eql(expectedResult);
    });

    it('should pass a proper message to the response', async () => {
      const res = generateResponse();
      const newDosState = 150;
      const newDosMessage = 'Hi! this is the new massage';
      nodeDosState.setDosMessage(newDosMessage);
      nodeDosState.setDosStateValue(newDosState);
      const expectedResult = {
        status: 'success',
        data: {
          dosState: newDosState,
          dosMessage: newDosMessage,
        },
      };

      const result = await fluxNetworkHelper.getDOSState(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      expect(result).to.eql(expectedResult);
    });
  });

  describe('getDOSState', () => {
    afterEach(() => {
      Object.values(nodeDosState.StickyDosOwner).forEach(nodeDosState.clearStickyDos);
      nodeDosState.setDosMessage(null);
      nodeDosState.setDosStateValue(0);
    });

    it('reports the held verdict over the counted one', () => {
      nodeDosState.setDosMessage('regular reason');
      nodeDosState.setDosStateValue(50);
      nodeDosState.setStickyDos(nodeDosState.StickyDosOwner.APP_TAMPERING, 'sticky reason');

      expect(fluxNetworkHelper.getDOSState()).to.eql({
        status: 'success',
        data: { dosState: 100, dosMessage: 'sticky reason' },
      });
    });

    it('reports the counted pair when no owner holds the node', () => {
      nodeDosState.setDosMessage('regular reason');
      nodeDosState.setDosStateValue(50);

      expect(fluxNetworkHelper.getDOSState()).to.eql({
        status: 'success',
        data: { dosState: 50, dosMessage: 'regular reason' },
      });
    });
  });

  describe('checkNodeJsVersionAllowed tests', () => {
    // minimumNodeJsAllowedVersion = '20.8.0'
    const realNodeJsVersion = process.versions.node;
    const { NODEJS_FLOOR, RESIDENTIAL_DOS } = nodeDosState.StickyDosOwner;

    function runningOn(version) {
      Object.defineProperty(process.versions, 'node', { value: version, configurable: true });
    }

    // node-config seals its values once the module graph has loaded, so the
    // floor is varied by loading the helper over a config that carries a
    // different one. The instance is its own, which is also what keeps its DOS
    // state out of the tests either side.
    function helperWithFloor(floor) {
      return proxyquire('../../ZelBack/src/services/fluxNetworkHelper', {
        config: asConfig({ minimumNodeJsAllowedVersion: floor }),
      });
    }

    afterEach(() => {
      runningOn(realNodeJsVersion);
      nodeDosState.clearStickyDos(NODEJS_FLOOR);
      nodeDosState.clearStickyDos(RESIDENTIAL_DOS);
      nodeDosState.setDosStateValue(0);
      nodeDosState.setDosMessage(null);
    });

    it('allows the runtime the fleet already runs', () => {
      runningOn('24.14.1');

      expect(fluxNetworkHelper.checkNodeJsVersionAllowed()).to.equal(true);
      expect(nodeDosState.getStickyDosMessage()).to.equal(null);
    });

    it('allows the floor itself', () => {
      runningOn('20.8.0');

      expect(fluxNetworkHelper.checkNodeJsVersionAllowed()).to.equal(true);
      expect(nodeDosState.getStickyDosMessage()).to.equal(null);
    });

    it('takes a node below the floor out of service, and says which version it found', () => {
      // the last 16.x release, which left support in September 2023
      runningOn('16.20.2');

      expect(fluxNetworkHelper.checkNodeJsVersionAllowed()).to.equal(false);
      const reported = fluxNetworkHelper.getDOSState().data;
      expect(reported.dosMessage).to.include('20.8.0');
      expect(reported.dosMessage).to.include('16.20.2');
      expect(reported.dosState).to.equal(100);
    });

    it('refuses a version below the floor within the same major', () => {
      runningOn('20.7.0');

      expect(fluxNetworkHelper.checkNodeJsVersionAllowed()).to.equal(false);
      expect(fluxNetworkHelper.getDOSState().data.dosState).to.equal(100);
    });

    it('survives the clear a successful availability pass performs', () => {
      // checkMyFluxAvailability ends a good pass with dosState = 0 and
      // setDosMessage(null). The runtime verdict is asked once at startup, so if
      // that clear reached it the node would return to service on a NodeJS that
      // cannot run the code and nothing would ask again.
      runningOn('16.20.2');
      fluxNetworkHelper.checkNodeJsVersionAllowed();

      nodeDosState.setDosStateValue(0);
      nodeDosState.setDosMessage(null);

      const reported = fluxNetworkHelper.getDOSState().data;
      expect(reported.dosMessage).to.include('16.20.2');
      expect(reported.dosState).to.equal(100);
    });

    it('allows when no floor is configured, on a runtime a floor would refuse', () => {
      // Unsetting the key is how the floor comes off a live fleet. The check runs
      // bare in startFluxFunctions, whose catch re-enters it after 15s, so a
      // throw here is a boot loop - and a node held out of service by a missing
      // floor has nothing left to tell it when to come back.
      // null, which is what a node carries with the key unset.
      const helper = helperWithFloor(null);
      runningOn('16.20.2');

      expect(helper.checkNodeJsVersionAllowed()).to.equal(true);
      expect(nodeDosState.getStickyDosMessage()).to.equal(null);
      expect(helper.getDOSState().data.dosState).to.equal(0);
    });

    it('allows when the configured floor is empty', () => {
      const helper = helperWithFloor('');
      runningOn('16.20.2');

      expect(helper.checkNodeJsVersionAllowed()).to.equal(true);
      expect(nodeDosState.getStickyDosMessage()).to.equal(null);
    });

    it('refuses on the loaded floor, so the instance is reading the one it was given', () => {
      // The canary for the two above: a helper loaded the same way, with a floor
      // present, must still take the node out of service. Without it, a config
      // stub that silently failed to reach the module would pass both.
      const helper = helperWithFloor('20.8.0');
      runningOn('16.20.2');

      expect(helper.checkNodeJsVersionAllowed()).to.equal(false);
      expect(helper.getDOSState().data.dosState).to.equal(100);
      nodeDosState.clearStickyDos(NODEJS_FLOOR);
    });

    it("records its verdict beside another owner's, and outlives that owner's release", () => {
      // The verdict is asked once at startup. Recorded under another owner's
      // identity - or not recorded at all - it leaves with that owner's release,
      // and the node returns to service on a runtime that cannot run the code.
      const theirs = 'Residential node not running ArcaneOS. Migrate this node to ArcaneOS or move it to a data center connection.';
      nodeDosState.setStickyDos(RESIDENTIAL_DOS, theirs);
      runningOn('16.20.2');

      expect(fluxNetworkHelper.checkNodeJsVersionAllowed()).to.equal(false);
      expect(nodeDosState.getStickyDosMessage(), 'overwrote a verdict it does not own').to.include(theirs);

      nodeDosState.clearStickyDos(RESIDENTIAL_DOS);

      const reported = fluxNetworkHelper.getDOSState().data;
      expect(reported.dosState, 'returned to service on the other owner\'s release').to.equal(100);
      expect(reported.dosMessage).to.include('16.20.2');
    });

    it('states its verdict once, however often startup re-enters the check', () => {
      // startFluxFunctions catches any throw and re-enters itself after 15s, so
      // this is asked again on every retry - and by then the other writers of
      // the slot have started.
      //
      // Asserted on the LOG rather than on the message, because re-setting the
      // slot to the same string leaves it equal to itself: the message alone
      // cannot tell a second write from no second write.
      const errorLog = sinon.spy(log, 'error');
      try {
        runningOn('16.20.2');
        expect(fluxNetworkHelper.checkNodeJsVersionAllowed()).to.equal(false);
        expect(fluxNetworkHelper.checkNodeJsVersionAllowed()).to.equal(false);

        const stated = errorLog.getCalls().filter((call) => String(call.args[0]).includes('NodeJS Version Error'));
        expect(stated).to.have.lengthOf(1);
        expect(fluxNetworkHelper.getDOSState().data.dosState).to.equal(100);
      } finally {
        errorLog.restore();
      }
    });
  });


  // Every ufw command runs through the one bounded runner: the lock-first helper
  // as root, the command's arguments as given, and a wait of at most 30 s on
  // ufw's lock.
  const ufwRun = (args) => sinon.match({
    runAsRoot: true, params: [ufw.UFW_HELPER, '--wait', '30', '--command', JSON.stringify(args)], timeout: 60_000,
  });
  // The ufw arguments a runCommand call ran through the runner, or null.
  const ufwArgs = (call) => {
    const params = call.args[0] === 'python3' ? call.args[1].params : [];
    const at = params.indexOf('--command');
    return at === -1 ? null : JSON.parse(params[at + 1]);
  };
  const lockTimedOut = () => ({ error: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), stdout: '', stderr: '' });

  describe('allowPort tests', () => {
    let runCommandStub;
    const updated = 'Rules updated\nRules updated (v6)\n';
    beforeEach(() => {
      runCommandStub = sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: updated, stderr: '' });
    });
    afterEach(() => {
      sinon.restore();
    });

    it('should allow the port inbound, in string or number format', async () => {
      expect(await fluxNetworkHelper.allowPort('12345')).to.eql({ status: true, message: updated });
      expect(await fluxNetworkHelper.allowPort(12_345)).to.eql({ status: true, message: updated });
      sinon.assert.alwaysCalledWith(runCommandStub, 'python3', ufwRun(['allow', '12345']));
    });

    it('should skip updating if the rule already exists', async () => {
      runCommandStub.resolves({ error: null, stdout: 'Skipping adding existing rule\n', stderr: '' });

      expect(await fluxNetworkHelper.allowPort(12_345)).to.eql({ status: true, message: 'existing' });
    });

    it('should return false with specific message error if the parameter is not a proper number', async () => {
      expect(await fluxNetworkHelper.allowPort('test')).to.eql({ status: false, message: 'Port needs to be a number' });
      sinon.assert.notCalled(runCommandStub);
    });

    it('should return status: false if the command response does not include words "updated", "existing" or "added"', async () => {
      runCommandStub.resolves({ error: null, stdout: 'testing', stderr: '' });

      expect((await fluxNetworkHelper.allowPort(12_345)).status).to.eql(false);
    });

    it('should return status: false when ufw is locked by another ufw command', async () => {
      runCommandStub.resolves(lockTimedOut());

      expect(await fluxNetworkHelper.allowPort(12_345)).to.eql({ status: false, message: 'ufw is locked by another ufw command' });
    });
  });

  describe('port rule commands', () => {
    let runCommandStub;
    beforeEach(() => {
      runCommandStub = sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: 'Rule deleted\n', stderr: '' });
    });
    afterEach(() => {
      sinon.restore();
    });

    it('should deny a port inbound only', async () => {
      await fluxNetworkHelper.denyPort(31_000);
      sinon.assert.calledOnceWithExactly(runCommandStub, 'python3', ufwRun(['deny', '31000']));
    });

    it('should delete only the inbound allow rule of a port', async () => {
      expect((await fluxNetworkHelper.deleteAllowPortRule(31_000)).status).to.equal(true);
      sinon.assert.calledOnceWithExactly(runCommandStub, 'python3', ufwRun(['delete', 'allow', '31000']));
    });

    it('should count a rule already gone as deleted', async () => {
      runCommandStub.resolves({ error: null, stdout: 'Could not delete non-existent rule\n', stderr: '' });

      expect((await fluxNetworkHelper.deleteAllowPortRule(31_000)).status).to.equal(true);
    });

    it('should report a delete that ran out of the lock wait as not done', async () => {
      runCommandStub.resolves(lockTimedOut());

      expect(await fluxNetworkHelper.deleteAllowPortRule(31_000)).to.eql({ status: false, message: 'ufw is locked by another ufw command' });
      expect(await fluxNetworkHelper.denyPort(31_000)).to.eql({ status: false, message: 'ufw is locked by another ufw command' });
    });
  });

  describe('app port rules', () => {
    let runCommandStub;
    let readFile;
    const ufwFiles = ({ enabled = 'yes', ipv6Filtered = 'yes' } = {}) => {
      readFile.withArgs('/etc/ufw/ufw.conf', 'utf8').resolves(`ENABLED=${enabled}\n`);
      readFile.withArgs('/etc/default/ufw', 'utf8').resolves(`IPV6=${ipv6Filtered}\n`);
    };
    const batched = (result) => ({ error: null, stdout: `${JSON.stringify({ removed: 0, applied: true, failed: [], reason: null, ...result })}\n`, stderr: '' });
    // The ufw commands each batch handed to the helper, in order.
    const batches = () => runCommandStub.getCalls()
      .filter((call) => call.args[0] === 'python3' && call.args[1].params.includes('--keep-outbound'))
      .map((call) => JSON.parse(call.args[1].params[call.args[1].params.indexOf('--rules') + 1]));
    beforeEach(() => {
      runCommandStub = sinon.stub(serviceHelper, 'runCommand').resolves(batched());
      readFile = sinon.stub(fs, 'readFile');
    });
    afterEach(() => {
      sinon.restore();
    });

    it('admits every client to every port of an app, IPv4 and IPv6, in one batch', async () => {
      ufwFiles();

      expect(await fluxNetworkHelper.allowAppPorts([31_000, 31_001])).to.deep.equal({ failed: [], locked: false });
      expect(batches()).to.deep.equal([[['allow', '31000'], ['allow', '31001']]]);
      sinon.assert.calledOnce(runCommandStub);
    });

    it('writes nothing while ufw is disabled, and no rule for a port apps are not given', async () => {
      ufwFiles({ enabled: 'no' });
      await fluxNetworkHelper.allowAppPorts([31_000]);
      sinon.assert.notCalled(runCommandStub);

      ufwFiles();
      await fluxNetworkHelper.allowAppPorts([31_000, 16_127, 22]);
      expect(batches()).to.deep.equal([[['allow', '31000']]]);
    });

    it('reports a port ufw refused', async () => {
      ufwFiles();
      const failed = [{ rule: 'allow 31000', error: 'ERROR: Bad port' }];
      runCommandStub.resolves(batched({ failed }));

      expect(await fluxNetworkHelper.allowAppPorts([31_000])).to.deep.equal({ failed, locked: false });
    });

    it('deletes each port\'s rule in one batch, while ufw is disabled too', async () => {
      ufwFiles({ enabled: 'no' });

      await fluxNetworkHelper.deleteAppPortRules([31_000, 31_001]);

      expect(batches()).to.deep.equal([[['delete', 'allow', '31000'], ['delete', 'allow', '31001']]]);
    });

    it('deletes no rule for a port apps are not given', async () => {
      ufwFiles();

      await fluxNetworkHelper.deleteAppPortRules([31_000, 16_127, 22]);

      expect(batches()).to.deep.equal([[['delete', 'allow', '31000']]]);
    });
  });

  describe('test port rules', () => {
    let runUfw;

    beforeEach(() => {
      runUfw = sinon.stub(ufw, 'runUfw').resolves({ error: null, stdout: 'Rule added\n', stderr: '', locked: false });
    });

    it('opens a port under test to IPv4 TCP clients only', async () => {
      expect(await fluxNetworkHelper.allowTestPort(31_350)).to.deep.equal({ status: true, message: 'Rule added\n' });
      sinon.assert.calledOnceWithExactly(runUfw, ['allow', 'proto', 'tcp', 'from', '0.0.0.0/0', 'to', 'any', 'port', '31350']);
    });

    it('deletes that rule and no other, a rule already gone counting as deleted', async () => {
      runUfw.resolves({ error: null, stdout: 'Could not delete non-existent rule\n', stderr: '', locked: false });
      expect((await fluxNetworkHelper.deleteTestPortRule('31350')).status).to.equal(true);
      sinon.assert.calledOnceWithExactly(runUfw, ['delete', 'allow', 'proto', 'tcp', 'from', '0.0.0.0/0', 'to', 'any', 'port', '31350']);
    });

    it('names a protocol, so ufw keeps it apart from the app port rule allow <port>', async () => {
      await fluxNetworkHelper.allowTestPort(31_350);
      await fluxNetworkHelper.deleteTestPortRule(31_350);
      runUfw.getCalls().forEach((call) => {
        expect(call.args[0].slice(-8, -6), 'a protocol named').to.deep.equal(['proto', 'tcp']);
        expect(call.args[0], 'IPv4 alone').to.include('0.0.0.0/0');
      });
    });

    it('opens and deletes a UDP test rule that names udp', async () => {
      await fluxNetworkHelper.allowTestPort(31_350, 'udp');
      await fluxNetworkHelper.deleteTestPortRule(31_350, 'udp');
      expect(runUfw.args).to.deep.equal([
        [['allow', 'proto', 'udp', 'from', '0.0.0.0/0', 'to', 'any', 'port', '31350']],
        [['delete', 'allow', 'proto', 'udp', 'from', '0.0.0.0/0', 'to', 'any', 'port', '31350']],
      ]);
    });

    it('refuses a protocol other than tcp or udp, running nothing', async () => {
      expect((await fluxNetworkHelper.allowTestPort(31_350, 'any')).status).to.equal(false);
      expect((await fluxNetworkHelper.deleteTestPortRule(31_350, 'any')).status).to.equal(false);
      sinon.assert.notCalled(runUfw);
    });

    it('reports a held lock and refuses a port that is not a number', async () => {
      runUfw.resolves({ error: null, stdout: '', stderr: '', locked: true });
      expect(await fluxNetworkHelper.allowTestPort(31_350)).to.deep.equal({ status: false, message: 'ufw is locked by another ufw command' });
      expect(await fluxNetworkHelper.deleteTestPortRule(31_350)).to.deep.equal({ status: false, message: 'ufw is locked by another ufw command' });
      expect((await fluxNetworkHelper.allowTestPort('x')).status).to.equal(false);
    });
  });

  describe('purgeUFW tests', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('should delete only the inbound deny rule of each denied port, and no outbound rule', async () => {
      const runCommandStub = sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: 'Rule deleted\n', stderr: '' });
      runCommandStub.withArgs('python3', ufwRun(['status'])).resolves({
        error: null,
        stdout: 'Status: active\n\nTo                         Action      From\n--                         ------      ----\n31000                      DENY        Anywhere\n16127                      ALLOW       Anywhere\n',
        stderr: '',
      });

      await fluxNetworkHelper.purgeUFW();

      sinon.assert.calledWith(runCommandStub, 'python3', ufwRun(['delete', 'deny', '31000']));
      const params = runCommandStub.getCalls().map(ufwArgs).filter(Boolean);
      expect(params.filter((args) => args.includes('out')), 'outbound rules touched').to.deep.equal([]);
      expect(params.filter((args) => args.includes('16127')), 'an allow rule touched').to.deep.equal([]);
    });
  });

  describe('denyPort tests', () => {
    const port = '32111';
    const updated = 'Rules updated\nRules updated (v6)\n';
    let runCommandStub;

    beforeEach(() => {
      runCommandStub = sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: updated, stderr: '' });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should deny port given in a string or number format', async () => {
      expect(await fluxNetworkHelper.denyPort(port)).to.eql({ status: true, message: updated });
      expect(await fluxNetworkHelper.denyPort(+port)).to.eql({ status: true, message: updated });
    });

    it('should skip updating if policy already exists', async () => {
      runCommandStub.resolves({ error: null, stdout: 'Skipping adding existing rule\n', stderr: '' });

      expect(await fluxNetworkHelper.denyPort(port)).to.eql({ status: true, message: 'existing' });
    });

    it('should return false with specific message error if the parameter is not a proper number', async () => {
      expect(await fluxNetworkHelper.denyPort('test')).to.eql({ status: false, message: 'Port needs to be a number' });
    });

    it('should return status: false if the command response does not include words "updated", "existing" or "added"', async () => {
      runCommandStub.resolves({ error: null, stdout: 'testing', stderr: '' });

      expect((await fluxNetworkHelper.denyPort(12_345)).status).to.eql(false);
    });
  });

  describe('allowPortApi tests', () => {
    let verifyPrivilegeStub;
    const port = '5555';
    const generateResponse = () => {
      const res = { test: 'testing' };
      res.status = sinon.stub().returns(res);
      res.json = sinon.fake((param) => param);
      return res;
    };

    beforeEach(async () => {
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: 'Rules updated\nRules updated (v6)\nRules updated\nRules updated (v6)\n', stderr: '' });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return a success message if the port number is properly passed in the params', async () => {
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      const req = {
        params: {
          port,
        },
      };
      const expectedResult = {
        status: 'success',
        data: {
          code: '5555',
          name: '5555',
          message: 'Rules updated\nRules updated (v6)\nRules updated\nRules updated (v6)\n',
        },
      };

      const result = await fluxNetworkHelper.allowPortApi(req, res);

      expect(result).to.eql(expectedResult);
      sinon.assert.calledOnceWithExactly(verifyPrivilegeStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should return a success message if the port number is properly passed in query', async () => {
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      const req = {
        params: {
          testing: 'testing',
        },
        query: {
          port,
        },
      };
      const expectedResult = {
        status: 'success',
        data: {
          code: '5555',
          name: '5555',
          message: 'Rules updated\nRules updated (v6)\nRules updated\nRules updated (v6)\n',
        },
      };

      const result = await fluxNetworkHelper.allowPortApi(req, res);

      expect(result).to.eql(expectedResult);
      sinon.assert.calledOnceWithExactly(verifyPrivilegeStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should return an unauthorized message if privilege is not right', async () => {
      verifyPrivilegeStub.returns(false);
      const res = generateResponse();
      const req = {
        params: {
          port,
        },
      };
      const expectedResult = {
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      };

      const result = await fluxNetworkHelper.allowPortApi(req, res);

      expect(result).to.eql(expectedResult);
      sinon.assert.calledOnceWithExactly(verifyPrivilegeStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should return an error message if allowPort status is false', async () => {
      const errorMessage = 'This is error message';
      // Restore and re-stub to return error message for this test
      sinon.restore();
      sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: errorMessage, stderr: '' });
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
      verifyPrivilegeStub.returns(true);
      const res = generateResponse();
      const req = {
        params: {
          port,
        },
      };
      const expectedResult = {
        status: 'error',
        data: {
          code: '5555',
          name: '5555',
          message: errorMessage,
        },
      };

      const result = await fluxNetworkHelper.allowPortApi(req, res);

      expect(result).to.eql(expectedResult);
      sinon.assert.calledOnceWithExactly(verifyPrivilegeStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });
  });

  describe('isFirewallActive tests', () => {
    let runCommandStub;
    beforeEach(() => {
      runCommandStub = sinon.stub(serviceHelper, 'runCommand');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return true if firewall is active', async () => {
      runCommandStub.resolves({ error: null, stdout: 'Status: active\n', stderr: '' });

      expect(await fluxNetworkHelper.isFirewallActive()).to.be.true;
      sinon.assert.calledOnceWithExactly(runCommandStub, 'python3', ufwRun(['status']));
    });

    it('should return false if firewall is not active', async () => {
      runCommandStub.resolves({ error: null, stdout: 'Status: inactive\n', stderr: '' });

      expect(await fluxNetworkHelper.isFirewallActive()).to.be.false;
    });

    it('should return false when ufw cannot be run', async () => {
      runCommandStub.resolves({ error: new Error('sudo: ufw: command not found'), stdout: '', stderr: '' });

      expect(await fluxNetworkHelper.isFirewallActive()).to.be.false;
    });

    it('should answer whether ufw is enabled when ufw is locked by another ufw command', async () => {
      runCommandStub.resolves(lockTimedOut());
      const readFile = sinon.stub(fs, 'readFile');
      readFile.withArgs('/etc/ufw/ufw.conf', 'utf8').resolves('ENABLED=yes\n');

      expect(await fluxNetworkHelper.isFirewallActive()).to.be.true;
      readFile.withArgs('/etc/ufw/ufw.conf', 'utf8').resolves('ENABLED=no\n');
      expect(await fluxNetworkHelper.isFirewallActive()).to.be.false;
    });
  });

  describe('adjustFirewall tests', () => {
    // api, home, ssl and syncthing ports, http(s), fluxd, then every flux api port
    const ports = () => ['16127', '16126', '16128', '16129', '80', '443', '16125', ...config.server.allowedPorts.map(String)];
    const applierCall = sinon.match({ runAsRoot: true, params: sinon.match((params) => params[0] === ufwHelper.UFW_HELPER && params.includes('--rules')) });
    let runCommandStub;
    let publishStub;
    let warnSpy;

    const firewallEnabled = (enabled) => {
      const readFile = sinon.stub(fs, 'readFile');
      readFile.callThrough();
      readFile.withArgs('/etc/ufw/ufw.conf', 'utf8').resolves(enabled ? 'ENABLED=yes\nLOGLEVEL=low\n' : 'ENABLED=no\nLOGLEVEL=low\n');
    };
    const applier = (result) => runCommandStub.withArgs('python3', applierCall).resolves(result);
    const answered = (answer) => applier({ error: null, stdout: `${JSON.stringify({ failed: [], reason: null, ...answer })}\n`, stderr: '' });
    const appliedRules = () => JSON.parse(runCommandStub.getCalls().find((call) => call.args[0] === 'python3' && call.args[1].params.includes('--rules')).args[1].params[4]);
    const ufwCalls = () => runCommandStub.getCalls().map(ufwArgs).filter(Boolean).map((args) => args.join(' '));

    beforeEach(() => {
      runCommandStub = sinon.stub(serviceHelper, 'runCommand').resolves({ error: null, stdout: '', stderr: '' });
      runCommandStub.withArgs('ip').resolves({ error: null, stdout: 'default via 192.168.1.1 dev eth0\n10.0.0.0/8 dev eth1\n', stderr: '' });
      publishStub = sinon.stub(fluxEventBus, 'publish');
      warnSpy = sinon.spy(log, 'warn');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should hand every rule of the node to the applier in one go, as root, waiting at most 30 s on ufw\'s lock', async () => {
      firewallEnabled(true);
      answered({ removed: 0, applied: true });

      await fluxNetworkHelper.adjustFirewall();

      sinon.assert.calledOnce(runCommandStub.withArgs('python3', applierCall));
      const [, options] = runCommandStub.getCalls().find((call) => call.args[0] === 'python3').args;
      expect(options.params.slice(1, 4)).to.deep.equal(['--wait', '30', '--rules']);
      expect(appliedRules()).to.deep.equal([
        ['delete', 'allow', 'in', 'proto', 'udp', 'to', 'any', 'port', '53'],
        ['prepend', 'limit', 'to', 'any', 'app', 'OpenSSH'],
        ['prepend', 'allow', 'from', '192.168.1.1', 'to', 'any', 'proto', 'udp'],
        ...ports().map((port) => ['allow', port]),
        ['allow', 'from', '172.23.0.0/16', 'proto', 'tcp', 'to', '169.254.43.43/32', 'port', '16101'],
      ]);
      expect(ufwCalls(), 'no ufw command of its own').to.deep.equal([]);
      sinon.assert.calledOnceWithExactly(publishStub, 'firewall:adjusted', { outboundRemoved: 0, rulesFailed: [], appliedBy: 'library' });
    });

    it('should write no outbound rule and never set a default policy', async () => {
      firewallEnabled(true);
      answered({ removed: 0, applied: true });

      await fluxNetworkHelper.adjustFirewall();

      expect(appliedRules().filter((rule) => rule.includes('out') || rule[0] === 'default')).to.deep.equal([]);
    });

    it('should reload ufw once, through the bounded runner, when outbound rules were removed', async () => {
      firewallEnabled(true);
      answered({ removed: 4, applied: true });

      await fluxNetworkHelper.adjustFirewall();

      expect(ufwCalls()).to.deep.equal(['reload']);
      sinon.assert.calledWith(runCommandStub, 'python3', ufwRun(['reload']));
      sinon.assert.calledOnceWithExactly(publishStub, 'firewall:adjusted', { outboundRemoved: 4, rulesFailed: [], appliedBy: 'library' });
    });

    it('should report each rule ufw refused, but not a delete of a rule already gone', async () => {
      firewallEnabled(true);
      answered({
        removed: 0,
        applied: true,
        failed: [
          { rule: 'delete allow in proto udp to any port 53', error: 'Could not delete non-existent rule' },
          { rule: 'prepend limit to any app OpenSSH', error: "ERROR: Could not find a profile matching 'OpenSSH'" },
        ],
      });

      await fluxNetworkHelper.adjustFirewall();

      sinon.assert.calledWith(warnSpy, "Firewall rule not applied: ufw prepend limit to any app OpenSSH: ERROR: Could not find a profile matching 'OpenSSH'");
      sinon.assert.neverCalledWith(warnSpy, sinon.match(/port 53/));
      sinon.assert.calledOnceWithExactly(publishStub, 'firewall:adjusted', { outboundRemoved: 0, rulesFailed: ['prepend limit to any app OpenSSH'], appliedBy: 'library' });
    });

    it('should run no ufw command at all when another ufw command holds the lock', async () => {
      // Each would wait on the same lock for as long as it is held.
      firewallEnabled(true);
      applier({ error: Object.assign(new Error('command failed'), { code: 75 }), stdout: '', stderr: 'ufw lock /run/ufw.lock not free within 30s' });
      const errorSpy = sinon.spy(log, 'error');

      await fluxNetworkHelper.adjustFirewall();

      expect(ufwCalls()).to.deep.equal([]);
      sinon.assert.calledWith(errorSpy, 'Firewall not adjusted: ufw is locked by another ufw command');
      sinon.assert.calledOnceWithExactly(publishStub, 'firewall:locked', {});
    });

    it('should apply the rules one bounded ufw command each when ufw\'s library cannot be used', async () => {
      firewallEnabled(true);
      answered({ removed: 2, applied: false, reason: 'ufw library not usable: TypeError()' });

      await fluxNetworkHelper.adjustFirewall();

      const rules = appliedRules().map((rule) => rule.join(' '));
      expect(ufwCalls()).to.deep.equal([...rules, 'reload']);
      runCommandStub.getCalls().filter(ufwArgs).forEach((call) => expect(call.args[1].timeout).to.equal(60_000));
      sinon.assert.calledWith(warnSpy, 'Firewall rules applied one ufw command each: ufw library not usable: TypeError()');
      sinon.assert.calledOnceWithExactly(publishStub, 'firewall:adjusted', { outboundRemoved: 2, rulesFailed: [], appliedBy: 'commands' });
    });

    it('should leave the rules it hands to ufw as they were', async () => {
      // The fallback runs each rule as given, and reports a refused one by it.
      firewallEnabled(true);
      answered({ removed: 0, applied: false, reason: 'ufw library not usable: TypeError()' });
      runCommandStub.withArgs('python3', ufwRun(['prepend', 'limit', 'to', 'any', 'app', 'OpenSSH'])).callsFake(async (cmd, options) => {
        options.params.unshift(cmd);
        return { error: new Error('exit 1'), stdout: '', stderr: "ERROR: Could not find a profile matching 'OpenSSH'" };
      });

      await fluxNetworkHelper.adjustFirewall();

      sinon.assert.calledOnceWithExactly(publishStub, 'firewall:adjusted', { outboundRemoved: 0, rulesFailed: ['prepend limit to any app OpenSSH'], appliedBy: 'commands' });
    });

    it('should apply the rules one ufw command each when the applier fails', async () => {
      firewallEnabled(true);
      applier({ error: Object.assign(new Error('command failed'), { code: 1 }), stdout: '', stderr: 'Traceback: no such file' });

      await fluxNetworkHelper.adjustFirewall();

      sinon.assert.calledWith(warnSpy, 'Firewall applier failed: Traceback: no such file');
      expect(ufwCalls()).to.include('allow 16127');
      expect(ufwCalls()).to.not.include('reload');
      sinon.assert.calledOnceWithExactly(publishStub, 'firewall:adjusted', { outboundRemoved: 0, rulesFailed: [], appliedBy: 'commands' });
    });

    it('should stop at the first ufw command that outruns the lock wait, and report the firewall locked', async () => {
      // A ufw command waits on ufw's lock for as long as it is held: one killed
      // at the wait was waiting on it, and every later one would wait too.
      firewallEnabled(true);
      answered({ removed: 0, applied: false, reason: 'ufw library not usable: TypeError()' });
      runCommandStub.withArgs('python3', ufwRun(['allow', '16127'])).resolves({ error: Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), stdout: '', stderr: '' });

      await fluxNetworkHelper.adjustFirewall();

      const calls = ufwCalls();
      expect(calls[calls.length - 1]).to.equal('allow 16127');
      sinon.assert.calledOnceWithExactly(publishStub, 'firewall:locked', {});
      sinon.assert.neverCalledWith(publishStub, 'firewall:adjusted');
    });

    it('should change nothing, and ask ufw nothing, when the firewall is not enabled', async () => {
      firewallEnabled(false);

      await fluxNetworkHelper.adjustFirewall();

      expect(runCommandStub.getCalls().filter(ufwArgs)).to.deep.equal([]);
      sinon.assert.neverCalledWith(runCommandStub, 'python3');
      sinon.assert.notCalled(publishStub);
    });
  });

  describe('isCommunicationEstablished tests', () => {
    const minNumberOfIncoming = 4;
    const minNumberOfOutgoing = 8;

    const generateResponse = () => {
      const res = { test: 'testing' };
      res.status = sinon.stub().returns(res);
      res.json = sinon.fake((param) => param);
      return res;
    };
    const populatePeers = (numberOfincomingPeers, numberOfOutgoingPeers) => {
      peerManager.reset();
      const baseIp = '192.168.0.';
      for (let i = 1; i <= numberOfincomingPeers; i += 1) {
        const ws = {
          ip: `${baseIp}${i}`,
          port: '16127',
          readyState: WebSocket.OPEN,
          close: sinon.stub(),
          ping: sinon.stub(),
          on: sinon.stub(),
        };
        peerManager.add(ws, `${baseIp}${i}`, '16127', { source: PEER_SOURCE.INBOUND });
      }

      for (let i = 1; i <= numberOfOutgoingPeers; i += 1) {
        const ws = {
          ip: `${baseIp}${100 + i}`,
          port: '16127',
          readyState: WebSocket.OPEN,
          close: sinon.stub(),
          ping: sinon.stub(),
          on: sinon.stub(),
        };
        peerManager.add(ws, `${baseIp}${100 + i}`, '16127', { source: PEER_SOURCE.RANDOM });
      }
    };

    afterEach(() => {
      peerManager.reset();
      sinon.restore();
    });

    it('is established with the minimum of each', () => {
      populatePeers(minNumberOfIncoming, minNumberOfOutgoing);

      expect(fluxNetworkHelper.isCommunicationEstablished()).to.deep.equal({ established: true });
    });

    it('is not established with too few incoming peers, and says so', () => {
      populatePeers(minNumberOfIncoming - 1, minNumberOfOutgoing);

      expect(fluxNetworkHelper.isCommunicationEstablished()).to.deep.equal({
        established: false, reason: 'Not enough incoming connections from Flux network. Minimum required 4 found 3',
      });
    });

    it('is not established with too few outgoing peers, and says so', () => {
      populatePeers(minNumberOfIncoming, minNumberOfOutgoing - 1);

      expect(fluxNetworkHelper.isCommunicationEstablished()).to.deep.equal({
        established: false, reason: 'Not enough outgoing connections established to Flux network. Minimum required 8 found 7',
      });
    });

    it('names the outgoing shortfall first when both are short', () => {
      populatePeers(minNumberOfIncoming - 1, minNumberOfOutgoing - 1);

      expect(fluxNetworkHelper.isCommunicationEstablished().reason).to.equal('Not enough outgoing connections established to Flux network. Minimum required 8 found 7');
    });

    it('answers the route with a success message when established', () => {
      const res = generateResponse();
      populatePeers(minNumberOfIncoming, minNumberOfOutgoing);

      fluxNetworkHelper.isCommunicationEstablishedAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success', data: { code: undefined, name: undefined, message: 'Communication to Flux network is properly established' },
      });
    });

    it('answers the route with the shortfall as an error message', () => {
      const res = generateResponse();
      populatePeers(minNumberOfIncoming - 1, minNumberOfOutgoing);

      fluxNetworkHelper.isCommunicationEstablishedAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error', data: { code: undefined, name: undefined, message: 'Not enough incoming connections from Flux network. Minimum required 4 found 3' },
      });
    });
  });

  describe('fluxUptime tests', () => {
    const ut = process.uptime();

    it('is the whole seconds this process has run', () => {
      const uptime = fluxNetworkHelper.fluxUptime();

      // Floored, and uptime only increases: at least the floor of the earlier
      // reading, at most the raw reading now.
      expect(uptime).to.be.gte(Math.floor(ut));
      expect(uptime).to.be.lte(process.uptime());
    });

    it('answers the route with it as data', () => {
      const res = { json: sinon.stub() };

      fluxNetworkHelper.fluxUptimeAPI({}, res);

      const [message] = res.json.firstCall.args;
      expect(message.status).to.equal('success');
      expect(message.data).to.be.a('number').and.gte(Math.floor(ut));
    });
  });

  describe('remove flux container access to private address space tests', () => {
    let runCommandStub;
    let infoLogSpy;
    let errorLogSpy;

    // iptables is invoked with an argv list, so the cases below rebuild the readable command
    // they match on
    const invocation = (cmd, options) => `${cmd} ${options.params.join(' ')}`;
    const ok = (stdout = '') => ({ error: null, stdout });
    const failed = () => ({ error: new Error(), stdout: '' });
    const chainListing = `Chain DOCKER-USER (0 references)
          target     prot opt source               destination`;

    beforeEach(() => {
      // hide console output from logs, but still get logging spy
      sinon.stub(console, 'log');
      runCommandStub = sinon.stub(serviceHelper, 'runCommand');
      infoLogSpy = sinon.spy(log, 'info');
      errorLogSpy = sinon.spy(log, 'error');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return false if the iptables binary does not exist', async () => {
      runCommandStub.callsFake(async (cmd, options) => (
        invocation(cmd, options) === 'iptables --version' ? failed() : ok()));

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);
      expect(result).to.eql(false);
      sinon.assert.calledOnceWithMatch(runCommandStub, 'iptables', { runAsRoot: true, params: ['--version'] });
      sinon.assert.calledWith(errorLogSpy, 'Unable to find iptables binary');
    });

    it('should add the DOCKER-USER chain to iptables if it is missing', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        // chain doesn't exist
        if (command === 'iptables -L DOCKER-USER') return failed();
        return ok();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);
      expect(result).to.eql(true);

      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-L', 'DOCKER-USER'] });
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-N', 'DOCKER-USER'] });
      sinon.assert.calledWith(infoLogSpy, 'IPTABLES: DOCKER-USER chain created');
      sinon.assert.notCalled(errorLogSpy);
    });

    it('should skip addding the DOCKER-USER chain to iptables if it already exists', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        return ok();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(true);
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-L', 'DOCKER-USER'] });
      sinon.assert.neverCalledWithMatch(runCommandStub, 'iptables', { params: ['-N', 'DOCKER-USER'] });
      sinon.assert.calledWith(infoLogSpy, 'IPTABLES: DOCKER-USER chain already created');
      sinon.assert.notCalled(errorLogSpy);
    });

    it('should bail out if there is an error addding the DOCKER-USER chain to iptables', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        // fail for both -L and -N (failing on -L is normal)
        return failed();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(false);
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-L', 'DOCKER-USER'] });
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-N', 'DOCKER-USER'] });
      sinon.assert.notCalled(infoLogSpy);
      sinon.assert.calledOnceWithExactly(errorLogSpy, 'IPTABLES: Error adding DOCKER-USER chain');
    });

    it('should add the jump to DOCKER-USER chain from FORWARD chain to iptables if it is missing', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        if (command === 'iptables -C FORWARD -j DOCKER-USER') {
          return { error: new Error('iptables: Bad rule (does a matching rule exist in that chain?).'), stdout: '' };
        }
        return ok();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(true);
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-C', 'FORWARD', '-j', 'DOCKER-USER'] });
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-I', 'FORWARD', '-j', 'DOCKER-USER'] });

      sinon.assert.calledWith(infoLogSpy, 'IPTABLES: New rule in FORWARD inserted to jump to DOCKER-USER chain');
      sinon.assert.notCalled(errorLogSpy);
    });

    it('should skip adding the jump to DOCKER-USER chain from FORWARD chain to iptables if it already exists', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        return ok();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(true);
      sinon.assert.neverCalledWithMatch(runCommandStub, 'iptables', { params: ['-I', 'FORWARD', '-j', 'DOCKER-USER'] });

      sinon.assert.calledWith(infoLogSpy, 'IPTABLES: Jump to DOCKER-USER chain already enabled');
      sinon.assert.notCalled(errorLogSpy);
    });

    it('should bail out if there is an error adding the jump to the DOCKER-USER chain', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        if (command === 'iptables -C FORWARD -j DOCKER-USER') {
          return { error: new Error('iptables: Bad rule (does a matching rule exist in that chain?).'), stdout: '' };
        }
        return failed();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(false);
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-C', 'FORWARD', '-j', 'DOCKER-USER'] });
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-I', 'FORWARD', '-j', 'DOCKER-USER'] });

      sinon.assert.neverCalledWith(infoLogSpy, 'IPTABLES: New rule in FORWARD inserted to jump to DOCKER-USER chain');
      expect(infoLogSpy.callCount).to.eql(1);
      sinon.assert.calledOnceWithExactly(errorLogSpy, 'IPTABLES: Error inserting FORWARD jump to DOCKER-USER chain');
    });

    it('should flush the DOCKER-USER chain', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        return ok();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(true);
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-F', 'DOCKER-USER'] });
      sinon.assert.notCalled(errorLogSpy);
    });

    it('should bail out if there is an error flushing the DOCKER-USER chain', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        if (command === 'iptables -C FORWARD -j DOCKER-USER') return ok();
        return failed();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(false);
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-F', 'DOCKER-USER'] });
      sinon.assert.calledOnceWithExactly(errorLogSpy, 'IPTABLES: Error flushing DOCKER-USER table. Error');
      expect(runCommandStub.callCount).to.eql(4);
    });

    it('should add two allow and one drop rule for each private network', async () => {
      const networks = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        return ok();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(true);

      // eslint-disable-next-line no-restricted-syntax
      for (const network of networks) {
        sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-I', 'DOCKER-USER', '-s', '172.23.0.0/16', '-d', network, '-p', 'udp', '--dport', '53', '-j', 'ACCEPT'] });
        sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-I', 'DOCKER-USER', '-s', '172.23.0.0/16', '-d', network, '-m', 'state', '--state', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'] });
        sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-A', 'DOCKER-USER', '-s', '172.23.0.0/16', '-d', network, '-j', 'DROP'] });
      }

      // 2 for the CHAIN rules, 1 FLUSH, 1 docker0 allow, 9 for the adds and 1 for the RETURN
      expect(infoLogSpy.callCount).to.eql(14);
      sinon.assert.notCalled(errorLogSpy);
    });

    it('should add an allow for intra-network traffic per docker network', async () => {
      const interfaces = ['br-aaf87aa57b20', 'br-098bac43a7f1'];

      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        return ok();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable(interfaces);

      expect(result).to.eql(true);

      // eslint-disable-next-line no-restricted-syntax
      for (const int of interfaces) {
        sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-I', 'DOCKER-USER', '-i', int, '-o', int, '-j', 'ACCEPT'] });
      }
      sinon.assert.calledWithMatch(runCommandStub, 'iptables', { params: ['-I', 'DOCKER-USER', '-i', 'docker0', '-o', 'docker0', '-j', 'ACCEPT'] });

      // 2 for the CHAIN rules, 1 FLUSH, 1 docker0 allow, 2 interface allows, 9 for the adds and 1 for the RETURN
      expect(infoLogSpy.callCount).to.eql(16);
      sinon.assert.notCalled(errorLogSpy);
    });

    it('should bail out as soon as a rule errors out', async () => {
      runCommandStub.callsFake(async (cmd, options) => {
        const command = invocation(cmd, options);
        if (command === 'iptables --version') return ok('iptables v1.8.7 (nf_tables)');
        if (command === 'iptables -L DOCKER-USER') return ok(chainListing);
        if (command === 'iptables -C FORWARD -j DOCKER-USER') return ok();
        // this is the rule under test
        if (command === 'iptables -I DOCKER-USER -i docker0 -o docker0 -j ACCEPT') return failed();
        return ok();
      });

      const result = await fluxNetworkHelper.removeDockerContainerAccessToNonRoutable([]);

      expect(result).to.eql(false);
      expect(runCommandStub.callCount).to.eql(5);

      sinon.assert.calledOnceWithExactly(errorLogSpy, 'IPTABLES: Error allowing traffic on Flux interface docker0. Error');
    });
  });

  describe('local socket address announcements', () => {
    afterEach(() => {
      // Setting the address also tells the peer manager; a later suite must not
      // find this node at the address these tests gave it.
      fluxNetworkHelper.setLocalSocketAddress(null);
      sinon.restore();
    });

    it('announces an address only when it differs from the last one learned', () => {
      const listener = sinon.spy();
      fluxNetworkHelper.onLocalSocketAddressChange(listener);

      fluxNetworkHelper.setLocalSocketAddress('198.51.100.10');
      fluxNetworkHelper.setLocalSocketAddress('198.51.100.10:16127');
      fluxNetworkHelper.setLocalSocketAddress(null);
      fluxNetworkHelper.setLocalSocketAddress('198.51.100.10');
      fluxNetworkHelper.setLocalSocketAddress('198.51.100.11:16137');
      fluxNetworkHelper.offLocalSocketAddressChange(listener);
      fluxNetworkHelper.setLocalSocketAddress('198.51.100.12');

      expect(listener.args).to.eql([['198.51.100.10:16127'], ['198.51.100.11:16137']]);
      expect(fluxNetworkHelper.getKnownLocalSocketAddress()).to.equal('198.51.100.12:16127');
    });

    it('keeps the last address learned when the benchmark stops answering', () => {
      fluxNetworkHelper.setLocalSocketAddress('198.51.100.20');
      fluxNetworkHelper.setLocalSocketAddress(null);

      expect(fluxNetworkHelper.getKnownLocalSocketAddress()).to.equal('198.51.100.20:16127');
    });
  });

  describe('hasPublicIpOnInterface', () => {
    afterEach(() => {
      sinon.restore();
    });

    it('is true for a public address on the device the traffic leaves by', async () => {
      sinon.stub(dgram, 'createSocket').returns(fakeUdpSocket({ source: '203.0.113.7' }));
      sinon.stub(os, 'networkInterfaces').returns({
        eth0: [{ family: 'IPv4', internal: false, address: '203.0.113.7' }],
      });

      expect(await fluxNetworkHelper.hasPublicIpOnInterface()).to.equal(true);
    });

    it('finds a public address that is not the first one on the device', async () => {
      // An interface can carry a private primary and a public secondary - the
      // shape add-on and failover addresses arrive in. The kernel picks the
      // primary as the source; the device still holds the public address.
      sinon.stub(dgram, 'createSocket').returns(fakeUdpSocket({ source: '192.168.1.50' }));
      sinon.stub(os, 'networkInterfaces').returns({
        eth0: [
          { family: 'IPv4', internal: false, address: '192.168.1.50' },
          { family: 'IPv4', internal: false, address: '203.0.113.7' },
        ],
      });

      expect(await fluxNetworkHelper.hasPublicIpOnInterface()).to.equal(true);
    });

    it('finds a public address bound under a label on the device', async () => {
      sinon.stub(dgram, 'createSocket').returns(fakeUdpSocket({ source: '192.168.1.50' }));
      sinon.stub(os, 'networkInterfaces').returns({
        eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.50' }],
        'eth0:1': [{ family: 'IPv4', internal: false, address: '203.0.113.7' }],
      });

      expect(await fluxNetworkHelper.hasPublicIpOnInterface()).to.equal(true);
    });

    it('is false behind NAT', async () => {
      sinon.stub(dgram, 'createSocket').returns(fakeUdpSocket({ source: '192.168.1.50' }));
      sinon.stub(os, 'networkInterfaces').returns({
        eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.50' }],
      });

      expect(await fluxNetworkHelper.hasPublicIpOnInterface()).to.equal(false);
    });

    it('is false for a public address on a device the traffic does not leave by', async () => {
      // A wg-quick full tunnel: the public address stays on eth0 while every
      // packet leaves by wg0.
      sinon.stub(dgram, 'createSocket').returns(fakeUdpSocket({ source: '10.66.0.2' }));
      sinon.stub(os, 'networkInterfaces').returns({
        eth0: [{ family: 'IPv4', internal: false, address: '203.0.113.7' }],
        wg0: [{ family: 'IPv4', internal: false, address: '10.66.0.2' }],
      });

      expect(await fluxNetworkHelper.hasPublicIpOnInterface()).to.equal(false);
    });

    it('is NULL, not false, when the device cannot be named', async () => {
      // "No public address on the device" is a fact about the node and means it
      // is behind NAT; "no route out" is not an answer to that question.
      sinon.stub(dgram, 'createSocket').returns(fakeUdpSocket({ error: Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }) }));

      expect(await fluxNetworkHelper.hasPublicIpOnInterface()).to.equal(null);
    });
  });

  describe('interfaceDevice', () => {
    it('names the device a labelled address is bound on', () => {
      expect(fluxNetworkHelper.interfaceDevice('eth0:1')).to.equal('eth0');
    });

    it('names an unlabelled interface as itself', () => {
      expect(fluxNetworkHelper.interfaceDevice('enp3s0')).to.equal('enp3s0');
    });
  });

  describe('egressDevice', () => {
    let socket;

    afterEach(() => {
      sinon.restore();
    });

    it('names the device holding the source address the kernel chose', async () => {
      socket = fakeUdpSocket({ source: '10.66.0.2' });
      sinon.stub(dgram, 'createSocket').returns(socket);
      sinon.stub(os, 'networkInterfaces').returns({
        eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
        wg0: [{ family: 'IPv4', internal: false, address: '10.66.0.2' }],
      });

      expect(await fluxNetworkHelper.egressDevice('1.1.1.1')).to.equal('wg0');
      sinon.assert.calledWith(socket.connect, sinon.match.number, '1.1.1.1');
      sinon.assert.calledOnce(socket.close);
    });

    it('names the device when the source address is bound under a label', async () => {
      socket = fakeUdpSocket({ source: '203.0.113.7' });
      sinon.stub(dgram, 'createSocket').returns(socket);
      sinon.stub(os, 'networkInterfaces').returns({
        eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
        'eth0:1': [{ family: 'IPv4', internal: false, address: '203.0.113.7' }],
      });

      expect(await fluxNetworkHelper.egressDevice('1.1.1.1')).to.equal('eth0');
    });

    it('is null when the source address is on no listed interface', async () => {
      socket = fakeUdpSocket({ source: '10.8.0.2' });
      sinon.stub(dgram, 'createSocket').returns(socket);
      sinon.stub(os, 'networkInterfaces').returns({
        eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
      });

      expect(await fluxNetworkHelper.egressDevice('1.1.1.1')).to.equal(null);
    });

    it('is null, and closes the socket, when there is no route', async () => {
      socket = fakeUdpSocket({ error: Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }) });
      sinon.stub(dgram, 'createSocket').returns(socket);
      const interfaces = sinon.stub(os, 'networkInterfaces');

      expect(await fluxNetworkHelper.egressDevice('1.1.1.1')).to.equal(null);
      sinon.assert.calledOnce(socket.close);
      sinon.assert.notCalled(interfaces);
    });
  });
});
