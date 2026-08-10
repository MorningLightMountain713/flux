'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const chainReadApi = require('../../ZelBack/src/services/chainReadApi');
const daemonServiceAddressRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceAddressRpcs');
const daemonServiceMiscRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceMiscRpcs');
const dbHelper = require('../../ZelBack/src/services/dbHelper');
const log = require('../../ZelBack/src/lib/log');

const generateResponse = () => {
  const res = { test: 'testing' };
  res.status = sinon.stub().returns(res);
  res.json = sinon.stub().returns(res);
  return res;
};

describe('chainReadApi tests', () => {
  let logErrorSpy;

  beforeEach(() => {
    logErrorSpy = sinon.spy(log, 'error');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getAddressUtxos tests', () => {
    let getSingleAddressUtxosStub;

    beforeEach(() => {
      getSingleAddressUtxosStub = sinon.stub(daemonServiceAddressRpcs, 'getSingleAddressUtxos');
      sinon.stub(daemonServiceMiscRpcs, 'isDaemonSynced').returns({
        status: 'success',
        data: { height: 100, header: 100, synced: true },
      });
    });

    it('should return an error message when no address is provided', async () => {
      const res = generateResponse();

      await chainReadApi.getAddressUtxos({ params: { test: 'test' }, query: {} }, res);

      sinon.assert.calledOnce(logErrorSpy);
      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: undefined, name: 'Error', message: 'No address provided' },
      });
    });

    it('should answer from the daemon address index', async () => {
      const res = generateResponse();
      getSingleAddressUtxosStub.resolves({
        status: 'success',
        data: [{
          address: '1Z123', txid: 'tx1', outputIndex: 2, height: 90, satoshis: 500, script: 'aabb',
        }],
      });

      await chainReadApi.getAddressUtxos({ params: { address: '1Z123' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: [{
          address: '1Z123',
          txid: 'tx1',
          vout: 2,
          height: 90,
          satoshis: 500,
          scriptPubKey: 'aabb',
          confirmations: 10,
        }],
      });
    });

    it('should recompute confirmations from the current height rather than forward the daemon value', async () => {
      const res = generateResponse();
      getSingleAddressUtxosStub.resolves({
        status: 'success',
        data: [{
          address: '1Z123', txid: 'tx1', outputIndex: 0, height: 40, satoshis: 1, script: 'cc', confirmations: 99999,
        }],
      });

      await chainReadApi.getAddressUtxos({ params: { address: '1Z123' }, query: {} }, res);

      expect(res.json.firstCall.args[0].data[0].confirmations).to.equal(60);
    });

    it('should accept the address from the query string', async () => {
      const res = generateResponse();
      getSingleAddressUtxosStub.resolves({ status: 'success', data: [] });

      await chainReadApi.getAddressUtxos({ params: {}, query: { address: '1Q999' } }, res);

      sinon.assert.calledWithMatch(getSingleAddressUtxosStub, { params: { address: '1Q999' } });
    });
  });

  describe('getAddressTransactions tests', () => {
    let getSingleAddresssTxidsStub;

    beforeEach(() => {
      getSingleAddresssTxidsStub = sinon.stub(daemonServiceAddressRpcs, 'getSingleAddresssTxids');
    });

    it('should return an error message when no address is provided', async () => {
      const res = generateResponse();

      await chainReadApi.getAddressTransactions({ params: {}, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: undefined, name: 'Error', message: 'No address provided' },
      });
    });

    it('should return txids newest first, wrapped as objects', async () => {
      const res = generateResponse();
      getSingleAddresssTxidsStub.resolves({ status: 'success', data: ['oldest', 'middle', 'newest'] });

      await chainReadApi.getAddressTransactions({ params: { address: '1Z123' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: [{ txid: 'newest' }, { txid: 'middle' }, { txid: 'oldest' }],
      });
    });
  });

  describe('getAddressBalance tests', () => {
    let getSingleAddressBalanceStub;

    beforeEach(() => {
      getSingleAddressBalanceStub = sinon.stub(daemonServiceAddressRpcs, 'getSingleAddressBalance');
    });

    it('should return an error message when no address is provided', async () => {
      const res = generateResponse();

      await chainReadApi.getAddressBalance({ params: {}, query: {} }, res);

      sinon.assert.calledOnce(logErrorSpy);
      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: undefined, name: 'Error', message: 'No address provided' },
      });
    });

    it('should return the balance the daemon reports', async () => {
      const res = generateResponse();
      getSingleAddressBalanceStub.resolves({ status: 'success', data: { balance: 12345 } });

      await chainReadApi.getAddressBalance({ params: { address: '1Z123' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 12345 });
    });
  });

  describe('getScannedHeight tests', () => {
    let findOneInDatabaseStub;

    beforeEach(async () => {
      findOneInDatabaseStub = sinon.stub(dbHelper, 'findOneInDatabase');
      await dbHelper.initiateDB();
      dbHelper.databaseConnection();
    });

    it('should return an error when scanning has not been initiated', async () => {
      const res = generateResponse();
      findOneInDatabaseStub.returns(null);

      await chainReadApi.getScannedHeight(undefined, res);

      sinon.assert.calledOnce(logErrorSpy);
      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: undefined, name: 'Error', message: 'Scanning not initiated' },
      });
    });

    it('should return the cursor when a response is passed', async () => {
      const res = generateResponse();
      findOneInDatabaseStub.returns({ generalScannedHeight: 200000 });

      await chainReadApi.getScannedHeight(undefined, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: { generalScannedHeight: 200000 },
      });
    });

    it('should return the cursor directly when no response is passed', async () => {
      findOneInDatabaseStub.returns({ generalScannedHeight: 200000 });

      const result = await chainReadApi.getScannedHeight();

      expect(result).to.eql({
        status: 'success',
        data: { generalScannedHeight: 200000 },
      });
    });
  });
});
