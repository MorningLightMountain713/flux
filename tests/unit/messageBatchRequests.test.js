'use strict';

const { EventEmitter } = require('events');
const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { appSyncEvents, EVENTS } = require('../../ZelBack/src/services/utils/appSyncEvents');

describe('messageBatchRequests', () => {
  const PEER = '198.51.100.7:16127';
  const OTHER = '198.51.100.8:16127';
  let batches;
  let peerManager;
  let store;
  let alreadyHeld;

  // The store, doubled: every message handed to it is stored unless the test
  // says its hash is already held.
  function storeDouble() {
    return sinon.stub().callsFake(async (messages) => ({
      stored: messages.filter((m) => !alreadyHeld.has(m.hash)).map((m) => ({ hash: m.hash, event: null, record: {} })),
      alreadyStored: messages.filter((m) => alreadyHeld.has(m.hash)).map((m) => m.hash),
      unpaid: [],
      refused: [],
    }));
  }

  const message = (hash) => ({
    hash, type: 'fluxappregister', version: 1, timestamp: 1, signature: 'sig', appSpecifications: { name: hash },
  });

  beforeEach(() => {
    peerManager = new EventEmitter();
    alreadyHeld = new Set();
    store = storeDouble();
    batches = proxyquire('../../ZelBack/src/services/appMessaging/messageBatchRequests', {
      '../../lib/log': { warn: sinon.stub(), info: sinon.stub(), error: sinon.stub() },
      './confirmedMessageStore': { storeConfirmedMessages: store },
      '../utils/peerState': { peerManager },
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  it('opens a request as the v3 message to send, naming its hashes and its id', () => {
    const { requestId, message: request } = batches.openRequest(PEER, ['a', 'b']);
    expect(request).to.deep.equal({
      type: 'fluxapprequest', version: 3, hashes: ['a', 'b'], requestId,
    });
  });

  it('stores what each frame carries and settles on the last frame, with what it stored and what is still unheld', async () => {
    const { requestId, done } = batches.openRequest(PEER, ['a', 'b', 'c']);
    await batches.receiveFrame({ requestId, messages: [message('a')], done: false }, PEER);
    await batches.receiveFrame({ requestId, messages: [message('b')], done: true }, PEER);

    expect(await done).to.deep.equal({
      requestId, peerKey: PEER, stored: 2, missing: ['c'], closed: false,
    });
    expect(store.getCalls().map((call) => call.args[0].map((m) => m.hash))).to.deep.equal([['a'], ['b']]);
  });

  it('hands the store every message as the peer sent it, and judges none itself', async () => {
    const { requestId, done } = batches.openRequest(PEER, ['a']);
    const sent = message('a');
    await batches.receiveFrame({ requestId, messages: [sent], done: true }, PEER);
    await done;
    expect(store.firstCall.args[0]).to.deep.equal([sent]);
  });

  it('counts a message already held as no longer unheld, and not as stored', async () => {
    alreadyHeld.add('a');
    const { requestId, done } = batches.openRequest(PEER, ['a', 'b']);
    await batches.receiveFrame({ requestId, messages: [message('a'), message('b')], done: true }, PEER);
    expect(await done).to.include({ stored: 1 });
    expect((await done).missing).to.deep.equal([]);
  });

  it('tells the hash sync each hash it stored', async () => {
    const heard = [];
    const listener = (hash) => heard.push(hash);
    appSyncEvents.on(EVENTS.HASH_RESPONSE_RECEIVED, listener);
    try {
      const { requestId } = batches.openRequest(PEER, ['a', 'b']);
      await batches.receiveFrame({ requestId, messages: [message('a'), message('b')], done: true }, PEER);
    } finally {
      appSyncEvents.removeListener(EVENTS.HASH_RESPONSE_RECEIVED, listener);
    }
    expect(heard).to.deep.equal(['a', 'b']);
  });

  it('takes from a frame only the hashes its request named', async () => {
    const { requestId, done } = batches.openRequest(PEER, ['a']);
    await batches.receiveFrame({ requestId, messages: [message('a'), message('z')], done: true }, PEER);
    await done;
    expect(store.firstCall.args[0].map((m) => m.hash)).to.deep.equal(['a']);
  });

  it('takes no frame for a request it does not hold open, nor one from another peer', async () => {
    const { requestId, done } = batches.openRequest(PEER, ['a']);
    await batches.receiveFrame({ requestId: 'never-opened', messages: [message('a')], done: true }, PEER);
    await batches.receiveFrame({ requestId, messages: [message('a')], done: true }, OTHER);
    sinon.assert.notCalled(store);

    await batches.receiveFrame({ requestId, messages: [], done: true }, PEER);
    expect((await done).missing).to.deep.equal(['a']);
    await batches.receiveFrame({ requestId, messages: [message('a')], done: true }, PEER);
    sinon.assert.notCalled(store);
  });

  it('settles a request as closed when its peer\'s connection closes, and leaves other peers\' open', async () => {
    const mine = batches.openRequest(PEER, ['a', 'b']);
    const theirs = batches.openRequest(OTHER, ['c']);
    await batches.receiveFrame({ requestId: mine.requestId, messages: [message('a')], done: false }, PEER);
    const [ip, port] = PEER.split(':');
    peerManager.emit('peer:removed', { ip, port });

    expect(await mine.done).to.include({ stored: 1, closed: true });
    expect((await mine.done).missing).to.deep.equal(['b']);
    await batches.receiveFrame({ requestId: theirs.requestId, messages: [message('c')], done: true }, OTHER);
    expect(await theirs.done).to.include({ stored: 1, closed: false });
  });

  it('settles a request as closed when no frame arrives within FRAME_WAIT_MS of the last', async () => {
    const clock = sinon.useFakeTimers();
    const { requestId, done } = batches.openRequest(PEER, ['a', 'b']);
    let settled = null;
    done.then((outcome) => { settled = outcome; });

    await clock.tickAsync(batches.FRAME_WAIT_MS - 1);
    await batches.receiveFrame({ requestId, messages: [message('a')], done: false }, PEER);
    await clock.tickAsync(batches.FRAME_WAIT_MS - 1);
    expect(settled).to.equal(null);

    await clock.tickAsync(1);
    expect(settled).to.include({ stored: 1, closed: true });
    expect(settled.missing).to.deep.equal(['b']);
  });

  it('refuses to open a request naming more than MAX_REQUEST_HASHES', () => {
    const tooMany = Array.from({ length: batches.MAX_REQUEST_HASHES + 1 }, (_, i) => `h${i}`);
    expect(() => batches.openRequest(PEER, tooMany)).to.throw(/at most/);
  });
});
