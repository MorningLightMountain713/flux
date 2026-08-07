const chai = require('chai');
const sinon = require('sinon');

const asyncLock = require('../../ZelBack/src/services/utils/asyncLock');

const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');

const { expect } = chai;

describe('daemonServiceUtils tests', () => {
  describe('executeCall tests', () => {
    afterEach(() => {
      daemonServiceUtils.setFluxdClient(null);
      sinon.restore();
    });

    it('should reach the daemon twice for two identical calls', async () => {
      // The whole contract in one assertion: an answer is never reused, however
      // fixed it looks. A block read back by its own hash is the most cacheable
      // thing the daemon serves, and even that is asked for again — the verbose
      // answer carries confirmations, which grows every block and reads -1 once
      // the block is off the main chain. What is worth repeating is cached at the
      // HTTP layer, keyed by URL rather than by caller-supplied JSON.
      const rpc = 'getBlock';
      const params = ['a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', 2];
      const daemonRpcClientStub = sinon.stub();
      daemonRpcClientStub.onFirstCall().resolves({ confirmations: 1 });
      daemonRpcClientStub.onSecondCall().resolves({ confirmations: 2 });
      daemonServiceUtils.setFluxdClient({ run: daemonRpcClientStub });

      const first = await daemonServiceUtils.executeCall(rpc, params);
      const second = await daemonServiceUtils.executeCall(rpc, params);

      sinon.assert.calledTwice(daemonRpcClientStub);
      sinon.assert.alwaysCalledWithExactly(daemonRpcClientStub, rpc, { params });
      expect(first).to.eql({ status: 'success', data: { confirmations: 1 } });
      expect(second).to.eql({ status: 'success', data: { confirmations: 2 } });
    });

    it('should ask the daemon every time for a call that acts as well as answers', async () => {
      const rpc = 'sendToAddress';
      const params = ['t1address', 1];
      const daemonRpcClientStub = sinon.stub();
      daemonRpcClientStub.onFirstCall().resolves('firsttxid');
      daemonRpcClientStub.onSecondCall().resolves('secondtxid');
      daemonServiceUtils.setFluxdClient({ run: daemonRpcClientStub });

      const first = await daemonServiceUtils.executeCall(rpc, params);
      const second = await daemonServiceUtils.executeCall(rpc, params);

      expect(first).to.eql({ status: 'success', data: 'firsttxid' });
      expect(second).to.eql({ status: 'success', data: 'secondtxid' });
      sinon.assert.calledTwice(daemonRpcClientStub);
    });

    it('should return an error message if rpc call throws an error', async () => {
      const rpc = 'getInfo';
      const params = ['someParameterGetinfo'];
      const expectedErrorMessage = {
        status: 'error',
        data: {
          code: undefined,
          message: 'Error',
          name: 'Error',
        },
      };
      const daemonRpcClientStub = sinon.stub().throws();
      daemonServiceUtils.setFluxdClient({ run: daemonRpcClientStub });

      const result = await daemonServiceUtils.executeCall(rpc, params);

      expect(result).to.eql(expectedErrorMessage);
    });
  });

  describe('executeBatchCall tests', () => {
    afterEach(() => {
      daemonServiceUtils.setFluxdClient(null);
      sinon.restore();
    });

    it('should delegate to fluxdClient.runBatch', async () => {
      const batchData = [{ id: 0, result: 'ok', error: null }];
      const runBatchStub = sinon.stub().resolves(batchData);
      daemonServiceUtils.setFluxdClient({ run: sinon.stub(), runBatch: runBatchStub });

      const calls = [{ method: 'getblockcount', params: [] }];
      const result = await daemonServiceUtils.executeBatchCall(calls);

      expect(result.status).to.equal('success');
      expect(result.data).to.eql(batchData);
      sinon.assert.calledOnceWithExactly(runBatchStub, calls);
    });

    it('should return error message on failure', async () => {
      const runBatchStub = sinon.stub().rejects(new Error('Connection refused'));
      daemonServiceUtils.setFluxdClient({ run: sinon.stub(), runBatch: runBatchStub });

      const calls = [{ method: 'getblockcount', params: [] }];
      const result = await daemonServiceUtils.executeBatchCall(calls);

      expect(result.status).to.equal('error');
      expect(result.data.message).to.equal('Connection refused');
    });

    it('should bypass the semaphore that executeCall takes', async () => {
      const acquireSpy = sinon.spy(asyncLock.AsyncLock.prototype, 'acquire');
      const runBatchStub = sinon.stub().resolves([{ id: 0, result: 'ok', error: null }]);
      daemonServiceUtils.setFluxdClient({ run: sinon.stub().resolves('ok'), runBatch: runBatchStub });

      await daemonServiceUtils.executeBatchCall([{ method: 'getblockcount', params: [] }]);

      sinon.assert.notCalled(acquireSpy);

      // The same spy sees the single call the semaphore does guard, so the batch
      // leaving it untouched above is a fact about the batch path, not about the spy.
      await daemonServiceUtils.executeCall('getblockcount', []);

      sinon.assert.calledOnce(acquireSpy);
    });
  });
});
