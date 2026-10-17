'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const componentKeyMap = require('../../ZelBack/src/services/appLifecycle/componentKeyMap');
const appHistory = require('../../ZelBack/src/services/appDecisions/appHistory');
const specCutover = require('../../ZelBack/src/services/utils/specCutover');
const { inMemoryHostedInstances } = require('./fixtures/appRecords');
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
    return domain.registeredSpec({ event, identity: IDENTITY, uuid: UUID });
  }

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('namingForVersion', () => {
    it('replays the app\'s applied versions in order: a rename keeps the key, an added component mints one', async () => {
      sinon.stub(appHistory, 'appliedMessages').resolves([
        await applied(HX, { web: component('web') }, 'u-earlier-app'),
        await applied(H1, { web: component('web') }),
        await applied(H2, { frontend: component('frontend', 'web'), db: component('db') }),
        await applied(H3, { frontend: component('frontend'), db: component('db') }),
      ]);
      const atRegistration = flux.componentKeysFor(await specWith({ web: component('web') }), { previous: null, appIdentity: IDENTITY, messageHash: H1 });

      const { componentKeys: keys } = await componentKeyMap.namingForVersion(await registered(H2, { frontend: component('frontend', 'web'), db: component('db') }));

      expect([...keys.keys()]).to.have.members(['frontend', 'db']);
      expect(keys.get('frontend'), 'the renamed component keeps the key the registration minted').to.equal(atRegistration.get('web'));
      expect(flux.isComponentKey(keys.get('db'))).to.equal(true);
      expect(keys.get('db')).to.not.equal(keys.get('frontend'));
    });

    it('reads no version applied after it', async () => {
      sinon.stub(appHistory, 'appliedMessages').resolves([
        await applied(H1, { web: component('web') }),
        await applied(H2, { site: component('site', 'web'), web: component('web') }),
      ]);
      const atRegistration = flux.componentKeysFor(await specWith({ web: component('web') }), { previous: null, appIdentity: IDENTITY, messageHash: H1 });
      const naming = await componentKeyMap.namingForVersion(await registered(H1, { web: component('web') }, 'fluxappregister'));
      expect([...naming.componentKeys]).to.deep.equal([['web', atRegistration.get('web')]]);
      expect([...naming.formerNames]).to.deep.equal([]);
    });

    it('keys a version whose decision is not stored yet from the versions applied before it', async () => {
      sinon.stub(appHistory, 'appliedMessages').resolves([
        await applied(HX, { web: component('web') }, 'u-earlier-app'),
        await applied(H1, { web: component('web') }),
      ]);
      const atRegistration = flux.componentKeysFor(await specWith({ web: component('web') }), { previous: null, appIdentity: IDENTITY, messageHash: H1 });

      const { componentKeys: keys } = await componentKeyMap.namingForVersion(await registered(H2, { site: component('site', 'web'), db: component('db') }));

      expect([...keys.keys()]).to.have.members(['site', 'db']);
      expect(keys.get('site'), 'the renamed component keeps the key the registration minted').to.equal(atRegistration.get('web'));
      expect(flux.isComponentKey(keys.get('db'))).to.equal(true);
    });

    it('gives each component the names its key held before, in the order it last held them', async () => {
      sinon.stub(appHistory, 'appliedMessages').resolves([
        await applied(H1, { web: component('web'), db: component('db') }),
        await applied(H2, { site: component('site', 'web'), db: component('db') }),
        await applied(H3, { web: component('web', 'site'), db: component('db') }),
      ]);
      const { componentKeys, formerNames } = await componentKeyMap.namingForVersion(await registered(HX, { www: component('www', 'web'), db: component('db') }));
      expect([...formerNames]).to.deep.equal([[componentKeys.get('www'), ['site', 'web']]]);
    });

    it('gives a re-added name nothing of the component that held it before', async () => {
      sinon.stub(appHistory, 'appliedMessages').resolves([
        await applied(H1, { web: component('web') }),
        await applied(H2, { site: component('site', 'web') }),
      ]);
      const { componentKeys, formerNames } = await componentKeyMap.namingForVersion(await registered(H3, { site: component('site'), web: component('web') }));
      expect([...formerNames]).to.deep.equal([[componentKeys.get('site'), ['web']]]);
    });
  });

  describe('namingForUpdate', () => {
    const KEY = `c${'b'.repeat(51)}a`;

    it('carries the hosted instance\'s keys onto the update: a rename keeps its key and gains its former name', async () => {
      const appliedMessages = sinon.stub(appHistory, 'appliedMessages').rejects(new Error('the history is not read'));
      const install = new flux.HostedInstance({
        record: await registered(H1, { web: component('web') }, 'fluxappregister'), componentKeys: new Map([['web', KEY]]),
      });
      const naming = await componentKeyMap.namingForUpdate(install, await registered(H2, { frontend: component('frontend', 'web') }));
      expect([...naming.componentKeys]).to.deep.equal([['frontend', KEY]]);
      expect([...naming.formerNames]).to.deep.equal([[KEY, ['web']]]);
      expect(appliedMessages.called).to.equal(false);
    });

    it('carries the hosted instance\'s former names through an update that renames nothing', async () => {
      const install = new flux.HostedInstance({
        record: await registered(H1, { frontend: component('frontend') }),
        componentKeys: new Map([['frontend', KEY]]),
        formerNames: new Map([[KEY, ['web']]]),
      });
      const naming = await componentKeyMap.namingForUpdate(install, await registered(H2, { frontend: component('frontend'), db: component('db') }));
      expect([...naming.formerNames]).to.deep.equal([[KEY, ['web']]]);
    });

    it('keys a record stored before keys by the names its components run under', async () => {
      const install = new flux.HostedInstance({ record: await registered(H1, { web: component('web') }, 'fluxappregister') });
      const { componentKeys: keys } = await componentKeyMap.namingForUpdate(install, await registered(H2, { web: component('web'), db: component('db') }));
      expect(keys.get('web'), 'a component the node already runs keeps its name as its key').to.equal('web');
      const minted = flux.componentKeysFor(await specWith({ web: component('web'), db: component('db') }), {
        previous: new Map([['web', 'web']]), appIdentity: IDENTITY, messageHash: H2,
      });
      expect(keys.get('db'), 'the one the update adds is minted from the app\'s identity and the update').to.equal(minted.get('db'));
    });
  });

  // The boot step: a record stored before records held keys gets its
  // components' names, which is what its containers, data and folders are named by.
  describe('keyInstalledByName', () => {
    const instance = async (name, components, own = {}) => new flux.HostedInstance({
      record: await domain.registeredSpec({
        event: await domain.confirmedEvent({ spec: await domain.v9Spec({ name, components }), hash: H1, type: 'fluxappregister' }),
        identity: IDENTITY,
        uuid: `u-${name}`,
      }),
      ...own,
    });

    it('keys each component of a record that holds no keys by its name, and leaves a keyed record as it is', async () => {
      const { installed } = await inMemoryHostedInstances();
      const minted = new Map([['web', `c${'b'.repeat(51)}a`]]);
      await installed.put(await instance('unkeyed', { web: component('web'), db: component('db') }, { replica: 'r1' }));
      await installed.put(await instance('keyed', { web: component('web') }, { componentKeys: minted }));

      const results = await componentKeyMap.keyInstalledByName();

      expect(results).to.deep.equal({ keyed: [{ name: 'unkeyed', replica: 'r1' }], skipped: [] });
      const unkeyed = await installed.byReplica('unkeyed', 'r1');
      expect([...unkeyed.componentKeys]).to.have.deep.members([['web', 'web'], ['db', 'db']]);
      expect(unkeyed.record.hash, 'the registered record is kept').to.equal(H1);
      expect([...(await installed.byName('keyed')).componentKeys]).to.deep.equal([...minted]);

      expect(await componentKeyMap.keyInstalledByName(), 'nothing is left to key').to.deep.equal({ keyed: [], skipped: [] });
    });

    it('leaves a record whose spec it cannot open without keys, and keys the rest', async () => {
      const { installed } = await inMemoryHostedInstances();
      await installed.put(await instance('sealed', { web: component('web') }));
      await installed.put(await instance('open', { web: component('web') }));
      const resolve = specCutover.resolveRegisteredSpec;
      sinon.stub(specCutover, 'resolveRegisteredSpec').callsFake(async (record) => (record.name === 'sealed' ? null : resolve(record)));

      const results = await componentKeyMap.keyInstalledByName();

      expect(results.keyed).to.deep.equal([{ name: 'open', replica: null }]);
      expect(results.skipped).to.have.length(1);
      expect(results.skipped[0]).to.include({ name: 'sealed', replica: null });
      expect(results.skipped[0].reason).to.match(/^component keys for sealed: its spec cannot be opened on this node$/);
      expect((await installed.byName('sealed')).componentKeys).to.equal(null);
      expect([...(await installed.byName('open')).componentKeys]).to.deep.equal([['web', 'web']]);
    });
  });
});
