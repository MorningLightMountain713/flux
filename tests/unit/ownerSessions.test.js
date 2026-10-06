'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { Privilege } = require('../../ZelBack/src/services/utils/privileges');

describe('ownerSessions (the sessions open on an app\'s containers)', () => {
  const IDENTITY = `b${'a'.repeat(52)}`;
  const OTHER = `b${'c'.repeat(52)}`;
  let verifyPrivilege;
  let logStub;
  let ownerSessions;

  beforeEach(() => {
    // The owner check as the record answers it now: the buyer and the Flux team
    // pass, the seller no longer does.
    verifyPrivilege = sinon.stub().callsFake(async (privilege, zelidauth) => zelidauth !== 'seller');
    logStub = { info: sinon.stub(), error: sinon.stub() };
    ownerSessions = proxyquire('../../ZelBack/src/lib/socketIoHandlers/ownerSessions', {
      '../../services/verificationHelper': { verifyPrivilege },
      '../log': logStub,
    });
  });

  it('puts every session open on the app to the owner check again, by its identity, and closes the ones whose caller no longer passes', async () => {
    const closeSeller = sinon.spy();
    const closeTeam = sinon.spy();
    ownerSessions.track(IDENTITY, 'seller', closeSeller);
    ownerSessions.track(IDENTITY, 'team', closeTeam);

    expect(await ownerSessions.recheck(IDENTITY)).to.equal(1);

    sinon.assert.calledWithExactly(verifyPrivilege, Privilege.APP_OWNER_OR_FLUX_TEAM, 'seller', { identity: IDENTITY });
    sinon.assert.calledWithExactly(verifyPrivilege, Privilege.APP_OWNER_OR_FLUX_TEAM, 'team', { identity: IDENTITY });
    sinon.assert.calledOnce(closeSeller);
    sinon.assert.notCalled(closeTeam);
  });

  it('leaves the sessions open on another app alone, unchecked', async () => {
    const close = sinon.spy();
    ownerSessions.track(OTHER, 'seller', close);

    expect(await ownerSessions.recheck(IDENTITY)).to.equal(0);

    sinon.assert.notCalled(verifyPrivilege);
    sinon.assert.notCalled(close);
  });

  it('forgets a session that ended: it is neither checked nor closed, and forgetting it twice changes nothing', async () => {
    const closeEnded = sinon.spy();
    const closeOpen = sinon.spy();
    const forget = ownerSessions.track(IDENTITY, 'seller', closeEnded);
    ownerSessions.track(IDENTITY, 'seller', closeOpen);
    forget();
    forget();

    await ownerSessions.recheck(IDENTITY);

    sinon.assert.notCalled(closeEnded);
    sinon.assert.calledOnce(closeOpen);
  });

  it('holds nothing for an app once its last session ended', () => {
    const forget = ownerSessions.track(IDENTITY, 'seller', () => {});
    expect(ownerSessions.open.has(IDENTITY)).to.equal(true);
    forget();
    expect(ownerSessions.open.has(IDENTITY)).to.equal(false);
  });

  it('closes the rest when one session cannot be closed', async () => {
    const closeSecond = sinon.spy();
    ownerSessions.track(IDENTITY, 'seller', () => { throw new Error('socket gone'); });
    ownerSessions.track(IDENTITY, 'seller', closeSecond);

    expect(await ownerSessions.recheck(IDENTITY)).to.equal(1);

    sinon.assert.calledOnce(closeSecond);
    sinon.assert.calledWithMatch(logStub.error, /socket gone/);
  });
});
