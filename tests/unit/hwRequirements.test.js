const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

function makeSpecLibsStub() {
  return {
    getSpecBackend: sinon.stub().resolves({
      DeploymentSpec: {
        fromSpec(spec) {
          if (spec.compose) {
            const totals = spec.compose.reduce((acc, c) => ({
              cpu: acc.cpu + (c.cpu || 0),
              memory: acc.memory + (c.ram || 0),
              storage: acc.storage + (c.hdd || 0),
            }), { cpu: 0, memory: 0, storage: 0 });
            return { totalResources: () => totals };
          }
          return {
            totalResources: () => ({ cpu: spec.cpu || 0, memory: spec.ram || 0, storage: spec.hdd || 0 }),
          };
        },
      },
    }),
  };
}

describe('hwRequirements tests', () => {
  let hwRequirements;
  let serviceHelperStub;
  let logStub;

  beforeEach(() => {
    serviceHelperStub = {
      ensureNumber: sinon.stub().returnsArg(0),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    hwRequirements = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
      '../serviceHelper': serviceHelperStub,
      '../benchmarkService': {
        getBenchmarks: sinon.stub().resolves({
          status: 'success',
          data: {
            cpucores: 4,
            ram: 8000,
            ssd: 100,
          },
        }),
      },
      '../generalService': {
        nodeTier: sinon.stub().resolves('cumulus'),
      },
      '../geolocationService': {
        isStaticIP: sinon.stub().returns(true),
        getNodeGeolocation: sinon.stub().returns('US-NY'),
      },
      '../fluxNetworkHelper': {
        getFluxNodeCount: sinon.stub().resolves(1000),
      },
      '../appDatabase/registryManager': {
        availableApps: sinon.stub().resolves([]),
      },
      '../appQuery/appQueryService': {
        installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
      },
      '../../lib/log': logStub,
      config: {
        fluxSpecifics: {
          cpu: {
            cumulus: 2,
            nimbus: 4,
            stratus: 8,
          },
          ram: {
            cumulus: 4000,
            nimbus: 8000,
            stratus: 16000,
          },
          hdd: {
            cumulus: 220,
            nimbus: 440,
            stratus: 880,
          },
        },
      },
    });
  });

  afterEach(() => {
    sinon.restore();
  });


  describe('checkAppStaticIpRequirements', () => {
    it('should pass when app does not require static IP', () => {
      const appSpecs = {
        name: 'testapp',
        staticip: false,
      };

      // Should not throw
      hwRequirements.checkAppStaticIpRequirements(appSpecs);
    });

    it('should pass when node has static IP and app requires it', () => {
      const appSpecs = {
        name: 'testapp',
        staticip: true,
      };

      // Should not throw
      hwRequirements.checkAppStaticIpRequirements(appSpecs);
    });
  });

  describe('checkAppGeolocationRequirements', () => {
    it('should pass when app has no geolocation restrictions', async () => {
      const appSpecs = {
        name: 'testapp',
        geolocation: [],
      };

      // Should not throw
      await hwRequirements.checkAppGeolocationRequirements(appSpecs);
    });

    it('should throw if geolocation returns undefined', async () => {
      const hwRequirementsWithUndefinedGeo = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 4,
              ram: 8000,
              ssd: 100,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().resolves(undefined),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../../lib/log': logStub,
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
        },
      });

      const appSpec = {
        version: 5,
        geolocation: ['acEU'],
      };

      try {
        await hwRequirementsWithUndefinedGeo.checkAppGeolocationRequirements(appSpec);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should return true if app ver < 5', async () => {
      const appSpec = {
        version: 4,
      };

      const result = await hwRequirements.checkAppGeolocationRequirements(appSpec);

      expect(result).to.equal(true);
    });

    it('should return true if geolocation matches', async () => {
      const hwRequirementsWithMatchingGeo = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 4,
              ram: 8000,
              ssd: 100,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().resolves({
            continentCode: 'EU',
            countryCode: 'CZ',
            regionName: 'PRG',
          }),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../../lib/log': logStub,
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
        },
      });

      const appSpec = {
        version: 5,
        geolocation: ['acEU_CZ_PRG'],
      };

      const result = await hwRequirementsWithMatchingGeo.checkAppGeolocationRequirements(appSpec);

      expect(result).to.equal(true);
    });

    it('should throw if geolocation is forbidden', async () => {
      const hwRequirementsWithForbiddenGeo = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 4,
              ram: 8000,
              ssd: 100,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().resolves({
            continentCode: 'EU',
            countryCode: 'CZ',
            regionName: 'PRG',
          }),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../../lib/log': logStub,
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
        },
      });

      const appSpec = {
        version: 5,
        geolocation: ['a!cEU_CZ_PRG'],
      };

      try {
        await hwRequirementsWithForbiddenGeo.checkAppGeolocationRequirements(appSpec);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it('should throw if geolocation is not matching', async () => {
      const hwRequirementsWithNonMatchingGeo = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 4,
              ram: 8000,
              ssd: 100,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().resolves({
            continentCode: 'EU',
            countryCode: 'CZ',
            regionName: 'PRG',
          }),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../../lib/log': logStub,
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
        },
      });

      const appSpec = {
        version: 5,
        geolocation: ['acEU_PL_GDA'],
      };

      try {
        await hwRequirementsWithNonMatchingGeo.checkAppGeolocationRequirements(appSpec);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe('checkAppHWRequirements tests', () => {
    it('should throw error if there would be insufficient space on node for the app - 0 on the node', async () => {
      const hwRequirementsWithResources = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 0,
              ram: 0,
              ssd: 0,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().returns('US-NY'),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../appQuery/resourceQueryService': {
          appsResources: sinon.stub().resolves({
            status: 'success',
            data: { appsCpusLocked: 0, appsRamLocked: 0, appsHddLocked: 0 },
          }),
        },
        '../utils/specLibs': makeSpecLibsStub(),
        '../../lib/log': logStub,
        os: {
          cpus: sinon.stub().returns(new Array(4)),
          totalmem: sinon.stub().returns(8000 * 1024 * 1024),
        },
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
          lockedSystemResources: {
            cpu: 0,
            ram: 0,
            hdd: 0,
            extrahdd: 0,
          },
        },
      });

      const appSpecs = {
        cpu: 256000,
        hdd: 100,
        ram: 50,
        version: 3,
      };

      try {
        await hwRequirementsWithResources.checkAppHWRequirements(appSpecs);
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).to.include('Insufficient');
      }
    });

    it('should throw error if there would be insufficient space on node for the app', async () => {
      const hwRequirementsWithLimitedSpace = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 10,
              ram: 20,
              ssd: 90,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().returns('US-NY'),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({
            status: 'success',
            data: [
              {
                version: 3,
                tiered: true,
                cpu: 1000,
                ram: 256000,
                hdd: 100000,
                cpucumulus: 2000,
                ramcumulus: 100000,
                hddcumulus: 200000,
              },
            ],
          }),
        },
        '../appQuery/resourceQueryService': {
          appsResources: sinon.stub().resolves({
            status: 'success',
            data: {
              appsCpusLocked: 0,
              appsRamLocked: 0,
              appsHddLocked: 0,
            },
          }),
        },
        '../utils/specLibs': makeSpecLibsStub(),
        '../../lib/log': logStub,
        os: {
          cpus: sinon.stub().returns(new Array(4)),
          totalmem: sinon.stub().returns(8000 * 1024 * 1024),
        },
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
          lockedSystemResources: {
            cpu: 0,
            ram: 0,
            hdd: 0,
            extrahdd: 0,
          },
        },
      });

      const appSpecs = {
        cpu: 256000,
        hdd: 100,
        ram: 50,
        version: 3,
      };

      try {
        await hwRequirementsWithLimitedSpace.checkAppHWRequirements(appSpecs);
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).to.include('Insufficient');
      }
    });

    it('should throw error if there would be insufficient cpu power on node for the app', async () => {
      const hwRequirementsWithLimitedCpu = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 10,
              ram: 20,
              ssd: 2000000,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().returns('US-NY'),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({
            status: 'success',
            data: [
              {
                version: 3,
                tiered: true,
                cpu: 1000,
                ram: 256000,
                hdd: 100000,
                cpucumulus: 2000,
                ramcumulus: 100000,
                hddcumulus: 200000,
              },
            ],
          }),
        },
        '../appQuery/resourceQueryService': {
          appsResources: sinon.stub().resolves({
            status: 'success',
            data: {
              appsCpusLocked: 0,
              appsRamLocked: 0,
              appsHddLocked: 0,
            },
          }),
        },
        '../utils/specLibs': makeSpecLibsStub(),
        '../../lib/log': logStub,
        os: {
          cpus: sinon.stub().returns(new Array(4)),
          totalmem: sinon.stub().returns(8000 * 1024 * 1024),
        },
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
          lockedSystemResources: {
            cpu: 0,
            ram: 0,
            hdd: 0,
            extrahdd: 0,
          },
        },
      });

      const appSpecs = {
        cpu: 256000,
        hdd: 100,
        ram: 50,
        version: 3,
      };

      try {
        await hwRequirementsWithLimitedCpu.checkAppHWRequirements(appSpecs);
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).to.include('Insufficient');
      }
    });

    it('should throw error if there would be insufficient ram on node for the app', async () => {
      const hwRequirementsWithLimitedRam = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 10000,
              ram: 50,
              ssd: 2000000,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().returns('US-NY'),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({
            status: 'success',
            data: [
              {
                version: 3,
                tiered: true,
                cpu: 1000,
                ram: 256000,
                hdd: 100000,
                cpucumulus: 2000,
                ramcumulus: 100000,
                hddcumulus: 200000,
              },
            ],
          }),
        },
        '../appQuery/resourceQueryService': {
          appsResources: sinon.stub().resolves({
            status: 'success',
            data: {
              appsCpusLocked: 0,
              appsRamLocked: 0,
              appsHddLocked: 0,
            },
          }),
        },
        '../utils/specLibs': makeSpecLibsStub(),
        '../../lib/log': logStub,
        os: {
          cpus: sinon.stub().returns(new Array(4)),
          totalmem: sinon.stub().returns(8000 * 1024 * 1024),
        },
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
          lockedSystemResources: {
            cpu: 0,
            ram: 0,
            hdd: 0,
            extrahdd: 0,
          },
        },
      });

      const appSpecs = {
        cpu: 4000,
        hdd: 100,
        ram: 50,
        version: 3,
      };

      try {
        await hwRequirementsWithLimitedRam.checkAppHWRequirements(appSpecs);
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).to.include('Insufficient');
      }
    });

    it('should return true if all reqs are met', async () => {
      const hwRequirementsWithGoodResources = proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: {
              cpucores: 10000,
              ram: 256000,
              ssd: 2000000,
            },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('cumulus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().returns('US-NY'),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({
            status: 'success',
            data: [],
          }),
        },
        '../appQuery/resourceQueryService': {
          appsResources: sinon.stub().resolves({
            status: 'success',
            data: {
              appsCpusLocked: 0,
              appsRamLocked: 0,
              appsHddLocked: 0,
            },
          }),
        },
        '../utils/specLibs': makeSpecLibsStub(),
        '../../lib/log': logStub,
        os: {
          cpus: sinon.stub().returns(new Array(4)),
          totalmem: sinon.stub().returns(8000 * 1024 * 1024),
        },
        config: {
          fluxSpecifics: {
            cpu: {
              cumulus: 2,
              nimbus: 4,
              stratus: 8,
            },
            ram: {
              cumulus: 4000,
              nimbus: 8000,
              stratus: 16000,
            },
            hdd: {
              cumulus: 220,
              nimbus: 440,
              stratus: 880,
            },
          },
          lockedSystemResources: {
            cpu: 0,
            ram: 0,
            hdd: 0,
            extrahdd: 0,
          },
        },
      });

      const appSpecs = {
        cpu: 0.5,
        hdd: 100,
        ram: 50,
        version: 3,
      };

      const result = await hwRequirementsWithGoodResources.checkAppHWRequirements(appSpecs);

      expect(result).to.equal(true);
    });
  });

  describe('checkAppCpuBurstHeadroom tests', () => {
    // Build a fresh hwRequirements module with plugable cpu/lock/app values.
    // Formula: freeCoresAfterInstall = cpuCores - lockedSystemResources.cpu/10
    //   - appsCpusLocked - appHWrequirements.cpu
    // Throws when freeCoresAfterInstall <= 4.
    function buildHw({ cpucores, appsCpusLocked, lockedCpuTenths = 10, appsResourcesStatus = 'success' }) {
      return proxyquire('../../ZelBack/src/services/appRequirements/hwRequirements', {
        '../serviceHelper': serviceHelperStub,
        '../utils/specLibs': makeSpecLibsStub(),
        '../benchmarkService': {
          getBenchmarks: sinon.stub().resolves({
            status: 'success',
            data: { cpucores, ram: 8000, ssd: 1000 },
          }),
        },
        '../generalService': {
          nodeTier: sinon.stub().resolves('stratus'),
        },
        '../geolocationService': {
          isStaticIP: sinon.stub().returns(true),
          getNodeGeolocation: sinon.stub().returns('US-NY'),
        },
        '../fluxNetworkHelper': {
          getFluxNodeCount: sinon.stub().resolves(1000),
        },
        '../appDatabase/registryManager': {
          availableApps: sinon.stub().resolves([]),
        },
        '../appQuery/appQueryService': {
          installedApps: sinon.stub().resolves({ status: 'success', data: [] }),
        },
        '../appQuery/resourceQueryService': {
          appsResources: sinon.stub().resolves({
            status: appsResourcesStatus,
            data: { appsCpusLocked, appsRamLocked: 0, appsHddLocked: 0 },
          }),
        },
        '../../lib/log': logStub,
        os: {
          cpus: sinon.stub().returns(new Array(cpucores)),
          totalmem: sinon.stub().returns(8000 * 1024 * 1024),
        },
        config: {
          fluxSpecifics: {
            cpu: { cumulus: 2, nimbus: 4, stratus: 8 },
            ram: { cumulus: 4000, nimbus: 8000, stratus: 16000 },
            hdd: { cumulus: 220, nimbus: 440, stratus: 880 },
          },
          lockedSystemResources: {
            cpu: lockedCpuTenths, ram: 0, hdd: 0, extrahdd: 0,
          },
        },
      });
    }

    it('passes when remaining free cores after install are > 4', async () => {
      // 16 cores - 1 (system) - 3 (locked) - 2 (this app) = 10 > 4 → ok
      const hw = buildHw({ cpucores: 16, appsCpusLocked: 3 });
      const result = await hw.checkAppCpuBurstHeadroom({ version: 3, cpu: 2, ram: 10, hdd: 10 });
      expect(result).to.equal(true);
    });

    it('throws when remaining free cores would be exactly 4 (boundary)', async () => {
      // 10 cores - 1 - 3 - 2 = 4 → throw (rule is strict <=)
      const hw = buildHw({ cpucores: 10, appsCpusLocked: 3 });
      try {
        await hw.checkAppCpuBurstHeadroom({ version: 3, cpu: 2, ram: 10, hdd: 10 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('CPU burst headroom');
      }
    });

    it('passes at 5 free cores (just above the boundary)', async () => {
      // 10 cores - 1 - 3 - 1 = 5 > 4 → ok
      const hw = buildHw({ cpucores: 10, appsCpusLocked: 3 });
      const result = await hw.checkAppCpuBurstHeadroom({ version: 3, cpu: 1, ram: 10, hdd: 10 });
      expect(result).to.equal(true);
    });

    it('throws when remaining free cores would be negative (over-subscribed)', async () => {
      // 8 cores - 1 - 5 - 4 = -2 → throw
      const hw = buildHw({ cpucores: 8, appsCpusLocked: 5 });
      try {
        await hw.checkAppCpuBurstHeadroom({ version: 3, cpu: 4, ram: 10, hdd: 10 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('CPU burst headroom');
      }
    });

    it('throws when appsResources cannot be read', async () => {
      const hw = buildHw({ cpucores: 16, appsCpusLocked: 0, appsResourcesStatus: 'error' });
      try {
        await hw.checkAppCpuBurstHeadroom({ version: 3, cpu: 1, ram: 10, hdd: 10 });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('locked system resources');
      }
    });

    it('sums cpu across compose components for v4+ apps', async () => {
      // 10 cores - 1 - 0 - (3+3) = 0 → throw (compose summed)
      const hw = buildHw({ cpucores: 10, appsCpusLocked: 0 });
      const appSpecs = {
        version: 4,
        compose: [
          { name: 'c1', cpu: 3, ram: 10, hdd: 10 },
          { name: 'c2', cpu: 3, ram: 10, hdd: 10 },
        ],
      };
      try {
        await hw.checkAppCpuBurstHeadroom(appSpecs);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('CPU burst headroom');
      }
    });
  });

  describe('exported functions', () => {
    it('should export requirement checking functions', () => {
      expect(hwRequirements.checkAppHWRequirements).to.be.a('function');
      expect(hwRequirements.checkAppCpuBurstHeadroom).to.be.a('function');
      expect(hwRequirements.checkAppStaticIpRequirements).to.be.a('function');
      expect(hwRequirements.checkAppNodesRequirements).to.be.a('function');
      expect(hwRequirements.checkAppGeolocationRequirements).to.be.a('function');
    });
  });
});
