'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');
const { nodeChain } = require('../../ZelBack/src/services/utils/nodeChain');
const specLibrary = require('../../ZelBack/src/services/utils/specLibrary');
const daemonStatus = require('../../ZelBack/src/services/daemonService/daemonStatus');
const daemonServiceBlockchainRpcs = require('../../ZelBack/src/services/daemonService/daemonServiceBlockchainRpcs');
const serviceHelper = require('../../ZelBack/src/services/serviceHelper');
const log = require('../../ZelBack/src/lib/log');

describe('the chain this node runs on', () => {
  afterEach(() => sinon.restore());

  it('is the library\'s chain named by daemon.chain', () => {
    expect(nodeChain()).to.equal(specLibrary.loaded().Chain.MAIN);
  });

  describe('boot refuses a daemon on another chain', () => {
    it('accepts a daemon running the configured chain', () => {
      expect(daemonStatus.daemonChainMismatch({ blocks: 5, chain: 'main' })).to.equal(null);
    });

    for (const other of ['labnet', 'test', 'regtest']) {
      it(`refuses a daemon running "${other}", naming both chains`, () => {
        const mismatch = daemonStatus.daemonChainMismatch({ blocks: 5, chain: other });
        expect(mismatch).to.include(`"${other}"`).and.include('"main"').and.include('daemon.chain');
      });
    }

    it('reads the daemon\'s chain from the answer that tells it the daemon is up', async () => {
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlockchainInfo').resolves({ value: { blocks: 3_000_000, chain: 'labnet', headers: 3_000_000 } });
      expect(await daemonStatus.waitForDaemonRpc()).to.deep.equal({ blocks: 3_000_000, chain: 'labnet' });
    });

    it('waits through a daemon still warming up, and says why', async () => {
      sinon.stub(daemonServiceBlockchainRpcs, 'getBlockchainInfo')
        .onFirstCall().resolves({ value: null, reason: { code: -28, message: 'Loading block index...' } })
        .onSecondCall().resolves({ value: { blocks: 5, chain: 'main' } });
      sinon.stub(serviceHelper, 'delay').resolves();
      const info = sinon.stub(log, 'info');

      expect(await daemonStatus.waitForDaemonRpc()).to.deep.equal({ blocks: 5, chain: 'main' });
      sinon.assert.calledWith(info, 'Waiting for daemon RPC... (Loading block index...)');
    });
  });
});

// Every v1-v8 spec FluxOS builds from a document is read on the node's chain.
// The library refuses a missing chain, but FluxOS's read paths turn a refusal
// into an unreadable record and carry on, so a forgotten chain would not fail
// loudly: this scan does.
describe('every call FluxOS and its harness make to a door that builds a legacy spec passes a chain', () => {
  const ROOT = path.join(__dirname, '../..');
  const SOURCES = [path.join(ROOT, 'ZelBack/src'), path.join(ROOT, 'test-infra/runner/framework')];
  const DOORS = new RegExp(`\\b(${[
    'deserializeSpec', 'parseSubmission', 'RegisteredSpec\\.deserialize', 'HostedInstance\\.deserialize',
    'AppEventLegacy\\.deserialize', 'SealedSpecV8\\.(?:deserialize|fromSubmission)',
    'VersionClass\\.(?:deserialize|fromSubmission)', 'FluxAppSpecV[1-8]\\.(?:deserialize|fromSubmission)',
    'new AppRegistry', 'new HostedInstances',
  ].join('|')})\\(`, 'g');
  // FluxOS's own wrapper of the library door, which passes the node's chain
  // inside: its definition and its one call are not calls to the library.
  const OWN = { 'services/utils/specCutover.js': ['deserializeSpec'] };

  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

  const argumentsOf = (source, open) => {
    let depth = 1;
    let at = open;
    while (depth > 0 && at < source.length) {
      if ('([{'.includes(source[at])) depth += 1;
      if (')]}'.includes(source[at])) depth -= 1;
      at += 1;
    }
    return source.slice(open, at - 1);
  };

  const calls = () => SOURCES.flatMap(files).flatMap((file) => {
    const relative = path.relative(path.join(ROOT, 'ZelBack/src'), file);
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(DOORS)]
      .filter((match) => !(OWN[relative] ?? []).includes(match[1]))
      .filter((match) => !/function\s*$/.test(source.slice(Math.max(0, match.index - 15), match.index)))
      .map((match) => ({
        where: `${relative}:${source.slice(0, match.index).split('\n').length}`,
        args: argumentsOf(source, match.index + match[0].length),
      }));
  });

  it('finds the calls to check, so a broken scan cannot pass quietly', () => {
    expect(calls().length).to.be.at.least(12);
  });

  it('names the chain in each one', () => {
    const missing = calls().filter((call) => !/\bchain\b/.test(call.args)).map((call) => call.where);
    expect(missing, `no chain at ${missing.join(', ')}`).to.deep.equal([]);
  });
});
