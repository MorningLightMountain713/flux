'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

// Presence is ASSIGNMENT, not liveness. The running-apps message states what this
// node is assigned to run; assignment does not change when a container stops, dies
// or is rebuilt, so it is read from the installed set and never from docker.
//
// This was previously guarded by a proxyquire entry stubbing dockerService as null,
// which would indeed have broken the moment peerNotification required it. But a
// stub for a module nothing requires reads as stale to
// tests/tools/stale-proxyquire-stubs.js, and a permanent false positive there
// teaches people to skim that tool's output. A source guard says the same thing
// where it can be read, and fails with the reason attached.
//
// If presence legitimately starts depending on run state, this file is the
// conscious edit that records the decision.
const MODULE = path.join(
  __dirname, '..', '..', 'ZelBack', 'src', 'services', 'appMessaging', 'peerNotification.js',
);

const FORBIDDEN = [
  ['../dockerService', 'docker is liveness; presence is assignment'],
  ['../appQuery/appQueryService', 'listRunningApps is liveness; presence is assignment'],
];

describe('peerNotification presence guard', () => {
  const source = fs.readFileSync(MODULE, 'utf8');

  FORBIDDEN.forEach(([dependency, why]) => {
    it(`does not reach for ${dependency} — ${why}`, () => {
      const pattern = new RegExp(`require\\(\\s*['"]${dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`);
      expect(
        pattern.test(source),
        `peerNotification.js requires ${dependency}. An app the node is assigned must be `
        + 'announced whether or not its container happens to be up — see the comment above '
        + 'listInstalledIdentities. Route the read through appsRepository, or change this '
        + 'guard on purpose.',
      ).to.equal(false);
    });
  });

  it('reads presence from the installed set', () => {
    expect(source).to.match(/appsRepository\.listInstalledIdentities\(/);
  });
});
