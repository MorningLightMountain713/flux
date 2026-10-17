'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const daemonServiceUtils = require('../../ZelBack/src/services/daemonService/daemonServiceUtils');
const verificationHelper = require('../../ZelBack/src/services/verificationHelper');
const daemonServiceControlRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceControlRpcs');

const generateResponse = () => {
  const res = { test: 'testing' };
  res.status = sinon.stub().returns(res);
  res.json = sinon.fake((param) => `Response: ${param}`);
  return res;
};

describe('daemonServiceControlRpcs tests', () => {
  describe('help tests', () => {
    let daemonServiceUtilsStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should trigger rpc, response passed', async () => {
      daemonServiceUtilsStub.returns('success');
      const req = {
        params: {
          test: 'test',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = generateResponse();
      const expectedResponse = 'success';

      const result = await daemonServiceControlRpcs.help(req, res);

      expect(result).to.equal(`Response: ${expectedResponse}`);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'help', ['']);
    });

    it('should trigger rpc, data passed in params, response passed', async () => {
      daemonServiceUtilsStub.returns('success');
      const req = {
        params: {
          command: 'testcommand',
        },
        query: {
          test2: 'test2',
        },
      };
      const res = generateResponse();
      const expectedResponse = 'success';

      await daemonServiceControlRpcs.help(req, res);

      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'help', [req.params.command]);
    });
  });

  describe('getInfo tests', () => {
    let daemonServiceUtilsStub;
    let verifyPrivilegeStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall').callsFake(async () => ({
        status: 'success', data: { version: 7_020_051, balance: '1234' },
      }));
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('answers the daemon\'s info without the balance', async () => {
      expect(await daemonServiceControlRpcs.getInfo()).to.deep.equal({ value: { version: 7_020_051 } });
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'getInfo');
    });

    it('answers it with the balance when asked for', async () => {
      expect(await daemonServiceControlRpcs.getInfo({ withBalance: true })).to.deep.equal({ value: { version: 7_020_051, balance: '1234' } });
    });

    it('answers why there is no info when the daemon refuses', async () => {
      daemonServiceUtilsStub.callsFake(async () => ({ status: 'error', data: { code: -28, message: 'Loading block index' } }));

      expect(await daemonServiceControlRpcs.getInfo()).to.deep.equal({ value: null, reason: { code: -28, message: 'Loading block index' } });
    });

    it('serves its route without the balance to anyone but a node operator', async () => {
      verifyPrivilegeStub.resolves(false);
      const res = { json: sinon.stub() };

      await daemonServiceControlRpcs.getInfoAPI({ headers: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: { version: 7_020_051 } });
    });

    it('serves its route with the balance to a node operator', async () => {
      verifyPrivilegeStub.resolves(true);
      const res = { json: sinon.stub() };

      await daemonServiceControlRpcs.getInfoAPI({ headers: {} }, res);

      sinon.assert.calledOnceWithExactly(res.json, { status: 'success', data: { version: 7_020_051, balance: '1234' } });
    });
  });

  describe('stop tests', () => {
    let daemonServiceUtilsStub;
    let verifyPrivilegeStub;

    beforeEach(() => {
      daemonServiceUtilsStub = sinon.stub(daemonServiceUtils, 'executeCall');
      verifyPrivilegeStub = sinon.stub(verificationHelper, 'verifyPrivilege');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should throw error if user is unauthorized, no response passed', async () => {
      verifyPrivilegeStub.returns(false);
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };

      const result = await daemonServiceControlRpcs.stop();

      expect(result).to.eql(expectedResponse);
      sinon.assert.notCalled(daemonServiceUtilsStub);
    });

    it('should throw error if user is unauthorized, response passed', async () => {
      verifyPrivilegeStub.returns(false);
      const expectedResponse = {
        data: {
          code: 401,
          message: 'Unauthorized. Access denied.',
          name: 'Unauthorized',
        },
        status: 'error',
      };
      const res = generateResponse();

      const result = await daemonServiceControlRpcs.stop(res);

      expect(result).to.eql(expectedResponse);
      sinon.assert.notCalled(daemonServiceUtilsStub);
    });

    it('should trigger rpc, no response passed', async () => {
      verifyPrivilegeStub.returns(true);
      daemonServiceUtilsStub.returns('success');

      const expectedResponse = 'success';

      const result = await daemonServiceControlRpcs.stop();

      expect(result).to.eql(expectedResponse);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'stop');
    });

    it('should trigger rpc, response passed', async () => {
      verifyPrivilegeStub.returns(true);
      daemonServiceUtilsStub.returns('success');

      const expectedResponse = 'success';
      const res = generateResponse();

      const result = await daemonServiceControlRpcs.stop(undefined, res);

      expect(result).to.equal(`Response: ${expectedResponse}`);
      sinon.assert.calledOnceWithExactly(res.json, expectedResponse);
      sinon.assert.calledOnceWithExactly(daemonServiceUtilsStub, 'stop');
    });
  });
});
