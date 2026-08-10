'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Every function here is a fixed sequence of ip/iptables/systemctl/nsenter
// invocations, so the tests record the commands and pin the sequences — the
// commands ARE the behaviour. Failures are injected through the recorder to
// prove tolerated errors (rebuilding an absent device) stay tolerated and
// real ones throw.
describe('meshNamespace', () => {
  let meshNamespace;
  let calls;
  let failures;
  let netnsEntries;

  beforeEach(() => {
    calls = [];
    failures = new Map();
    netnsEntries = null;
    meshNamespace = proxyquire('../../ZelBack/src/services/appMesh/meshNamespace', {
      'node:fs/promises': {
        readdir: sinon.stub().callsFake(async (dir) => {
          expect(dir).to.equal('/run/netns');
          if (netnsEntries === null) {
            const error = new Error('ENOENT: no such file or directory');
            error.code = 'ENOENT';
            throw error;
          }
          return netnsEntries;
        }),
      },
      '../serviceHelper': {
        runCommand: sinon.stub().callsFake(async (cmd, options) => {
          const line = `${cmd} ${options.params.join(' ')}`;
          calls.push(line);
          expect(options.runAsRoot).to.equal(true);
          for (const [pattern, stderr] of failures) {
            if (line.includes(pattern)) return { error: new Error('exit 1'), stdout: '', stderr };
          }
          return { error: null, stdout: '', stderr: '' };
        }),
      },
      '../../lib/log': {
        info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub(),
      },
    });
  });

  afterEach(() => sinon.restore());

  const INSTANCE = 'ab12cd34ef56';
  const NS = 'flux-mesh-ab12cd34ef56';

  describe('ensureNamespace', () => {
    it('adds the namespace and tolerates it already existing', async () => {
      await meshNamespace.ensureNamespace(INSTANCE);
      expect(calls).to.deep.equal([`ip netns add ${NS}`]);
      failures.set('netns add', 'Cannot create namespace file "/run/netns/x": File exists');
      await meshNamespace.ensureNamespace(INSTANCE);
    });

    it('rejects a malformed instance', () => {
      expect(() => meshNamespace.netnsName('../oops')).to.throw(TypeError);
    });
  });

  describe('listNamespaces', () => {
    it('is empty when the netns dir does not exist', async () => {
      expect(await meshNamespace.listNamespaces()).to.deep.equal([]);
    });

    it('lists only well-formed mesh namespaces', async () => {
      netnsEntries = [
        'flux-mesh-ab12cd34ef56',
        'flux-mesh-ffee00112233',
        'flux-mesh-../oops',
        'other-ns',
        'flux-mesh-',
      ];
      expect(await meshNamespace.listNamespaces()).to.deep.equal(['ab12cd34ef56', 'ffee00112233']);
    });
  });

  describe('ensureUplink', () => {
    it('rebuilds the veth and plumbs both sides', async () => {
      await meshNamespace.ensureUplink(INSTANCE, {
        linkId: 'a1b2c3', hostIp: '169.254.108.1', namespaceIp: '169.254.108.2', prefixLength: 30,
      });
      expect(calls).to.deep.equal([
        'ip link delete fmu-a1b2c3',
        `ip link add fmu-a1b2c3 type veth peer name uplink0 netns ${NS}`,
        'ip address add 169.254.108.1/30 dev fmu-a1b2c3',
        'ip link set fmu-a1b2c3 up',
        `ip -n ${NS} address add 169.254.108.2/30 dev uplink0`,
        `ip -n ${NS} link set uplink0 up`,
        `ip -n ${NS} link set lo up`,
        `ip -n ${NS} route replace default via 169.254.108.1 dev uplink0`,
      ]);
    });

    it('tolerates the stale device being absent, throws on real failures', async () => {
      failures.set('link delete', 'Cannot find device "fmu-a1b2c3"');
      await meshNamespace.ensureUplink(INSTANCE, {
        linkId: 'a1b2c3', hostIp: '169.254.108.1', namespaceIp: '169.254.108.2', prefixLength: 30,
      });
      failures.set('link add', 'Operation not permitted');
      try {
        await meshNamespace.ensureUplink(INSTANCE, {
          linkId: 'a1b2c3', hostIp: '169.254.108.1', namespaceIp: '169.254.108.2', prefixLength: 30,
        });
        expect.fail('should throw');
      } catch (error) {
        expect(error.message).to.include('Operation not permitted');
      }
    });
  });

  describe('attachContainer', () => {
    it('pins the full replumb sequence', async () => {
      await meshNamespace.attachContainer(INSTANCE, {
        linkId: 'web1', containerPid: 4242, presentedIp: '10.127.1.11',
      });
      expect(calls).to.deep.equal([
        `ip -n ${NS} link delete c-web1`,
        'ip link delete fmt-web1',
        `ip link add fmt-web1 type veth peer name c-web1 netns ${NS}`,
        'ip link set fmt-web1 netns 4242',
        'nsenter -t 4242 -n ip link set fmt-web1 name flux-mesh0',
        'nsenter -t 4242 -n ip address add 10.127.1.11/32 dev flux-mesh0',
        'nsenter -t 4242 -n ip link set flux-mesh0 mtu 1400 up',
        'nsenter -t 4242 -n ip route replace 10.127.0.0/20 dev flux-mesh0',
        `ip -n ${NS} link set c-web1 mtu 1400 up`,
        `ip netns exec ${NS} sysctl -q -w net.ipv4.conf.c-web1.proxy_arp=1`,
        `ip -n ${NS} route replace 10.127.1.11/32 dev c-web1`,
      ]);
    });

    it('rejects a bad pid or link id', async () => {
      try {
        await meshNamespace.attachContainer(INSTANCE, { linkId: 'web1', containerPid: 0, presentedIp: '10.127.1.11' });
        expect.fail('should throw');
      } catch (error) {
        expect(error).to.be.instanceOf(TypeError);
      }
      try {
        await meshNamespace.attachContainer(INSTANCE, { linkId: 'much-too-long-id', containerPid: 4242, presentedIp: '10.127.1.11' });
        expect.fail('should throw');
      } catch (error) {
        expect(error).to.be.instanceOf(TypeError);
      }
    });
  });

  describe('ensureTranslatorRoutes', () => {
    it('steers the block and the synthetic range into the translator tun', async () => {
      await meshNamespace.ensureTranslatorRoutes(INSTANCE, { ownBlock: 'fdb2:8fa9:3450:76a8:bd32:a312::/96' });
      expect(calls).to.deep.equal([
        `ip -n ${NS} link set siit0 mtu 1400 up`,
        `ip -n ${NS} -6 route replace fdb2:8fa9:3450:76a8:bd32:a312::/96 dev siit0`,
        `ip -n ${NS} route replace 10.127.0.0/20 dev siit0`,
      ]);
    });
  });

  describe('ensureMeshChains', () => {
    it('creates missing chains and re-asserts the jumps', async () => {
      failures.set('-L FLUX-MESH-PRE', 'No chain/target/match by that name');
      failures.set('-C PREROUTING', 'No chain/target/match by that name');
      await meshNamespace.ensureMeshChains();
      expect(calls).to.include('iptables -t nat -N FLUX-MESH-PRE');
      expect(calls).to.include('iptables -t nat -I PREROUTING -j FLUX-MESH-PRE');
      // Present chains are probed, not recreated; present jumps stay put.
      expect(calls).to.include('iptables -t nat -L FLUX-MESH-POST -n');
      expect(calls).to.not.include('iptables -t nat -N FLUX-MESH-POST');
      expect(calls).to.include('iptables -t filter -C FORWARD -j FLUX-MESH-FWD');
      expect(calls).to.not.include('iptables -t filter -I FORWARD -j FLUX-MESH-FWD');
    });
  });

  describe('setMeshChainRules', () => {
    it('flushes each chain then writes exactly the given rules', async () => {
      await meshNamespace.setMeshChainRules({
        pre: [['-i', 'eth0', '-p', 'udp', '--dport', '16230', '-j', 'DNAT', '--to-destination', '169.254.108.2:16230']],
        post: [['-s', '169.254.108.0/30', '-j', 'MASQUERADE']],
        fwd: [
          ['-d', '169.254.108.0/30', '-j', 'ACCEPT'],
          ['-s', '169.254.108.0/30', '-j', 'ACCEPT'],
        ],
      });
      expect(calls).to.deep.equal([
        'iptables -t nat -F FLUX-MESH-PRE',
        'iptables -t nat -A FLUX-MESH-PRE -i eth0 -p udp --dport 16230 -j DNAT --to-destination 169.254.108.2:16230',
        'iptables -t nat -F FLUX-MESH-POST',
        'iptables -t nat -A FLUX-MESH-POST -s 169.254.108.0/30 -j MASQUERADE',
        'iptables -t filter -F FLUX-MESH-FWD',
        'iptables -t filter -A FLUX-MESH-FWD -d 169.254.108.0/30 -j ACCEPT',
        'iptables -t filter -A FLUX-MESH-FWD -s 169.254.108.0/30 -j ACCEPT',
      ]);
    });
  });

  describe('meshUnits', () => {
    it('starts, reloads, restarts and stops the right template instances', async () => {
      await meshNamespace.meshUnits.startAll(INSTANCE);
      await meshNamespace.meshUnits.reloadNebula(INSTANCE);
      await meshNamespace.meshUnits.restartTayga(INSTANCE);
      await meshNamespace.meshUnits.stopAll(INSTANCE);
      expect(calls).to.have.members([
        `systemctl start flux-mesh@${INSTANCE}`,
        `systemctl start flux-mesh-tayga@${INSTANCE}`,
        `systemctl reload flux-mesh@${INSTANCE}`,
        `systemctl restart flux-mesh-tayga@${INSTANCE}`,
        `systemctl stop flux-mesh@${INSTANCE}`,
        `systemctl stop flux-mesh-tayga@${INSTANCE}`,
      ]);
    });
  });
});
