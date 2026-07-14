const { expect } = require('chai');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const proxyquire = require('proxyquire');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

describe('contentStore', () => {
  let baseDir;
  let contentStore;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-content-test-'));
    contentStore = proxyquire('../../ZelBack/src/services/appLifecycle/contentStore', {
      '../utils/appConstants': { contentStorePath: baseDir },
    });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('round-trips a blob through put/get and lists it', async () => {
    const framed = Buffer.from('framed-ciphertext');
    expect(await contentStore.put('myapp', HASH_A, framed)).to.equal(true);
    const back = await contentStore.get('myapp', HASH_A);
    expect(back.equals(framed)).to.equal(true);
    expect(await contentStore.list('myapp')).to.deep.equal([HASH_A]);
  });

  it('returns null / empty for an app with no store', async () => {
    expect(await contentStore.get('ghost', HASH_A)).to.equal(null);
    expect(await contentStore.list('ghost')).to.deep.equal([]);
  });

  it('rejects a malformed hash and a path-traversal app name before touching the filesystem', async () => {
    let threw = 0;
    await contentStore.get('myapp', 'sha256:../../../etc/passwd').catch(() => { threw += 1; });
    await contentStore.get('../escape', HASH_A).catch(() => { threw += 1; });
    await contentStore.remove('myapp', 'not-a-hash').catch(() => { threw += 1; });
    expect(threw).to.equal(3);
  });

  it('remove drops one blob, removeApp drops the whole app dir', async () => {
    await contentStore.put('myapp', HASH_A, Buffer.from('one'));
    await contentStore.put('myapp', HASH_B, Buffer.from('two'));
    await contentStore.remove('myapp', HASH_A);
    expect(await contentStore.list('myapp')).to.deep.equal([HASH_B]);
    await contentStore.removeApp('myapp');
    expect(await contentStore.list('myapp')).to.deep.equal([]);
  });

  it('retainOnly deletes exactly the undeclared entries', async () => {
    await contentStore.put('myapp', HASH_A, Buffer.from('keep'));
    await contentStore.put('myapp', HASH_B, Buffer.from('reap'));
    await contentStore.retainOnly('myapp', [HASH_A]);
    expect(await contentStore.list('myapp')).to.deep.equal([HASH_A]);
    expect((await contentStore.get('myapp', HASH_A)).toString()).to.equal('keep');
  });

  it('put is best-effort: an unwritable store logs and returns false instead of throwing', async () => {
    const blocked = proxyquire('../../ZelBack/src/services/appLifecycle/contentStore', {
      '../utils/appConstants': { contentStorePath: path.join(baseDir, 'not-a-dir-file') },
    });
    await fs.writeFile(path.join(baseDir, 'not-a-dir-file'), 'occupied');
    expect(await blocked.put('myapp', HASH_A, Buffer.from('x'))).to.equal(false);
  });

  it('stores the app dir 0700 and the blob 0600', async () => {
    await contentStore.put('myapp', HASH_A, Buffer.from('x'));
    const dirMode = (await fs.stat(path.join(baseDir, 'myapp'))).mode & 0o777;
    const fileMode = (await fs.stat(path.join(baseDir, 'myapp', 'a'.repeat(64)))).mode & 0o777;
    expect(dirMode).to.equal(0o700);
    expect(fileMode).to.equal(0o600);
  });
});
