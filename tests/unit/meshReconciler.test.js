'use strict';

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
      listInstalledApps: sinon.stub().callsFake(async () => stubs.installedApps),
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
      getBlock: sinon.stub().callsFake(async (options) => ({
        status: 'success',
        data: { height: 995, confirmations: 5, hash: options.hashheight },
      })),
      materialInstances: [IDENTITY],
      namespaces: [],
      transitInstances: [],
      portInstances: [],
      getDefaultRouteInterface: sinon.stub().resolves('eth0'),
      slotView: null,
      slotClaims: [],
      enqueued: [],
    };

    const record = (name) => sinon.stub().callsFake(async (...args) => {
      stubs.namespaceCalls.push([name, ...args]);
    });
    stubs.destroyNamespace = record('destroyNamespace');

    meshReconciler = proxyquire('../../ZelBack/src/services/appMesh/meshReconciler', {
      '../../lib/log': {
        info: (m) => logLines.info.push(m),
        warn: (m) => logLines.warn.push(m),
        error: (m) => logLines.error.push(m),
        debug: sinon.stub(),
      },
      '../appDatabase/appsRepository': {
        listInstalledApps: (...args) => stubs.listInstalledApps(...args),
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
        dockerContainerInspect: sinon.stub().callsFake(async () => stubs.containerInspect ?? {
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
      '../fluxNetworkHelper': { getDefaultRouteInterface: (...args) => stubs.getDefaultRouteInterface(...args) },
      '../appMonitoring/reconcilerQueue': {
        enqueue: sinon.stub().callsFake((identifier) => stubs.enqueued.push(identifier)),
      },
      // The slot store/gossip reads are stubbed; the pure arbitration runs real.
      './meshSlots': {
        arbitrate: require('../../ZelBack/src/services/appMesh/meshSlots').arbitrate,
        appSlotView: sinon.stub().callsFake(async () => stubs.slotView
          ?? { ownSlot: null, ownSince: null, winners: new Map() }),
        resolveOwnSlot: sinon.stub().callsFake(async () => (stubs.slotView?.ownSlot ?? null)),
        publishClaimSlot: sinon.stub().callsFake(async (...args) => { stubs.slotClaims.push(args); }),
      },
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
        listMaterialInstances: sinon.stub().callsFake(async () => stubs.materialInstances),
      },
      './meshMembership': {
        evaluateCandidates: (...args) => stubs.evaluateCandidates(...args),
      },
      './meshRefuseSet': {
        refusedOutpoints: sinon.stub().resolves(new Set()),
      },
      './meshNamespace': {
        ensureNamespace: record('ensureNamespace'),
        destroyNamespace: (...args) => stubs.destroyNamespace(...args),
        listNamespaces: sinon.stub().callsFake(async () => stubs.namespaces),
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
        assignedInstances: sinon.stub().callsFake(() => stubs.transitInstances),
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
        allocatedInstances: sinon.stub().callsFake(async () => stubs.portInstances),
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
    // The pass writes the real (dependency-free) drift registry singleton.
    require('../../ZelBack/src/services/appMesh/meshIdentityDrift').reset();
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
      stubs.materialInstances = [];
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
      expect(meshReconciler.lastPassStatus('myblog').externalInterface).to.equal('eth0');
    });

    it('with no default-route interface: converges locally, chains empty, degradation loud and visible', async () => {
      stubs.getDefaultRouteInterface = sinon.stub().resolves(null);
      await meshReconciler.reconcileAllMeshApps();
      // The local overlay still came up — material, snapshot, units.
      expect(stubs.writeSnapshotCalls).to.have.length(1);
      expect(stubs.unitCalls).to.deep.include(['startAll', IDENTITY]);
      // But no reachability rules could be scoped, and it is NOT reported healthy-silent.
      expect(stubs.chainsEnsured).to.equal(true);
      expect(stubs.chainRules).to.deep.equal({ pre: [], post: [], fwd: [] });
      expect(logLines.error.some((m) => m.includes('no default-route interface'))).to.equal(true);
      expect(meshReconciler.lastPassStatus('myblog').externalInterface).to.equal(null);
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
          components: app.components,
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

    it('calls during a running pass share one follow-up that sees their changes', async () => {
      const first = meshReconciler.reconcileAllMeshApps();
      const second = meshReconciler.reconcileAllMeshApps();
      const third = meshReconciler.reconcileAllMeshApps();
      stubs.installedApps = [];
      await Promise.all([first, second, third]);
      // The first pass converged the app it gathered before the change...
      const configText = await realFsp.readFile(path.join(tmpRoot, IDENTITY, 'config.yml'), 'utf8');
      expect(configText).to.include('ca_sha: "fp-peer"');
      // ...and the one shared follow-up gathered again and saw it gone.
      expect(stubs.listInstalledApps.callCount).to.equal(2);
      expect(meshReconciler.lastPassStatus('myblog')).to.equal(null);
    });

    it('a follow-up still runs after a pass that failed', async () => {
      stubs.listInstalledApps.onFirstCall().rejects(new Error('db exploded'));
      const first = meshReconciler.reconcileAllMeshApps().then(() => null, (e) => e.message);
      const second = meshReconciler.reconcileAllMeshApps();
      expect(await first).to.equal('db exploded');
      await second;
      expect(stubs.writeSnapshotCalls).to.have.length(1);
    });

    it('collects mesh state no installed app claims', async () => {
      stubs.materialInstances = [IDENTITY, 'deadbeef0123'];
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.unitCalls).to.deep.include(['stopAll', 'deadbeef0123']);
      expect(stubs.namespaceCalls).to.deep.include(['destroyNamespace', 'deadbeef0123']);
      expect(stubs.namespaceCalls).to.deep.include(['releaseTransportPort', 'deadbeef0123']);
      expect(stubs.namespaceCalls).to.deep.include(['releaseTransit', 'deadbeef0123']);
      expect(stubs.namespaceCalls).to.deep.include(['removeAppMaterial', 'deadbeef0123']);
      expect(stubs.namespaceCalls).to.not.deep.include(['removeAppMaterial', IDENTITY]);
      expect(logLines.warn.some((m) => m.includes('stray mesh state for deadbeef0123'))).to.equal(true);
    });

    it('a namespace alone is enough to be collected', async () => {
      stubs.namespaces = ['deadbeef0123'];
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.namespaceCalls).to.deep.include(['destroyNamespace', 'deadbeef0123']);
      expect(stubs.namespaceCalls).to.deep.include(['removeAppMaterial', 'deadbeef0123']);
    });

    it('one stray failing to collect does not block another, or the pass', async () => {
      stubs.materialInstances = [IDENTITY, 'aaaa11112222', 'bbbb33334444'];
      stubs.destroyNamespace = sinon.stub().callsFake(async (instance) => {
        stubs.namespaceCalls.push(['destroyNamespace', instance]);
        if (instance === 'aaaa11112222') throw new Error('netns busy');
      });
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.namespaceCalls).to.deep.include(['removeAppMaterial', 'bbbb33334444']);
      expect(stubs.namespaceCalls).to.not.deep.include(['removeAppMaterial', 'aaaa11112222']);
      expect(logLines.error.some((m) => m.includes('aaaa11112222'))).to.equal(true);
      expect(stubs.writeSnapshotCalls).to.have.length(1);
    });

    it('the last app leaving sheds the snapshot and the chains', async () => {
      stubs.installedApps = [];
      stubs.materialInstances = [IDENTITY];
      stubs.snapshotOnDisk = {
        schemaVersion: 1,
        generation: 3,
        nodeId: OWN_NODE_ID,
        apps: [{ name: 'myblog', members: [], containers: [] }],
      };
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.namespaceCalls).to.deep.include(['removeAppMaterial', IDENTITY]);
      expect(stubs.writeSnapshotCalls).to.deep.equal([{ ownNodeId: OWN_NODE_ID, apps: [] }]);
      expect(stubs.chainsEnsured).to.equal(true);
      expect(stubs.chainRules).to.deep.equal({ pre: [], post: [], fwd: [] });
    });

    it('a node that never ran mesh executes nothing on an empty pass', async () => {
      stubs.installedApps = [];
      stubs.materialInstances = [];
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.namespaceCalls).to.have.length(0);
      expect(stubs.unitCalls).to.have.length(0);
      expect(stubs.writeSnapshotCalls).to.have.length(0);
      expect(stubs.chainsEnsured).to.equal(false);
    });

    it('an installed app keeps its material even when its view is not mesh', async () => {
      stubs.installedApps = [makeApp({ view: makeView({ network: { mesh: false } }) })];
      stubs.materialInstances = [IDENTITY];
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.namespaceCalls.map(([name]) => name)).to.not.include('removeAppMaterial');
    });
  });

  describe('lastPassStatus', () => {
    it('is null before any pass, and retains the pass outcome after one', async () => {
      stubs.nebulaActive = true;
      expect(meshReconciler.lastPassStatus('myblog')).to.equal(null);
      await meshReconciler.reconcileAllMeshApps();
      const status = meshReconciler.lastPassStatus('myblog');
      expect(status.error).to.equal(null);
      expect(status.meshPort).to.equal(16230);
      expect(status.members).to.have.length(1);
      expect(status.members[0].outpoint).to.equal(PEER_OUTPOINT);
      expect(status.members[0]).to.not.have.property('meshCa');
      expect(status.detector).to.deep.equal({ checked: true, evicted: [], foreign: 0 });
      expect(status.at).to.be.a('number');
    });

    it('retains the failure when the material pass breaks', async () => {
      stubs.evaluateCandidates = sinon.stub().rejects(new Error('daemon exploded'));
      await meshReconciler.reconcileAllMeshApps();
      expect(meshReconciler.lastPassStatus('myblog').error).to.equal('daemon exploded');
    });

    it('forgets an app the gather no longer sees', async () => {
      await meshReconciler.reconcileAllMeshApps();
      expect(meshReconciler.lastPassStatus('myblog')).to.not.equal(null);
      stubs.installedApps = [];
      await meshReconciler.reconcileAllMeshApps();
      expect(meshReconciler.lastPassStatus('myblog')).to.equal(null);
    });

    it('surfaces slot-identity drift, and enqueues the rebuild only once confirmed', async () => {
      // The container was created as a standby (nodeid identity); the passes
      // resolve slot 1 — drift. One pass records it, the second confirms and
      // hands the identifier to the app reconciler's queue.
      stubs.slotView = { ownSlot: 1, ownSince: null, winners: new Map() };
      stubs.containerInspect = {
        State: { Pid: 4242 },
        Config: { Env: [`FLUX_MESH_SELF=web-${OWN_NODE_ID}`] },
        NetworkSettings: { Networks: { fluxDockerNetwork_myblog: { IPAddress: '172.23.4.5' } } },
      };
      await meshReconciler.reconcileAllMeshApps();
      expect(meshReconciler.lastPassStatus('myblog').identityDrift).to.deep.equal([{
        identifier: 'web_ab12cd34ef56', component: 'web', is: `web-${OWN_NODE_ID}`, wants: 'web-1',
      }]);
      expect(stubs.enqueued).to.deep.equal([]);
      await meshReconciler.reconcileAllMeshApps();
      expect(stubs.enqueued).to.deep.equal(['web_ab12cd34ef56']);
      // A container matching its resolved slot records no drift at all.
      stubs.containerInspect.Config.Env = ['FLUX_MESH_SELF=web-1'];
      await meshReconciler.reconcileAllMeshApps();
      expect(meshReconciler.lastPassStatus('myblog').identityDrift).to.deep.equal([]);
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
        `FLUX_MESH_SELF_FQDN=web-${OWN_NODE_ID}.myblog.mesh.flux`,
        `FLUX_MESH_SELF_IP=${ownIp}`,
      ]);
      expect(result.dns).to.deep.equal(['169.254.43.53', '8.8.8.8', '1.1.1.1']);
      // A slot-less member keeps the component-name hostname convention via
      // the member-name hostname + component alias pair all mesh containers get.
      expect(result.hostname).to.equal(`web-${OWN_NODE_ID}`);
      expect(result.aliases).to.deep.equal(['web']);
    });

    it('a slot-holder is created under its ordinal identity', async () => {
      stubs.slotView = { ownSlot: 1, ownSince: null, winners: new Map() };
      const addresses = realSnapshot.assignMemberAddresses(null, [{
        name: 'myblog',
        members: [{ component: 'web', nodeId: OWN_NODE_ID }],
      }]);
      const ownIp = addresses.get(`myblog|${OWN_NODE_ID}|web`);
      let passRan = false;
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
      const result = await (async () => {
        const out = meshReconciler.reconcileAllMeshApps().then(() => { passRan = true; });
        await out;
        return meshReconciler.prepareComponentMesh('myblog', 'web');
      })();
      expect(result.env).to.deep.equal([
        'FLUX_MESH_APP=myblog',
        'FLUX_MESH_SELF=web-1',
        'FLUX_MESH_SELF_FQDN=web-1.myblog.mesh.flux',
        'FLUX_MESH_ORDINAL=1',
        `FLUX_MESH_SELF_IP=${ownIp}`,
      ]);
      expect(result.hostname).to.equal('web-1');
      expect(result.aliases).to.deep.equal(['web']);
      // The chosen slot was published onto the standing install claim so
      // concurrent installers split vacancies.
      expect(stubs.slotClaims).to.deep.include(['myblog', 1]);
    });
  });

  describe('buildSnapshotApp', () => {
    it('feeds each component\'s mesh ports into the snapshot as the SRV map', () => {
      const app = {
        name: 'myblog',
        view: {
          componentNames: () => ['web', 'mysql'],
          components: {
            web: { meshPorts: {} },
            mysql: {
              meshPorts: {
                galera: { containerPort: 4567, protocol: 'tcp' },
                sst: { containerPort: 4444 },
              },
            },
          },
        },
        material: { members: [{ nodeId: PEER_NODE_ID }] },
        containers: [],
      };
      const snapApp = meshReconciler.buildSnapshotApp(app, { ownNodeId: OWN_NODE_ID });
      // Only components that declare mesh ports appear; the protocol falls
      // back to tcp; keys are deterministically ordered.
      expect(snapApp.components).to.deep.equal({
        mysql: {
          ports: {
            galera: { port: 4567, proto: 'tcp' },
            sst: { port: 4444, proto: 'tcp' },
          },
        },
      });
      expect(snapApp.members).to.have.length(4);
    });

    it('emits an empty components map for a view carrying no meshPorts', () => {
      const app = {
        name: 'myblog',
        view: { componentNames: () => ['web'] },
        material: { members: [] },
        containers: [],
      };
      const snapApp = meshReconciler.buildSnapshotApp(app, { ownNodeId: OWN_NODE_ID });
      expect(snapApp.components).to.deep.equal({});
    });

    it('assigns ordinals from the arbitrated slot assertions', () => {
      const app = {
        name: 'myblog',
        view: { componentNames: () => ['web'], instances: 3 },
        material: {
          slotView: { ownSlot: 0, ownSince: '2026-08-10T08:00:00.000Z' },
          members: [
            {
              nodeId: PEER_NODE_ID, outpoint: PEER_OUTPOINT, slot: 1, runningSince: '2026-08-10T09:00:00.000Z',
            },
            // A standby peer: admitted, listed, no ordinal.
            {
              nodeId: 'aaaa1111', outpoint: 'aaaa:0', slot: null, runningSince: '2026-08-10T10:00:00.000Z',
            },
          ],
        },
        containers: [],
      };
      const snapApp = meshReconciler.buildSnapshotApp(app, {
        ownNodeId: OWN_NODE_ID, ownOutpoint: OWN_OUTPOINT,
      });
      const byNode = new Map(snapApp.members.map((m) => [m.nodeId, m.ordinal]));
      expect(byNode.get(OWN_NODE_ID)).to.equal(0);
      expect(byNode.get(PEER_NODE_ID)).to.equal(1);
      expect(snapApp.members.find((m) => m.nodeId === 'aaaa1111')).to.not.have.property('ordinal');
    });

    it('a double-claimed slot names only the arbitration winner', () => {
      const app = {
        name: 'myblog',
        view: { componentNames: () => ['web'], instances: 3 },
        material: {
          slotView: { ownSlot: 1, ownSince: '2026-08-10T10:00:00.000Z' },
          members: [
            // Same slot, earlier runningSince: the peer wins, this node is
            // slot-less this pass (its own resolver re-picks on the next).
            {
              nodeId: PEER_NODE_ID, outpoint: PEER_OUTPOINT, slot: 1, runningSince: '2026-08-10T09:00:00.000Z',
            },
          ],
        },
        containers: [],
      };
      const snapApp = meshReconciler.buildSnapshotApp(app, {
        ownNodeId: OWN_NODE_ID, ownOutpoint: OWN_OUTPOINT,
      });
      const byNode = new Map(snapApp.members.map((m) => [m.nodeId, m.ordinal]));
      expect(byNode.get(PEER_NODE_ID)).to.equal(1);
      expect(snapApp.members.find((m) => m.nodeId === OWN_NODE_ID)).to.not.have.property('ordinal');
    });

    it('ignores slots at or beyond the instance cap', () => {
      const app = {
        name: 'myblog',
        view: { componentNames: () => ['web'], instances: 2 },
        material: {
          slotView: { ownSlot: null, ownSince: null },
          members: [{
            nodeId: PEER_NODE_ID, outpoint: PEER_OUTPOINT, slot: 5, runningSince: '2026-08-10T09:00:00.000Z',
          }],
        },
        containers: [],
      };
      const snapApp = meshReconciler.buildSnapshotApp(app, {
        ownNodeId: OWN_NODE_ID, ownOutpoint: OWN_OUTPOINT,
      });
      expect(snapApp.members.find((m) => m.nodeId === PEER_NODE_ID)).to.not.have.property('ordinal');
    });
  });

  describe('removeAppMesh', () => {
    it('tears the runtime down and forgets the allocations', async () => {
      await meshReconciler.removeAppMesh(IDENTITY);
      expect(stubs.unitCalls).to.deep.include(['stopAll', IDENTITY]);
      const names = stubs.namespaceCalls.map(([name]) => name);
      expect(names).to.include.members(['destroyNamespace', 'releaseTransportPort', 'releaseTransit', 'removeAppMaterial']);
      // Join the detached post-removal pass before the temp dir goes: a
      // coalesced call resolves only after a pass that began at or after it
      // has completed, so no write is still in flight past this await.
      await meshReconciler.reconcileAllMeshApps();
    });

    it('tears down when only the namespace remains', async () => {
      stubs.namespaces = ['ghost0123'];
      await meshReconciler.removeAppMesh('ghost0123');
      expect(stubs.unitCalls).to.deep.include(['stopAll', 'ghost0123']);
      expect(stubs.namespaceCalls).to.deep.include(['destroyNamespace', 'ghost0123']);
      expect(stubs.namespaceCalls).to.deep.include(['removeAppMaterial', 'ghost0123']);
      await meshReconciler.reconcileAllMeshApps();
    });

    it('is a no-op when the app holds no artifact', async () => {
      await meshReconciler.removeAppMesh('ghost0123');
      expect(stubs.unitCalls).to.have.length(0);
      expect(stubs.namespaceCalls).to.have.length(0);
    });
  });
});
