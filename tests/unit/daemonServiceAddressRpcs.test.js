'use strict';

const sinon = require('sinon');
const { PassThrough } = require('stream');
const { expect } = require('chai');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const daemonServiceAddressRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceAddressRpcs');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');

const generateResponse = () => {
  const res = { test: 'testing' };
  res.status = sinon.stub().returns(res);
  res.json = sinon.fake((param) => param);
  return res;
};

describe('daemonServiceAddressRpcs tests', () => {
  describe('getAddressTxids tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should return transactions\' ids for specified address(es)', async () => {
      daemonServiceUtilsStub.resolves('success');
      const params = {
        addresses: '12QSasdfggYy4sditOpQzsee',
        start: 1_670_654_443,
        end: 167_068_000,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressTxids(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddresstxids', [params]);
      sinon.assert.calledOnceWithExactly(res.json, 'success');
    });

    it('should call rpc even without parameters', async () => {
      daemonServiceUtilsStub.resolves('NoParamsGiven');
      const params = {
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressTxids(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddresstxids', [{ addresses: undefined }]);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParamsGiven');
    });
  });

  describe('getSingleAddresssTxids tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: 'answer' });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('asks the daemon about the address', async () => {
      expect(await daemonServiceAddressRpcs.getSingleAddresssTxids('t1abc', 100, 200)).to.deep.equal({ value: 'answer' });
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddresstxids', [{ addresses: ['t1abc'], start: 100, end: 200 }]);
    });

    it('answers why there is no value when the daemon refuses', async () => {
      daemonServiceUtilsStub.resolves({ status: 'error', data: { code: -5, message: 'Invalid address' } });

      expect(await daemonServiceAddressRpcs.getSingleAddresssTxids('t1abc', 100, 200)).to.deep.equal({ value: null, reason: { code: -5, message: 'Invalid address' } });
    });

    it('takes what its route is asked for', async () => {
      const res = { json: sinon.stub() };

      await daemonServiceAddressRpcs.getSingleAddresssTxidsAPI({ params: { address: 't1abc' }, query: { start: '100', end: '200' } }, res);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddresstxids', [{ addresses: ['t1abc'], start: 100, end: 200 }]);
      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 'answer' });
    });

    it('asks for every height when none is given', async () => {
      await daemonServiceAddressRpcs.getSingleAddresssTxids('t1abc');

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddresstxids', [{ addresses: ['t1abc'] }]);
    });
  });

  describe('getAddressBalance tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should call getAddressBalance rpc', async () => {
      daemonServiceUtilsStub.resolves('success');
      const params = {
        addresses: '12QSasdfggYy4sditOpQzsee',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressBalance(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressbalance', [params]);
      sinon.assert.calledOnceWithExactly(res.json, 'success');
    });

    it('should call rpc even without parameters', async () => {
      daemonServiceUtilsStub.resolves('NoParamsGiven');
      const params = {
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressBalance(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressbalance', [{ addresses: undefined }]);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParamsGiven');
    });
  });

  describe('getSingleAddressBalance tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: 'answer' });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('asks the daemon about the address', async () => {
      expect(await daemonServiceAddressRpcs.getSingleAddressBalance('t1abc')).to.deep.equal({ value: 'answer' });
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressbalance', [{ addresses: ['t1abc'] }]);
    });

    it('answers why there is no value when the daemon refuses', async () => {
      daemonServiceUtilsStub.resolves({ status: 'error', data: { code: -5, message: 'Invalid address' } });

      expect(await daemonServiceAddressRpcs.getSingleAddressBalance('t1abc')).to.deep.equal({ value: null, reason: { code: -5, message: 'Invalid address' } });
    });

    it('takes what its route is asked for', async () => {
      const res = { json: sinon.stub() };

      await daemonServiceAddressRpcs.getSingleAddressBalanceAPI({ params: {}, query: { address: 't1abc' } }, res);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressbalance', [{ addresses: ['t1abc'] }]);
      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 'answer' });
    });
  });

  describe('getAddressDeltas tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should call getAddressDeltas rpc', async () => {
      daemonServiceUtilsStub.resolves('success');
      const params = {
        addresses: '12QSasdfggYy4sditOpQzsee',
        start: 1_670_654_443,
        end: 167_068_000,
        chaininfo: true,
      };

      const expectedParams = {
        addresses: '12QSasdfggYy4sditOpQzsee',
        start: 1_670_654_443,
        end: 167_068_000,
        chainInfo: true,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressDeltas(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressdeltas', [expectedParams]);
      sinon.assert.calledOnceWithExactly(res.json, 'success');
    });

    it('should call rpc even without parameters', async () => {
      daemonServiceUtilsStub.resolves('NoParamsGiven');
      const params = {
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressDeltas(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressdeltas', [{
        addresses: undefined,
      }]);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParamsGiven');
    });
  });

  describe('getSingleAddressDeltas tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should execute RPC if parameters are passed in params, response passed', async () => {
      const req = {
        params: {
          address: '12QSasdfggYy4sditOpQzsee',
          start: 1_670_654_443,
          end: 167_068_000,
          chaininfo: true,
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = {
        addresses: [req.params.address],
        start: req.params.start,
        end: req.params.end,
        chainInfo: req.params.chaininfo,
      };

      const res = generateResponse();
      await daemonServiceAddressRpcs.getSingleAddressDeltas(req, res);

      sinon.assert.calledOnceWithExactly(res.json, 'success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressdeltas', [expectedParams]);
    });

    it('should execute RPC if parameters are passed in query, response passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          address: '12QSasdfggYy4sditOpQzsee',
          start: 1_670_654_443,
          end: 167_068_000,
          chaininfo: true,
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = {
        addresses: [req.query.address],
        start: req.query.start,
        end: req.query.end,
        chainInfo: req.query.chaininfo,
      };
      const res = generateResponse();

      const result = await daemonServiceAddressRpcs.getSingleAddressDeltas(req, res);

      expect(result).to.eql('success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressdeltas', [expectedParams]);
      sinon.assert.calledOnceWithExactly(res.json, 'success');
    });

    it('should execute RPC if no params are given', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };
      daemonServiceUtilsStub.returns('NoParams');
      const expectedParams = {
        addresses: [req.query.address],
        start: req.query.start,
        end: req.query.end,
        chainInfo: req.query.chaininfo,
      };
      const res = generateResponse();

      const result = await daemonServiceAddressRpcs.getSingleAddressDeltas(req, res);

      expect(result).to.eql('NoParams');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressdeltas', [{ addresses: expectedParams.addresses }]);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParams');
    });
  });

  describe('getAddressUtxos tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should call getAddressDeltas rpc', async () => {
      daemonServiceUtilsStub.resolves('success');
      const params = {
        addresses: '12QSasdfggYy4sditOpQzsee',
        chainInfo: true,
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressUtxos(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressutxos', [params]);
      sinon.assert.calledOnceWithExactly(res.json, 'success');
    });

    it('should call rpc even without parameters', async () => {
      daemonServiceUtilsStub.resolves('NoParamsGiven');
      const params = {
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressUtxos(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressutxos', [{ addresses: undefined, chainInfo: undefined }]);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParamsGiven');
    });
  });

  describe('getSingleAddressUtxos tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: 'answer' });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('asks the daemon about the address', async () => {
      expect(await daemonServiceAddressRpcs.getSingleAddressUtxos('t1abc', true)).to.deep.equal({ value: 'answer' });
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressutxos', [{ addresses: ['t1abc'], chainInfo: true }]);
    });

    it('answers why there is no value when the daemon refuses', async () => {
      daemonServiceUtilsStub.resolves({ status: 'error', data: { code: -5, message: 'Invalid address' } });

      expect(await daemonServiceAddressRpcs.getSingleAddressUtxos('t1abc', true)).to.deep.equal({ value: null, reason: { code: -5, message: 'Invalid address' } });
    });

    it('takes what its route is asked for', async () => {
      const res = { json: sinon.stub() };

      await daemonServiceAddressRpcs.getSingleAddressUtxosAPI({ params: { address: 't1abc', chaininfo: 'true' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressutxos', [{ addresses: ['t1abc'], chainInfo: 'true' }]);
      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 'answer' });
    });
  });

  describe('getAddressMempool tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should call getAddressMempool rpc', async () => {
      daemonServiceUtilsStub.resolves('success');
      const params = {
        addresses: '12QSasdfggYy4sditOpQzsee',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressMempool(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressmempool', [params]);
      sinon.assert.calledOnceWithExactly(res.json, 'success');
    });

    it('should call rpc even without parameters', async () => {
      daemonServiceUtilsStub.resolves('NoParamsGiven');
      const params = {
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceAddressRpcs.getAddressMempool(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressmempool', [{ addresses: undefined }]);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParamsGiven');
    });
  });

  describe('getSingleAddressMempool tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should execute RPC if parameters are passed in params, response passed', async () => {
      const req = {
        params: {
          address: '12QSasdfggYy4sditOpQzsee',
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = {
        addresses: [req.params.address],
      };

      const res = generateResponse();
      await daemonServiceAddressRpcs.getSingleAddressMempool(req, res);

      sinon.assert.calledOnceWithExactly(res.json, 'success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressmempool', [expectedParams]);
    });

    it('should execute RPC if parameters are passed in query, response passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          address: '12QSasdfggYy4sditOpQzsee',
          chaininfo: true,
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = {
        addresses: [req.query.address],
      };
      const res = generateResponse();

      const result = await daemonServiceAddressRpcs.getSingleAddressMempool(req, res);

      expect(result).to.eql('success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressmempool', [expectedParams]);
      sinon.assert.calledOnceWithExactly(res.json, 'success');
    });

    it('should execute RPC if no params are given', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',

        },
      };
      daemonServiceUtilsStub.returns('NoParams');
      const expectedParams = {
        addresses: [req.query.address],
      };
      const res = generateResponse();

      const result = await daemonServiceAddressRpcs.getSingleAddressMempool(req, res);

      expect(result).to.eql('NoParams');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getaddressmempool', [expectedParams]);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParams');
    });
  });
});
