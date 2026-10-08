'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

// Stored app messages include every refused one, so a reader that treats them
// as an app's history reads refusals as if they had happened. An app's history
// is read through appDecisions/appHistory. These are the only modules that
// touch the app messages collection, each for the reason given.
const ALLOWED = {
  'services/appDatabase/appRecords.js': 'names the collection',
  'services/appDecisions/appHistory.js': 'the applied-messages accessor',
  'services/appDecisions/decider.js': 'decides every stored message',
  'services/appDecisions/unclaimedPayments.js': 'voids a payment whose contents never appeared',
  'services/appDatabase/appRegistry.js': 'projects an applied decision\'s message into its row',
  'services/appMessaging/confirmedMessageStore.js': 'stores a paid hash\'s contents',
  'services/appMessaging/messageStore.js': 'stores a received message\'s contents',
  'services/appMessaging/appHashSyncService.js': 'which paid hashes this node holds',
  'services/appMessaging/temporaryPoolSweep.js': 'the pool\'s payment windows',
  'services/appDatabase/registryManager.js': 'serves the hash index and checks a name against the payments',
  'services/appMessaging/messageVerifier.js': '/apps/permanentmessages serves stored messages as they are',
  'services/appQuery/appQueryService.js': 'the per-owner message count counts every stored message',
  'services/appDatabase/appsRepository.js': 'a message by hash; ingress attestations by app; v7 secrets ever published',
  'services/fluxCommunicationMessagesSender.js': 'serves the pool to a syncing peer',
  'services/chainState.js': 'a rewind takes the payments above its height',
  'services/explorerService.js': 'records the chain\'s payments; a reindex takes them all off',
  'services/migrations/appMessages.js': 'folds the old collections in',
  'services/migrations/paymentPositions.js': 'records a payment\'s chain position',
  'services/serviceManager.js': 'prepares the collection\'s indexes',
};

// listAppMessagesByName reads every stored message for a name, refused ones
// included: the repository's own ingress-attestation listing is its one use.
const BY_NAME_ALLOWED = ['services/appDatabase/appsRepository.js'];

const SRC = path.join(__dirname, '../../ZelBack/src');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('readers of stored app messages', () => {
  const files = sourceFiles(SRC).map((file) => ({
    file: path.relative(SRC, file),
    text: fs.readFileSync(file, 'utf8'),
  }));

  it('touch the stored messages only in the modules listed, and every listed module does', () => {
    const touching = files
      .filter(({ text }) => /appRecords\.messages\(\)|collections\.appMessages/.test(text))
      .map(({ file }) => file)
      .sort();
    expect(touching).to.deep.equal(Object.keys(ALLOWED).sort());
  });

  it('read a name\'s stored messages only where refusals belong in the answer', () => {
    const byName = files
      .filter(({ text }) => /listAppMessagesByName\(/.test(text))
      .map(({ file }) => file);
    expect(byName).to.deep.equal(BY_NAME_ALLOWED);
  });
});
