'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const CLOSE_CODES = Object.freeze({ SHUTTING_DOWN: 4001, RESTARTING: 4002 });

describe('nodeProcess', () => {
  let nodeProcess;
  let stubs;

  beforeEach(() => {
    stubs = {
      existsSync: sinon.stub().returns(false),
      runCommand: sinon.stub().resolves({ stdout: '', stderr: '', error: null }),
      log: {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
      },
      dockerListContainers: sinon.stub().resolves([]),
      appDockerStop: sinon.stub().resolves(),
      appDockerKill: sinon.stub().resolves(),
      writeShutdownReason: sinon.stub().resolves(),
      closeAllForStop: sinon.stub().resolves(0),
      verifyPoolStop: sinon.stub(),
      startFluxFunctions: sinon.stub(),
      startFlushTimer: sinon.stub(),
      isUPNP: sinon.stub().returns(false),
      isArcane: sinon.stub().returns(false),
    };
    nodeProcess = proxyquire('../../ZelBack/src/services/nodeProcess', {
      'node:fs': { existsSync: stubs.existsSync },
      '../lib/log': stubs.log,
      './serviceHelper': { runCommand: stubs.runCommand, delay: sinon.stub().resolves() },
      './serviceManager': { startFluxFunctions: stubs.startFluxFunctions },
      './upnpService': { isUPNP: stubs.isUPNP },
      './utils/capabilities': { claim: sinon.stub() },
      './utils/globalState': { isArcane: stubs.isArcane },
      './nodeDosState': { addDosState: sinon.stub(), setDosMessage: sinon.stub() },
      './utils/requestHistory': { RequestHistory: sinon.stub() },
      './dockerService': {
        dockerListContainers: stubs.dockerListContainers,
        appDockerStop: stubs.appDockerStop,
        appDockerKill: stubs.appDockerKill,
      },
      './analyticsService': { startFlushTimer: stubs.startFlushTimer },
      './appMessaging/appSyncOrchestrator': { AppSyncOrchestrator: { writeShutdownReason: stubs.writeShutdownReason } },
      './utils/FluxPeerManager': { peerManager: { closeAllForStop: stubs.closeAllForStop } },
      './utils/FluxPeerSocket': { CLOSE_CODES },
      './utils/verifyPool': { stop: stubs.verifyPoolStop },
    });
  });

  afterEach(() => sinon.restore());

  const answers = (command, params, stdout) => stubs.runCommand
    .withArgs(command, sinon.match(params ? { params } : {}))
    .resolves({ stdout, stderr: '', error: null });
  const detectedVia = () => stubs.log.info.args.map((args) => args[0]).find((line) => line.startsWith('System shutdown detected via'));

  describe('isSystemShuttingDown', () => {
    it('answers false when nothing says the machine is going down', async () => {
      expect(await nodeProcess.isSystemShuttingDown()).to.equal(false);
    });

    it('detects a scheduled shutdown', async () => {
      stubs.existsSync.withArgs('/run/systemd/shutdown/scheduled').returns(true);

      expect(await nodeProcess.isSystemShuttingDown()).to.equal(true);
      expect(detectedVia()).to.include('/run/systemd/shutdown/scheduled');
    });

    it('detects systemd stopping', async () => {
      answers('systemctl', ['is-system-running'], 'stopping\n');

      expect(await nodeProcess.isSystemShuttingDown()).to.equal(true);
      expect(detectedVia()).to.include('is-system-running');
    });

    ['shutdown.target', 'reboot.target', 'poweroff.target', 'halt.target'].forEach((target) => {
      it(`detects a ${target} job`, async () => {
        answers('systemctl', ['is-system-running'], 'running\n');
        answers('systemctl', ['list-jobs', '--no-pager'], `123 ${target} start waiting\n`);

        expect(await nodeProcess.isSystemShuttingDown()).to.equal(true);
        expect(detectedVia()).to.include('list-jobs');
      });
    });

    it('detects a running shutdown process', async () => {
      answers('systemctl', ['is-system-running'], 'running\n');
      answers('systemctl', ['list-jobs', '--no-pager'], 'No jobs running.\n');
      answers('pgrep', ['-x', 'shutdown'], '1234\n');

      expect(await nodeProcess.isSystemShuttingDown()).to.equal(true);
      expect(detectedVia()).to.include('running shutdown process');
    });

    ['0', '6'].forEach((level) => {
      it(`detects runlevel ${level}`, async () => {
        answers('runlevel', null, `N ${level}\n`);

        expect(await nodeProcess.isSystemShuttingDown()).to.equal(true);
        expect(detectedVia()).to.include(`runlevel: N ${level}`);
      });
    });

    it('answers false at runlevel 5', async () => {
      answers('runlevel', null, 'N 5\n');

      expect(await nodeProcess.isSystemShuttingDown()).to.equal(false);
    });

    it('detects /run/nologin', async () => {
      stubs.existsSync.withArgs('/run/nologin').returns(true);

      expect(await nodeProcess.isSystemShuttingDown()).to.equal(true);
      expect(detectedVia()).to.include('/run/nologin');
    });

    it('answers false when every probe fails', async () => {
      stubs.existsSync.throws(new Error('EACCES'));
      stubs.runCommand.resolves({ stdout: '', stderr: '', error: new Error('Command failed') });

      expect(await nodeProcess.isSystemShuttingDown()).to.equal(false);
    });

    it('stops at the first signal it finds', async () => {
      stubs.existsSync.withArgs('/run/systemd/shutdown/scheduled').returns(true);
      answers('systemctl', ['is-system-running'], 'stopping\n');

      expect(await nodeProcess.isSystemShuttingDown()).to.equal(true);
      sinon.assert.notCalled(stubs.runCommand);
    });
  });

  describe('handleSigterm', () => {
    let exit;

    beforeEach(() => {
      exit = sinon.stub(process, 'exit');
    });

    it('on a restart, announces RESTARTING, leaves every container running, and exits', async () => {
      await nodeProcess.handleSigterm();

      sinon.assert.calledOnceWithExactly(stubs.writeShutdownReason, 'restart');
      expect(stubs.closeAllForStop.firstCall.args[0]).to.equal(CLOSE_CODES.RESTARTING);
      sinon.assert.notCalled(stubs.dockerListContainers);
      sinon.assert.calledOnce(stubs.verifyPoolStop);
      sinon.assert.calledOnceWithExactly(exit, 0);
    });

    describe('when the machine is going down', () => {
      beforeEach(() => {
        stubs.existsSync.withArgs('/run/systemd/shutdown/scheduled').returns(true);
      });

      it('announces SHUTTING_DOWN and stops every Flux app container, and nothing else', async () => {
        stubs.dockerListContainers.resolves([
          { Names: ['/fluxweb_app1'] }, { Names: ['/zelold_app2'] }, { Names: ['/postgres'] },
        ]);

        await nodeProcess.handleSigterm();

        sinon.assert.calledOnceWithExactly(stubs.writeShutdownReason, 'sigterm');
        expect(stubs.closeAllForStop.firstCall.args[0]).to.equal(CLOSE_CODES.SHUTTING_DOWN);
        expect(stubs.appDockerStop.args).to.deep.equal([['fluxweb_app1', 9], ['zelold_app2', 9]]);
        sinon.assert.calledOnceWithExactly(exit, 0);
      });

      it('stops them in parallel, all asked before any has stopped', async () => {
        const pending = [];
        stubs.appDockerStop.callsFake(() => new Promise((resolve) => { pending.push(resolve); }));
        stubs.dockerListContainers.resolves([{ Names: ['/fluxa_x'] }, { Names: ['/fluxb_x'] }]);

        const done = nodeProcess.handleSigterm();
        await new Promise((resolve) => { setImmediate(resolve); });
        await new Promise((resolve) => { setImmediate(resolve); });

        expect(stubs.appDockerStop.callCount).to.equal(2);
        pending.forEach((resolve) => resolve());
        await done;
      });

      it('kills a container whose stop fails', async () => {
        stubs.dockerListContainers.resolves([{ Names: ['/fluxweb_app1'] }]);
        stubs.appDockerStop.rejects(new Error('timeout'));

        await nodeProcess.handleSigterm();

        sinon.assert.calledOnceWithExactly(stubs.appDockerKill, 'fluxweb_app1');
        sinon.assert.calledOnceWithExactly(exit, 0);
      });

      it('on Arcane, leaves every container to the shutdown daemon and exits', async () => {
        stubs.isArcane.returns(true);
        stubs.dockerListContainers.resolves([{ Names: ['/fluxweb_app1'] }]);

        await nodeProcess.handleSigterm();

        expect(stubs.closeAllForStop.firstCall.args[0]).to.equal(CLOSE_CODES.SHUTTING_DOWN);
        sinon.assert.notCalled(stubs.dockerListContainers);
        sinon.assert.notCalled(stubs.appDockerStop);
        sinon.assert.calledOnceWithExactly(exit, 0);
      });

      it('still exits when docker cannot list its containers', async () => {
        stubs.dockerListContainers.rejects(new Error('docker down'));

        await nodeProcess.handleSigterm();

        sinon.assert.calledOnceWithExactly(exit, 0);
      });
    });
  });

  describe('start', () => {
    let registered;

    beforeEach(() => {
      registered = sinon.spy(process, 'on');
      globalThis.userconfig = globalThis.userconfig || { initial: {} };
    });

    afterEach(() => {
      process.removeListener('SIGTERM', nodeProcess.handleSigterm);
    });

    it('starts the analytics flush, the stop handler and every service', () => {
      nodeProcess.start({ apiPort: 16_127, socketIoServers: [] });

      sinon.assert.calledOnce(stubs.startFlushTimer);
      sinon.assert.calledWith(registered, 'SIGTERM', nodeProcess.handleSigterm);
      sinon.assert.calledOnce(stubs.startFluxFunctions);
      sinon.assert.calledOnce(stubs.isUPNP);
    });
  });
});
