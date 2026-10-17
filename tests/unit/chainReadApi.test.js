'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const chainReadApi = require('../../ZelBack/src/services/chainReadApi');
const daemonServiceAddressRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceAddressRpcs');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
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
      sinon.stub(daemonStatus, 'daemonSyncState').returns({ height: 100, header: 100, synced: true });
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
      getSingleAddressUtxosStub.resolves({ value: [{
        address: '1Z123', txid: 'tx1', outputIndex: 2, height: 90, satoshis: 500, script: 'aabb',
      }] });

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
      getSingleAddressUtxosStub.resolves({ value: [{
        address: '1Z123', txid: 'tx1', outputIndex: 0, height: 40, satoshis: 1, script: 'cc', confirmations: 99_999,
      }] });

      await chainReadApi.getAddressUtxos({ params: { address: '1Z123' }, query: {} }, res);

      expect(res.json.firstCall.args[0].data[0].confirmations).to.equal(60);
    });

    it('should accept the address from the query string', async () => {
      const res = generateResponse();
      getSingleAddressUtxosStub.resolves({ value: [] });

      await chainReadApi.getAddressUtxos({ params: {}, query: { address: '1Q999' } }, res);

      sinon.assert.calledOnceWithExactly(getSingleAddressUtxosStub, '1Q999');
    });

    it('answers the daemon\'s reason when it refuses', async () => {
      const res = generateResponse();
      getSingleAddressUtxosStub.resolves({ value: null, reason: { code: -5, message: 'Invalid address' } });

      await chainReadApi.getAddressUtxos({ params: { address: 'bad' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'error', data: { code: -5, name: undefined, message: 'Invalid address' } });
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
      getSingleAddresssTxidsStub.resolves({ value: ['oldest', 'middle', 'newest'] });

      await chainReadApi.getAddressTransactions({ params: { address: '1Z123' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: [{ txid: 'newest' }, { txid: 'middle' }, { txid: 'oldest' }],
      });
    });

    it('answers the daemon\'s reason when it refuses', async () => {
      const res = generateResponse();
      getSingleAddresssTxidsStub.resolves({ value: null, reason: { code: -5, message: 'Invalid address' } });

      await chainReadApi.getAddressTransactions({ params: { address: 'bad' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'error', data: { code: -5, name: undefined, message: 'Invalid address' } });
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
      getSingleAddressBalanceStub.resolves({ value: { balance: 12_345 } });

      await chainReadApi.getAddressBalance({ params: { address: '1Z123' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: 12_345 });
    });

    it('answers the daemon\'s reason when it refuses', async () => {
      const res = generateResponse();
      getSingleAddressBalanceStub.resolves({ value: null, reason: { code: -5, message: 'Invalid address' } });

      await chainReadApi.getAddressBalance({ params: { address: 'bad' }, query: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'error', data: { code: -5, name: undefined, message: 'Invalid address' } });
    });
  });

  describe('getScannedHeight tests', () => {
    let findOneInDatabaseStub;

    beforeEach(() => {
      findOneInDatabaseStub = sinon.stub(dbHelper, 'findOneInDatabase');
      sinon.stub(dbHelper, 'databaseConnection').returns({ db: () => ({}) });
    });

    it('answers its route that scanning has not started, without logging an error', async () => {
      const res = generateResponse();
      findOneInDatabaseStub.returns(null);

      await chainReadApi.getScannedHeightAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'error',
        data: { code: undefined, name: undefined, message: 'Scanning not initiated' },
      });
    });

    it('answers its route with the cursor', async () => {
      const res = generateResponse();
      findOneInDatabaseStub.returns({ generalScannedHeight: 200_000 });

      await chainReadApi.getScannedHeightAPI({}, res);

      sinon.assert.calledOnceWithExactly(res.json, {
        status: 'success',
        data: { generalScannedHeight: 200_000 },
      });
    });

    it('answers the cursor as a value', async () => {
      findOneInDatabaseStub.returns({ generalScannedHeight: 200_000 });

      expect(await chainReadApi.getScannedHeight()).to.eql({ value: { generalScannedHeight: 200_000 } });
    });
  });
});
