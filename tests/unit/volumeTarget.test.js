'use strict';

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const volumeService = require('../../ZelBack/src/services/utils/volumeService');
const { resolveVolumeTarget } = require('../../ZelBack/src/services/appSystem/volumeTarget');

chai.use(chaiAsPromised);
const { expect } = chai;

describe('volumeTarget: which volume a request addresses', () => {
  let listStub;

  function req(params = {}, query = {}) {
    return { params, query };
  }

  const loose = { replica: null, mount: '/mnt/appdata/fluxweb_myapp' };
  const s1 = { replica: 's1', mount: '/mnt/appdata/fluxweb_myapp_s1' };
  const s2 = { replica: 's2', mount: '/mnt/appdata/fluxweb_myapp_s2' };

  beforeEach(() => {
    listStub = sinon.stub(volumeService, 'listComponentVolumeMounts');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('parameters', () => {
    it('reads appname and component from params', async () => {
      listStub.resolves([loose]);
      const target = await resolveVolumeTarget(req({ appname: 'myapp', component: 'web' }));
      expect(target.mount).to.equal(loose.mount);
      sinon.assert.calledOnceWithExactly(listStub, 'myapp', 'web');
    });

    it('falls back to the query string for both', async () => {
      listStub.resolves([loose]);
      const target = await resolveVolumeTarget(req({}, { appname: 'myapp', component: 'web' }));
      expect(target.mount).to.equal(loose.mount);
      sinon.assert.calledOnceWithExactly(listStub, 'myapp', 'web');
    });

    it('rejects a missing appname', async () => {
      await expect(resolveVolumeTarget(req({ component: 'web' })))
        .to.be.rejectedWith('appname parameter is mandatory');
    });

    it('rejects a missing component', async () => {
      await expect(resolveVolumeTarget(req({ appname: 'myapp' })))
        .to.be.rejectedWith('component parameter is mandatory');
    });

    it('allows a missing component when the caller does not require one', async () => {
      listStub.resolves([loose]);
      await resolveVolumeTarget(req({ appname: 'myapp' }), { requireComponent: false });
      // The v1-3 flat form's identifier is the bare app name, so that is what
      // its component decodes to.
      sinon.assert.calledOnceWithExactly(listStub, 'myapp', 'myapp');
    });
  });

  describe('a node holding one volume', () => {
    it('resolves a loose app without a replica parameter', async () => {
      listStub.resolves([loose]);
      const target = await resolveVolumeTarget(req({ appname: 'myapp', component: 'web' }));
      expect(target).to.deep.equal({
        appname: 'myapp', component: 'web', replica: null, mount: loose.mount, volume: loose,
      });
    });

    it('resolves a named replica alone on its node, and reports which one it is', async () => {
      listStub.resolves([s1]);
      const target = await resolveVolumeTarget(req({ appname: 'myapp', component: 'web' }));
      expect(target.replica).to.equal('s1');
      expect(target.mount).to.equal(s1.mount);
    });

    it('rejects when nothing is mounted', async () => {
      listStub.resolves([]);
      await expect(resolveVolumeTarget(req({ appname: 'myapp', component: 'web' })))
        .to.be.rejectedWith('Application volume not found');
    });
  });

  describe('a co-located node', () => {
    it('refuses to guess when no replica is named', async () => {
      // The whole point: picking one silently is how a restore overwrites the
      // wrong replica's live data.
      listStub.resolves([s1, s2]);
      await expect(resolveVolumeTarget(req({ appname: 'myapp', component: 'web' })))
        .to.be.rejectedWith(/co-located on this node.*\?replica=.*s1, s2/);
    });

    it('resolves exactly the named replica', async () => {
      listStub.resolves([s1, s2]);
      const target = await resolveVolumeTarget(req({ appname: 'myapp', component: 'web' }, { replica: 's2' }));
      expect(target.replica).to.equal('s2');
      expect(target.mount).to.equal(s2.mount);
    });

    it('takes the replica from the route params too', async () => {
      listStub.resolves([s1, s2]);
      const target = await resolveVolumeTarget(req({ appname: 'myapp', component: 'web', replica: 's1' }));
      expect(target.mount).to.equal(s1.mount);
    });

    it('rejects a replica that is not mounted here, naming what is', async () => {
      listStub.resolves([s1, s2]);
      await expect(resolveVolumeTarget(req({ appname: 'myapp', component: 'web' }, { replica: 's9' })))
        .to.be.rejectedWith(/not found for replica s9.*s1, s2/);
    });

    it('does not accept a replica name for a loose volume', async () => {
      listStub.resolves([loose]);
      await expect(resolveVolumeTarget(req({ appname: 'myapp', component: 'web' }, { replica: 's1' })))
        .to.be.rejectedWith(/not found for replica s1.*unnamed/);
    });
  });
});
