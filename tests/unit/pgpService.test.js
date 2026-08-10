'use strict';

const chai = require('chai');
const sinon = require('sinon');

const { expect } = chai;

const pgpService = require('../../ZelBack/src/services/pgpService');
const workerRunner = require('../../ZelBack/src/services/utils/workerRunner');
const generalService = require('../../ZelBack/src/services/generalService');
const nodeIdentityRepository = require('../../ZelBack/src/services/appDatabase/nodeIdentityRepository');

describe('pgpService tests', () => {
  let originalUserconfig;

  // Scoped to this suite and restored afterwards. Assigning globalThis.userconfig at
  // module load leaked into every suite mocha loaded after this one, which changed the
  // answers other suites got from their own config.
  before(() => {
    originalUserconfig = globalThis.userconfig;
    // eslint-disable-next-line global-require
    globalThis.userconfig = require('../../config/userconfig');
  });

  after(() => {
    globalThis.userconfig = originalUserconfig;
  });

  describe('encryptMessage decryptMessage tests', async () => {
    it('should encrypt, decrypt a message', async () => {
      const message = 'Hello, my message';
      const publicKeys = [
        `-----BEGIN PGP PUBLIC KEY BLOCK-----

xjMEZFy8HxYJKwYBBAHaRw8BAQdAaP1lYSOxwKgLOZBljT1T7RUf41Tfs11e
rfmf0u719HrNG0pvbiBTbWl0aCA8am9uQGV4YW1wbGUuY29tPsKMBBAWCgA+
BYJkXLwfBAsJBwgJkBM7nfDSgt1SAxUICgQWAAIBAhkBApsDAh4BFiEEphKB
KTLt83clUmbFEzud8NKC3VIAANBoAP49gaNBpaMx54YrHuUkEa2Sqq8ep7V0
St/zBzhvC7eSnQEAi2bw89bUr0jKz4IsUy2Sb2HgFdEcDDMPS2uvJr0fNQ7O
OARkXLwfEgorBgEEAZdVAQUBAQdAEqaB8u+FgHwA5d1aNY/9zGiqpr5hPaMd
Ir/HQHixswwDAQgHwngEGBYIACoFgmRcvB8JkBM7nfDSgt1SApsMFiEEphKB
KTLt83clUmbFEzud8NKC3VIAAK/oAQCE82Dx1FAvWXajFmloRVPtu35v5Sbm
lfbpohsNnRj6uwEAr1nVaA1SD+d1PwvzMy7+QmnpJoLx7ustBMrtabbbzQ4=
=OCME
-----END PGP PUBLIC KEY BLOCK-----`,

        `-----BEGIN PGP PUBLIC KEY BLOCK-----

xjMEZFy8HxYJKwYBBAHaRw8BAQdAQnWNN393wTC6qX6qqXy4/YgTj+9gyK3P
CmwRV/w/boDNG0pvbiBTbWl0aCA8am9uQGV4YW1wbGUuY29tPsKMBBAWCgA+
BYJkXLwfBAsJBwgJkL5gqbwh9G29AxUICgQWAAIBAhkBApsDAh4BFiEEnjqD
4ezF0T8+Co9vvmCpvCH0bb0AAOU3AQDbodmU8DVv6ghZJYQWkFQsOP7lOI6y
+yh6L4kfZrFQ+wEAuMqJFiz0xE5hviqMy0sDtnQqu+yX4L5Qptn3NVEotA/O
OARkXLwfEgorBgEEAZdVAQUBAQdAvg0Xv0hhIDTe3G1XceeTBg1d4bmC+nFF
BdA1I2fxfTMDAQgHwngEGBYIACoFgmRcvB8JkL5gqbwh9G29ApsMFiEEnjqD
4ezF0T8+Co9vvmCpvCH0bb0AALc5AP9sDXv0AeIB01ArvJJL4kOjXFmdxjqJ
6TDLNQpNC1WnFQEA5HezfztN7q1ItHr9FXWcXzSl0uVarqnT9ahhQ210pAw=
=qHan
-----END PGP PUBLIC KEY BLOCK-----`,
      ];

      const validPrivateKey = `-----BEGIN PGP PRIVATE KEY BLOCK-----

xVgEZFy8HxYJKwYBBAHaRw8BAQdAaP1lYSOxwKgLOZBljT1T7RUf41Tfs11e
rfmf0u719HoAAP9BwvCGy8HiilSR+BdPEilWfYzGxDylt3gmAQq4oHjfPxEG
zRtKb24gU21pdGggPGpvbkBleGFtcGxlLmNvbT7CjAQQFgoAPgWCZFy8HwQL
CQcICZATO53w0oLdUgMVCAoEFgACAQIZAQKbAwIeARYhBKYSgSky7fN3JVJm
xRM7nfDSgt1SAADQaAD+PYGjQaWjMeeGKx7lJBGtkqqvHqe1dErf8wc4bwu3
kp0BAItm8PPW1K9Iys+CLFMtkm9h4BXRHAwzD0trrya9HzUOx10EZFy8HxIK
KwYBBAGXVQEFAQEHQBKmgfLvhYB8AOXdWjWP/cxoqqa+YT2jHSK/x0B4sbMM
AwEIBwAA/3Sz/vBPpvgOA1546xRBofI39aU2DEJUJbQI6SFMYstoEDDCeAQY
FggAKgWCZFy8HwmQEzud8NKC3VICmwwWIQSmEoEpMu3zdyVSZsUTO53w0oLd
UgAAr+gBAITzYPHUUC9ZdqMWaWhFU+27fm/lJuaV9umiGw2dGPq7AQCvWdVo
DVIP53U/C/MzLv5CaekmgvHu6y0Eyu1pttvNDg==
=o9ym
-----END PGP PRIVATE KEY BLOCK-----`;

      const invalidPrivateKey = `-----BEGIN PGP PRIVATE KEY BLOCK-----

xVgEZFy8HxYJKwYBBAHaRw8BAQdATjNcrzRHzLT5cDCkNrrohHwIx1A3mZwd
c1FcyU08VUUAAP4zimxLUVIs727vVotscvedRRoCJEBergkoi+5COWW03Q7M
zRtKb24gU21pdGggPGpvbkBleGFtcGxlLmNvbT7CjAQQFgoAPgWCZFy8HwQL
CQcICZBjUysAnLN4hAMVCAoEFgACAQIZAQKbAwIeARYhBMQTRvLWiqvU3FtZ
MmNTKwCcs3iEAABrJQD+NkE6p7wRU9MHuxQ1EqW4jGGwYl0tU7E0buTDJUlO
VD0BANiSB+0xt9xCxw0HWhJ1bBEpHMnbFYRevJ00iFGaN+QOx10EZFy8HxIK
KwYBBAGXVQEFAQEHQONcz3VgXp4gepyVK7lM44rpeFIdujr2YC4lgBBOCgly
AwEIBwAA/1UgwPF6fiFTtvQcLe5/u8Vsr02nBY3g0Rumuu0B1Yo4EcPCeAQY
FggAKgWCZFy8HwmQY1MrAJyzeIQCmwwWIQTEE0by1oqr1NxbWTJjUysAnLN4
hAAAS88A/RCY6LT3m7X/KRFKntdqCzFVfSuiYR2meOtp+mWIlE07AP9rYjN1
BIscsJYafHuBDymkCDcQ0KPIgFPLHt4qSDBtDg==
=apCq
-----END PGP PRIVATE KEY BLOCK-----`;
      const encryptedMessage = await pgpService.encryptMessage(message, publicKeys);
      const isMessage = encryptedMessage.startsWith('-----BEGIN PGP MESSAGE----');
      expect(isMessage).to.be.eql(true);
      expect(encryptedMessage).to.be.a('string');

      const decrpytedMessage = await pgpService.decryptMessage(encryptedMessage, validPrivateKey);
      expect(decrpytedMessage).to.be.eql(message);
      const invalidDecryptMessage = await pgpService.decryptMessage(encryptedMessage, invalidPrivateKey);
      expect(invalidDecryptMessage).to.be.eql(null);
    });
  });

  describe('identity tests', () => {
    // Rewritten for the model this commit installs: the keypair lives in
    // zelfluxlocal through nodeIdentityRepository, not in config/userconfig.js, so
    // the fixtures stub the repository rather than the global and the file writer.
    // The behaviours development's versions pinned are the same ones asserted here -
    // do nothing when the pair is good, replace it when the public half does not
    // belong to the private one, and never derive when the caller supplies a key.
    let runInWorkerStub;
    let getIdentityStub;
    let setIdentityStub;

    beforeEach(() => {
      runInWorkerStub = sinon.stub(workerRunner, 'runInWorker');
      getIdentityStub = sinon.stub(nodeIdentityRepository, 'getPgpIdentity');
      setIdentityStub = sinon.stub(nodeIdentityRepository, 'setPgpIdentity').resolves(true);
    });

    afterEach(() => {
      sinon.restore();
    });

    it('generates nothing on a node whose stored keypair verifies', async () => {
      getIdentityStub.resolves({ privateKey: 'aPrivateKey', publicKey: 'itsPublicKey' });
      runInWorkerStub.withArgs('pgpWorker', sinon.match({ operation: 'derivePublicKey' })).resolves('itsPublicKey');

      await pgpService.generateIdentity();

      const generations = runInWorkerStub.getCalls().filter((call) => call.args[1].operation === 'generateKey');
      expect(generations.length).to.be.eql(0);
      sinon.assert.notCalled(setIdentityStub);
    });

    it('generates and stores a keypair on a node that has none', async () => {
      getIdentityStub.resolves(null);
      globalThis.userconfig.initial.pgpPrivateKey = '';
      globalThis.userconfig.initial.pgpPublicKey = '';
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({ txhash: 'abcd', txindex: 0 });
      runInWorkerStub.withArgs('pgpWorker', sinon.match({ operation: 'generateKey' }))
        .resolves({ privateKey: 'newPrivateKey', publicKey: 'newPublicKey' });

      await pgpService.generateIdentity();

      sinon.assert.calledWithMatch(runInWorkerStub, 'pgpWorker', { operation: 'generateKey' });
      sinon.assert.calledOnceWithExactly(setIdentityStub, { privateKey: 'newPrivateKey', publicKey: 'newPublicKey' });
    });

    it('replaces a stored keypair whose public key does not belong to its private key', async () => {
      getIdentityStub.resolves({ privateKey: 'aCorruptPrivateKey', publicKey: 'someoneElsesPublicKey' });
      globalThis.userconfig.initial.pgpPrivateKey = '';
      globalThis.userconfig.initial.pgpPublicKey = '';
      sinon.stub(generalService, 'obtainNodeCollateralInformation').resolves({ txhash: 'abcd', txindex: 0 });
      runInWorkerStub.withArgs('pgpWorker', sinon.match({ operation: 'derivePublicKey' })).resolves('aDifferentPublicKey');
      runInWorkerStub.withArgs('pgpWorker', sinon.match({ operation: 'generateKey' }))
        .resolves({ privateKey: 'newPrivateKey', publicKey: 'newPublicKey' });

      await pgpService.generateIdentity();

      sinon.assert.calledWithMatch(runInWorkerStub, 'pgpWorker', { operation: 'generateKey' });
      sinon.assert.calledOnceWithExactly(setIdentityStub, { privateKey: 'newPrivateKey', publicKey: 'newPublicKey' });
    });

    it('adopts an intact keypair still held in the config file rather than generating over it', async () => {
      getIdentityStub.resolves(null);
      globalThis.userconfig.initial.pgpPrivateKey = 'operatorsPrivateKey';
      globalThis.userconfig.initial.pgpPublicKey = 'operatorsPublicKey';
      runInWorkerStub.withArgs('pgpWorker', sinon.match({ operation: 'keypairMatches' })).resolves(true);

      await pgpService.generateIdentity();

      const generations = runInWorkerStub.getCalls().filter((call) => call.args[1].operation === 'generateKey');
      expect(generations.length).to.be.eql(0);
      sinon.assert.calledOnceWithExactly(setIdentityStub, {
        privateKey: 'operatorsPrivateKey',
        publicKey: 'operatorsPublicKey',
      });
    });

    it('decrypts with a caller-supplied key without reading the stored identity', async () => {
      runInWorkerStub.withArgs('pgpWorker', sinon.match({ operation: 'decrypt' })).resolves('plaintext');

      const result = await pgpService.decryptMessage('encrypted', 'aCallerSuppliedKey');

      expect(result).to.be.eql('plaintext');
      sinon.assert.notCalled(getIdentityStub);
    });

    it('decrypts with the stored key when the caller supplies none', async () => {
      getIdentityStub.resolves({ privateKey: 'aPrivateKey', publicKey: 'itsPublicKey' });
      runInWorkerStub.withArgs('pgpWorker', sinon.match({ operation: 'decrypt' })).resolves('plaintext');

      const result = await pgpService.decryptMessage('encrypted');

      expect(result).to.be.eql('plaintext');
      sinon.assert.calledWithMatch(runInWorkerStub, 'pgpWorker', {
        operation: 'decrypt',
        params: { decryptionKey: 'aPrivateKey' },
      });
    });
  });
});
