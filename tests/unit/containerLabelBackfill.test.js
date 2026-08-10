'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const LABEL_KEYS = { IDENTIFIER: 'io.runonflux.identifier', APP: 'io.runonflux.app' };

describe('containerLabelBackfill tests', () => {
  let stubs;
  let containerLabelBackfill;

  // A deployment view exposing only what the backfill asks of it: the inverse of
  // containerIdentifier. Mirrors the real semantics rather than answering a
  // constant - a stub that matched anything would make the resolution assertions
  // pass while proving nothing.
  function stubDeployment(comps) {
    return {
      componentForIdentifier: (identifier) => comps.find((c) => c.identifier === identifier),
    };
  }

  beforeEach(() => {
    stubs = {
      log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
      dockerService: {
        dockerListContainers: sinon.stub().resolves([]),
        getBaseAppName: (name) => {
          if (name.startsWith('flux')) return name.slice(4);
          if (name.startsWith('zel')) return name.slice(3);
          return name;
        },
      },
      appsRepository: { getInstalledAppByIdentity: sinon.stub().resolves(null) },
      deploymentProvider: { getInstalledDeployments: sinon.stub().resolves([]) },
      appOperations: { redeployComponent: sinon.stub().resolves() },
      specLibs: {
        getSpecBackend: async () => ({
          LABEL_KEYS,
          DeploymentSpec: {
            appNameFromIdentifier: (identifier) => {
              const parts = identifier.split('_');
              return parts.length <= 1 ? identifier : parts[1];
            },
          },
        }),
      },
    };

    containerLabelBackfill = proxyquire('../../ZelBack/src/services/appLifecycle/containerLabelBackfill', {
      '../dockerService': stubs.dockerService,
      '../appDatabase/appsRepository': stubs.appsRepository,
      '../appRuntime/deploymentProvider': stubs.deploymentProvider,
      './appOperations': stubs.appOperations,
      '../utils/specLibs': stubs.specLibs,
      '../../lib/log': stubs.log,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  const labelled = (name, identifier) => ({
    Names: [`/${name}`], Labels: { [LABEL_KEYS.IDENTIFIER]: identifier }, State: 'exited',
  });
  // Stopped unless stated: the sweep only ever restamps what is already down.
  const bare = (name, state = 'exited') => ({ Names: [`/${name}`], Labels: {}, State: state });
  const running = (name) => bare(name, 'running');

  describe('surveyContainers', () => {
    it('counts a legacy zel container as ours', async () => {
      // Counting only `flux` reports 100% coverage on a node whose containers all
      // predate the rename - the exact case the sweep exists for.
      stubs.dockerService.dockerListContainers.resolves([bare('zelwww_App')]);

      const { ours, unlabelled } = await containerLabelBackfill.surveyContainers(LABEL_KEYS);

      expect(ours).to.have.lengthOf(1);
      expect(unlabelled).to.have.lengthOf(1);
    });

    it('ignores a container that is not ours', async () => {
      stubs.dockerService.dockerListContainers.resolves([bare('someoneElsesDatabase')]);

      const { ours } = await containerLabelBackfill.surveyContainers(LABEL_KEYS);

      expect(ours).to.have.lengthOf(0);
    });

    it('separates the labelled from the unlabelled', async () => {
      stubs.dockerService.dockerListContainers.resolves([
        labelled('fluxwww_App', 'www_App'),
        bare('fluxdb_App'),
      ]);

      const { ours, unlabelled } = await containerLabelBackfill.surveyContainers(LABEL_KEYS);

      expect(ours).to.have.lengthOf(2);
      expect(unlabelled.map((c) => c.Names[0])).to.deep.equal(['/fluxdb_App']);
    });
  });

  describe('resolveContainer', () => {
    it('resolves through the installed row and takes the component name from the deployment', async () => {
      stubs.appsRepository.getInstalledAppByIdentity.withArgs('App').resolves({ name: 'App' });
      stubs.deploymentProvider.getInstalledDeployments.withArgs('App').resolves([
        stubDeployment([{ name: 'www', identifier: 'www_App' }]),
      ]);

      const target = await containerLabelBackfill.resolveContainer(bare('fluxwww_App'));

      expect(target).to.deep.equal({ appName: 'App', componentName: 'www' });
    });

    it('leaves a container no installed app claims alone', async () => {
      stubs.appsRepository.getInstalledAppByIdentity.resolves(null);

      const target = await containerLabelBackfill.resolveContainer(bare('fluxwww_Gone'));

      expect(target).to.be.null;
    });

    it('leaves a container the deployment does not name alone', async () => {
      stubs.appsRepository.getInstalledAppByIdentity.withArgs('App').resolves({ name: 'App' });
      stubs.deploymentProvider.getInstalledDeployments.withArgs('App').resolves([
        stubDeployment([{ name: 'www', identifier: 'www_App' }]),
      ]);

      const target = await containerLabelBackfill.resolveContainer(bare('fluxghost_App'));

      expect(target).to.be.null;
    });
  });

  describe('labelCoverage', () => {
    it('reports a fully labelled node as covered', async () => {
      stubs.dockerService.dockerListContainers.resolves([
        labelled('fluxwww_App', 'www_App'), labelled('fluxdb_App', 'db_App'),
      ]);

      expect(await containerLabelBackfill.labelCoverage())
        .to.deep.equal({ labelled: 2, total: 2, covered: true });
    });

    it('reports a partially labelled node as not covered', async () => {
      stubs.dockerService.dockerListContainers.resolves([
        labelled('fluxwww_App', 'www_App'), bare('fluxdb_App'),
      ]);

      expect(await containerLabelBackfill.labelCoverage())
        .to.deep.equal({ labelled: 1, total: 2, covered: false });
    });

    it('counts a legacy zel container against coverage', async () => {
      // Counting only flux-prefixed containers reports a legacy node as fully
      // covered while every one of its containers still needs the fallback.
      stubs.dockerService.dockerListContainers.resolves([bare('zelwww_App')]);

      expect(await containerLabelBackfill.labelCoverage())
        .to.deep.equal({ labelled: 0, total: 1, covered: false });
    });

    it('treats a node with no containers as covered', async () => {
      stubs.dockerService.dockerListContainers.resolves([]);

      expect(await containerLabelBackfill.labelCoverage())
        .to.deep.equal({ labelled: 0, total: 0, covered: true });
    });

    it('does not count containers that are not ours', async () => {
      stubs.dockerService.dockerListContainers.resolves([
        labelled('fluxwww_App', 'www_App'), bare('someoneElsesDatabase'),
      ]);

      expect(await containerLabelBackfill.labelCoverage())
        .to.deep.equal({ labelled: 1, total: 1, covered: true });
    });
  });

  describe('backfillContainerLabels', () => {
    it('reports the node covered and redeploys nothing when every container is labelled', async () => {
      stubs.dockerService.dockerListContainers.resolves([
        labelled('fluxwww_App', 'www_App'),
        labelled('fluxdb_App', 'db_App'),
      ]);

      const result = await containerLabelBackfill.backfillContainerLabels();

      expect(result.covered).to.be.true;
      expect(result.labelled).to.equal(2);
      expect(result.total).to.equal(2);
      expect(stubs.appOperations.redeployComponent.called).to.be.false;
    });

    it('redeploys an unlabelled component keeping its volume', async () => {
      stubs.dockerService.dockerListContainers.resolves([bare('fluxwww_App')]);
      stubs.appsRepository.getInstalledAppByIdentity.withArgs('App').resolves({ name: 'App' });
      stubs.deploymentProvider.getInstalledDeployments.withArgs('App').resolves([
        stubDeployment([{ name: 'www', identifier: 'www_App' }]),
      ]);

      const result = await containerLabelBackfill.backfillContainerLabels();

      expect(result.covered).to.be.false;
      // createVolumes: true REFORMATS the volume, and there is nothing wrong with
      // the data here - only the container's labels
      sinon.assert.calledOnceWithExactly(
        stubs.appOperations.redeployComponent, 'App', 'www', { createVolumes: false },
      );
      expect(result.restamped).to.deep.equal(['www_App']);
    });

    it('redeploys a co-located component once, not once per replica', async () => {
      // One redeploy targets the component in every local identity; redeploying per
      // container would tear the same component down twice.
      stubs.dockerService.dockerListContainers.resolves([
        bare('fluxwww_App_s1'), bare('fluxwww_App_s2'),
      ]);
      stubs.appsRepository.getInstalledAppByIdentity.withArgs('App').resolves({ name: 'App' });
      stubs.deploymentProvider.getInstalledDeployments.withArgs('App').resolves([
        stubDeployment([{ name: 'www', identifier: 'www_App_s1' }]),
        stubDeployment([{ name: 'www', identifier: 'www_App_s2' }]),
      ]);

      await containerLabelBackfill.backfillContainerLabels();

      sinon.assert.calledOnce(stubs.appOperations.redeployComponent);
    });

    it('leaves a RUNNING unlabelled container alone', async () => {
      // No app loses uptime for a label. The reboot that ships a release stops
      // everything anyway, and this pass runs before they are started again.
      stubs.dockerService.dockerListContainers.resolves([running('fluxwww_App')]);
      stubs.appsRepository.getInstalledAppByIdentity.withArgs('App').resolves({ name: 'App' });
      stubs.deploymentProvider.getInstalledDeployments.withArgs('App').resolves([
        stubDeployment([{ name: 'www', identifier: 'www_App' }]),
      ]);

      const result = await containerLabelBackfill.backfillContainerLabels();

      expect(stubs.appOperations.redeployComponent.called).to.be.false;
      expect(result.deferred).to.equal(1);
      expect(result.covered).to.be.false;
    });

    it('restamps the stopped ones and defers the running ones in the same pass', async () => {
      stubs.dockerService.dockerListContainers.resolves([
        bare('fluxdb_App'), running('fluxwww_App'),
      ]);
      stubs.appsRepository.getInstalledAppByIdentity.withArgs('App').resolves({ name: 'App' });
      stubs.deploymentProvider.getInstalledDeployments.withArgs('App').resolves([
        stubDeployment([
          { name: 'db', identifier: 'db_App' },
          { name: 'www', identifier: 'www_App' },
        ]),
      ]);

      const result = await containerLabelBackfill.backfillContainerLabels();

      sinon.assert.calledOnceWithExactly(
        stubs.appOperations.redeployComponent, 'App', 'db', { createVolumes: false },
      );
      expect(result.restamped).to.deep.equal(['db_App']);
      expect(result.deferred).to.equal(1);
    });

    it('leaves an unclaimed container alone rather than acting on a guess', async () => {
      stubs.dockerService.dockerListContainers.resolves([bare('fluxwww_Gone')]);
      stubs.appsRepository.getInstalledAppByIdentity.resolves(null);

      const result = await containerLabelBackfill.backfillContainerLabels();

      expect(result.unresolved).to.deep.equal(['fluxwww_Gone']);
      expect(stubs.appOperations.redeployComponent.called).to.be.false;
    });

    it('carries on after one component fails to redeploy', async () => {
      stubs.dockerService.dockerListContainers.resolves([bare('fluxwww_App'), bare('fluxdb_App')]);
      stubs.appsRepository.getInstalledAppByIdentity.withArgs('App').resolves({ name: 'App' });
      stubs.deploymentProvider.getInstalledDeployments.withArgs('App').resolves([
        stubDeployment([
          { name: 'www', identifier: 'www_App' },
          { name: 'db', identifier: 'db_App' },
        ]),
      ]);
      stubs.appOperations.redeployComponent.onFirstCall().rejects(new Error('image gone'));

      const result = await containerLabelBackfill.backfillContainerLabels();

      expect(stubs.appOperations.redeployComponent.callCount).to.equal(2);
      expect(result.restamped).to.deep.equal(['db_App']);
    });

    it('reports coverage without acting when docker cannot be listed', async () => {
      stubs.dockerService.dockerListContainers.rejects(new Error('daemon down'));

      const result = await containerLabelBackfill.backfillContainerLabels();

      expect(result.covered).to.be.false;
      expect(stubs.appOperations.redeployComponent.called).to.be.false;
    });
  });
});
