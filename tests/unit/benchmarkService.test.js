'use strict';

const chai = require('chai');
const sinon = require('sinon');

const { PassThrough } = require('stream');

const fluxRpc = require('../../ZelBack/src/services/utils/fluxRpc');
const { Privilege, authOf } = require('../../ZelBack/src/services/utils/privileges');
const fs = require('node:fs/promises');

const { expect } = chai;
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');

describe('benchmarkService tests', () => {
  describe('executeCall tests', () => {
    let benchmarkStub;

    beforeEach(() => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return a sucessful response if called properly with no parameters', async () => {
      const executeCallResult = await benchmarkService.executeCall('getstatus');
      expect(executeCallResult).to.be.an('object');
      expect(executeCallResult.status).to.equal('success');
      expect(executeCallResult.data).to.equal('called');
      sinon.assert.calledOnceWithExactly(benchmarkStub, 'getstatus', { params: [] });
    });

    it('should return a sucessful response if called properly with parameters', async () => {
      const params = ['test', 10, '192.168.0.0'];

      const executeCallResult = await benchmarkService.executeCall('getstatus', params);

      expect(executeCallResult).to.be.an('object');
      expect(executeCallResult.status).to.equal('success');
      sinon.assert.calledOnceWithExactly(benchmarkStub, 'getstatus', { params });
    });

    it('should throw error if called function does not exist', async () => {
      benchmarkStub.rejects(new Error('Invalid Method: testing123'));

      const expectedErrorMessage = {
        status: 'error',
        data: {
          code: undefined,
          message: 'Invalid Method: testing123',
          name: 'Error',
        },
      };
      const executeCallRes = await benchmarkService.executeCall('testing123');

      expect(executeCallRes).to.eql(expectedErrorMessage);
    });

    it('should throw error if parameter is not an iterable', async () => {
      benchmarkStub.rejects(new Error('Params must be an Array'));

      const params = {
        test: 'test1',
        test2: 'test3',
      };
      const expectedErrorMessage = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'Params must be an Array',
        },
      };
      const executeCallRes = await benchmarkService.executeCall('getstatus', params);

      expect(executeCallRes).to.eql(expectedErrorMessage);
    });
  });

  describe('transport methods', () => {
    let benchmarkStub;

    beforeEach(() => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should request the transport public key as a url-encoded query string', async () => {
      await benchmarkService.transportPublicKey({ appName: 'my app', fluxID: '1abc/def' });

      sinon.assert.calledOnceWithExactly(benchmarkStub, 'transportpublickey', {
        params: ['appName=my%20app&fluxID=1abc%2Fdef'],
      });
    });

    it('should send the transport decap payload as a single stringified param', async () => {
      const payload = {
        appName: 'myapp', fluxID: '1xyz', encapsulatedKey: 'ek',
      };

      await benchmarkService.transportDecap(payload);

      sinon.assert.calledOnceWithExactly(benchmarkStub, 'transportdecap', {
        params: [JSON.stringify(payload)],
      });
    });
  });

  describe('attestation methods', () => {
    let benchmarkStub;

    beforeEach(() => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should send the attest payload as a single stringified param', async () => {
      const payload = { message: 'FLUX_ARCANE_ATTEST_v1deadbeef' };

      await benchmarkService.attest(payload);

      sinon.assert.calledOnceWithExactly(benchmarkStub, 'attest', {
        params: [JSON.stringify(payload)],
      });
    });
  });

  describe('getStatus tests', () => {
    let benchmarkStub;

    beforeEach(() => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('answers the daemon\'s value', async () => {
      expect(await benchmarkService.getStatus()).to.deep.equal({ value: 'called' });
      sinon.assert.calledOnce(benchmarkStub);
    });

    it('answers why there is no value when the call fails', async () => {
      benchmarkStub.rejects(Object.assign(new Error('benchmark down'), { code: 'EDOWN' }));

      expect(await benchmarkService.getStatus()).to.deep.equal({
        value: null, reason: { code: 'EDOWN', name: 'Error', message: 'benchmark down' },
      });
    });

    it('answers its route with the value as data', async () => {
      const res = { json: sinon.stub() };

      await benchmarkService.getStatusAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 'called' });
    });

    it('answers its route with the reason as an error', async () => {
      benchmarkStub.rejects(Object.assign(new Error('benchmark down'), { code: 'EDOWN' }));
      const res = { json: sinon.stub() };

      await benchmarkService.getStatusAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'error', data: { code: 'EDOWN', name: 'Error', message: 'benchmark down' } });
    });
  });

  describe('restartNodeBenchmarks tests', () => {
    let benchmarkStub;
    let verificationHelperStub;

    beforeEach(async () => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    // No need to test specific privilege - function has been tested in verification helper
    it('should return a sucessful response if called without parameters by an authorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNN7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
      };

      const restartNodeBenchmarksResult = await benchmarkService.restartNodeBenchmarks(req);

      expect(restartNodeBenchmarksResult).to.be.an('object');
      expect(restartNodeBenchmarksResult.status).to.equal('success');
      expect(restartNodeBenchmarksResult.data).to.equal('called');
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should return a sucessful response if called with parameters by an authorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNN7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
      };
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedSuccessMessage = { status: 'success', data: 'called' };

      await benchmarkService.restartNodeBenchmarks(req, mockResponse);

      sinon.assert.calledOnce(benchmarkStub);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedSuccessMessage);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
    });

    it('should return an access denied response if called without parameters by an unauthorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(false);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uV',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNN7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBx=',
          },
        },
      };
      const restartNodeBenchmarksResult = await benchmarkService.restartNodeBenchmarks(req);

      expect(restartNodeBenchmarksResult).to.be.an('object');
      expect(restartNodeBenchmarksResult.status).to.equal('error');
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR_OR_FLUX_TEAM, authOf(req));
      sinon.assert.notCalled(benchmarkStub);
    });
  });

  describe('signFluxTransaction tests', () => {
    let benchmarkStub;
    let verificationHelperStub;

    beforeEach(async () => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return a sucessful response if called without parameters by an authorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNN7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
        params: {
          hexstring: '0x0123ABCDF',
        },
      };
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedSuccessMessage = { status: 'success', data: 'called' };

      await benchmarkService.signFluxTransaction(req, mockResponse);

      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedSuccessMessage);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR, authOf(req));
      sinon.assert.calledOnceWithExactly(benchmarkStub, 'signzelnodetransaction', { params: [req.params.hexstring] });
    });

    it('should return a sucessful response if called with parameters by an authorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uZ',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNx7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
        params: {
          hexstring: '0x0123ABCDF',
        },
      };
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedSuccessMessage = { status: 'success', data: 'called' };

      await benchmarkService.signFluxTransaction(req, mockResponse);

      sinon.assert.calledOnce(benchmarkStub);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedSuccessMessage);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR, authOf(req));
      sinon.assert.calledOnceWithExactly(benchmarkStub, 'signzelnodetransaction', { params: [req.params.hexstring] });
    });

    it('should return an access denied response if called without parameters by an unauthorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(false);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNN7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
        params: {
          hexstring: '0x0123ABCDF',
        },
      };
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedErrorMessage = {
        status: 'error',
        data: {
          code: 401,
          name: 'Unauthorized',
          message: 'Unauthorized. Access denied.',
        },
      };

      await benchmarkService.signFluxTransaction(req, mockResponse);

      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedErrorMessage);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR, authOf(req));
      sinon.assert.notCalled(benchmarkStub);
    });
  });

  describe.skip('signFluxTransactionPost tests', () => {
    // TODO: These tests are going to be altered when we're switching all requests from streams to body.parse.
    // As they are right now - it's almost impossible to test without actually starting the deamon or without using hacky workarounds

    beforeEach(async () => {
      sinon.stub(fs, 'stat').resolves(true);
      sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should sign flux transaction if called properly', async () => {
      sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);

      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNN7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
        params: {
          hexstring: '0x0123ABCDF',
        },
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(req));
      mockStream.end();
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedSuccessMessage = { status: 'success', data: 'called' };

      await benchmarkService.signFluxTransactionPost(mockStream, mockResponse);

      sinon.assert.calledOnce(mockResponse.json);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedSuccessMessage);
    });
  });

  describe('help tests', () => {
    let benchmarkStub;

    beforeEach(async () => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return a sucessful response if called with response', async () => {
      const req = {
        params: {
          command: 'testing',
        },
      };
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedSuccessMessage = { status: 'success', data: 'called' };

      await benchmarkService.help(req, mockResponse);

      sinon.assert.calledOnce(benchmarkStub);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedSuccessMessage);
      sinon.assert.calledOnceWithExactly(benchmarkStub, 'help', { params: [req.params.command] });
    });

    it('should return a sucessful response if called with paramaters in query', async () => {
      const req = {
        params: {
          test: 'something',
        },
        query: {
          command: 'test',
        },
      };
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedSuccessMessage = { status: 'success', data: 'called' };

      await benchmarkService.help(req, mockResponse);

      sinon.assert.calledOnce(benchmarkStub);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedSuccessMessage);
      sinon.assert.calledOnceWithExactly(benchmarkStub, 'help', { params: [req.query.command] });
    });

    it('should return a sucessful response if called without parameters in query or params', async () => {
      const req = {
        params: {
          test: 'something',
        },
        query: {
          test2: 'test3',
        },
      };
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedSuccessMessage = { status: 'success', data: 'called' };

      await benchmarkService.help(req, mockResponse);

      sinon.assert.calledOnce(benchmarkStub);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedSuccessMessage);
      sinon.assert.calledOnceWithExactly(benchmarkStub, 'help', { params: [''] });
    });
  });

  describe('stop tests', () => {
    let benchmarkStub;
    let verificationHelperStub;

    beforeEach(async () => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return a sucessful response if called without parameters by an authorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNN7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
      };

      const signFluxTransactionResult = await benchmarkService.stop(req);

      expect(signFluxTransactionResult).to.be.an('object');
      expect(signFluxTransactionResult.status).to.equal('success');
      expect(signFluxTransactionResult.data).to.equal('called');
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR, authOf(req));
      sinon.assert.calledOnce(benchmarkStub);
    });

    it('should return a sucessful response if called with parameters by an authorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(true);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uZ',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNx7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
      };
      const generateResponse = () => {
        const res = { test: 'testing' };
        res.status = sinon.stub().returns(res);
        res.json = sinon.stub().returns(res);
        return res;
      };
      const mockResponse = generateResponse();
      const expectedSuccessMessage = { status: 'success', data: 'called' };

      await benchmarkService.stop(req, mockResponse);

      sinon.assert.calledOnce(benchmarkStub);
      sinon.assert.calledOnceWithExactly(mockResponse.json, expectedSuccessMessage);
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR, authOf(req));
    });

    it('should return an access denied response if called without parameters by an unauthorized party', async () => {
      verificationHelperStub = sinon.stub(verificationHelper, 'verifyPrivilege').returns(false);
      const req = {
        headers: {
          zelidauth: {
            zelid: '1CbErtneaX2QVyUfwU7JGB7VzvPgrgc3uC',
            loginPhrase: '16125160820394ddsh5skgwv0ipodku92y0jbwvpyj17bh68lzrjlxq9',
            signature: 'IH9d68fk/dYQtuMlNN7ioc52MJ6ryRT0IYss6h/KCwVWGcbVNFoI8Jh6hIklRq+w2itV/6vs/xzCWp4TUdSWDBc=',
          },
        },
      };
      const signFluxTransactionResult = await benchmarkService.stop(req);

      expect(signFluxTransactionResult).to.be.an('object');
      expect(signFluxTransactionResult.status).to.equal('error');
      sinon.assert.calledOnceWithExactly(verificationHelperStub, Privilege.NODE_OPERATOR, authOf(req));
      sinon.assert.notCalled(benchmarkStub);
    });
  });

  describe('getBenchmarks tests', () => {
    let benchmarkStub;

    beforeEach(() => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('answers the daemon\'s value', async () => {
      expect(await benchmarkService.getBenchmarks()).to.deep.equal({ value: 'called' });
      sinon.assert.calledOnce(benchmarkStub);
    });

    it('answers why there is no value when the call fails', async () => {
      benchmarkStub.rejects(Object.assign(new Error('benchmark down'), { code: 'EDOWN' }));

      expect(await benchmarkService.getBenchmarks()).to.deep.equal({
        value: null, reason: { code: 'EDOWN', name: 'Error', message: 'benchmark down' },
      });
    });

    it('answers its route with the value as data', async () => {
      const res = { json: sinon.stub() };

      await benchmarkService.getBenchmarksAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 'called' });
    });

    it('answers its route with the reason as an error', async () => {
      benchmarkStub.rejects(Object.assign(new Error('benchmark down'), { code: 'EDOWN' }));
      const res = { json: sinon.stub() };

      await benchmarkService.getBenchmarksAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'error', data: { code: 'EDOWN', name: 'Error', message: 'benchmark down' } });
    });
  });

  describe('getInfo tests', () => {
    let benchmarkStub;

    beforeEach(() => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('answers the daemon\'s value', async () => {
      expect(await benchmarkService.getInfo()).to.deep.equal({ value: 'called' });
      sinon.assert.calledOnce(benchmarkStub);
    });

    it('answers why there is no value when the call fails', async () => {
      benchmarkStub.rejects(Object.assign(new Error('benchmark down'), { code: 'EDOWN' }));

      expect(await benchmarkService.getInfo()).to.deep.equal({
        value: null, reason: { code: 'EDOWN', name: 'Error', message: 'benchmark down' },
      });
    });

    it('answers its route with the value as data', async () => {
      const res = { json: sinon.stub() };

      await benchmarkService.getInfoAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 'called' });
    });

    it('answers its route with the reason as an error', async () => {
      benchmarkStub.rejects(Object.assign(new Error('benchmark down'), { code: 'EDOWN' }));
      const res = { json: sinon.stub() };

      await benchmarkService.getInfoAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'error', data: { code: 'EDOWN', name: 'Error', message: 'benchmark down' } });
    });
  });

  describe('getPublicIp tests', () => {
    let benchmarkStub;

    beforeEach(() => {
      sinon.stub(fs, 'stat').resolves(true);
      benchmarkStub = sinon.stub(fluxRpc.FluxRpc.prototype, 'run').resolves('called');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('answers the daemon\'s value', async () => {
      expect(await benchmarkService.getPublicIp()).to.deep.equal({ value: 'called' });
      sinon.assert.calledOnce(benchmarkStub);
    });

    it('answers why there is no value when the call fails', async () => {
      benchmarkStub.rejects(Object.assign(new Error('benchmark down'), { code: 'EDOWN' }));

      expect(await benchmarkService.getPublicIp()).to.deep.equal({
        value: null, reason: { code: 'EDOWN', name: 'Error', message: 'benchmark down' },
      });
    });
  });
});
