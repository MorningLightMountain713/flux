const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const configManager = require('../../ZelBack/src/services/utils/configManager');

const { ConfigManager } = configManager;

const validConfig = () => ({
  initial: {
    ipaddress: '127.0.0.1',
    zelid: '1TestZelID123',
    testnet: false,
    development: false,
    debug: false,
    upnp: false,
    apiport: 16127,
    routerIP: '192.168.1.1',
  },
});

describe('configManager tests', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('evaluate', () => {
    it('should return the module exports of a config file', () => {
      const result = ConfigManager.evaluate("module.exports = { initial: { zelid: 'abc' } }");
      expect(result).to.deep.equal({ initial: { zelid: 'abc' } });
    });

    it('should evaluate an empty file to an empty object', () => {
      // This is the shape the truncation window produces, and why the file being
      // readable is not on its own evidence that it is usable.
      expect(ConfigManager.evaluate('')).to.deep.equal({});
    });

    it('should throw on a malformed file rather than return a partial config', () => {
      expect(() => ConfigManager.evaluate('module.exports = { initial: {')).to.throw();
    });
  });

  describe('validate', () => {
    it('should accept a complete config', () => {
      expect(ConfigManager.validate(validConfig())).to.equal(null);
    });

    it('should reject an empty file, which is a legal program exporting {}', () => {
      expect(ConfigManager.validate(ConfigManager.evaluate(''))).to.equal('config has no initial section');
    });

    it('should reject a config with no initial section', () => {
      expect(ConfigManager.validate({})).to.equal('config has no initial section');
    });

    it('should reject a non-object', () => {
      expect(ConfigManager.validate(null)).to.equal('config is not an object');
      expect(ConfigManager.validate('nope')).to.equal('config is not an object');
    });

    it('should reject a missing or empty zelid', () => {
      const noZelid = validConfig();
      delete noZelid.initial.zelid;
      expect(ConfigManager.validate(noZelid)).to.equal('initial.zelid is missing');

      const emptyZelid = validConfig();
      emptyZelid.initial.zelid = '';
      expect(ConfigManager.validate(emptyZelid)).to.equal('initial.zelid is missing');
    });

    it('should reject an apiport outside the allowed set', () => {
      const config = validConfig();
      config.initial.apiport = 1234;
      expect(ConfigManager.validate(config)).to.equal('initial.apiport 1234 is not an allowed port');
    });

    it('should accept a blank apiport, which is how a non-UPnP node is configured', () => {
      const config = validConfig();
      config.initial.apiport = '';
      expect(ConfigManager.validate(config)).to.equal(null);
    });

    it('should reject a non-boolean where a flag is expected', () => {
      const config = validConfig();
      config.initial.upnp = 'true';
      expect(ConfigManager.validate(config)).to.equal('initial.upnp is not a boolean');
    });

    it('should accept a config that omits the optional flags', () => {
      const config = validConfig();
      delete config.initial.upnp;
      delete config.initial.debug;
      expect(ConfigManager.validate(config)).to.equal(null);
    });

    it('should reject a non-string routerIP', () => {
      const config = validConfig();
      config.initial.routerIP = 1234;
      expect(ConfigManager.validate(config)).to.equal('initial.routerIP is not a string');
    });
  });

  describe('singleton', () => {
    it('should be initialized', () => {
      expect(configManager.isInitialized()).to.equal(true);
    });

    it('should read the running config from globalThis', () => {
      expect(configManager.getUserConfig()).to.equal(globalThis.userconfig);
    });

    it('should get a nested value by dot notation', () => {
      expect(configManager.getConfigValue('initial.zelid')).to.equal(globalThis.userconfig.initial.zelid);
    });

    it('should return undefined for a path that does not exist', () => {
      expect(configManager.getConfigValue('initial.nothingHere')).to.equal(undefined);
      expect(configManager.getConfigValue('nothing.at.all')).to.equal(undefined);
    });

    it('should report no load error when the operator config was published', () => {
      expect(configManager.getLastLoadError()).to.equal(null);
    });

    it('should not offer a way to reload, since the config is read once at startup', () => {
      // Republishing mid-flight produced a process whose stated config and actual
      // behaviour disagreed - apiport in particular, which is captured by the HTTP
      // server but read live by the address this node announces.
      expect(configManager.reloadConfig).to.equal(undefined);
      expect(configManager.startWatching).to.equal(undefined);
    });
  });

  // Each of these constructs its own manager, which publishes onto globalThis, so the
  // running config is put back afterwards - a leaked default poisons every later suite.
  describe('startup fallback', () => {
    let running;

    beforeEach(() => {
      running = globalThis.userconfig;
    });

    afterEach(() => {
      globalThis.userconfig = running;
    });

    it('should publish defaults and record why when the file does not validate', () => {
      sinon.stub(ConfigManager, 'validate').returns('initial.zelid is missing');

      const manager = new ConfigManager();

      expect(manager.getLastLoadError()).to.equal('initial.zelid is missing');
      expect(globalThis.userconfig.initial.zelid).to.equal(null);
    });

    it('should publish defaults and record why when the file cannot be read', () => {
      // The 101-auth case. Requiring the module still succeeds - apiServer is what
      // refuses to start on a recorded error, so the abort lives in one place.
      const Patched = proxyquire('../../ZelBack/src/services/utils/configManager', {
        'node:fs': {
          readFileSync: () => { throw new Error('ENOENT: no such file or directory'); },
        },
      }).ConfigManager;

      const manager = new Patched();

      expect(manager.getLastLoadError()).to.include('unreadable');
      expect(globalThis.userconfig.initial.zelid).to.equal(null);
    });

    it('should publish the operator config when it reads and validates', () => {
      const manager = new ConfigManager();

      expect(manager.getLastLoadError()).to.equal(null);
      expect(globalThis.userconfig.initial.zelid).to.be.a('string');
    });
  });
});
