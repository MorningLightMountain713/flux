'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

// Stored app messages include every refused one, so a reader that treats them
// as an app's history reads refusals as if they had happened. An app's history
// is read through appDecisions/appHistory. These are the only modules that
// touch the stored messages themselves, each for the reason given.
const ALLOWED = {
  'services/appDecisions/appHistory.js': 'the applied-messages accessor',
  'services/appDecisions/decider.js': 'decides every stored message',
  'services/appDatabase/appRegistry.js': 'projects an applied decision\'s message into its row',
  'services/appMessaging/confirmedMessageStore.js': 'the one store',
  'services/appMessaging/appHashSyncService.js': 'which paid hashes this node holds',
  'services/appDatabase/registryManager.js': 'the payment-record audit: which paid hashes this node holds',
  'services/appMessaging/messageVerifier.js': '/apps/permanentmessages serves stored messages as they are',
  'services/appQuery/appQueryService.js': 'the per-owner message count counts every stored message',
  'services/appDatabase/appsRepository.js': 'a message by hash; ingress attestations by app; v7 secrets ever published',
  'services/appDatabase/appsMaintenance.js': 'repairs stored values',
  'services/chainState.js': 'a rescan deletes the messages above its height',
  'services/explorerService.js': 'a reindex drops the collection',
  'services/serviceManager.js': 'prepares the collection\'s indexes',
  'services/utils/appConstants.js': 'names the collection',
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
      .filter(({ text }) => /globalAppsMessages|collections\.appsMessages/.test(text))
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
