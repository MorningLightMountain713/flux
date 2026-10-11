'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const appsRepository = require('../../ZelBack/src/services/appDatabase/appsRepository');
const appSubmission = require('../../ZelBack/src/services/appRequirements/appSubmission');

// The submission door judges a v7 app's component secrets by flux-spec's rule,
// the one the decider judges by: the same secrets never serve two apps, an
// update keeps the secrets its own app carries now whoever it names as owner,
// and secrets another owner used before are refused otherwise.
describe('appSubmission v7 secrets at the door', () => {
  const SECRETS = '-----BEGIN PGP MESSAGE-----\nwcBMA0secret\n-----END PGP MESSAGE-----';
  let live;
  let earlier;

  beforeEach(() => {
    live = [];
    earlier = [];
    sinon.stub(appsRepository, 'listLiveV7Secrets').callsFake(async () => live);
    sinon.stub(appsRepository, 'listHistoricalV7Secrets').callsFake(async () => earlier);
  });

  afterEach(() => {
    sinon.restore();
  });

  const update = (owner) => appSubmission.assertSecretsNotConflicting('myapp', 'web', SECRETS, owner);

  it('a sold app\'s update keeps the secrets it carries now, under the buyer', async () => {
    live = [{ appName: 'myapp', owner: 'seller', secrets: SECRETS }];
    earlier = [{ appName: 'myapp', owner: 'seller', secrets: SECRETS }];
    await update('buyer');
  });

  it('secrets another owner used before are refused to an app that does not carry them now', async () => {
    earlier = [{ appName: 'otherapp', owner: 'seller', secrets: SECRETS }];
    let refused = null;
    try {
      await update('buyer');
    } catch (error) {
      refused = error;
    }
    expect(refused?.message).to.match(/used before by another owner/);
  });

  it('secrets another live app carries are refused to an update', async () => {
    live = [{ appName: 'otherapp', owner: 'buyer', secrets: SECRETS }];
    let refused = null;
    try {
      await update('buyer');
    } catch (error) {
      refused = error;
    }
    expect(refused?.message).to.match(/already in use by app 'otherapp'/);
  });

  it('a registration carrying secrets a live app carries is refused', async () => {
    live = [{ appName: 'otherapp', owner: 'buyer', secrets: SECRETS }];
    let refused = null;
    try {
      await appSubmission.assertSecretsNotConflicting('myapp', 'web', SECRETS, 'buyer', { isRegistration: true });
    } catch (error) {
      refused = error;
    }
    expect(refused?.message).to.match(/already in use by app 'otherapp'/);
  });

  it('a registration claims no live secrets, not even those of a live app of its own name; an update keeps them', async () => {
    live = [{ appName: 'myapp', owner: 'buyer', secrets: SECRETS }];
    await update('buyer');
    let refused = null;
    try {
      await appSubmission.assertSecretsNotConflicting('myapp', 'web', SECRETS, 'buyer', { isRegistration: true });
    } catch (error) {
      refused = error;
    }
    expect(refused?.message).to.match(/already in use by app 'myapp'/);
  });
});
