'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const appHistory = require('../../ZelBack/src/services/appDecisions/appHistory');
const manifestStanding = require('../../ZelBack/src/services/appLifecycle/manifestStanding');
const contentSlotService = require('../../ZelBack/src/services/appLifecycle/contentSlotService');
const messageStore = require('../../ZelBack/src/services/appMessaging/messageStore');
const appSubmission = require('../../ZelBack/src/services/appRequirements/appSubmission');
const { loadSpecLibrary, v9Spec, V9_SUBMISSION } = require('./fixtures/fluxSpec');

// The submission door refuses an update that does not name what it stands on
// by flux-spec's rule: the manifest of a slot app and each standing generation
// record, named exactly when the owner the spec names did not sign it in that
// owner's ownership. A sale names everything that stands.
describe('appSubmission: an update names what it stands on', () => {
  const SELLER = V9_SUBMISSION.owner;
  const BUYER = '196GJWyLxzAw3MirTT7Bqs2iGpUQio29GH';
  const IDENTITY = `b${'a'.repeat(52)}`;
  const STANDING_HASH = `sha256:${'c'.repeat(64)}`;
  const MASTER = `sha256:${'d'.repeat(64)}`;
  const SLOT_MOUNTS = {
    '/etc/app.conf': {
      source: 'app.conf', destination: '/etc/app.conf', type: 'file', contentSlot: 'app-config', onUpdate: { action: 'signal', signal: 'SIGHUP' },
    },
  };
  const APP = { name: 'myapp', identity: IDENTITY, owner: SELLER };
  const CARRIED_PLAIN = {
    appName: 'myapp', identity: IDENTITY, version: 3, ownedFrom: 500, timestamp: 1_700_000_000_000, slots: { 'app-config': { hash: 'e'.repeat(64) } }, ownerSignature: 'sig',
  };
  const CARRIED = { ...CARRIED_PLAIN, slots: { sealed: { ciphertext: 'x' } } };
  let flux;
  let standingRow;
  let records;

  before(async function loadLibrary() {
    this.timeout(30_000);
    flux = await loadSpecLibrary();
  });

  const slotSpec = (overrides = {}) => v9Spec({
    components: {
      web: {
        ...V9_SUBMISSION.components.web,
        persistentStorage: { sizeGb: 1, mounts: SLOT_MOUNTS },
      },
    },
    ...overrides,
  }, { encrypted: true });

  beforeEach(() => {
    standingRow = {
      hash: STANDING_HASH, signer: SELLER, ownedFrom: 500, manifest: { sealed: 'standing' },
    };
    records = {};
    sinon.stub(appHistory, 'ownerships').resolves([{ owner: SELLER, from: 500 }]);
    sinon.stub(manifestStanding, 'standingManifest').callsFake(async () => ({ app: APP, row: standingRow, aside: false, rows: [] }));
    sinon.stub(contentSlotService, 'refreshManifests').resolves();
    sinon.stub(contentSlotService, 'openManifestSlots').callsFake(async (manifest) => (
      manifest === CARRIED ? CARRIED_PLAIN : { slots: { 'app-config': { hash: 'f'.repeat(64) } } }
    ));
    sinon.stub(messageStore, 'standingGeneration').callsFake(async (identity, role) => ({ record: records[role] ?? null, aside: false, ownership: null }));
  });

  afterEach(() => {
    sinon.restore();
  });

  const refusalOf = async (spec, options) => {
    try {
      await appSubmission.assertNamesWhatStands(spec, APP, options);
    } catch (error) {
      return error.message;
    }
    return null;
  };

  it('a sale of a slot app naming no manifest is refused', async () => {
    expect(await refusalOf(await slotSpec({ owner: BUYER }))).to.match(/content must name the manifest the update stands on, sha256:c{64}/);
  });

  it('a sale naming the standing manifest stands', async () => {
    expect(await refusalOf(await slotSpec({ owner: BUYER, content: { manifest: STANDING_HASH } }))).to.equal(null);
  });

  it('the owner\'s own update of a manifest they signed in this ownership names nothing', async () => {
    expect(await refusalOf(await slotSpec())).to.equal(null);
  });

  it('a sale carrying a manifest stands on the carried one: naming the standing one is refused', async () => {
    const carriedHash = flux.contentManifestHash(CARRIED_PLAIN);
    expect(await refusalOf(await slotSpec({ owner: BUYER, content: { manifest: STANDING_HASH } }), { carriedManifest: CARRIED }))
      .to.match(/not the manifest the update stands on/);
    expect(await refusalOf(await slotSpec({ owner: BUYER, content: { manifest: carriedHash } }), { carriedManifest: CARRIED })).to.equal(null);
  });

  it('the owner\'s own update carrying a manifest they signed in this ownership names nothing', async () => {
    expect(await refusalOf(await slotSpec(), { carriedManifest: CARRIED })).to.equal(null);
  });

  it('with no manifest standing the node asks its peers and FluxDrive, then judges what it holds', async () => {
    const found = standingRow;
    standingRow = null;
    contentSlotService.refreshManifests.callsFake(async () => { standingRow = found; });
    expect(await refusalOf(await slotSpec({ owner: BUYER, content: { manifest: STANDING_HASH } }))).to.equal(null);
    sinon.assert.calledWith(contentSlotService.refreshManifests, 'myapp', IDENTITY);
  });

  it('a slot app with no manifest to be had is refused', async () => {
    standingRow = null;
    expect(await refusalOf(await slotSpec())).to.match(/no manifest stands/);
  });

  it('a manifest short of a declared slot is refused', async () => {
    contentSlotService.openManifestSlots.resolves({ slots: { other: { hash: 'f'.repeat(64) } } });
    expect(await refusalOf(await slotSpec())).to.match(/does not cover slot app-config/);
  });

  it('a sale naming no standing master record is refused; naming it stands', async () => {
    records.master = { hash: MASTER, signer: SELLER, data: { ownedFrom: 500 } };
    expect(await refusalOf(await v9Spec({ owner: BUYER }))).to.match(/grants must name the standing master record/);
    expect(await refusalOf(await v9Spec({ owner: BUYER, grants: { master: MASTER } }))).to.equal(null);
  });

  it('a record the owner signed in this ownership is not named by their own update', async () => {
    records.master = { hash: MASTER, signer: SELLER, data: { ownedFrom: 500 } };
    expect(await refusalOf(await v9Spec())).to.equal(null);
  });

  it('an app declaring no slots reads no manifest', async () => {
    expect(await refusalOf(await v9Spec({ owner: BUYER }))).to.equal(null);
    sinon.assert.notCalled(manifestStanding.standingManifest);
  });
});
