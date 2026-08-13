'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('meshSlots', () => {
  let meshSlots;
  let stubs;

  const OWN_ADDR = '203.0.113.5:16127';
  const PEER_ADDR = '203.0.113.7:16127';

  beforeEach(() => {
    stubs = {
      rows: [],
      claims: [],
      localAddr: OWN_ADDR,
      stored: [],
      broadcasts: [],
    };
    meshSlots = proxyquire('../../ZelBack/src/services/appMesh/meshSlots', {
      '../appDatabase/appsRepository': {
        appLocationFromEvents: sinon.stub().callsFake(async () => stubs.rows),
      },
      '../appDatabase/registryManager': {
        appInstallingLocation: sinon.stub().callsFake(async () => stubs.claims),
        storeAppInstallingMessage: sinon.stub().callsFake(async (message) => {
          stubs.stored.push(message);
          return true;
        }),
      },
      '../fluxNetworkHelper': {
        getLocalSocketAddress: sinon.stub().callsFake(async () => stubs.localAddr),
      },
      '../fluxCommunicationMessagesSender': {
        broadcastMessageToAll: sinon.stub().callsFake(async (message, options) => {
          stubs.broadcasts.push([message, options]);
        }),
      },
    });
  });

  afterEach(() => sinon.restore());

  describe('arbitrate', () => {
    it('the earliest runningSince wins a contested slot, outpoint breaks ties', () => {
      const winners = meshSlots.arbitrate([
        { slot: 1, since: '2026-08-10T10:00:00.000Z', tiebreak: 'bb:0' },
        { slot: 1, since: '2026-08-10T09:00:00.000Z', tiebreak: 'cc:0' },
        { slot: 2, since: '2026-08-10T09:00:00.000Z', tiebreak: 'bb:0' },
        { slot: 2, since: '2026-08-10T09:00:00.000Z', tiebreak: 'aa:0' },
      ]);
      expect(winners.get(1).tiebreak).to.equal('cc:0');
      expect(winners.get(2).tiebreak).to.equal('aa:0');
    });

    it('a running member always beats a joiner with no runningSince', () => {
      const winners = meshSlots.arbitrate([
        { slot: 0, since: null, tiebreak: 'aa:0' },
        { slot: 0, since: '2026-08-10T09:00:00.000Z', tiebreak: 'zz:0' },
      ]);
      expect(winners.get(0).tiebreak).to.equal('zz:0');
    });

    it('ignores entries without a valid slot', () => {
      const winners = meshSlots.arbitrate([
        { slot: -1, since: null, tiebreak: 'aa:0' },
        { slot: 1.5, since: null, tiebreak: 'bb:0' },
        { slot: null, since: null, tiebreak: 'cc:0' },
      ]);
      expect(winners.size).to.equal(0);
    });
  });

  describe('lowestVacancy', () => {
    it('fills gaps first and reports a full space as null', () => {
      expect(meshSlots.lowestVacancy(new Set([0, 2]), 3)).to.equal(1);
      expect(meshSlots.lowestVacancy(new Set(), 3)).to.equal(0);
      expect(meshSlots.lowestVacancy(new Set([0, 1, 2]), 3)).to.equal(null);
    });
  });

  describe('appSlotView / resolveOwnSlot', () => {
    it('keeps the own settled running assertion untouched', async () => {
      stubs.rows = [
        {
          ip: OWN_ADDR, meshSlot: 2, runningSince: '2026-08-10T09:00:00.000Z', outpoint: 'own:0',
        },
        {
          ip: PEER_ADDR, meshSlot: 0, runningSince: '2026-08-10T08:00:00.000Z', outpoint: 'peer:0',
        },
      ];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(2);
    });

    it('re-picks after losing a double-claim arbitration', async () => {
      // The peer asserted slot 0 earlier: it was never validly ours, and the
      // deterministic verdict sends this node to the next vacancy.
      stubs.rows = [
        {
          ip: OWN_ADDR, meshSlot: 0, runningSince: '2026-08-10T10:00:00.000Z', outpoint: 'own:0',
        },
        {
          ip: PEER_ADDR, meshSlot: 0, runningSince: '2026-08-10T09:00:00.000Z', outpoint: 'peer:0',
        },
      ];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(1);
    });

    it('honours the own installing claim while its slot stays vacant', async () => {
      stubs.claims = [{ ip: OWN_ADDR, meshSlot: 1, announcedAt: new Date(1) }];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(1);
    });

    it('abandons an installing claim whose slot a running member won', async () => {
      stubs.rows = [
        {
          ip: PEER_ADDR, meshSlot: 1, runningSince: '2026-08-10T09:00:00.000Z', outpoint: 'peer:0',
        },
      ];
      stubs.claims = [{ ip: OWN_ADDR, meshSlot: 1, announcedAt: new Date(1) }];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(0);
    });

    it('counts other installers\' claimed slots as occupied', async () => {
      stubs.claims = [{ ip: PEER_ADDR, meshSlot: 0, announcedAt: new Date(1) }];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(1);
    });

    it('the EARLIER claimant keeps a contested slot — no mutual deference', async () => {
      stubs.claims = [
        { ip: OWN_ADDR, meshSlot: 0, announcedAt: new Date(1) },
        { ip: PEER_ADDR, meshSlot: 0, announcedAt: new Date(2) },
      ];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(0);
    });

    it('the later claimant of a contested slot re-picks the next vacancy', async () => {
      stubs.claims = [
        { ip: OWN_ADDR, meshSlot: 0, announcedAt: new Date(2) },
        { ip: PEER_ADDR, meshSlot: 0, announcedAt: new Date(1) },
      ];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(1);
    });

    it('a claim tie breaks on the ip, and both sides reach the same verdict', async () => {
      stubs.claims = [
        { ip: OWN_ADDR, meshSlot: 0, announcedAt: new Date(5) },
        { ip: PEER_ADDR, meshSlot: 0, announcedAt: new Date(5) },
      ];
      // OWN_ADDR (203.0.113.5) sorts below PEER_ADDR (203.0.113.7): ours.
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(0);

      stubs.localAddr = PEER_ADDR;
      stubs.claims = [
        { ip: OWN_ADDR, meshSlot: 0, announcedAt: new Date(5) },
        { ip: PEER_ADDR, meshSlot: 0, announcedAt: new Date(5) },
      ];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(1);
    });

    it('claim arbitration ranks on announcedAt, falling back to broadcastedAt', async () => {
      // The peer's v1 row carries only broadcastedAt, and it is earlier than
      // this node's announce: the peer keeps the slot.
      stubs.claims = [
        { ip: OWN_ADDR, meshSlot: 0, announcedAt: new Date(10) },
        { ip: PEER_ADDR, meshSlot: 0, broadcastedAt: new Date(3) },
      ];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(1);
    });

    it('is a standby when every slot is held', async () => {
      stubs.rows = [
        {
          ip: PEER_ADDR, meshSlot: 0, runningSince: '2026-08-10T09:00:00.000Z', outpoint: 'p1:0',
        },
        {
          ip: '203.0.113.8:16127', meshSlot: 1, runningSince: '2026-08-10T09:01:00.000Z', outpoint: 'p2:0',
        },
      ];
      expect(await meshSlots.resolveOwnSlot('myblog', 2)).to.equal(null);
    });

    it('ignores slots at or beyond the instance cap', async () => {
      stubs.rows = [
        {
          ip: PEER_ADDR, meshSlot: 7, runningSince: '2026-08-10T09:00:00.000Z', outpoint: 'peer:0',
        },
      ];
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(0);
    });

    it('resolves null without an instance cap or a local address', async () => {
      expect(await meshSlots.resolveOwnSlot('myblog', 0)).to.equal(null);
      expect(await meshSlots.resolveOwnSlot('myblog', undefined)).to.equal(null);
      stubs.localAddr = null;
      expect(await meshSlots.resolveOwnSlot('myblog', 3)).to.equal(null);
    });
  });

  describe('publishClaimSlot', () => {
    it('re-broadcasts the own claim with the slot and the ORIGINAL announcedAt', async () => {
      stubs.claims = [
        { ip: OWN_ADDR, replica: null, announcedAt: new Date(1754800000000) },
        { ip: PEER_ADDR, replica: null, announcedAt: new Date(1) },
      ];
      await meshSlots.publishClaimSlot('myblog', 2);
      expect(stubs.stored).to.have.length(1);
      const message = stubs.stored[0];
      expect(message.meshSlot).to.equal(2);
      expect(message.announcedAt).to.equal(1754800000000);
      expect(message.ip).to.equal(OWN_ADDR);
      expect(message.type).to.equal('fluxappinstalling');
      expect(message.version).to.equal(2);
      expect(stubs.broadcasts).to.have.length(1);
      expect(stubs.broadcasts[0][1]).to.deep.equal({ requireCapability: 'appInstallingClaims' });
    });

    it('is a no-op when the claim already carries the slot, or without a claim', async () => {
      stubs.claims = [{ ip: OWN_ADDR, replica: null, announcedAt: new Date(1), meshSlot: 2 }];
      await meshSlots.publishClaimSlot('myblog', 2);
      stubs.claims = [];
      await meshSlots.publishClaimSlot('myblog', 2);
      expect(stubs.stored).to.have.length(0);
      expect(stubs.broadcasts).to.have.length(0);
    });
  });
});
