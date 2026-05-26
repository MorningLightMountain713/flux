const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('telemetryIdentityService tests', () => {
  let service;
  let dockerServiceStub;
  let dbHelperStub;
  let geolocationServiceStub;
  let logStub;
  let configStub;
  let dbStub;

  beforeEach(() => {
    configStub = {
      database: {
        appslocal: {
          database: 'localapps',
        },
      },
    };

    dockerServiceStub = {
      dockerListContainers: sinon.stub().resolves([]),
    };

    dbStub = {
      collection: sinon.stub().returns({
        findOne: sinon.stub().resolves(null),
      }),
    };

    dbHelperStub = {
      databaseConnection: sinon.stub().returns({
        db: sinon.stub().returns(dbStub),
      }),
      findOneInDatabase: sinon.stub().resolves(null),
    };

    geolocationServiceStub = {
      getNodeGeolocation: sinon.stub().resolves({ continentCode: 'NA', country: 'US' }),
    };

    logStub = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    service = proxyquire('../../ZelBack/src/services/telemetryIdentityService', {
      config: configStub,
      '../lib/log': logStub,
      './dockerService': dockerServiceStub,
      './dbHelper': dbHelperStub,
      './geolocationService': geolocationServiceStub,
      './utils/appConstants': { localAppsInformation: 'zelappsinformation' },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  // --- parseContainerName ------------------------------------------------

  describe('parseContainerName', () => {
    it('should parse standard flux-prefixed container name', () => {
      const result = service.parseContainerName('fluxMyApp');
      expect(result).to.deep.equal({ appName: 'MyApp', componentName: null });
    });

    it('should parse legacy zel-prefixed container name', () => {
      const result = service.parseContainerName('zelKadenaChainWebNode');
      expect(result).to.deep.equal({ appName: 'KadenaChainWebNode', componentName: null });
    });

    it('should parse component container name', () => {
      const result = service.parseContainerName('frontend_MyApp');
      expect(result).to.deep.equal({ appName: 'MyApp', componentName: 'frontend' });
    });

    it('should parse component container name with multiple underscores in app name', () => {
      // Only the first underscore is the separator
      const result = service.parseContainerName('db_My_Complex_App');
      expect(result).to.deep.equal({ appName: 'My_Complex_App', componentName: 'db' });
    });

    it('should return null for empty name', () => {
      expect(service.parseContainerName('')).to.be.null;
      expect(service.parseContainerName(null)).to.be.null;
      expect(service.parseContainerName(undefined)).to.be.null;
    });

    it('should return null for non-flux container name', () => {
      expect(service.parseContainerName('nginx')).to.be.null;
      expect(service.parseContainerName('postgres')).to.be.null;
    });

    it('should handle flux prefix with nothing after it', () => {
      const result = service.parseContainerName('flux');
      // 'flux' with nothing after means appName is empty string
      expect(result).to.deep.equal({ appName: '', componentName: null });
    });
  });

  // --- handleRequest (protocol) ------------------------------------------

  describe('handleRequest', () => {
    it('should reject invalid JSON', async () => {
      const response = JSON.parse(await service.handleRequest('not json'));
      expect(response.ok).to.be.false;
      expect(response.error).to.equal('invalid JSON');
    });

    it('should reject unknown op', async () => {
      const response = JSON.parse(await service.handleRequest('{"op":"delete"}'));
      expect(response.ok).to.be.false;
      expect(response.error).to.equal('unknown op: delete');
    });

    it('should reject missing container_id', async () => {
      const response = JSON.parse(await service.handleRequest('{"op":"lookup"}'));
      expect(response.ok).to.be.false;
      expect(response.error).to.equal('invalid container_id');
    });

    it('should reject non-64-hex container_id', async () => {
      const response = JSON.parse(await service.handleRequest('{"op":"lookup","container_id":"short"}'));
      expect(response.ok).to.be.false;
      expect(response.error).to.equal('invalid container_id');
    });

    it('should reject uppercase hex in container_id', async () => {
      const id = 'A'.repeat(64);
      const response = JSON.parse(await service.handleRequest(`{"op":"lookup","container_id":"${id}"}`));
      expect(response.ok).to.be.false;
      expect(response.error).to.equal('invalid container_id');
    });

    it('should return null identity for unknown container', async () => {
      const id = 'a'.repeat(64);
      dockerServiceStub.dockerListContainers.resolves([]);

      const response = JSON.parse(await service.handleRequest(`{"op":"lookup","container_id":"${id}"}`));
      expect(response.ok).to.be.true;
      expect(response.identity).to.be.null;
    });
  });

  // --- resolveIdentity ---------------------------------------------------

  describe('resolveIdentity', () => {
    const containerId = 'a1b2c3d4e5f6'.padEnd(64, '0');

    it('should return null when container not found in Docker', async () => {
      dockerServiceStub.dockerListContainers.resolves([]);
      const result = await service.resolveIdentity(containerId);
      expect(result).to.be.null;
    });

    it('should return null when container name is not a Flux app', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: containerId, Names: ['/nginx'] },
      ]);
      const result = await service.resolveIdentity(containerId);
      expect(result).to.be.null;
    });

    it('should return null when app is not in local database', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: containerId, Names: ['/fluxMyApp'] },
      ]);
      dbHelperStub.findOneInDatabase.resolves(null);

      const result = await service.resolveIdentity(containerId);
      expect(result).to.be.null;
    });

    it('should resolve a standard flux app with image and container name', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: containerId, Names: ['/fluxMyApp'], Image: 'nginx:1.25' },
      ]);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'MyApp',
        version: 8,
      });

      const result = await service.resolveIdentity(containerId);
      expect(result).to.not.be.null;
      expect(result.app_name).to.equal('MyApp');
      expect(result.tags['region']).to.equal('NA');
      expect(result.tags).to.not.have.property('component');
      expect(result.tags.image_name).to.equal('nginx:1.25');
      expect(result.tags.container_name).to.equal('fluxMyApp');
    });

    it('should resolve a component container with component tag', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: containerId, Names: ['/frontend_MyApp'] },
      ]);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'MyApp',
        version: 8,
        compose: [{ name: 'frontend' }, { name: 'backend' }],
      });

      const result = await service.resolveIdentity(containerId);
      expect(result).to.not.be.null;
      expect(result.app_name).to.equal('MyApp');
      expect(result.tags['component']).to.equal('frontend');
      expect(result.tags['region']).to.equal('NA');
    });

    it('should resolve a legacy zel-prefixed app', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: containerId, Names: ['/zelKadenaChainWebNode'] },
      ]);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'KadenaChainWebNode',
        version: 3,
      });

      const result = await service.resolveIdentity(containerId);
      expect(result).to.not.be.null;
      expect(result.app_name).to.equal('KadenaChainWebNode');
    });

    it('should handle geolocation being unavailable', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: containerId, Names: ['/fluxMyApp'] },
      ]);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'MyApp',
        version: 8,
      });
      geolocationServiceStub.getNodeGeolocation.resolves(null);

      const result = await service.resolveIdentity(containerId);
      expect(result).to.not.be.null;
      expect(result.app_name).to.equal('MyApp');
      expect(result.tags).to.not.have.property('region');
    });

    it('should handle geolocation throwing an error', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: containerId, Names: ['/fluxMyApp'] },
      ]);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'MyApp',
        version: 8,
      });
      geolocationServiceStub.getNodeGeolocation.rejects(new Error('network down'));

      const result = await service.resolveIdentity(containerId);
      expect(result).to.not.be.null;
      expect(result.app_name).to.equal('MyApp');
      expect(result.tags).to.not.have.property('region');
    });
  });

  // --- end-to-end protocol via handleRequest -----------------------------

  describe('handleRequest end-to-end', () => {
    const containerId = 'deadbeef'.padEnd(64, '0');

    it('should return full identity for a known container', async () => {
      dockerServiceStub.dockerListContainers.resolves([
        { Id: containerId, Names: ['/frontend_WebApp'] },
      ]);
      dbHelperStub.findOneInDatabase.resolves({
        name: 'WebApp',
        version: 8,
        compose: [{ name: 'frontend' }],
      });

      const raw = await service.handleRequest(`{"op":"lookup","container_id":"${containerId}"}`);
      const response = JSON.parse(raw);

      expect(response.ok).to.be.true;
      expect(response.identity).to.not.be.null;
      expect(response.identity.app_name).to.equal('WebApp');
      expect(response.identity.tags['component']).to.equal('frontend');
      expect(response.identity.tags['region']).to.equal('NA');
    });

    it('should return null identity when Docker throws', async () => {
      dockerServiceStub.dockerListContainers.rejects(new Error('Docker unavailable'));

      const raw = await service.handleRequest(`{"op":"lookup","container_id":"${'a'.repeat(64)}"}`);
      const response = JSON.parse(raw);

      expect(response.ok).to.be.false;
      expect(response.error).to.equal('internal error');
    });
  });

  // --- TAG_ALLOWLIST -----------------------------------------------------

  describe('TAG_ALLOWLIST', () => {
    it('should contain exactly the expected public tags', () => {
      expect(service.TAG_ALLOWLIST.has('region')).to.be.true;
      expect(service.TAG_ALLOWLIST.has('component')).to.be.true;
      expect(service.TAG_ALLOWLIST.has('image_name')).to.be.true;
      expect(service.TAG_ALLOWLIST.has('container_name')).to.be.true;
      expect(service.TAG_ALLOWLIST.size).to.equal(4);
    });
  });
});
