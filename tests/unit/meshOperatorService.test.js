const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Handlers judged at their seams: authorization is checked before anything is
// touched, the status shape assembles from the retained pass + disk reads,
// and every lever calls exactly its certificate/refuse-set function and pokes
// the reconciler — never converging anything itself.
describe('meshOperatorService', () => {
  let service;
  let stubs;

  const APP_NAME = 'myblog';
  const IDENTITY = 'ab12cd34ef56';
  const OUTPOINT = `${'c'.repeat(64)}:3`;
  const OWN_TX = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  const resSpy = () => ({ json: sinon.stub() });
  const sent = (res) => res.json.firstCall.args[0];

  beforeEach(() => {
    stubs = {
      privilege: sinon.stub().resolves(true),
      installedApp: {
        name: APP_NAME,
        uuid: '5db6f53acbbd9b38e949307e96601e573bd6437ddec08707e76a33f771b358ea',
        identity: IDENTITY,
        view: { network: { mesh: true } },
      },
      certDetails: sinon.stub().callsFake(async (p) => ({
        name: 'cert', fingerprint: `fp:${p.split('/').pop()}`, issuer: 'fp-ca', notAfter: new Date('2027-01-01T00:00:00Z'),
      })),
      nebulaActive: sinon.stub().resolves(true),
      printOwnCert: sinon.stub().resolves({ fingerprint: 'fp:host.crt' }),
      forceRenewal: sinon.stub().resolves(),
      rotation: { begin: sinon.stub().resolves(), adopt: sinon.stub().resolves(), conclude: sinon.stub().resolves() },
      refuse: sinon.stub().resolves(),
      unrefuse: sinon.stub().resolves(),
      reconcile: sinon.stub().resolves(),
      rebroadcast: sinon.stub().resolves(),
      reload: sinon.stub().resolves(),
      getInstalledApp: null,
    };
    stubs.getInstalledApp = sinon.stub().callsFake(async () => stubs.installedApp);

    service = proxyquire('../../ZelBack/src/services/appMesh/meshOperatorService', {
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
      },
      '../verificationHelper': { verifyPrivilege: stubs.privilege },
      '../generalService': {
        obtainNodeCollateralInformation: sinon.stub().resolves({ txhash: OWN_TX, txindex: 0 }),
      },
      '../appDatabase/appsRepository': { getInstalledApp: stubs.getInstalledApp },
      '../appRuntime/deploymentProvider': { appNameFromRequest: (name) => name.split('_')[1] || name },
      '../utils/specCutover': { resolveInstantiatedSpec: async (inst) => inst.view },
      '../appMessaging/peerNotification': { checkAndNotifyPeersOfRunningApps: stubs.rebroadcast },
      './meshCertificates': {
        meshAppDir: (instance) => `/dat/var/lib/flux-mesh/${instance}`,
        certificateDetails: stubs.certDetails,
        forceHostCertificateRenewal: stubs.forceRenewal,
        beginAuthorityRotation: stubs.rotation.begin,
        adoptSuccessorAuthority: stubs.rotation.adopt,
        concludeAuthorityRotation: stubs.rotation.conclude,
      },
      './meshRefuseSet': {
        refusedOutpoints: sinon.stub().resolves(new Set([OUTPOINT])),
        refuseOutpoint: stubs.refuse,
        removeRefusedOutpoint: stubs.unrefuse,
      },
      './meshPorts': { getPort: sinon.stub().resolves(16230) },
      './meshNamespace': {
        meshUnits: { nebulaActive: stubs.nebulaActive, reloadNebula: stubs.reload },
      },
      './meshSsh': { printOwnCert: stubs.printOwnCert },
      './meshReconciler': {
        reconcileAllMeshApps: stubs.reconcile,
        lastPassStatus: sinon.stub().returns({ at: 123, members: [], rejected: [] }),
      },
    });
  });

  afterEach(() => sinon.restore());

  describe('meshAppStatusAPI', () => {
    it('refuses before touching the database', async () => {
      stubs.privilege.resolves(false);
      const res = resSpy();
      await service.meshAppStatusAPI({ params: { appname: APP_NAME }, query: {} }, res);
      expect(sent(res).status).to.equal('error');
      expect(stubs.getInstalledApp.called).to.equal(false);
    });

    it('answers meshEnabled false for a non-mesh app', async () => {
      stubs.installedApp.view = { network: { mesh: false } };
      const res = resSpy();
      await service.meshAppStatusAPI({ params: { appname: APP_NAME }, query: {} }, res);
      expect(sent(res).data).to.deep.equal({ meshEnabled: false });
    });

    it('assembles the full status for a mesh app', async () => {
      const res = resSpy();
      await service.meshAppStatusAPI({ params: { appname: APP_NAME }, query: {} }, res);
      const { data } = sent(res);
      expect(data.meshEnabled).to.equal(true);
      expect(data.identity).to.equal(IDENTITY);
      expect(data.port).to.equal(16230);
      expect(data.refused).to.deep.equal([OUTPOINT]);
      expect(data.unitActive).to.equal(true);
      expect(data.certificates.authority.fingerprint).to.equal('fp:ca.crt');
      expect(data.certificates.successor.fingerprint).to.equal('fp:ca-successor.crt');
      expect(data.certificates.host.fingerprint).to.equal('fp:host.crt');
      expect(data.certificates.host.notAfter).to.equal('2027-01-01T00:00:00.000Z');
      expect(data.lastPass).to.deep.equal({ at: 123, members: [], rejected: [] });
      expect(stubs.privilege.firstCall.args).to.deep.equal(['appownerabove',
        { params: { appname: APP_NAME }, query: {} }, APP_NAME]);
    });

    it('accepts the component form of a name', async () => {
      const res = resSpy();
      await service.meshAppStatusAPI({ params: { appname: `web_${APP_NAME}` }, query: {} }, res);
      expect(sent(res).data.meshEnabled).to.equal(true);
      expect(stubs.getInstalledApp.firstCall.args[0]).to.equal(APP_NAME);
    });
  });

  describe('levers', () => {
    it('every lever is flux-team only — the node operator (admin) is refused', async () => {
      // The operator's session authorizes at 'admin'/'appownerabove' but must
      // NOT reach a lever: only 'fluxteam' does.
      stubs.privilege.callsFake(async (tier) => tier !== 'fluxteam');
      const levers = ['meshRenewCertificateAPI', 'meshRotationBeginAPI', 'meshRotationAdoptAPI',
        'meshRotationConcludeAPI', 'meshRefuseAPI', 'meshUnrefuseAPI'];
      // eslint-disable-next-line no-restricted-syntax
      for (const lever of levers) {
        const res = resSpy();
        // eslint-disable-next-line no-await-in-loop
        await service[lever]({ body: { appname: APP_NAME, outpoint: OUTPOINT } }, res);
        expect(sent(res).status, lever).to.equal('error');
      }
      expect(stubs.forceRenewal.called).to.equal(false);
      expect(stubs.rotation.begin.called).to.equal(false);
      expect(stubs.refuse.called).to.equal(false);
      expect(stubs.unrefuse.called).to.equal(false);
    });

    it('renewcertificate deploys, reloads and read-back-verifies', async () => {
      const res = resSpy();
      await service.meshRenewCertificateAPI({ body: { appname: APP_NAME } }, res);
      const { data } = sent(res);
      expect(stubs.forceRenewal.calledOnce).to.equal(true);
      expect(stubs.reload.calledWith(IDENTITY)).to.equal(true);
      expect(data).to.deep.equal({
        renewed: true, fingerprint: 'fp:host.crt', reloaded: true, verified: true,
      });
    });

    it('renewcertificate reports an unverified reload', async () => {
      stubs.printOwnCert.resolves({ fingerprint: 'fp:stale' });
      const res = resSpy();
      await service.meshRenewCertificateAPI({ body: { appname: APP_NAME } }, res);
      expect(sent(res).data.verified).to.equal(false);
    });

    it('rotation begin and conclude rebroadcast; adopt does not', async () => {
      await service.meshRotationBeginAPI({ body: { appname: APP_NAME } }, resSpy());
      expect(stubs.rotation.begin.calledOnce).to.equal(true);
      expect(stubs.rebroadcast.callCount).to.equal(1);
      await service.meshRotationAdoptAPI({ body: { appname: APP_NAME } }, resSpy());
      expect(stubs.rotation.adopt.calledOnce).to.equal(true);
      expect(stubs.rebroadcast.callCount).to.equal(1);
      await service.meshRotationConcludeAPI({ body: { appname: APP_NAME } }, resSpy());
      expect(stubs.rotation.conclude.calledWith(IDENTITY)).to.equal(true);
      expect(stubs.rebroadcast.callCount).to.equal(2);
      expect(stubs.reconcile.callCount).to.equal(3);
    });

    it('refuse and unrefuse edit the set and poke the reconciler', async () => {
      const res = resSpy();
      await service.meshRefuseAPI({ body: { appname: APP_NAME, outpoint: OUTPOINT } }, res);
      expect(stubs.refuse.calledWith(IDENTITY, OUTPOINT)).to.equal(true);
      expect(sent(res).data).to.deep.equal({ refused: OUTPOINT });
      const res2 = resSpy();
      await service.meshUnrefuseAPI({ body: { appname: APP_NAME, outpoint: OUTPOINT } }, res2);
      expect(stubs.unrefuse.calledWith(IDENTITY, OUTPOINT)).to.equal(true);
      expect(sent(res2).data).to.deep.equal({ unrefused: OUTPOINT });
      expect(stubs.reconcile.callCount).to.equal(2);
    });

    it('a lever on a non-mesh app errors without acting', async () => {
      stubs.installedApp.view = { network: { mesh: false } };
      const res = resSpy();
      await service.meshRefuseAPI({ body: { appname: APP_NAME, outpoint: OUTPOINT } }, res);
      expect(sent(res).status).to.equal('error');
      expect(stubs.refuse.called).to.equal(false);
    });
  });
});
