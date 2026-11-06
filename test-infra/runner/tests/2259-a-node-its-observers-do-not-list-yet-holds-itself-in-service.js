// fleet: 3
import {
  describe, it, before, after,
} from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { hideNodeFromPeers, revealNodeToPeers } from '../framework/daemon-control.js';
import { waitFor } from '../framework/wait.js';
import { dumpLogsOnFailure } from '../framework/log-on-failure.js';

// A node asks its peers whether they can reach it. A peer whose node list does
// not hold the node's address - an address change it has not yet seen confirmed -
// has not looked, and says so: "not listed", not "not available". The node takes
// that as no answer: it holds no reachability verdict against itself, and asks
// again on its next pass.

const SUBJECT = 1;
const OBSERVER = 2;
const API_PORT = 16127;
const NOT_LISTED = 'Asking Flux is not listed';
const REACHABILITY_MESSAGES = [
  'Flux communication is limited, other nodes on the network cannot reach yours through API calls',
  'Flux is not available for outside communication',
];

describe('a node its observers do not list yet holds itself in service', function () {
  let env;
  dumpLogsOnFailure(() => env);
  const client = (i) => env.clients[i];

  before(async function () {
    this.timeout(600000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      configOverrides: { fluxapps: { minOutgoing: 1, minIncoming: 1 } },
      // A node of three can end with no outbound peer or no inbound one, and what
      // the availability check counts for that is not this case's subject.
      nodeConfigOverrides: {
        [SUBJECT]: {
          fluxapps: {
            minOutgoing: 0, minIncoming: 0, minUniqueIpsOutgoing: 0, minUniqueIpsIncoming: 0,
          },
        },
      },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1 });
    await client(SUBJECT).waitForEvent('availability:checked', (d) => d.available === true, 240000);
    await hideNodeFromPeers(client(SUBJECT).ip);
  });

  after(async function () {
    this.timeout(60000);
    if (env) await revealNodeToPeers(client(SUBJECT).ip).catch(() => {});
    await env?.teardown();
  });

  it('is answered "not listed" by a peer that does not list it', async function () {
    this.timeout(60000);
    // The observer's list changes on its next refresh; every answer until then is
    // that the node is available.
    const answers = [];
    await waitFor(async () => {
      const url = `${client(OBSERVER).url}/flux/checkfluxavailability?ip=${client(SUBJECT).ip}&port=${API_PORT}&_=${Date.now()}`;
      answers.push(await (await fetch(url)).json());
      return answers.at(-1).status === 'error';
    }, { timeout: 50000, interval: 2000, label: 'the observer no longer lists the node' });

    expect(answers.at(-1).data.message).to.equal(NOT_LISTED);
  });

  it('holds no reachability verdict against itself on the passes that ask', async function () {
    this.timeout(300000);
    const node = client(SUBJECT);
    let anchor = node.getLastEventId();
    // eslint-disable-next-line no-restricted-syntax
    for (const pass of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const checked = await node.waitForEvent('availability:checked', () => true, 180000, { afterId: anchor });
      anchor = checked.id;
      expect(checked.data.available, `pass ${pass} reached a verdict`).to.equal(false);
      expect(REACHABILITY_MESSAGES, `pass ${pass}'s dos message`).to.not.include(checked.data.dosMessage);
      expect(checked.data.dosState, `pass ${pass}'s dos state`).to.be.at.most(10);
    }
    const dos = (await node.getDOSState()).data;
    expect(REACHABILITY_MESSAGES).to.not.include(dos.dosMessage);
    expect(dos.dosState).to.be.at.most(10);
  });
});
