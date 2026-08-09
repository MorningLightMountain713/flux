const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const realFsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// The orchestration is the module, so the suite drives full passes against
// recorded fakes: every collaborator is stubbed at its seam, the pure
// derivation and generators run real, and the assertions read what landed on
// disk (config.yml, tayga.conf) and what was asked of the namespace, units,
// chains and detector. Expected addresses are computed with the real
// derivation and the real ledger assignment, never transcribed by hand.
const meshDerivation = require('../../ZelBack/src/services/appMesh/meshDerivation');
const realSnapshot = require('../../ZelBack/src/services/appMesh/meshSnapshot');

const APP_UUID = '5db6f53acbbd9b38e949307e96601e573bd6437ddec08707e76a33f771b358ea';
const IDENTITY = 'ab12cd34ef56';
const OWN_OUTPOINT = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08:0';
const PEER_OUTPOINT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855:1';
const OWN_NODE_ID = meshDerivation.nodeId(OWN_OUTPOINT);
const PEER_NODE_ID = meshDerivation.nodeId(PEER_OUTPOINT);
const SLOT = 0x03a9f2c1;
const ANCHOR_HASH = 'aa'.repeat(32);

const PEER_MEMBER = {
  outpoint: PEER_OUTPOINT,
  nodeId: PEER_NODE_ID,
  address: meshDerivation.nodeAddress(APP_UUID, PEER_OUTPOINT),
  block: meshDerivation.nodeBlock(APP_UUID, PEER_OUTPOINT),
  endpoint: '203.0.113.7:16240',
  caShas: ['fp-peer'],
  meshCa: 'PEM-PEER\n',
};

const TRANSIT = {
  slot: 2,
  linkId: '2',
  subnet: '169.254.108.8/30',
  hostIp: '169.254.108.9',
  namespaceIp: '169.254.108.10',
  prefixLength: 30,
};

