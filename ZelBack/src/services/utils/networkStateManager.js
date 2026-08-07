const { EventEmitter } = require('node:events');
const config = require('config');
const { FluxController } = require('./fluxController');
const { normalizeSocketAddress } = require('./socketAddressUtils');

const log = require('../../lib/log');

/**
 * The Fluxnode as returned by fluxd
 * @typedef {{
 *   collateral: string,
 *   txhash: string,
 *   outidx: number,
 *   ip: string,
 *   network: string,
 *   added_height: number,
 *   confirmed_height: number,
 *   last_confirmed_height: number,
 *   last_paid_height: number,
 *   tier: string,
 *   payment_address: string,
 *   pubkey: string,
 *   activesince: string,
 *   lastpaid: string,
 *   amount: string,
 *   rank: number
 * }} Fluxnode
 */

class NetworkStateManager extends EventEmitter {
  // Nodelist fetch throttle: block-driven refresh requests inside this window
  // serve the cached list. Config-backed so the harness can run a fast poll;
  // everything reacting to nodelist changes (confirmation, capability) inherits
  // this cadence as its detection latency.
  static #minFetchIntervalMs = config.fluxapps.networkStateMinFetchIntervalMs ?? 30_000;

  /**
   * @type {Array<Fluxnode>}
   */
  #state = [];

  #pubkeyIndex = new Map();

  #socketAddressIndex = new Map();

  // Keyed `txhash:outidx`. A delta identifies nodes by outpoint, so without this an
  // apply would be a linear scan of ~13k entries per changed node.
  #outpointIndex = new Map();

  /**
   * The transition this state was last brought to, as {height, hash}. Deltas chain by
   * hash, so this is what the next delta's `fromHash` must match. Null until a
   * snapshot anchors it.
   * @type {{height: number, hash: string} | null}
   */
  #chainAnchor = null;

  #controller = new FluxController();

  #started = false;

  #fetchQueued = false;

  #lastFetchTime = BigInt(0);

  /**
   * @type {() => Promise | null}
   */
  #onStartComplete = null;

