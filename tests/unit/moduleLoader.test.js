'use strict';

const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');
const moduleLoader = require('../../ZelBack/src/lib/moduleLoader');
const messageHelper = require('../../ZelBack/src/services/messageHelper');

const FIXTURE = path.join(__dirname, 'fixtures/moduleLoader');

describe('moduleLoader', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('load', () => {
    it('loads a module by its path under ZelBack/src, the instance every other require holds', () => {
      expect(moduleLoader.load('services/messageHelper')).to.equal(messageHelper);
    });

    it('loads from another root when one is named', () => {
      expect(moduleLoader.load('counter', FIXTURE).name).to.equal('counter');
    });
  });

  describe('lazyFunction', () => {
    it('loads nothing until it is called', () => {
      const resolved = require.resolve(path.join(FIXTURE, 'untouched'));
      const lazy = moduleLoader.lazyFunction(path.relative(moduleLoader.SRC_DIR, path.join(FIXTURE, 'untouched')), 'answer');
      expect(require.cache[resolved], 'loaded before the first call').to.equal(undefined);
      expect(lazy()).to.equal('answered');
      expect(require.cache[resolved], 'loaded by the first call').to.not.equal(undefined);
    });

    it('calls the named export, read from the module on every call', () => {
      const lazy = moduleLoader.lazyFunction('services/messageHelper', 'createDataMessage');
      expect(lazy('x')).to.deep.equal({ status: 'success', data: 'x' });
      sinon.stub(messageHelper, 'createDataMessage').returns('stubbed');
      expect(lazy('x')).to.equal('stubbed');
    });

    it('calls the module itself when no export is named', () => {
      const lazy = moduleLoader.lazyFunction(path.relative(moduleLoader.SRC_DIR, path.join(FIXTURE, 'callable')));
      expect(lazy(2, 3)).to.equal(5);
    });
  });

  describe('importModule', () => {
    it('imports an ESM-only package', async () => {
      const { CipherSuite } = await moduleLoader.importModule('@hpke/core');
      expect(CipherSuite).to.be.a('function');
    });

    it('imports an ES module by its absolute path', async () => {
      const esm = await moduleLoader.importModule(path.join(FIXTURE, 'esm.mjs'));
      expect(esm.kind).to.equal('esm');
    });
  });
});
