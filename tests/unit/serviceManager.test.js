'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const serviceManager = require('../../ZelBack/src/services/serviceManager');
const nodeDownService = require('../../ZelBack/src/services/nodeDownService');
const appStartupManager = require('../../ZelBack/src/services/appLifecycle/appStartupManager');

describe('serviceManager tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('wireServices', () => {
    it('hands the node-down service the placement check that removes apps', () => {
      const setPlacementCheck = sinon.stub(nodeDownService, 'setPlacementCheck');

      serviceManager.wireServices();

      sinon.assert.calledOnce(setPlacementCheck);
      expect(setPlacementCheck.firstCall.args[0]).to.equal(appStartupManager.enforceNodePlacement);
    });
  });
});