  /**
   * @type {Promise<void>}
   */
  waitStarted = new Promise((resolve) => {
    if (this.#onStartComplete) {
      resolve();
      return;
    }

    this.#onStartComplete = () => {
      resolve();
      this.#onStartComplete = () => Promise.resolve();
    };
  });

  /**
   * @type { "polling" | "subscription" }
   */
  #updateTrigger = 'subscription';

  /**
   * @type {()=>Promise<Array<Fluxnode>>}
   */
  #stateFetcher;

  /**
   * @type {EventEmitter | nulll}
   */
  #stateEmitter = null;

  /**
   * @type {()=>Promise<void> | null}
   */
  #boundEventHandler = null;

  /**
   * Until we get onto NodeJS > 17.0.0 - we need this. I.e. we have no
   * structured clone
   */
  static deepClone(target) {
    function replacer(_key, value) {
      if (value instanceof Map) {
        return {
          dataType: 'Map',
          payload: Array.from(value.entries()),
        };
      }
      return value;
    }
    function reviver(_key, value) {
      if (typeof value === 'object' && value !== null) {
        if (value.dataType === 'Map') {
          return new Map(value.payload);
        }
      }
      return value;
    }

    const asString = JSON.stringify(target, replacer);
    const clone = JSON.parse(asString, reviver);

    return clone;
  }

  /**
   *
   * @param {()=>Promise<Array<Fluxnode>>} stateFetcher
   * @param {{intervalMs?: number}} options
   */
  constructor(stateFetcher, options = {}) {
    super();

    if (!stateFetcher || typeof stateFetcher !== 'function') {
      throw new Error('State fetcher function is mandatory');
    }

    this.#stateFetcher = stateFetcher;
    this.intervalMs = options.intervalMs || 120_000;
    this.stateEvent = options.stateEvent || null;
    this.progressEvent = options.progressEvent || null;
    this.#stateEmitter = options.stateEmitter || null;

    if (this.#stateEmitter && !this.stateEvent) {
      throw new Error('The State Event is mandatory when state emitter is used');
    }

    this.#controller.addLock('fetcher');
  }

  get lastFetchElapsedMs() {
    const now = process.hrtime.bigint();

    const elapsedMs = Number(now - this.#lastFetchTime) / 1_000_000;

    return elapsedMs;
  }

  get canFetch() {
    const canFetch = this.lastFetchElapsedMs > NetworkStateManager.#minFetchIntervalMs;

    return canFetch;
  }

  get remainingFetchSeconds() {
    const remainingSec = (NetworkStateManager.#minFetchIntervalMs - this.lastFetchElapsedMs)
      / 1_000;

    const rounded = Math.round((remainingSec + Number.EPSILON) * 100) / 100;

    return rounded;
  }

  get updateTrigger() {
    return this.#updateTrigger;
  }

  get indexesReady() {
    return !this.#controller.lock.locked;
  }

  get waitIndexesReady() {
    return this.#controller.lock.waitReady();
  }

  get nodeCount() {
    return this.#state.length;
  }

  get started() {
    return this.#started;
  }

  get fetchRunning() {
    const fetchLock = this.#controller.getLock('fetcher');

    return fetchLock.locked;
  }

  get fetchQueued() {
    return this.#fetchQueued;
  }

  get waitFetchComplete() {
    const fetchLock = this.#controller.getLock('fetcher');

    return fetchLock.waitReady({ waitAll: true });
  }

  /**
   * Index map. Has to be a getter and not a field, as the field doesn't update
   * the reference.
   */
  get #indexes() {
    return {
      pubkey: this.#pubkeyIndex,
      socketAddress: this.#socketAddressIndex,
    };
  }

  #setIndexes(pubkeyIndex, socketAddressIndex, outpointIndex) {
    this.#pubkeyIndex = pubkeyIndex;
    this.#socketAddressIndex = socketAddressIndex;
    this.#outpointIndex = outpointIndex;
  }

  /**
   * The key a delta identifies a node by.
   * @param {{txhash: string, outidx: number|string}} node Node or outpoint.
   * @returns {string} Outpoint key.
   */
  static outpointKey(node) {
    return `${node.txhash}:${node.outidx}`;
  }

  #indexNode(node) {
    const nodesByPubkey = this.#pubkeyIndex.get(node.pubkey)
      || this.#pubkeyIndex.set(node.pubkey, new Map()).get(node.pubkey);

    nodesByPubkey.set(node.ip, node);
    this.#socketAddressIndex.set(normalizeSocketAddress(node.ip), node);
    this.#outpointIndex.set(NetworkStateManager.outpointKey(node), node);
  }

  #deindexNode(node) {
    const nodesByPubkey = this.#pubkeyIndex.get(node.pubkey);
    if (nodesByPubkey) {
      nodesByPubkey.delete(node.ip);
      if (!nodesByPubkey.size) this.#pubkeyIndex.delete(node.pubkey);
    }

    const socketAddress = normalizeSocketAddress(node.ip);
    // Only clear the entry if it still points at this node; an ip that has moved to
    // another node must not have the new owner's entry deleted underneath it.
    if (this.#socketAddressIndex.get(socketAddress) === node) {
      this.#socketAddressIndex.delete(socketAddress);
    }

    this.#outpointIndex.delete(NetworkStateManager.outpointKey(node));
  }

  async #buildIndexes(nodes) {
    // if we are building an index already, just wait for it to finish.
    // maybe look at cancelling it in future.
    const release = await this.#controller.lock.acquire({ label: 'networkState:buildIndexes' });

    const nodeCount = nodes.length;

    const pubkeyIndex = new Map();
    const socketAddressIndex = new Map();
    const outpointIndex = new Map();

    function iterIndexes(startIndex, callback) {
      const endIndex = startIndex + 1000;
      const chunk = nodes.slice(startIndex, endIndex);

      chunk.forEach((node) => {
        const nodesByPubkey = pubkeyIndex.get(node.pubkey)
          || pubkeyIndex.set(node.pubkey, new Map()).get(node.pubkey);

        nodesByPubkey.set(node.ip, node);
        // Canonicalise the socketAddress key: the daemon list may carry a
        // default-port node as either "ip" or "ip:16127". normalizeSocketAddress
        // appends the default port only to a bare ip; explicit (UPnP) ports pass
        // through unchanged. Lookups normalize the same way, so both forms resolve.
        socketAddressIndex.set(normalizeSocketAddress(node.ip), node);
        outpointIndex.set(NetworkStateManager.outpointKey(node), node);
      });

      if (endIndex >= nodeCount) {
        callback();
        return;
      }

      setImmediate(iterIndexes.bind(this, endIndex, callback));
    }

    // Yield to the event queue here, this way we are only ever doing O(1000),
    // instead of O(n). With around 13k nodes, this was taking on average 8ms.
    // I.e. the event queue was blocked for 8ms. Now we yield. I was using a
    // worker here, but overkill for what we are doing.

    return new Promise((resolve) => {
      iterIndexes(0, () => {
        this.#setIndexes(pubkeyIndex, socketAddressIndex, outpointIndex);
        release();
        resolve();
      });
    });
  }

  /**
   * Gets a random node from the network state. Ensures that the connection is
   * not to this node. When we build the indexes, we could also store the node
   * keys in an array, however, that is another array we have to keep in memory.
   * It may pay to do that though, as this is O(n), vs O(1) for array index. CPU
   * tradeoff for memory is probably good though.
   * @param {string} localSocketAddress The ip:port of this node
   * @returns {Promise<string | null>} A random socketAddress from the map
   */
  async getRandomSocketAddress(localSocketAddress) {
    await this.waitIndexesReady;

    const indexSize = this.#socketAddressIndex.size;

    if (!indexSize) return null;

    let stepsRemaining = Math.floor(Math.random() * indexSize);
    const iterator = this.#socketAddressIndex.values();

    let previous = null;

    // eslint-disable-next-line no-restricted-syntax
    for (const node of iterator) {
      const { ip: socketAddress } = node;

      if (!stepsRemaining) {
        const match = localSocketAddress === socketAddress;
        // if we've been unlucky (or lucky however you look at it) enough to hit
        // this node, we just take the value before, or if it's the initial index,
        // the next value from the iterator
        if (match) return previous || iterator.next().value.ip;
        return socketAddress;
      }

      previous = socketAddress;
      stepsRemaining -= 1;
    }

    // this should never happen, should probably log it
    return this.socketAddressIndex.values().next().value.ip;
  }

  /**
   * Returns up to `count` random socket addresses from the network state.
   *   options.excludeSocketAddress - never return this address, nor any address that
   *     shares its prefix.
   *   options.distinctPrefixes - returned addresses each have a distinct prefix, so a
   *     caller needing independent observers (e.g. the port-reachability probe) does
   *     not get same-subnet, shared-fate peers.
   *   options.prefixLength - bits of IP prefix (whole octets, default 16) defining
   *     "same network" for both exclusion and distinctness.
   * Fewer than `count` may be returned if the filtered pool is smaller.
   * @param {number} count
   * @param {{excludeSocketAddress?: string, distinctPrefixes?: boolean, prefixLength?: number}} options
   * @returns {Promise<string[]>}
   */
  async getRandomSocketAddressSample(count, options = {}) {
    await this.waitIndexesReady;

    const indexSize = this.#socketAddressIndex.size;
    if (!indexSize || count <= 0) return [];

    const { excludeSocketAddress = null, distinctPrefixes = false, prefixLength = 16 } = options;
    const excludePrefix = excludeSocketAddress ? ipPrefix(excludeSocketAddress, prefixLength) : null;

    // Walk the index from a random offset, collecting addresses that pass the filters
    // until we have `count`. Single pass, O(indexSize) worst case.
    const nodes = Array.from(this.#socketAddressIndex.values());
    const start = Math.floor(Math.random() * indexSize);
    const seenPrefixes = new Set();
    const picked = [];

    for (let n = 0; n < indexSize && picked.length < count; n += 1) {
      const { ip: socketAddress } = nodes[(start + n) % indexSize];
      if (excludeSocketAddress && socketAddress === excludeSocketAddress) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const prefix = ipPrefix(socketAddress, prefixLength);
      if (excludePrefix && prefix === excludePrefix) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (distinctPrefixes) {
        if (seenPrefixes.has(prefix)) {
          // eslint-disable-next-line no-continue
          continue;
        }
        seenPrefixes.add(prefix);
      }
      picked.push(socketAddress);
    }

    return picked;
  }

  /**
   *
   * @param {{sort?: boolean}} options
   */
  state(options = {}) {
    const sort = options.sort || false;

    const clone = Array.from(this.#state);

    if (!sort) return clone;

    clone.sort((a, b) => {
      if (a.added_height > b.added_height) return 1;
      if (b.added_height > a.added_height) return -1;
      if (b.txhash > a.txhash) return 1;
      return 0;
    });

    return clone;
  }

  /**
   * Replaces the held state with an atomic snapshot and anchors it to that block.
   *
   * The snapshot RPC returns height, blockhash and nodes under one lock, which is why
   * it is used rather than the plain list: an anchor taken from a separate call could
   * name a block the node set never matched.
   *
   * @param {Array<Fluxnode>} nodes The snapshot's node list.
   * @param {number} height Snapshot height.
   * @param {string} hash Snapshot block hash.
   * @returns {Promise<void>} Resolves once indexes are rebuilt.
   */
  async applySnapshot(nodes, height, hash) {
    if (!Array.isArray(nodes) || !nodes.length) {
      throw new Error('Refusing to replace network state with an empty snapshot');
    }

    const populated = Boolean(this.#state.length);

    this.#state = nodes;
    await this.#buildIndexes(this.#state);
    this.#chainAnchor = { height, hash };

    log.info(`Network state snapshot applied at ${height}: ${nodes.length} nodes`);

    if (!populated) {
      this.emit('populated');
      if (this.#onStartComplete) this.#onStartComplete();
      this.#started = true;
    }

    this.emit('updated');
  }

  /**
   * The transition this state currently sits at, or null if unanchored.
   * @returns {{height: number, hash: string} | null} Anchor.
   */
  get chainAnchor() {
    return this.#chainAnchor ? { ...this.#chainAnchor } : null;
  }

  /**
   * Anchors the state to a block, so subsequent deltas can be chained onto it. Set
   * from the snapshot that produced the state.
   * @param {number} height Snapshot height.
   * @param {string} hash Snapshot block hash.
   * @returns {void}
   */
  setChainAnchor(height, hash) {
    this.#chainAnchor = hash ? { height, hash } : null;
  }

  /**
   * Applies one fluxnodelistdelta to the held state.
   *
   * Deltas are final state rather than an event log: a node that was added, removed
   * and re-added inside one block arrives as a single update, so every entry is
   * applied as an overwrite and never replayed.
   *
   * Rejected rather than force-applied when it does not chain onto what we hold — the
   * caller's repair is a full snapshot, because a delta stream has no replay. Height
   * is not the test: after a reorg it can go backwards or repeat, so the hash is what
   * decides.
   *
   * @param {object} delta Decoded fluxnodelistdelta.
   * @param {(outpoints: Array<object>) => Promise<Array<object>>} resolveAdded Called
   *   with the outpoints of added nodes, returns their full records. Adds carry fewer
   *   fields on the wire than the list exposes — `added_height` and `payment_address`
   *   are not in the delta — and both have consumers.
   * @returns {Promise<{applied: boolean, code?: string, reason?: string}>} Outcome.
   *   `code` is the stable token to branch on; `reason` carries the detail for a log.
   */
  async applyDelta(delta, resolveAdded) {
    if (!this.#chainAnchor) {
      return { applied: false, code: 'not_anchored', reason: 'state is not anchored to a block' };
    }

    if (delta.fromHash !== this.#chainAnchor.hash) {
      return {
        applied: false,
        code: 'chain_mismatch',
        reason: `delta starts at ${delta.fromHash.slice(0, 16)} but state is at ${this.#chainAnchor.hash.slice(0, 16)}`,
      };
    }

    let added = [];
    if (delta.added.length) {
      added = await resolveAdded(delta.added);

      if (added.length !== delta.added.length) {
        return {
          applied: false,
          code: 'unresolved_additions',
          reason: `resolved ${added.length} of ${delta.added.length} added nodes`,
        };
      }
    }

    const removedKeys = new Set(
      delta.removed.map((outpoint) => `${outpoint.txid}:${outpoint.index}`),
    );

    removedKeys.forEach((key) => {
      const node = this.#outpointIndex.get(key);
      if (node) this.#deindexNode(node);
    });

    delta.updated.forEach((entry) => {
      const key = NetworkStateManager.outpointKey(entry);
      const existing = this.#outpointIndex.get(key);

      // An update for a node we never held cannot be merged onto anything. Rather
      // than invent a partial record, let it surface as a mismatch at the next
      // snapshot comparison.
      if (!existing) return;

      // The ip is an index key, so a move has to be re-keyed rather than overwritten
      // in place.
      const ipChanged = existing.ip !== entry.ip;
      if (ipChanged) this.#deindexNode(existing);

      existing.ip = entry.ip;
      existing.tier = entry.tier;
      existing.confirmed_height = entry.confirmedHeight;
      existing.last_paid_height = entry.lastPaidHeight;
      existing.pubkey = entry.pubkey;

      if (ipChanged) this.#indexNode(existing);
    });

    if (removedKeys.size) {
      this.#state = this.#state.filter(
        (node) => !removedKeys.has(NetworkStateManager.outpointKey(node)),
      );
    }

    added.forEach((node) => {
      const key = NetworkStateManager.outpointKey(node);
      if (this.#outpointIndex.has(key)) return;

      this.#state.push(node);
      this.#indexNode(node);
    });

    this.#chainAnchor = { height: delta.toHeight, hash: delta.toHash };

    log.info(
      `Network state delta ${delta.fromHeight}->${delta.toHeight}: `
      + `+${added.length} -${removedKeys.size} ~${delta.updated.length} (total: ${this.#state.length})`,
    );

    this.emit('updated');
    return { applied: true };
  }

  reset() {
    this.#stateEmitter = null;
    this.#pubkeyIndex = new Map();
    this.#socketAddressIndex = new Map();
    this.#outpointIndex = new Map();
    this.#chainAnchor = null;
    this.#state = [];
  }

  /**
   *
   * @param {number?} blockHeight Just for logging (from event emitter)
   * @returns {Promise<void>}
   */
  async fetchNetworkState(blockHeight = null) {
    // always use monotonic clock for any elapsed times
    const start = process.hrtime.bigint();
    const populated = Boolean(this.#state.length);

    let state = [];

    // on start, we loop until we have started. Then we only try fetch
    // once - if it fails, we give up (and let it retry on the next block)

    do {
      if (this.#controller.aborted) break;

      const fetchStart = process.hrtime.bigint();
      const fetchLock = this.#controller.getLock('fetcher');

      // eslint-disable-next-line no-await-in-loop
      const releaseFetch = await fetchLock.acquire({ label: 'networkState:fetcher' });
      try {
        // eslint-disable-next-line no-await-in-loop
        state = await this.#stateFetcher().catch((err) => {
          log.warn(`Network state fetcher error: ${err.message}`);
          return [];
        });
      } finally {
        releaseFetch();
      }

      const fetchEnd = process.hrtime.bigint();

      this.#lastFetchTime = fetchEnd;

      const fetchElapsed = Number(fetchEnd - fetchStart) / 1_000_000;

      const rounded = Math.round((fetchElapsed + Number.EPSILON) * 100) / 100;

      const elapsedMsg = `Network state fetch finished, elapsed: ${rounded} ms`;
      // We run first time without a blockheight, only on events do we get the height
      const blockMsg = blockHeight ? `. Block height: ${blockHeight}` : '';
      log.info(elapsedMsg + blockMsg);

      // eslint-disable-next-line no-await-in-loop
      if (!state.length) await this.#controller.sleep(15_000);
    } while (!populated && !state.length);

    if (state.length) {
      this.#state = state;

      const indexStart = process.hrtime.bigint();

      await this.#buildIndexes(this.#state);

      const indexElapsed = Number(process.hrtime.bigint() - indexStart) / 1_000_000;

      const rounded = Math.round((indexElapsed + Number.EPSILON) * 100) / 100;

      const pubkeySize = this.#pubkeyIndex.size;
      const socketAddressSize = this.#socketAddressIndex.size;

      log.info(
        'Network State Indexes created, nodes found: '
        + `${state.length}, elapsed: ${rounded} ms`,
      );

      log.info(
        `pubkeyIndexSize: ${pubkeySize}, socketAddressSize: ${socketAddressSize}`,
      );

      if (!populated) {
        this.emit('populated');
        if (this.#onStartComplete) this.#onStartComplete();
        this.#started = true;
      }

      this.emit('updated');
    }

    const elapsed = Number(process.hrtime.bigint() - start) / 1000000;

    // min sleep period is 1s
    const sleepMs = Math.max(1_000, this.intervalMs - elapsed);
    return sleepMs;
  }

  #startPolling() {
    this.#controller.startLoop(this.fetchNetworkState.bind(this));
  }

  #startEventEmitter() {
    const handler = async (blockHeight) => {
      if (!this.canFetch) {
        log.info(
          'Throttling networkUpdate - using cached nodelist '
          + `(${this.nodeCount} nodes). Next call allowed in ${this.remainingFetchSeconds}s`,
        );

        return;
      }

      if (this.#fetchQueued) {
        log.info(
          `Block ${blockHeight} received but a fetch `
          + 'is already queued... skipping',
        );

        return;
      }

      if (this.fetchRunning) {
        log.info(
          // eslint-disable-next-line no-useless-concat
          'Block received but fetching in progress... ' + 'queueing next fetch',
        );

        this.#fetchQueued = true;
        await this.waitFetchComplete;
        this.#fetchQueued = false;
      }

      await this.fetchNetworkState(blockHeight);
    };

    this.#boundEventHandler = handler;

    this.#stateEmitter.on(this.stateEvent, handler);
    if (this.progressEvent) {
      this.#stateEmitter.on(this.progressEvent, handler);
    }
  }

  async start() {
    await this.fetchNetworkState();
    await this.waitStarted;

    const updater = this.#stateEmitter && this.stateEvent
      ? this.#startEventEmitter
      : this.#startPolling;

    updater.bind(this)();
  }

  async stop() {
    await this.#controller.abort();

    if (this.#stateEmitter && this.#boundEventHandler) {
      this.#stateEmitter.removeListener(this.stateEvent, this.#boundEventHandler);
      if (this.progressEvent) {
        this.#stateEmitter.removeListener(this.progressEvent, this.#boundEventHandler);
      }
      this.#boundEventHandler = null;
    }

    this.reset();
  }

  /**
   * Find node(s) in the fluxnode network state by either pubkey or socketAddress
   *
   * @param {string} filter pubkey or socketAddress (ip:port)
   * @param {"pubkey" | "socketAddress"} type
   * @returns {Promise<Map<string, Fluxnode>> | Fluxnode | null>} Clone of the state
   */
  async search(filter, type) {
    const invalidInput = !filter || typeof filter !== 'string' || typeof type !== 'string';

    if (invalidInput) return null;

    if (!Object.keys(this.#indexes).includes(type)) return null;

    // if we are mid stroke indexing, may as well wait the ~10ms and get the
    // latest block
    await this.waitIndexesReady;

    const key = type === 'socketAddress' ? normalizeSocketAddress(filter) : filter;
    const cached = this.#indexes[type].get(key);
    const clone = cached ? NetworkStateManager.deepClone(cached) : null;

    return clone;
  }

  /**
   * Verify if node is in network state. Filter by either pubkey or socketAddress
   *
   * @param {string} filter pubkey or socketAddress (ip:port)
   * @param {"pubkey" | "socketAddress"} type
   * @returns {Promise<boolean>} If the target exists in the state
   */
  async includes(filter, type) {
    if (!filter) return false;
    if (!Object.keys(this.#indexes).includes(type)) return false;

    // if we are mid stroke indexing, may as well wait the 10ms (max) and get the
    // latest block
    await this.waitIndexesReady;

    const key = type === 'socketAddress' ? normalizeSocketAddress(filter) : filter;
    const found = this.#indexes[type].has(key);

    return found;
  }
}

async function main() {
  // eslint-disable-next-line global-require
  const daemonServiceFluxnodeRpcs = require('../daemonService/daemonServiceFluxnodeRpcs');

  const fetcher = async (filter = null) => {
    const options = { params: { filter }, query: { filter: null } };

    const res = await daemonServiceFluxnodeRpcs.viewDeterministicFluxNodeList(options);

    if (res.status === 'success') {
      return res.data;
    }
    console.log('fetcher says no');
    return [];
  };

  const network = new NetworkStateManager(fetcher, { intervalMs: 120_000, zmqEndpoint: 'tcp://127.0.0.1:28332' });
  network.on('updated', () => {
    console.log('received updated event');
  });
  network.on('populated', async () => {
    console.log('received populated event');
    console.log('Search result populated:', await network.search('212.71.244.159:16137', 'socketAddress'));
  });
  network.start();
  setInterval(async () => {
    // await network.search('212.71.244.159:16137', 'socketAddress');
    console.log('Search pubkey:', await network.search('045ae66321cfc172086d79252323b6cd4b83460e580e88f220582affda8a83b3ec68078ad80f7e465c42c3ef9bc01b912b3663e2ba09057bc43fbedf0afa9f3864', 'pubkey'));
  }, 5_000);
}

if (require.main === module) {
  main();
}

/**
 * The network prefix of a socketAddress ('ip:port' or 'ip') at the given bit
 * length, in whole octets (16 -> first two octets, 24 -> three, 32 -> full IP).
 * Used to keep randomly-sampled peers in distinct networks - same-prefix nodes
 * share routing fate, so their port-reachability verdicts are not independent.
 * @param {string} socketAddress
 * @param {number} prefixLength - bits (16/24/32)
 * @returns {string}
 */
function ipPrefix(socketAddress, prefixLength) {
  const ip = socketAddress.includes(':') ? socketAddress.slice(0, socketAddress.indexOf(':')) : socketAddress;
  const octets = Math.max(1, Math.min(4, Math.floor(prefixLength / 8)));
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  const prefix = parts.slice(0, octets).join('.');
  return prefix;
}

module.exports = { NetworkStateManager };

// interesting stuff:

// 6 nodes with no ip address

// ~ 420ms fetch time (on localhost) ~ 8.2Mb i/o. Not sure if this is time for fluxd
// to generate the list, or for the actual i/o on localhost.

// ~ 20ms to build cache. This was 8ms under no load, so obviously, yielding
// to the event queue is a good thing as there is other work to be done.

// if we need to search... we wait for indexes. What about if fetching?
// do we try for a search without waiting, then if a cache miss, we wait for
// the search to finish?

// fetching state
// Fetch finished, elapsed ms: 418.639369
// Nodes found: 13047
// Setting state and indexes
// pubkeyIndexSize: 3011
// socketAddressIndexSize: 13041
// Indexes created, elapsed ms: 18.25089
// New Flux App Removed message received.
