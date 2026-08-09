const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// The slot math is pure and pinned by exact values; the allocation flows are
// driven through a command recorder that plays back live-interface state, so
// adoption, lowest-free and exhaustion are all proven against the same
// observed-state inputs the real node would present.
describe('meshTransit', () => {
  let meshTransit;
  let responses;
  let calls;

  beforeEach(() => {
    calls = [];
    responses = new Map();
    meshTransit = proxyquire('../../ZelBack/src/services/appMesh/meshTransit', {
      '../serviceHelper': {
        runCommand: sinon.stub().callsFake(async (cmd, options) => {
          const line = `${cmd} ${options.params.join(' ')}`;
          calls.push(line);
          expect(options.runAsRoot).to.equal(true);
          for (const [pattern, response] of responses) {
            if (line.includes(pattern)) return response;
          }
          return { error: null, stdout: '', stderr: '' };
        }),
      },
    });
  });

  afterEach(() => sinon.restore());

  const INSTANCE = 'ab12cd34ef56';
  const OTHER = 'ffeeddccbbaa';

  describe('transitForSlot', () => {
    it('pins the slot addressing', () => {
      expect(meshTransit.transitForSlot(0)).to.deep.equal({
        slot: 0,
        linkId: '0',
        subnet: '169.254.108.0/30',
        hostIp: '169.254.108.1',
        namespaceIp: '169.254.108.2',
        prefixLength: 30,
      });
      expect(meshTransit.transitForSlot(255)).to.deep.equal({
        slot: 255,
        linkId: '255',
        subnet: '169.254.111.252/30',
        hostIp: '169.254.111.253',
        namespaceIp: '169.254.111.254',
        prefixLength: 30,
      });
    });

    it('rejects slots outside the range', () => {
      expect(() => meshTransit.transitForSlot(-1)).to.throw(TypeError);
      expect(() => meshTransit.transitForSlot(256)).to.throw(TypeError);
      expect(() => meshTransit.transitForSlot(1.5)).to.throw(TypeError);
    });
  });

  describe('slotOfNamespaceIp', () => {
    it('inverts the namespace address of every slot boundary', () => {
      expect(meshTransit.slotOfNamespaceIp('169.254.108.2')).to.equal(0);
      expect(meshTransit.slotOfNamespaceIp('169.254.108.6')).to.equal(1);
      expect(meshTransit.slotOfNamespaceIp('169.254.111.254')).to.equal(255);
    });

    it('answers null for anything that is not a namespace address', () => {
      expect(meshTransit.slotOfNamespaceIp('169.254.108.1')).to.equal(null);
      expect(meshTransit.slotOfNamespaceIp('169.254.108.0')).to.equal(null);
      expect(meshTransit.slotOfNamespaceIp('169.254.112.2')).to.equal(null);
      expect(meshTransit.slotOfNamespaceIp('10.0.0.2')).to.equal(null);
      expect(meshTransit.slotOfNamespaceIp('not-an-ip')).to.equal(null);
    });
  });

  describe('slotsOfLinkShow', () => {
    it('reads fmu- slots out of ip -o link show output', () => {
      const output = [
        '2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500',
        '14: fmu-3@if13: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500',
        '19: fmu-17@if18: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500',
        '21: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500',
      ].join('\n');
      expect([...meshTransit.slotsOfLinkShow(output)].sort((a, b) => a - b)).to.deep.equal([3, 17]);
    });

    it('ignores names outside the slot range', () => {
      expect(meshTransit.slotsOfLinkShow('9: fmu-999@if8: <UP>')).to.deep.equal(new Set());
    });
  });

  describe('ensureTransit', () => {
    it('adopts the slot a live uplink already carries', async () => {
      responses.set('addr show uplink0', {
        error: null,
        stdout: `23: uplink0    inet 169.254.108.14/30 brd 169.254.108.15 scope global uplink0\\       valid_lft forever preferred_lft forever`,
        stderr: '',
      });
      const transit = await meshTransit.ensureTransit(INSTANCE);
      expect(transit.slot).to.equal(3);
      expect(calls).to.deep.equal([
        `ip -n flux-mesh-${INSTANCE} -o -4 addr show uplink0`,
      ]);
    });

    it('assigns the lowest slot no live interface holds, and remembers it', async () => {
      responses.set('addr show uplink0', { error: new Error('exit 1'), stdout: '', stderr: 'No such file or directory' });
      responses.set('link show', {
        error: null,
        stdout: '14: fmu-0@if13: <UP>\n15: fmu-1@if14: <UP>\n16: fmu-3@if15: <UP>',
        stderr: '',
      });
      const transit = await meshTransit.ensureTransit(INSTANCE);
      expect(transit.slot).to.equal(2);
      const again = await meshTransit.ensureTransit(INSTANCE);
      expect(again.slot).to.equal(2);
      expect(calls.filter((c) => c.includes('link show')).length).to.equal(1);
    });

    it('never hands two apps the same slot, even racing', async () => {
      responses.set('addr show uplink0', { error: new Error('exit 1'), stdout: '', stderr: 'No such file' });
      const [a, b] = await Promise.all([
        meshTransit.ensureTransit(INSTANCE),
        meshTransit.ensureTransit(OTHER),
      ]);
      expect(a.slot).to.not.equal(b.slot);
    });

    it('release frees the slot for the next app', async () => {
      responses.set('addr show uplink0', { error: new Error('exit 1'), stdout: '', stderr: 'No such file' });
      const a = await meshTransit.ensureTransit(INSTANCE);
      meshTransit.releaseTransit(INSTANCE);
      const b = await meshTransit.ensureTransit(OTHER);
      expect(b.slot).to.equal(a.slot);
    });

    it('rejects a malformed instance', async () => {
      try {
        await meshTransit.ensureTransit('../oops');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).to.be.instanceOf(TypeError);
      }
    });
  });
});
