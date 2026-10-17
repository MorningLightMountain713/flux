'use strict';

const sinon = require('sinon');
const { PassThrough } = require('stream');
const { expect } = require('chai');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const daemonServiceBlockchainRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceBlockchainRpcs');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const daemonServiceTransactionRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceTransactionRpcs');

const generateResponse = () => {
  const res = { test: 'testing' };
  res.status = sinon.stub().returns(res);
  res.json = sinon.fake((param) => `Response: ${param}`);
  return res;
};

describe('daemonServiceTransactionRpcs tests', () => {
  describe('createRawTransaction tests', () => {
    let daemonServiceUtilsStub;
    let getBlockCountStub;
    const execCallResult = 'RPC call executed';
    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall').resolves(execCallResult);
      getBlockCountStub = sinon.stub(daemonServiceBlockchainRpcs, 'getBlockCount');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should create a raw transaction if all parameters are set properly - response passed', async () => {
      getBlockCountStub.resolves({ value: 5_243_422 });
      const req = {
        params: {
          transactions: {
            test: 'testtransaction',
            something: 'somethingelse',
          },
          addresses: {
            addr1: '1235asdf',
            addr2: '12344aaaa',
          },
          locktime: 5999,
          expiryheight: 1_234_677,
        },
      };
      const res = generateResponse();
      const result = await daemonServiceTransactionRpcs.createRawTransaction(req, res);
      const expectedCallParams = [
        { test: 'testtransaction', something: 'somethingelse' },
        { addr1: '1235asdf', addr2: '12344aaaa' },
        5999,
        1_234_677,
      ];

      expect(result).to.equal(`Response: ${execCallResult}`);
      sinon.assert.calledOnce(getBlockCountStub);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'createRawTransaction', expectedCallParams);
    });

    it('should return the created raw transaction in the response', async () => {
      getBlockCountStub.resolves({ value: 5_243_422 });
      const req = {
        params: {
          transactions: {
            test: 'testtransaction',
            something: 'somethingelse',
          },
          addresses: {
            addr1: '1235asdf',
            addr2: '12344aaaa',
          },
          locktime: 5999,
          expiryheight: 1_234_677,
        },
      };
      const res = generateResponse();
      await daemonServiceTransactionRpcs.createRawTransaction(req, res);
      const expectedCallParams = [
        { test: 'testtransaction', something: 'somethingelse' },
        { addr1: '1235asdf', addr2: '12344aaaa' },
        5999,
        1_234_677,
      ];

      sinon.assert.calledOnceWithExactly(res.json, execCallResult);
      sinon.assert.calledOnce(getBlockCountStub);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'createRawTransaction', expectedCallParams);
    });

    it('should create a raw transaction if all parameters are set properly, passed in query - response passed', async () => {
      getBlockCountStub.resolves({ value: 5_243_422 });
      const req = {
        params: {
          param1: 'test',
        },
        query: {
          transactions: {
            test: 'testtransaction',
            something: 'somethingelse',
          },
          addresses: {
            addr1: '1235asdf',
            addr2: '12344aaaa',
          },
          locktime: 5999,
          expiryheight: 1_234_677,
        },
      };
      const res = generateResponse();
      await daemonServiceTransactionRpcs.createRawTransaction(req, res);
      const expectedCallParams = [
        { test: 'testtransaction', something: 'somethingelse' },
        { addr1: '1235asdf', addr2: '12344aaaa' },
        5999,
        1_234_677,
      ];

      sinon.assert.calledOnceWithExactly(res.json, execCallResult);
      sinon.assert.calledOnce(getBlockCountStub);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'createRawTransaction', expectedCallParams);
    });

    it('should create a raw transaction if no expiryheight is passed - response passed', async () => {
      getBlockCountStub.resolves({ value: 5_243_422 });
      const req = {
        params: {
          param1: 'test',
        },
        query: {
          transactions: {
            test: 'testtransaction',
            something: 'somethingelse',
          },
          addresses: {
            addr1: '1235asdf',
            addr2: '12344aaaa',
          },
          locktime: 5999,
        },
      };
      const res = generateResponse();
      await daemonServiceTransactionRpcs.createRawTransaction(req, res);
      const expectedCallParams = [
        { test: 'testtransaction', something: 'somethingelse' },
        { addr1: '1235asdf', addr2: '12344aaaa' },
        5999,
        5_243_442,
      ];

      sinon.assert.calledOnceWithExactly(res.json, execCallResult);
      sinon.assert.calledOnce(getBlockCountStub);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'createRawTransaction', expectedCallParams);
    });

    it('should create a raw transaction if no locktime is passed - response passed', async () => {
      getBlockCountStub.resolves({ value: 5_243_422 });
      const req = {
        params: {
          param1: 'test',
        },
        query: {
          transactions: {
            test: 'testtransaction',
            something: 'somethingelse',
          },
          addresses: {
            addr1: '1235asdf',
            addr2: '12344aaaa',
          },
          expiryheight: 1_234_677,
        },
      };
      const res = generateResponse();
      await daemonServiceTransactionRpcs.createRawTransaction(req, res);
      const expectedCallParams = [
        { test: 'testtransaction', something: 'somethingelse' },
        { addr1: '1235asdf', addr2: '12344aaaa' },
        0,
        1_234_677,
      ];

      sinon.assert.calledOnceWithExactly(res.json, execCallResult);
      sinon.assert.calledOnce(getBlockCountStub);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'createRawTransaction', expectedCallParams);
    });

    it('answers the daemon\'s reason when the block count cannot be read', async () => {
      getBlockCountStub.resolves({ value: null, reason: { message: 'Error message!', name: 'Error' } });
      const req = {
        params: {
          param1: 'test',
        },
        query: {
          transactions: {
            test: 'testtransaction',
            something: 'somethingelse',
          },
          addresses: {
            addr1: '1235asdf',
            addr2: '12344aaaa',
          },
          expiryheight: 1_234_677,
        },
      };
      const expectedResult = {
        status: 'error',
        data: {
          code: undefined,
          message: 'Error message!',
          name: 'Error',
        },
      };

      const res = generateResponse();
      await daemonServiceTransactionRpcs.createRawTransaction(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResult);
      sinon.assert.calledOnce(getBlockCountStub);
      sinon.assert.notCalled(daemonServiceUtilsStub);
    });
  });

  describe('createRawTransactionPost tests', () => {
    let daemonServiceUtilsStub;
    let getBlockCountStub;
    const execCallResult = 'RPC call executed';
    beforeEach(() => {
      sinon.stub(daemonServiceUtils, 'getFluxdClient').callsFake(() => ({ getBlockCount: getBlockCountStub }));
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall').resolves(execCallResult);
      getBlockCountStub = sinon.stub(daemonServiceBlockchainRpcs, 'getBlockCount');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should create a raw transaction if all parameters are set properly', async () => {
      getBlockCountStub.resolves({ value: 5_243_422 });
      const params = {
        transactions: {
          test: 'testtransaction',
          something: 'somethingelse',
        },
        addresses: {
          addr1: '1235asdf',
          addr2: '12344aaaa',
        },
        locktime: 5999,
        expiryheight: 1_234_677,
      };
      const expectedCallParams = [
        { test: 'testtransaction', something: 'somethingelse' },
        { addr1: '1235asdf', addr2: '12344aaaa' },
        5999,
        1_234_677,
      ];
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceTransactionRpcs.createRawTransactionPost(mockStream, res);
      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, execCallResult);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'createRawTransaction', expectedCallParams);
    });

    it('should create a raw transaction if no expiryheight is given', async () => {
      getBlockCountStub.resolves({ value: 5_243_422 });
      const params = {
        transactions: {
          test: 'testtransaction',
          something: 'somethingelse',
        },
        addresses: {
          addr1: '1235asdf',
          addr2: '12344aaaa',
        },
        locktime: 5999,
      };
      const expectedCallParams = [
        { test: 'testtransaction', something: 'somethingelse' },
        { addr1: '1235asdf', addr2: '12344aaaa' },
        5999,
        5_243_442,
      ];
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceTransactionRpcs.createRawTransactionPost(mockStream, res);
      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, execCallResult);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'createRawTransaction', expectedCallParams);
    });

    it('should create a raw transaction if no locktime is given', async () => {
      getBlockCountStub.resolves({ value: 5_243_422 });
      const params = {
        transactions: {
          test: 'testtransaction',
          something: 'somethingelse',
        },
        addresses: {
          addr1: '1235asdf',
          addr2: '12344aaaa',
        },
        expiryheight: 1_234_677,
      };
      const expectedCallParams = [
        { test: 'testtransaction', something: 'somethingelse' },
        { addr1: '1235asdf', addr2: '12344aaaa' },
        0,
        1_234_677,
      ];
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceTransactionRpcs.createRawTransactionPost(mockStream, res);
      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, execCallResult);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'createRawTransaction', expectedCallParams);
    });

    it('answers the daemon\'s reason when the block count cannot be read', async () => {
      getBlockCountStub.resolves({ value: null, reason: { message: 'New Error!', name: 'Error' } });
      const params = {
        transactions: {
          test: 'testtransaction',
          something: 'somethingelse',
        },
        addresses: {
          addr1: '1235asdf',
          addr2: '12344aaaa',
        },
        expiryheight: 1_234_677,
      };
      const expectedErrorMessage = {
        status: 'error',
        data: {
          code: undefined,
          name: 'Error',
          message: 'New Error!',
        },
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceTransactionRpcs.createRawTransactionPost(mockStream, res);
      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(res.json, expectedErrorMessage);
      sinon.assert.notCalled(daemonServiceUtilsStub);
    });
  });

  describe('decodeRawTransactionPost tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should call decodeRawTransaction rpc', async () => {
      daemonServiceUtilsStub.resolves('success');
      const params = {
        hexstring: '0x412368904412378BAF',
      };
      const mockStream = new PassThrough();
      mockStream.push(JSON.stringify(params));
      mockStream.end();
      const res = generateResponse();

      await daemonServiceTransactionRpcs.decodeRawTransactionPost(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'decodeRawTransaction', [params.hexstring]);
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

      await daemonServiceTransactionRpcs.decodeRawTransactionPost(mockStream, res);

      // await because of the async nature of the request processing
      await serviceHelper.delay(150);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'decodeRawTransaction', []);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParamsGiven');
    });
  });

  describe('decodeScript tests', () => {
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
          hex: '0x412368904412378BAF',
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = [req.params.hex];

      const res = generateResponse();
      await daemonServiceTransactionRpcs.decodeScript(req, res);

      sinon.assert.calledOnceWithExactly(res.json, 'success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'decodeScript', expectedParams);
    });

    it('should execute RPC if parameters are passed in query, response passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          hex: '0x412368904412378BAF',
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = [req.query.hex];

      const res = generateResponse();

      const result = await daemonServiceTransactionRpcs.decodeScript(req, res);

      expect(result).to.eql('Response: success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'decodeScript', expectedParams);
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
      const res = generateResponse();

      const result = await daemonServiceTransactionRpcs.decodeScript(req, res);

      expect(result).to.eql('Response: NoParams');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'decodeScript', []);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParams');
    });
  });



  describe('getRawTransaction tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall').resolves({ status: 'success', data: 'raw' });
    });

    afterEach(() => {
      sinon.restore();
    });

    it('asks for a transaction, as hex unless verbose', async () => {
      expect(await daemonServiceTransactionRpcs.getRawTransaction('0x41')).to.deep.equal({ value: 'raw' });
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getRawTransaction', ['0x41', 0]);
    });

    it('asks for it decoded at a verbose of 1', async () => {
      await daemonServiceTransactionRpcs.getRawTransaction('0x41', 1);

      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getRawTransaction', ['0x41', 1]);
    });

    it('answers why there is none when the daemon has not got it', async () => {
      daemonServiceUtilsStub.resolves({ status: 'error', data: { code: -5, message: 'No such mempool or blockchain transaction' } });

      expect(await daemonServiceTransactionRpcs.getRawTransaction('0x41')).to.deep.equal({
        value: null, reason: { code: -5, message: 'No such mempool or blockchain transaction' },
      });
    });

    it('takes the transaction and verbose its route is asked for, from the path or the query', async () => {
      const res = { json: sinon.stub() };

      await daemonServiceTransactionRpcs.getRawTransactionAPI({ params: { txid: '0x41', verbose: '1' }, query: {} }, res);
      await daemonServiceTransactionRpcs.getRawTransactionAPI({ params: {}, query: { txid: '0x42' } }, res);

      expect(daemonServiceUtilsStub.args).to.deep.equal([['getRawTransaction', ['0x41', 1]], ['getRawTransaction', ['0x42', 0]]]);
      sinon.assert.alwaysCalledWithExactly(res.json, { status: 'success', data: 'raw' });
    });
  });

  describe('sendRawTransaction tests', () => {
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
          hexstring: '0x412368904412378BAF',
          allowhighfees: true,
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = [req.params.hexstring, req.params.allowhighfees];

      const res = generateResponse();
      await daemonServiceTransactionRpcs.sendRawTransaction(req, res);

      sinon.assert.calledOnceWithExactly(res.json, 'success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'sendRawTransaction', expectedParams);
    });

    it('should execute RPC if parameters are passed in query, no allowhighfees param, response passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          hexstring: '0x412368904412378BAF',
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = [req.query.hexstring, false];

      const res = generateResponse();
      await daemonServiceTransactionRpcs.sendRawTransaction(req, res);

      sinon.assert.calledOnceWithExactly(res.json, 'success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'sendRawTransaction', expectedParams);
    });

    it('should execute RPC if parameters are passed in query, allohighfees as a string, response passed', async () => {
      const req = {
        params: {
          test: 'test',
        },
        query: {
          hexstring: '0x412368904412378BAF',
          allowhighfees: 'true',
        },
      };
      daemonServiceUtilsStub.returns('success');
      const expectedParams = [req.query.hexstring, true];

      const res = generateResponse();

      const result = await daemonServiceTransactionRpcs.sendRawTransaction(req, res);

      expect(result).to.eql('Response: success');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'sendRawTransaction', expectedParams);
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
      const res = generateResponse();

      const result = await daemonServiceTransactionRpcs.sendRawTransaction(req, res);

      expect(result).to.eql('Response: NoParams');
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'sendRawTransaction', []);
      sinon.assert.calledOnceWithExactly(res.json, 'NoParams');
    });
  });


});
