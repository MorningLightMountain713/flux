const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const logStub = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
const registry = proxyquire('../../ZelBack/src/services/utils/operationRegistry', {
  '../../lib/log': logStub,
});

describe('operationRegistry', () => {
  afterEach(() => {
    registry.clear();
    sinon.restore();
    logStub.warn.resetHistory();
  });

  describe('acquire / per-key mutual exclusion', () => {
    it('acquires a free key and reports it held', () => {
      expect(registry.acquire('web', 'install', 'appInstaller')).to.equal(true);
      expect(registry.isHeld('web')).to.equal(true);
    });

    it('rejects a different operation on a held key', () => {
      registry.acquire('web', 'install', 'appInstaller');
      expect(registry.acquire('web', 'remove', 'appUninstaller')).to.equal(false);
      // the original lease is untouched
      expect(registry.get('web').type).to.equal('install');
    });

    it('is idempotent for the same owner+type (refreshes, does not reject)', () => {
      registry.acquire('web', 'install', 'appInstaller', 'first');
      expect(registry.acquire('web', 'install', 'appInstaller', 'again')).to.equal(true);
      expect(registry.get('web').reason).to.equal('again');
    });

    it('lets a DIFFERENT app be acquired concurrently (per-key scope, no global freeze)', () => {
      expect(registry.acquire('web', 'install', 'appInstaller')).to.equal(true);
      expect(registry.acquire('db', 'remove', 'appUninstaller')).to.equal(true);
      expect(registry.isHeld('web')).to.equal(true);
      expect(registry.isHeld('db')).to.equal(true);
    });
  });

  describe('release', () => {
    it('drops a held lease', () => {
      registry.acquire('web', 'install', 'appInstaller');
      expect(registry.release('web')).to.equal(true);
      expect(registry.isHeld('web')).to.equal(false);
    });

    it('is a no-op (false) for a key that is not held', () => {
      expect(registry.release('nope')).to.equal(false);
    });

    it('frees the key so a different operation can then acquire it', () => {
      registry.acquire('web', 'install', 'appInstaller');
      registry.release('web');
      expect(registry.acquire('web', 'remove', 'appUninstaller')).to.equal(true);
    });
  });

  describe('component-scoped leases coexist with app leases', () => {
    it('holds a component stopping lease independently of an app lease', () => {
      registry.acquire('web', 'install', 'appInstaller');
      registry.acquire('worker_web', 'stopping', 'appReconciler');
      expect(registry.isHeld('web')).to.equal(true);
      expect(registry.isHeld('worker_web')).to.equal(true);
      expect(registry.get('worker_web').type).to.equal('stopping');
    });
  });

  describe('observability', () => {
    it('get returns a snapshot with heldForMs and no internal timer', () => {
      registry.acquire('web', 'install', 'appInstaller', 'installing web');
      const snap = registry.get('web');
      expect(snap).to.include({ key: 'web', type: 'install', owner: 'appInstaller', reason: 'installing web' });
      expect(snap.heldForMs).to.be.a('number');
      expect(snap).to.not.have.property('timer');
    });

    it('list enumerates every current lease', () => {
      registry.acquire('web', 'install', 'appInstaller');
      registry.acquire('db', 'backup', 'appOperations');
      const keys = registry.list().map((l) => l.key).sort();
      expect(keys).to.deep.equal(['db', 'web']);
    });
  });

  describe('TTL watchdog', () => {
    it('force-releases a leaked lease after its TTL and logs loudly', () => {
      const clock = sinon.useFakeTimers();
      registry.acquire('web', 'install', 'appInstaller');
      expect(registry.isHeld('web')).to.equal(true);
      clock.tick(registry.TTL_MS.install + 1);
      expect(registry.isHeld('web')).to.equal(false);
      expect(logStub.warn.calledOnce).to.equal(true);
      clock.restore();
    });

    it('a released lease never trips its TTL (timer cleared on release)', () => {
      const clock = sinon.useFakeTimers();
      registry.acquire('web', 'stopping', 'appReconciler');
      registry.release('web');
      clock.tick(registry.TTL_MS.stopping + 1);
      expect(logStub.warn.called).to.equal(false);
      clock.restore();
    });
  });
});
