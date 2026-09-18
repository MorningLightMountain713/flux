'use strict';

process.env.NODE_CONFIG_DIR = `${process.cwd()}/tests/unit/globalconfig`;

const crypto = require('node:crypto');
const { expect } = require('chai');
const sinon = require('sinon');
const benchmarkService = require('../../ZelBack/src/services/benchmarkService');
const legacyTransportProvider = require('../../ZelBack/src/services/providers/FluxOSLegacyTransportProvider');
const { loadSpecLibrary } = require('./fixtures/fluxSpec');

/**
 * What a released client does with the v8 owner view: nonce, ciphertext, tag,
 * under the session key it sent. Anything the provider emits has to open here.
 */
function openAsReleasedClient(ciphertextBase64, aesKey) {
  const blob = Buffer.from(ciphertextBase64, 'base64');
  const nonce = blob.subarray(0, 12);
  const ciphertext = blob.subarray(12, -16);
  const tag = blob.subarray(-16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

describe('FluxOSLegacyTransportProvider', () => {
  const aesKey = crypto.randomBytes(32);
  // The wrapped key is opaque to the provider: fluxbenchd is what unwraps it.
  const wrappedKeyBase64 = crypto.randomBytes(256).toString('base64');
  let unwrap;

  before(async function loadLibrary() {
    this.timeout(30_000);
    await loadSpecLibrary();
  });

  beforeEach(() => {
    unwrap = sinon.stub(benchmarkService, 'decryptRSAMessage').resolves({
      status: 'success',
      data: JSON.stringify({ status: 'ok', message: aesKey.toString('base64') }),
    });
  });

  afterEach(() => sinon.restore());

  it('seals for the viewer as nonce, ciphertext, tag under the key the viewer sent', async () => {
    const provider = await legacyTransportProvider.create('myapp', '1owner', wrappedKeyBase64);
    const plaintext = Buffer.from(JSON.stringify({ compose: [{ name: 'web' }], contacts: [] }));

    const sealed = await provider.encrypt(plaintext);

    expect(sealed.algorithm).to.equal('AES-256-GCM');
    expect(Buffer.from(sealed.ciphertext, 'base64').length, 'no wrapped key travels with the view')
      .to.equal(12 + plaintext.length + 16);
    expect(openAsReleasedClient(sealed.ciphertext, aesKey)).to.equal(plaintext.toString('utf8'));
  });

  it('has fluxbenchd unwrap the key it was handed, for this app and owner, once', async () => {
    const provider = await legacyTransportProvider.create('myapp', '1owner', wrappedKeyBase64);

    await provider.encrypt(Buffer.from('a'));
    await provider.encrypt(Buffer.from('b'));

    sinon.assert.calledOnce(unwrap);
    expect(JSON.parse(unwrap.firstCall.args[0])).to.deep.equal({
      fluxID: '1owner', appName: 'myapp', message: wrappedKeyBase64, blockHeight: 0,
    });
  });

  it('opens what it sealed', async () => {
    const provider = await legacyTransportProvider.create('myapp', '1owner', wrappedKeyBase64);
    const sealed = await provider.encrypt(Buffer.from('round trip'));

    expect((await provider.decrypt(sealed)).toString('utf8')).to.equal('round trip');
  });

  it('refuses a view blob too short to carry a nonce and a tag', async () => {
    const provider = await legacyTransportProvider.create('myapp', '1owner', wrappedKeyBase64);

    let refused = null;
    await provider.decrypt({ algorithm: 'AES-256-GCM', ciphertext: Buffer.alloc(20).toString('base64') })
      .catch((error) => { refused = error; });

    expect(refused?.message).to.match(/shorter than minimum layout/);
  });

  it('refuses when fluxbenchd will not unwrap the key', async () => {
    unwrap.resolves({ status: 'success', data: JSON.stringify({ status: 'error', message: '' }) });
    const provider = await legacyTransportProvider.create('myapp', '1owner', wrappedKeyBase64);

    let refused = null;
    await provider.encrypt(Buffer.from('x')).catch((error) => { refused = error; });

    expect(refused?.message).to.match(/decryptRSAMessage RPC rejected/);
  });
});
