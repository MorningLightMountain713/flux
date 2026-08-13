'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const generalService = require('../../ZelBack/src/services/generalService');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const grantClient = require('../../ZelBack/src/services/quorumGrant/grantClient');
const foundingCommittee = require('../../ZelBack/src/services/appMesh/foundingCommittee');
const foundingService = require('../../ZelBack/src/services/appMesh/foundingService');

// The answer mapping is the whole module: every grant outcome must land on
// exactly one of yes/no/wait, and the published record must spare the
// committee a round only when it is the CURRENT world's record.

const SELF_TXHASH = 'a'.repeat(64);
const SELF = `${SELF_TXHASH}:0`;

const COMMITTEE = {
  repinned: false,
  generation: 2,
  anchor: 500_000,
  fingerprint: 'c'.repeat(64),
  quorum: 5,
  members: [],
};

describe('foundingService', () => {
  beforeEach(() => {
    sinon.stub(foundingCommittee, 'effectiveCommittee').resolves(COMMITTEE);
    sinon.stub(messageStore, 'getMasterleaseRecord').resolves(null);
    sinon.stub(grantClient, 'acquire').resolves({ granted: true, founder: SELF });
    sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({
      txhash: SELF_TXHASH, txindex: 0,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('no committee basis answers wait — never no, never a minted basis', async () => {
    foundingCommittee.effectiveCommittee.resolves(null);
    const reply = await foundingService.founderAsk('myapp', 'db');
    expect(reply).to.deep.equal({ answer: 'wait' });
    expect(grantClient.acquire.called).to.equal(false);
  });

  it('a granted founding answers yes, asked under the committee as resolved', async () => {
    const reply = await foundingService.founderAsk('myapp', 'DB');
    expect(reply).to.deep.equal({ answer: 'yes' });
    expect(grantClient.acquire.calledOnceWith('myapp/founder-DB@500000', {
      mode: 'oneshot', committee: COMMITTEE,
    })).to.equal(true);
  });

  it('a founding by another answers no', async () => {
    grantClient.acquire.resolves({ granted: false, founder: 'other:0' });
    const reply = await foundingService.founderAsk('myapp', 'db');
    expect(reply).to.deep.equal({ answer: 'no' });
  });

  it('an undecidable round answers wait, with the taught retry when one exists', async () => {
    grantClient.acquire.resolves({ granted: false, retryAfterMs: 9000 });
    expect(await foundingService.founderAsk('myapp', 'db')).to.deep.equal({
      answer: 'wait', retryAfterMs: 9000,
    });

    grantClient.acquire.resolves({ granted: false, reason: 'no prepare quorum' });
    expect(await foundingService.founderAsk('myapp', 'db')).to.deep.equal({ answer: 'wait' });
  });

  it('the synced record answers without a wire round — yes for the recorded founder, no for anyone else', async () => {
    messageStore.getMasterleaseRecord.resolves({
      data: { mode: 'oneshot', grantee: SELF, generation: 2 },
    });
    expect(await foundingService.founderAsk('myapp', 'db')).to.deep.equal({ answer: 'yes' });

    messageStore.getMasterleaseRecord.resolves({
      data: { mode: 'oneshot', grantee: 'other:0', generation: 2 },
    });
    expect(await foundingService.founderAsk('myapp', 'db')).to.deep.equal({ answer: 'no' });

    expect(messageStore.getMasterleaseRecord.alwaysCalledWith('myapp', 'founder-db@500000')).to.equal(true);
    expect(grantClient.acquire.called).to.equal(false);
  });

  it('a retired generation record is the dead world talking — the round runs fresh', async () => {
    messageStore.getMasterleaseRecord.resolves({
      data: { mode: 'oneshot', grantee: 'other:0', generation: 1 },
    });
    const reply = await foundingService.founderAsk('myapp', 'db');
    expect(reply).to.deep.equal({ answer: 'yes' });
    expect(grantClient.acquire.calledOnce).to.equal(true);
  });
});
