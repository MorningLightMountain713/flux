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
    it('acquires a free key (returns a token) and reports it held', () => {
      expect(registry.acquire('web', 'install', 'appInstaller')).to.be.a('string');
      expect(registry.isHeld('web')).to.equal(true);
    });

    it('rejects a different operation on a held key (returns null)', () => {
      registry.acquire('web', 'install', 'appInstaller');
      expect(registry.acquire('web', 'remove', 'appUninstaller')).to.equal(null);
      // the original lease is untouched
      expect(registry.get('web').type).to.equal('install');
    });

    it('is idempotent for the same owner+type (refreshes, returns the SAME token)', () => {
      const first = registry.acquire('web', 'install', 'appInstaller', 'first');
      const again = registry.acquire('web', 'install', 'appInstaller', 'again');
      expect(again).to.equal(first);
      expect(registry.get('web').reason).to.equal('again');
    });

    it('lets a DIFFERENT app be acquired concurrently (per-key scope, no global freeze)', () => {
      expect(registry.acquire('web', 'install', 'appInstaller')).to.be.a('string');
      expect(registry.acquire('db', 'remove', 'appUninstaller')).to.be.a('string');
      expect(registry.isHeld('web')).to.equal(true);
      expect(registry.isHeld('db')).to.equal(true);
    });
  });

  describe('release', () => {
    it('drops a held lease (no token = unconditional, the decoupled stopping markers)', () => {
      registry.acquire('worker_web', 'stopping', 'dockerService');
      expect(registry.release('worker_web')).to.equal(true);
      expect(registry.isHeld('worker_web')).to.equal(false);
    });

    it('is a no-op (false) for a key that is not held', () => {
      expect(registry.release('nope')).to.equal(false);
    });

    it('frees the key so a different operation can then acquire it', () => {
      const token = registry.acquire('web', 'install', 'appInstaller');
      registry.release('web', token);
      expect(registry.acquire('web', 'remove', 'appUninstaller')).to.be.a('string');
    });
  });

  describe('opaque-token own-lease-only release', () => {
    it('drops the lease when the token matches', () => {
      const token = registry.acquire('web', 'install', 'appInstaller');
      expect(registry.release('web', token)).to.equal(true);
      expect(registry.isHeld('web')).to.equal(false);
    });

    it('no-ops (false) on a mismatching token, leaving the held lease intact', () => {
      registry.acquire('web', 'install', 'appInstaller');
      expect(registry.release('web', 'lease-does-not-exist')).to.equal(false);
      expect(registry.isHeld('web')).to.equal(true);
      expect(registry.get('web').type).to.equal('install');
    });

    it('no-ops (false) on a null token — the never-acquired deferred/early-return path', () => {
      // A deferred install/remove hits its finally with token still null; an
      // own-checked release(key, null) must NOT delete the holder's lease.
      registry.acquire('web', 'install', 'appInstaller');
      expect(registry.release('web', null)).to.equal(false);
      expect(registry.isHeld('web')).to.equal(true);
    });

    it('a stale releaser cannot clobber a LATER lease on the same key (the skipGuard bug)', () => {
      // remove A acquires, then releases (own token) — the key is now free.
      const removeToken = registry.acquire('web', 'remove', 'appUninstaller');
      expect(registry.release('web', removeToken)).to.equal(true);
      // a fresh install acquires the freed key.
      registry.acquire('web', 'install', 'appInstaller');
      // a stale sibling remove releases with the OLD remove token — must NO-OP,
      // not delete the install's lease (the clobber that made hasBlockingLease lie).
      expect(registry.release('web', removeToken)).to.equal(false);
      expect(registry.isHeld('web')).to.equal(true);
      expect(registry.get('web').type).to.equal('install');
    });

    it('two same-app skipGuard removes share a token; the second release cannot clobber a later install', () => {
      const tokenA = registry.acquire('web', 'remove', 'appUninstaller');
      const tokenB = registry.acquire('web', 'remove', 'appUninstaller'); // idempotent -> same token
      expect(tokenB).to.equal(tokenA);
      // remove A finishes first and releases the shared lease.
      registry.release('web', tokenA);
      // an install acquires the freed key.
      registry.acquire('web', 'install', 'appInstaller');
      // remove B finishes and releases with its (shared) token — must NOT clobber install.
      registry.release('web', tokenB);
      expect(registry.get('web').type).to.equal('install');
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
    it('get returns a snapshot with heldForMs and no internal timer or token', () => {
      registry.acquire('web', 'install', 'appInstaller', 'installing web');
      const snap = registry.get('web');
      expect(snap).to.include({ key: 'web', type: 'install', owner: 'appInstaller', reason: 'installing web' });
      expect(snap.heldForMs).to.be.a('number');
      expect(snap).to.not.have.property('timer');
      expect(snap).to.not.have.property('token');
    });

    it('list enumerates every current lease', () => {
      registry.acquire('web', 'install', 'appInstaller');
      registry.acquire('db', 'backup', 'appOperations');
      const keys = registry.list().map((l) => l.key).sort();
      expect(keys).to.deep.equal(['db', 'web']);
    });

    it('anyHeld is false when empty and true while any lease is held', () => {
      expect(registry.anyHeld()).to.equal(false);
      const token = registry.acquire('web', 'install', 'appInstaller');
      expect(registry.anyHeld()).to.equal(true);
      registry.release('web', token);
      expect(registry.anyHeld()).to.equal(false);
    });

    it('anyHeld counts a transient component stopping lease too', () => {
      registry.acquire('worker_web', 'stopping', 'dockerService');
      expect(registry.anyHeld()).to.equal(true);
    });

    it('anyHeldOfType is true only for a held lease of a listed type', () => {
      const token = registry.acquire('web', 'backup', 'appOperations');
      expect(registry.anyHeldOfType('install', 'remove', 'reconcile')).to.equal(false);
      expect(registry.anyHeldOfType('backup', 'restore')).to.equal(true);
      registry.release('web', token);
      registry.acquire('db', 'install', 'appInstaller');
      expect(registry.anyHeldOfType('install', 'remove', 'softRedeploy', 'hardRedeploy', 'reconcile')).to.equal(true);
    });

    it('listByType returns only the keys of that lease type', () => {
      registry.acquire('web', 'backup', 'appOperations');
      registry.acquire('db', 'backup', 'appOperations');
      registry.acquire('cache', 'restore', 'appOperations');
      registry.acquire('api', 'install', 'appInstaller');
      expect(registry.listByType('backup').sort()).to.deep.equal(['db', 'web']);
      expect(registry.listByType('restore')).to.deep.equal(['cache']);
      expect(registry.listByType('reconcile')).to.deep.equal([]);
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
      const token = registry.acquire('web', 'stopping', 'appReconciler');
      registry.release('web', token);
      clock.tick(registry.TTL_MS.stopping + 1);
      expect(logStub.warn.called).to.equal(false);
      clock.restore();
    });
  });
});