describe('meshReconciler', () => {
  let tmpRoot;
  let meshReconciler;
  let stubs;
  let logLines;

  const makeView = (overrides = {}) => ({
    network: { mesh: true },
    placement: { mode: () => 'none', hasTargets: () => false },
    componentNames: () => ['web'],
    ...overrides,
  });

  const makeApp = (overrides = {}) => ({
    name: 'myblog',
    uuid: APP_UUID,
    identity: IDENTITY,
    view: makeView(),
    ...overrides,
  });

  beforeEach(async () => {
    tmpRoot = await realFsp.mkdtemp(path.join(os.tmpdir(), 'mesh-rec-'));
    await realFsp.mkdir(path.join(tmpRoot, IDENTITY), { recursive: true });
    logLines = { error: [], warn: [], info: [] };

    stubs = {
      installedApps: [makeApp()],
      rows: [{
        ip: '203.0.113.7:16240',
        outpoint: PEER_OUTPOINT,
        broadcastedAt: 1,
        meshCa: 'PEM-PEER\n',
        meshVoucher: 'sig',
        meshPort: 16240,
        meshAnchor: { height: 995, hash: ANCHOR_HASH },
      }],
      evaluateCandidates: sinon.stub().resolves({ members: [PEER_MEMBER], rejected: [] }),
      writeTrustBundle: sinon.stub().resolves(false),
      certAction: 'none',
      nebulaActive: false,
      detectResult: { checked: true, evicted: [], foreign: [] },
      converged: true,
      snapshotOnDisk: null,
      namespaceCalls: [],
      unitCalls: [],
      chainRules: null,
      chainsEnsured: false,
      attachments: [],
      writeSnapshotCalls: [],
      getBlock: sinon.stub().callsFake(async (req) => ({
        status: 'success',
        data: { height: 995, confirmations: 5, hash: req.params.hashheight },
      })),
    };

    const record = (name) => sinon.stub().callsFake(async (...args) => {
      stubs.namespaceCalls.push([name, ...args]);
    });

    meshReconciler = proxyquire('../../ZelBack/src/services/appMesh/meshReconciler', {
      '../../lib/log': {
        info: (m) => logLines.info.push(m),
        warn: (m) => logLines.warn.push(m),
        error: (m) => logLines.error.push(m),
        debug: sinon.stub(),
      },
      '../appDatabase/appsRepository': {
        listInstalledApps: sinon.stub().callsFake(async () => stubs.installedApps),
        appLocationFromEvents: sinon.stub().callsFake(async () => stubs.rows),
        getInstalledApp: sinon.stub().callsFake(async (name) => stubs.installedApps
          .find((app) => app.name === name) ?? null),
      },
      '../appRuntime/deploymentProvider': {
        getInstalledDeployments: sinon.stub().resolves([
          { componentEntries: () => [['web', { identifier: 'web_ab12cd34ef56' }]] },
        ]),
      },
      '../dockerService': {
        dockerContainerInspect: sinon.stub().resolves({
          State: { Pid: 4242 },
          NetworkSettings: { Networks: { fluxDockerNetwork_myblog: { IPAddress: '172.23.4.5' } } },
        }),
      },
      '../daemonService/daemonServiceMiscRpcs': {
        isDaemonSynced: sinon.stub().callsFake(() => stubs.synced
          ?? { status: 'success', data: { synced: true, height: 1000 } }),
      },
      '../daemonService/daemonServiceBlockchainRpcs': { getBlock: (...args) => stubs.getBlock(...args) },
      '../generalService': {
        obtainNodeCollateralInformation: sinon.stub().resolves({
          txhash: OWN_OUTPOINT.split(':')[0], txindex: 0,
        }),
      },
      '../networkStateService': {
        getFluxnodeBySocketAddress: sinon.stub().callsFake(async (addr) => stubs.nodeByAddress?.[addr] ?? null),
        getFluxnodesByPubkey: sinon.stub().callsFake(async (key) => stubs.nodesByPubkey?.[key] ?? null),
      },
      '../fluxNetworkHelper': { getDefaultRouteInterface: sinon.stub().resolves('eth0') },
      '../utils/specLibs': {
        getSpec: sinon.stub().resolves({ meshComponentSlot: () => SLOT }),
      },
      '../utils/specCutover': {
        resolveInstantiatedSpec: sinon.stub().callsFake(async (inst) => inst.view),
      },
      './meshCertificates': {
        HostCertificateAction: { DEPLOYED: 'deployed', PARKED: 'parked', NONE: 'none' },
        TRUST_BUNDLE_FILE: 'trust-bundle.pem',
        meshAppDir: (instance) => path.join(tmpRoot, instance),
        ensureAuthority: sinon.stub().resolves('PEM-OWN\n'),
        reconcileHostCertificate: sinon.stub().callsFake(async () => stubs.certAction),
        writeTrustBundle: (...args) => stubs.writeTrustBundle(...args),
        certificateDetails: sinon.stub().resolves({ fingerprint: 'fp-live' }),
        certificateBundleDetails: sinon.stub().resolves([{ fingerprint: 'fp-own' }, { fingerprint: 'fp-peer' }]),
        removeAppMaterial: record('removeAppMaterial'),
      },
      './meshMembership': {
        evaluateCandidates: (...args) => stubs.evaluateCandidates(...args),
      },
      './meshRefuseSet': {
        refusedOutpoints: sinon.stub().resolves(new Set()),
      },
      './meshNamespace': {
        ensureNamespace: record('ensureNamespace'),
        destroyNamespace: record('destroyNamespace'),
        ensureUplink: record('ensureUplink'),
        enableForwarding: record('enableForwarding'),
        ensureTranslatorRoutes: record('ensureTranslatorRoutes'),
        containerAttachment: sinon.stub().resolves(null),
        attachContainer: sinon.stub().callsFake(async (instance, link) => {
          stubs.attachments.push({ instance, ...link });
        }),
        ensureMeshChains: sinon.stub().callsFake(async () => { stubs.chainsEnsured = true; }),
        setMeshChainRules: sinon.stub().callsFake(async (rules) => { stubs.chainRules = rules; }),
        meshUnits: {
          startAll: sinon.stub().callsFake(async (i) => stubs.unitCalls.push(['startAll', i])),
          nebulaActive: sinon.stub().callsFake(async () => stubs.nebulaActive),
          reloadNebula: sinon.stub().callsFake(async (i) => stubs.unitCalls.push(['reloadNebula', i])),
          restartTayga: sinon.stub().callsFake(async (i) => stubs.unitCalls.push(['restartTayga', i])),
          stopAll: sinon.stub().callsFake(async (i) => stubs.unitCalls.push(['stopAll', i])),
        },
      },
      './meshTransit': {
        ensureTransit: sinon.stub().resolves(TRANSIT),
        observedSlot: sinon.stub().callsFake(async () => stubs.liveSlot ?? null),
        releaseTransit: record('releaseTransit'),
      },
      './meshSsh': {
        ensureClientKeypair: sinon.stub().resolves('ssh-ed25519 AAAAtest flux-mesh'),
        ensureHostKey: sinon.stub().resolves(),
        printOwnCert: sinon.stub().callsFake(async () => ({ fingerprint: stubs.liveCertFp ?? 'fp-live' })),
      },
      './meshSnapshot': {
        readCurrentSnapshot: sinon.stub().callsFake(async () => stubs.snapshotOnDisk),
        assignMemberAddresses: realSnapshot.assignMemberAddresses,
        writeSnapshot: sinon.stub().callsFake(async (ownNodeId, apps) => {
          stubs.writeSnapshotCalls.push({ ownNodeId, apps });
          return { generation: 1, snapshot: {}, addresses: realSnapshot.assignMemberAddresses(stubs.snapshotOnDisk, apps) };
        }),
      },
      './meshPortAllocator': {
        ensureTransportPort: sinon.stub().resolves(16230),
        releaseTransportPort: record('releaseTransportPort'),
      },
      './meshDetector': {
        detectImpersonation: sinon.stub().callsFake(async () => stubs.detectResult),
        awaitEvictionConverged: sinon.stub().callsFake(async () => stubs.converged),
      },
    });
  });

  afterEach(async () => {
    await realFsp.rm(tmpRoot, { recursive: true, force: true });
    sinon.restore();
  });

  describe('hostingOutpointsFor', () => {
    it('is null for unrestricted placement', async () => {
      const placement = { mode: () => 'none', hasTargets: () => false };
      expect(await meshReconciler.hostingOutpointsFor(placement)).to.equal(null);
      expect(await meshReconciler.hostingOutpointsFor(null)).to.equal(null);
    });

    it('resolves outpoint, ip and operator targets through the node list', async () => {
      const txB = 'b'.repeat(64);
      const txC = 'c'.repeat(64);
      stubs.nodeByAddress = { '1.2.3.4:16137': { txhash: txB, outidx: '1' } };
      stubs.nodesByPubkey = {
        opkey: new Map([['5.6.7.8', { txhash: txC, outidx: 2 }]]),
      };
      const placement = {
        mode: () => 'candidate',
        hasTargets: () => true,
        targetOutpoints: [`${'A'.repeat(64)}:0`],
        targetIps: ['1.2.3.4:16137', '9.9.9.9'],
        targetOperators: ['opkey'],
      };
      const outpoints = await meshReconciler.hostingOutpointsFor(placement);
      expect([...outpoints].sort()).to.deep.equal([
        `${'a'.repeat(64)}:0`,
        `${txB}:1`,
        `${txC}:2`,
      ].sort());
    });
  });

  describe('anchorHeightsFor', () => {
    it('resolves each unique hash once, from this chain only', async () => {
      stubs.getBlock = sinon.stub()
        .onFirstCall().resolves({ status: 'success', data: { height: 990, confirmations: 10 } })
        .onSecondCall().resolves({ status: 'success', data: { height: 700, confirmations: -1 } });
      const rows = [
        { meshAnchor: { hash: 'h1' } },
        { meshAnchor: { hash: 'h1' } },
        { meshAnchor: { hash: 'h2' } },
        { meshAnchor: null },
      ];
      const heights = await meshReconciler.anchorHeightsFor(rows);
      expect(heights.get('h1')).to.equal(990);
      expect(heights.get('h2')).to.equal(null);
      expect(stubs.getBlock.callCount).to.equal(2);
    });

    it('an unknown hash resolves to null', async () => {
      stubs.getBlock = sinon.stub().resolves({ status: 'error', data: { message: 'Block not found' } });
      const heights = await meshReconciler.anchorHeightsFor([{ meshAnchor: { hash: 'hx' } }]);
      expect(heights.get('hx')).to.equal(null);
    });
  });

  describe('reconcileAllMeshApps', () => {
    it('defers everything while the daemon is not synced', async () => {
      stubs.synced = { status: 'success', data: { synced: false } };
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.writeSnapshotCalls).to.have.length(0);
      expect(stubs.namespaceCalls).to.have.length(0);
    });

    it('does nothing on a node with no mesh apps', async () => {
      stubs.installedApps = [makeApp({ view: makeView({ network: { mesh: false } }) })];
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.writeSnapshotCalls).to.have.length(0);
      expect(stubs.chainsEnsured).to.equal(false);
    });

    it('skips a mesh app with no registration uuid, loudly', async () => {
      stubs.installedApps = [makeApp({ uuid: null, identity: null })];
      await meshReconciler.reconcileAllMeshApps();
      expect(logLines.warn.some((m) => m.includes('no registration uuid'))).to.equal(true);
      expect(stubs.writeSnapshotCalls).to.have.length(0);
    });

    it('converges one app end to end: material, snapshot, tayga, runtime, chains, detector', async () => {
      await meshReconciler.reconcileAllMeshApps();

      // Material: candidates were judged with the anchor resolved from MY chain.
      const ctx = stubs.evaluateCandidates.firstCall.args[0];
      expect(ctx.appUuid).to.equal(APP_UUID);
      expect(ctx.ownOutpoint).to.equal(OWN_OUTPOINT);
      expect(ctx.tipHeight).to.equal(1000);
      expect(ctx.anchorHeights.get(ANCHOR_HASH)).to.equal(995);
      expect(ctx.hostingOutpoints).to.equal(null);
      expect(stubs.writeTrustBundle.firstCall.args).to.deep.equal([IDENTITY, ['PEM-PEER\n']]);

      // The generated nebula config landed, carrying the peer and the sshd.
      const configText = await realFsp.readFile(path.join(tmpRoot, IDENTITY, 'config.yml'), 'utf8');
      expect(configText).to.include(`port: 16230`);
      expect(configText).to.include('ca_sha: "fp-peer"');
      expect(configText).to.include('sshd:');
      expect(configText).to.include('ssh-ed25519 AAAAtest flux-mesh');

      // Snapshot: own and peer members for the component, container scoping table.
      expect(stubs.writeSnapshotCalls).to.have.length(1);
      const snapApp = stubs.writeSnapshotCalls[0].apps[0];
      expect(snapApp.name).to.equal('myblog');
      expect(snapApp.members).to.deep.equal([
        { component: 'web', nodeId: OWN_NODE_ID },
        { component: 'web', nodeId: PEER_NODE_ID },
      ].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)));
      expect(snapApp.containers).to.deep.equal([{ component: 'web', sourceIp: '172.23.4.5' }]);

      // Tayga map: one entry per member, addresses from the ledger, IPv6 from
      // the derivation.
      const addresses = realSnapshot.assignMemberAddresses(null, stubs.writeSnapshotCalls[0].apps);
      const taygaText = await realFsp.readFile(path.join(tmpRoot, IDENTITY, 'tayga.conf'), 'utf8');
      expect(taygaText).to.include(`map ${addresses.get(`myblog|${OWN_NODE_ID}|web`)} ${meshDerivation.memberAddress(APP_UUID, OWN_OUTPOINT, SLOT)}`);
      expect(taygaText).to.include(`map ${addresses.get(`myblog|${PEER_NODE_ID}|web`)} ${meshDerivation.memberAddress(APP_UUID, PEER_OUTPOINT, SLOT)}`);

      // Runtime: namespace up, uplink rebuilt (no live slot), forwarding on,
      // units started, translator routes after, container attached at its
      // ledger address with the slot-derived linkId.
      const names = stubs.namespaceCalls.map(([name]) => name);
      expect(names).to.include.members(['ensureNamespace', 'ensureUplink', 'enableForwarding', 'ensureTranslatorRoutes']);
      expect(stubs.unitCalls).to.deep.include(['startAll', IDENTITY]);
      expect(stubs.attachments).to.deep.equal([{
        instance: IDENTITY,
        linkId: '03a9f2c1',
        containerPid: 4242,
        presentedIp: addresses.get(`myblog|${OWN_NODE_ID}|web`),
      }]);

      // Chains: the DNAT scoped to the external interface and this app's port.
      expect(stubs.chainsEnsured).to.equal(true);
      expect(stubs.chainRules.pre).to.deep.equal([[
        '-i', 'eth0', '-p', 'udp', '--dport', '16230',
        '-j', 'DNAT', '--to-destination', `${TRANSIT.namespaceIp}:16230`,
      ]]);
    });

    it('leaves a healthy uplink alone', async () => {
      stubs.liveSlot = TRANSIT.slot;
      await meshReconciler.reconcileAllMeshApps();
      const names = stubs.namespaceCalls.map(([name]) => name);
      expect(names).to.not.include('ensureUplink');
    });

    it('reloads a running nebula when material changed, with the renewal read-back', async () => {
      stubs.nebulaActive = true;
      stubs.certAction = 'deployed';
      stubs.liveCertFp = 'fp-live';
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.unitCalls).to.deep.include(['reloadNebula', IDENTITY]);
      expect(logLines.error).to.deep.equal([]);
    });

    it('flags a reload that still serves the previous certificate', async () => {
      stubs.nebulaActive = true;
      stubs.certAction = 'deployed';
      stubs.liveCertFp = 'fp-stale';
      await meshReconciler.reconcileAllMeshApps();
      expect(logLines.error.some((m) => m.includes('previous host certificate'))).to.equal(true);
    });

    it('a second pass with nothing changed rewrites nothing', async () => {
      await meshReconciler.reconcileAllMeshApps();
      const snapApps = stubs.writeSnapshotCalls[0].apps;
      const addresses = realSnapshot.assignMemberAddresses(null, snapApps);
      stubs.snapshotOnDisk = {
        schemaVersion: 1,
        generation: 1,
        nodeId: OWN_NODE_ID,
        apps: snapApps.map((app) => ({
          name: app.name,
          members: app.members.map((member) => ({
            ...member,
            ip: addresses.get(`${app.name}|${member.nodeId}|${member.component}`),
          })),
          containers: app.containers,
        })),
      };
      stubs.writeSnapshotCalls = [];
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.writeSnapshotCalls).to.have.length(0);
    });

    it('an eviction rebuilds the material, reloads, and requires convergence', async () => {
      stubs.nebulaActive = true;
      stubs.detectResult = {
        checked: true,
        evicted: [{ outpoint: PEER_OUTPOINT }],
        foreign: [],
      };
      stubs.converged = true;
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.evaluateCandidates.callCount).to.equal(2);
      expect(stubs.unitCalls.filter(([op]) => op === 'reloadNebula')).to.have.length.greaterThan(0);
      expect(logLines.error).to.deep.equal([]);
    });

    it('an eviction that does not converge is a security event', async () => {
      stubs.nebulaActive = true;
      stubs.detectResult = {
        checked: true,
        evicted: [{ outpoint: PEER_OUTPOINT }],
        foreign: [],
      };
      stubs.converged = false;
      await meshReconciler.reconcileAllMeshApps();
      expect(logLines.error.some((m) => m.includes('did NOT converge'))).to.equal(true);
    });

    it('foreign tunnels with nothing evicted force a reload', async () => {
      stubs.nebulaActive = true;
      stubs.detectResult = {
        checked: true, evicted: [], foreign: [{ issuer: 'fp-gone', vpnAddrs: [] }],
      };
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.unitCalls).to.deep.include(['reloadNebula', IDENTITY]);
      expect(logLines.warn.some((m) => m.includes('outside the trust bundle'))).to.equal(true);
    });
  });

  describe('prepareComponentMesh', () => {
    it('is null for a non-mesh app', async () => {
      stubs.installedApps = [makeApp({ view: makeView({ network: { mesh: false } }) })];
      expect(await meshReconciler.prepareComponentMesh('myblog', 'web')).to.equal(null);
    });

    it('returns the presented address, environment and resolver chain', async () => {
      const addresses = realSnapshot.assignMemberAddresses(null, [{
        name: 'myblog',
        members: [
          { component: 'web', nodeId: OWN_NODE_ID },
          { component: 'web', nodeId: PEER_NODE_ID },
        ],
      }]);
      const ownIp = addresses.get(`myblog|${OWN_NODE_ID}|web`);
      let passRan = false;
      stubs.writeSnapshotCalls = [];
      // After the pass, the snapshot on disk carries the assignment.
      const origWrite = stubs.snapshotOnDisk;
      Object.defineProperty(stubs, 'snapshotOnDisk', {
        get() {
          if (!passRan) return origWrite;
          return {
            apps: [{
              name: 'myblog',
              members: [{ component: 'web', nodeId: OWN_NODE_ID, ip: ownIp }],
            }],
          };
        },
        set() {},
        configurable: true,
      });
      const origReconcile = meshReconciler.reconcileAllMeshApps;
      const result = await (async () => {
        const out = origReconcile().then(() => { passRan = true; });
        await out;
        return meshReconciler.prepareComponentMesh('myblog', 'web');
      })();
      expect(result.presentedIp).to.equal(ownIp);
      expect(result.env).to.deep.equal([
        'FLUX_MESH_APP=myblog',
        `FLUX_MESH_SELF=web-${OWN_NODE_ID}`,
        `FLUX_MESH_SELF_IP=${ownIp}`,
      ]);
      expect(result.dns).to.deep.equal(['169.254.43.53', '8.8.8.8', '1.1.1.1']);
    });
  });

  describe('removeAppMesh', () => {
    it('tears the runtime down and forgets the allocations', async () => {
      await meshReconciler.removeAppMesh(IDENTITY);
      expect(stubs.unitCalls).to.deep.include(['stopAll', IDENTITY]);
      const names = stubs.namespaceCalls.map(([name]) => name);
      expect(names).to.include.members(['destroyNamespace', 'releaseTransportPort', 'releaseTransit', 'removeAppMaterial']);
      // The detached post-removal pass must finish before the temp dir goes.
      for (let i = 0; i < 25; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setImmediate(resolve); });
      }
    });
  });
});
