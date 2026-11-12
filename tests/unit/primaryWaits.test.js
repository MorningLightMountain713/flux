'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const primaryWaits = require('../../ZelBack/src/services/appLifecycle/primaryWaits');

describe('primaryWaits', () => {
  afterEach(() => primaryWaits.resetForTests());

  it('lists a component this node waits to take over', () => {
    primaryWaits.wait('db_App');

    expect(primaryWaits.waitingIdentifiers()).to.deep.equal(['db_App']);
  });

  it('lets a wait the election does not renew lapse', () => {
    const now = Date.now();
    primaryWaits.wait('db_App', now - primaryWaits.ELECTION_RECORD_STALE_MS);
    primaryWaits.wait('web_App', now - primaryWaits.ELECTION_RECORD_STALE_MS + 1);

    expect(primaryWaits.waitingIdentifiers(now)).to.deep.equal(['web_App']);
  });

  it('ends a wait that is cleared', () => {
    primaryWaits.wait('db_App');
    primaryWaits.clear('db_App');

    expect(primaryWaits.waitingIdentifiers()).to.deep.equal([]);
  });
});
