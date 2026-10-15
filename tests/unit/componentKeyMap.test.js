'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const componentKeyMap = require('../../ZelBack/src/services/appLifecycle/componentKeyMap');
const appHistory = require('../../ZelBack/src/services/appDecisions/appHistory');
const domain = require('./fixtures/appDomain');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const HX = 'f'.repeat(64);
const IDENTITY = `b${'a'.repeat(51)}q`;
const UUID = 'u-app';

describe('componentKeyMap', () => {
  let flux;
  const component = (name, renamedFrom = null) => ({
    name,
    image: 'nginx:latest',
    cpu: 1,
    memory: 1000,
    persistentStorage: { sizeGb: 1, mounts: {} },
    ...(renamedFrom === null ? {} : { renamedFrom }),
  });
  const specWith = (components) => domain.v9Spec({ components });

  // An applied message as appHistory answers it, for this app's uuid unless told.
  async function applied(hash, components, uuid = UUID) {
    const spec = await specWith(components);
    return { message: { hash, appSpecifications: spec.serialize() }, decision: { hash, uuid } };
  }

  async function registered(hash, components, type = 'fluxappupdate') {
    const event = await domain.confirmedEvent({ spec: await specWith(components), hash, type });
    return domain.instantiatedSpec({ event, identity: IDENTITY, uuid: UUID });
  }

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('keysForInstall', () => {
    it('replays the app\'s applied versions in order: a rename keeps the key, an added component mints one', async () => {
      sinon.stub(appHistory, 'appliedMessages').resolves([
        await applied(HX, { web: component('web') }, 'u-earlier-app'),
        await applied(H1, { web: component('web') }),
        await applied(H2, { frontend: component('frontend', 'web'), db: component('db') }),
        await applied(H3, { frontend: component('frontend'), db: component('db') }),
      ]);
      const atRegistration = flux.componentKeysFor(await specWith({ web: component('web') }), { previous: null, appIdentity: IDENTITY, messageHash: H1 });

      const keys = await componentKeyMap.keysForInstall(await registered(H2, { frontend: component('frontend', 'web'), db: component('db') }));

      expect([...keys.keys()]).to.have.members(['frontend', 'db']);
      expect(keys.get('frontend'), 'the renamed component keeps the key the registration minted').to.equal(atRegistration.get('web'));
      expect(flux.isComponentKey(keys.get('db'))).to.equal(true);
      expect(keys.get('db')).to.not.equal(keys.get('frontend'));
    });

    it('stops at the version being installed', async () => {
      sinon.stub(appHistory, 'appliedMessages').resolves([
        await applied(H1, { web: component('web') }),
        await applied(H2, { web: component('web'), db: component('db') }),
      ]);
      const keys = await componentKeyMap.keysForInstall(await registered(H1, { web: component('web') }, 'fluxappregister'));
      expect([...keys.keys()]).to.deep.equal(['web']);
    });

    it('refuses a version the app\'s history never applied', async () => {
      sinon.stub(appHistory, 'appliedMessages').resolves([await applied(H1, { web: component('web') })]);
      let caught;
      try {
        await componentKeyMap.keysForInstall(await registered(H2, { web: component('web') }));
      } catch (error) { caught = error; }
      expect(caught?.message).to.match(/not an applied message/);
    });
  });

  describe('keysForUpdate', () => {
    it('carries the installed record\'s keys onto the update: a rename keeps its key', async () => {
      const install = new flux.InstalledSpec({
        record: await registered(H1, { web: component('web') }, 'fluxappregister'), componentKeys: new Map([['web', `c${'b'.repeat(51)}a`]]),
      });
      const keys = await componentKeyMap.keysForUpdate(install, await registered(H2, { frontend: component('frontend', 'web') }));
      expect([...keys]).to.deep.equal([['frontend', `c${'b'.repeat(51)}a`]]);
    });

    it('keys a record stored before keys by the names its components run under', async () => {
      const install = new flux.InstalledSpec({ record: await registered(H1, { web: component('web') }, 'fluxappregister') });
      const keys = await componentKeyMap.keysForUpdate(install, await registered(H2, { web: component('web'), db: component('db') }));
      expect(keys.get('web'), 'a component the node already runs keeps its name as its key').to.equal('web');
      const minted = flux.componentKeysFor(await specWith({ web: component('web'), db: component('db') }), {
        previous: new Map([['web', 'web']]), appIdentity: IDENTITY, messageHash: H2,
      });
      expect(keys.get('db'), 'the one the update adds is minted from the app\'s identity and the update').to.equal(minted.get('db'));
    });
  });
});
