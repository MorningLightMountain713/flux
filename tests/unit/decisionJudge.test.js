'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const { load } = require('@runonflux/flux-spec-cjs');

const appDomain = require('./fixtures/appDomain');

const OWNER = '1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm';
const RENEWER = '1MCBJn6qsy3YRY2YasdYMYdJcdhy1ev8Rd';
const STRANGER = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

function loadJudge({ lookupBlockTime = sinon.stub().resolves(1_700_000_000) } = {}) {
  const { createJudge } = proxyquire('../../ZelBack/src/services/appDecisions/decisionJudge', {
    '../appMessaging/confirmedMessageStore': { lookupBlockTime },
  });
  return { createJudge, lookupBlockTime };
}

describe('decisionJudge', () => {
  afterEach(() => sinon.restore());

  describe('authorized', () => {
    async function updateEntry(spec, signers) {
      return { event: await appDomain.legacyEvent({ spec }), signers };
    }

    it('authorizes an update its predecessor\'s owner signed, from the recovered addresses alone', async () => {
      const judge = await loadJudge().createJudge();
      const spec = await appDomain.v8Spec();
      const previousState = { owner: OWNER, spec };
      expect(await judge.authorized(await updateEntry(spec, [OWNER]), { height: 2_000_000, previousState })).to.equal(true);
      expect(await judge.authorized(await updateEntry(spec, [STRANGER]), { height: 2_000_000, previousState })).to.equal(false);
    });

    it('lets a renewal signer in force at the height sign an update that changes nothing but expire', async () => {
      const judge = await loadJudge().createJudge();
      const prior = await appDomain.v8Spec({ expire: 22_000 });
      const renewal = await appDomain.v8Spec({ expire: 44_000 });
      const changed = await appDomain.v8Spec({ expire: 44_000, instances: 5 });
      const previousState = { owner: OWNER, spec: prior };
      expect(await judge.authorized(await updateEntry(renewal, [RENEWER]), { height: 2_000_000, previousState })).to.equal(true);
      expect(await judge.authorized(await updateEntry(changed, [RENEWER]), { height: 2_000_000, previousState })).to.equal(false);
    });
  });

  it('names a v9 registration\'s app by its whole uuid and a legacy one by its name', async () => {
    const judge = await loadJudge().createJudge();
    const { appUuid, appIdentityFromUuid } = await load();
    const hash = 'a'.repeat(64);
    const uuid = judge.mintUuid('myapp', hash);
    expect(uuid, 'the library\'s uuid of the name and the registration hash').to.equal(appUuid('myapp', hash));
    expect(judge.identityFor({ version: 9, name: 'myapp' }, uuid)).to.equal(appIdentityFromUuid(uuid));
    expect(judge.identityFor({ version: 8, name: 'MyApp' }, uuid)).to.equal('MyApp');
  });

  it('reads the activation height of each version from the enforcement heights', async () => {
    const judge = await loadJudge().createJudge();
    expect(judge.activationHeight(4)).to.equal(1_004_000);
    expect(judge.activationHeight(99)).to.equal(undefined);
  });

  describe('blockTime', () => {
    it('reads a record\'s own block time without asking the daemon', async () => {
      const { createJudge, lookupBlockTime } = loadJudge();
      const judge = await createJudge();
      expect(await judge.blockTime({ record: { height: 5, blockTime: 123 } })).to.equal(123);
      sinon.assert.notCalled(lookupBlockTime);
    });

    it('asks the daemon once per height for a record without one', async () => {
      const { createJudge, lookupBlockTime } = loadJudge();
      const judge = await createJudge();
      await judge.blockTime({ record: { height: 5, blockTime: null } });
      expect(await judge.blockTime({ record: { height: 5 } })).to.equal(1_700_000_000);
      sinon.assert.calledOnceWithExactly(lookupBlockTime, 5);
    });

    it('cannot answer when the daemon has no time for the height', async () => {
      const { createJudge } = loadJudge({ lookupBlockTime: sinon.stub().resolves(null) });
      const judge = await createJudge();
      let thrown = null;
      try { await judge.blockTime({ record: { height: 5 } }); } catch (error) { thrown = error; }
      expect(thrown).to.be.an('error');
    });
  });

  it('tells a spec the library refuses from any other failure', async () => {
    const judge = await loadJudge().createJudge();
    const { ValidationError, CODES } = await load();
    expect(judge.isValidationError(new ValidationError([{ path: [], code: CODES.INVALID_VALUE, message: 'bad' }]))).to.equal(true);
    expect(judge.isValidationError(new Error('history not in force'))).to.equal(false);
  });
});
