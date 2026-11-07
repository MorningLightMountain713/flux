'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

const { instanceKey } = require('../../ZelBack/src/services/appDatabase/appRecords');

const ME = '203.0.113.40:16127';
const resources = (name, replica, placedAt = null) => ({ name, replica, placedAt });

describe('placementDates', () => {
  let held;
  let setPlacedAt;
  let appLocationFromEvents;
  let waitForLocalSocketAddress;
  let publish;
  let placementDates;

  beforeEach(() => {
    held = [];
    setPlacedAt = sinon.stub().resolves();
    appLocationFromEvents = sinon.stub().resolves([]);
    waitForLocalSocketAddress = sinon.stub().resolves(ME);
    publish = sinon.stub();
    placementDates = proxyquire('../../ZelBack/src/services/appLifecycle/placementDates', {
      '../appDatabase/appRecords': {
        instanceKey,
        instanceResources: () => ({
          byInstance: async (name, replica) => held.find((r) => r.name.toLowerCase() === name.toLowerCase() && r.replica === replica) ?? null,
          all: async () => held,
          setPlacedAt,
        }),
      },
      '../appDatabase/appsRepository': { appLocationFromEvents },
      '../fluxNetworkHelper': { waitForLocalSocketAddress },
      '../utils/fluxEventBus': { publish },
      '../../lib/log': { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    });
  });

  describe('announcedSince', () => {
    it('is the date the instance\'s resources hold, whatever this node last announced', async () => {
      held.push(resources('web', null, new Date('2026-01-01T00:00:00Z')));
      appLocationFromEvents.resolves([{ name: 'web', replica: null, runningSince: '2026-10-01T00:00:00.000Z' }]);

      expect(await placementDates.announcedSince('web', null, ME)).to.equal('2026-01-01T00:00:00.000Z');
      sinon.assert.notCalled(appLocationFromEvents);
    });

    it('is what this node last announced for that instance when its resources hold no date', async () => {
      held.push(resources('web', 'r1'), resources('web', 'r2'));
      appLocationFromEvents.resolves([
        { name: 'Web', replica: 'r2', runningSince: '2026-02-02T00:00:00.000Z' },
        { name: 'web', replica: 'r1', runningSince: '2026-01-01T00:00:00.000Z' },
      ]);

      expect(await placementDates.announcedSince('web', 'r1', ME)).to.equal('2026-01-01T00:00:00.000Z');
      sinon.assert.calledWithExactly(appLocationFromEvents, { ip: ME });
    });

    it('is now for an instance neither dated nor announced', async () => {
      held.push(resources('web', null));
      const before = Date.now();

      const since = new Date(await placementDates.announcedSince('web', null, ME)).getTime();

      expect(since).to.be.at.least(before);
    });
  });

  describe('dateUndatedPlacements', () => {
    it('dates each undated instance at what this node last announced for it, or now, and leaves a date already held', async () => {
      held.push(
        resources('web', null),
        resources('db', 'r1'),
        resources('cache', null, new Date('2026-01-01T00:00:00Z')),
      );
      appLocationFromEvents.resolves([
        { name: 'web', replica: null, runningSince: '2026-03-03T00:00:00.000Z' },
        { name: 'cache', replica: null, runningSince: '2026-09-09T00:00:00.000Z' },
      ]);
      const before = Date.now();

      const result = await placementDates.dateUndatedPlacements();

      expect(result).to.deep.equal({ dated: 2, fromAnnouncements: 1 });
      sinon.assert.calledTwice(setPlacedAt);
      const [web, db] = setPlacedAt.getCalls().map((call) => call.args);
      expect([web[0], web[1], web[2].toISOString()]).to.deep.equal(['web', null, '2026-03-03T00:00:00.000Z']);
      expect([db[0], db[1]]).to.deep.equal(['db', 'r1']);
      expect(db[2].getTime()).to.be.at.least(before);
      sinon.assert.calledWithMatch(publish, 'app:placementRecorded', { name: 'web', source: 'announcement', placedAt: '2026-03-03T00:00:00.000Z' });
      sinon.assert.calledWithMatch(publish, 'app:placementRecorded', { name: 'db', replica: 'r1', source: 'now' });
      sinon.assert.calledWithExactly(publish, 'app:placementsDated', { dated: 2, fromAnnouncements: 1 });
    });

    it('reads this node\'s announcements only once it has its address', async () => {
      held.push(resources('web', null));
      let giveAddress;
      waitForLocalSocketAddress.returns(new Promise((resolve) => { giveAddress = resolve; }));

      const dating = placementDates.dateUndatedPlacements();
      await new Promise((resolve) => { setImmediate(resolve); });
      sinon.assert.notCalled(appLocationFromEvents);
      sinon.assert.notCalled(setPlacedAt);

      giveAddress(ME);
      await dating;
      sinon.assert.calledOnceWithExactly(appLocationFromEvents, { ip: ME });
      sinon.assert.calledOnce(setPlacedAt);
    });

    it('reads no announcement when every instance is dated', async () => {
      held.push(resources('web', null, new Date('2026-01-01T00:00:00Z')));

      expect(await placementDates.dateUndatedPlacements()).to.deep.equal({ dated: 0, fromAnnouncements: 0 });
      sinon.assert.notCalled(appLocationFromEvents);
      sinon.assert.notCalled(setPlacedAt);
    });
  });
});
