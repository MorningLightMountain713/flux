import { EventEmitter } from 'node:events';
import { EventSource } from 'eventsource';
import { getSubnetConfig } from './subnet-config.js';

export function nodeClient(nodeNum) {
  const ip = getSubnetConfig().nodeIp(nodeNum);
  const url = `http://${ip}:16127`;

  // apicache keys its cache by the FULL url (query string included — it only strips
  // the query under the jsonp option, which FluxOS does not set), so a unique query
  // param forces a fresh response past the 30s cache some GET routes carry. A getter
  // (or suite) that must observe real-time state passes { noCache: true }.
  let cacheBustSeq = 0;
  function freshen(path, noCache) {
    if (!noCache) return path;
    cacheBustSeq += 1;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}_=${Date.now()}-${cacheBustSeq}`;
  }

  async function get(path, { noCache = false } = {}) {
    const res = await fetch(`${url}${freshen(path, noCache)}`);
    return res.json();
  }

  async function getAuthed(path, zelidauth, { noCache = false } = {}) {
    const res = await fetch(`${url}${freshen(path, noCache)}`, { headers: { zelidauth } });
    return res.json();
  }

  async function post(path, body, headers = {}) {
    const contentType = headers['Content-Type'] ?? 'application/json';
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...headers },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  let eventSource = null;
  const eventBuffer = [];
  const emitter = new EventEmitter();
  emitter.on('error', () => {});
  let lastEventAt = 0;

  // The library's auto-reconnect fetch has no connect timeout: one hung TCP
  // connect freezes its retry loop forever and starves every wait on this
  // node, while the server holds replayable events (Last-Event-ID + ring
  // buffer). Bound the connect phase only - once headers arrive the stream
  // must live unbounded.
  function fetchWithConnectTimeout(input, init) {
    const controller = new AbortController();
    const onUpstreamAbort = () => controller.abort();
    init?.signal?.addEventListener('abort', onUpstreamAbort, { once: true });
    const connectTimer = setTimeout(() => controller.abort(), 15000);
    return fetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(connectTimer);
      init?.signal?.removeEventListener('abort', onUpstreamAbort);
    });
  }

  function connectEventStream(timeout = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SSE connect timeout after ${timeout}ms for ${ip}`));
      }, timeout);

      eventSource = new EventSource(`${url}/flux/eventstream`, { fetch: fetchWithConnectTimeout });

      eventSource.onopen = () => {
        clearTimeout(timer);
        resolve();
      };

      eventSource.onerror = (err) => {
        // A dead stream must never be silent: every later wait on this node
        // starves with a generic timeout unless the drop is visible here.
        console.error(`###SSE-ERROR ${ip} readyState=${eventSource?.readyState} ${err?.message || err?.code || 'connection error'} (${new Date().toISOString()})`);
        emitter.emit('error', err);
      };

      for (const name of [
        'block:processed',
        'boot:settled',
        'confirmation:changed',
        'daemon:deltaApplied',
        'daemon:deltaRefused',
        'daemon:listAnchored',
        'daemon:ownStatus',
        'daemon:polled',
        'daemon:recovered',
        'daemon:reorg',
        'daemon:resync',
        'daemon:resyncSkipped',
        'daemon:socketDropped',
        'daemon:subscriptionMode',
        'daemon:subscriptionsStarted',
        'daemon:unreachable',
        'dos:changed',
        'explorer:ready',
        'messageCapability:changed',
        'orchestrator:started',
        'orchestrator:stateChanged',
        'app:installed',
        'app:removed',
        'app:specStored',
        'app:running',
        'quorumGrant:askRefused',
        'quorumGrant:assess',
        'quorumGrant:founded',
        'quorumGrant:founderAnswer',
        'quorumGrant:founderFlip',
        'quorumGrant:granted',
        'quorumGrant:planeActivated',
        'quorumGrant:demoted',
        'quorumGrant:fenceRaised',
        'quorumGrant:coasting',
        'quorumGrant:healed',
        'quorumGrant:restCheck',
        'quorumGrant:served',
        'quorumGrant:standbys',
        'quorumGrant:generationRecord',
        'quorumGrant:generationRecordDropped',
        'quorumGrant:masterleaseDropped',
        'quorumGrant:generationLearned',
        'quorumGrant:ordinalFounded',
        'quorumGrant:ordinalReleased',
        'quorumGrant:ordinalVacated',
        'quorumGrant:yielded',
        'quorumGrant:fenceLifted',
        'quorumGrant:repair',
        'quorumGrant:termRefreshed',
        'quorumGrant:relayFailed',
        'quorumGrant:carryRefused',
        'imageUpdate:checked',
        'imageUpdate:redeployTriggered',
        'imageUpdate:redeployComplete',
        'peers:added',
        'peers:belowThreshold',
        'peers:removed',
        'peers:thresholdReached',
        'syncthing:folderErrors',
        'syncthing:eventsResync',
        'spawner:blocked',
        'spawner:deferred',
        'spawner:installFailed',
        'spawner:networkErrorSkip',
        'spawner:paused',
        'spawner:resumed',
        'nodedown:assembled',
        'nodedown:stored',
        'nodedown:refused',
        'nodedown:verdict',
        'nodedown:quarantined',
        'nodedown:inboundRefused',
        'network:apprunning',
        'network:appinstalling',
        'network:appinstallingerror',
        'network:appremoved',
        'network:appmessage',
        'network:ingressattestation',
        'network:ipchanged',
        'network:sigterm',
        'ephemeralSync:requested',
        'ephemeralSync:reconnectRequested',
        'ephemeralSync:peerComplete',
        'ephemeralSync:peerFailed',
        'ephemeralSync:allComplete',
        'sync:chunkVerified',
        'hashSync:complete',
        'hashSync:failed',
        'hashRequest:received',
        'hashRequest:responded',
        'message:dispatched',
        'reconciler:actuated',
        'reconciler:desiredChanged',
        'reconciler:swept',
        'janitor:sweep',
        'content:blobUploaded',
        'content:blobResolved',
        'content:blobPeerMiss',
        'content:blobProvisioned',
        'content:blobProvisionFailed',
        'content:blobServed',
        'content:manifestStored',
        'content:manifestReceived',
        'content:manifestDropped',
        'content:manifestPromoted',
        'content:manifestBackstopped',
        'content:reconcilePushed',
        'content:slotApplied',
        'content:slotApplySkipped',
        'content:slotsProvisioned',
        'content:rolloutScheduled',
        'content:bootReconcile',
        'content:contentUpdateApplied',
        'content:manifestSyncStarted',
        'content:manifestSyncComplete',
        'content:manifestReconciled',
        'content:manifestReaped',
        'activeStandby:decided',
      ]) {
        eventSource.addEventListener(name, (e) => {
          const entry = {
            event: e.type,
            data: JSON.parse(e.data),
            id: parseInt(e.lastEventId, 10) || 0,
          };
          lastEventAt = Date.now();
          eventBuffer.push(entry);
          emitter.emit(e.type, entry);
        });
      }
    });
  }

  // Pending waitForEvent settlers. Disconnect detaches every listener, so a
  // wait pending at that moment could never resolve - it would only sit on its
  // timeout timer (the runner's open-handle leak: every Promise.any loser held
  // its full timeout after teardown). Settle them at the source instead.
  const pendingWaits = new Set();

  function disconnectEventStream() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    eventBuffer.length = 0;
    for (const settle of [...pendingWaits]) settle();
    const names = emitter.eventNames().filter((n) => n !== 'error');
    for (const name of names) emitter.removeAllListeners(name);
  }

  function waitForEvent(name, predicate = () => true, timeout = 30000, { afterId = 0 } = {}) {
    const found = eventBuffer.find((e) => e.event === name && e.id > afterId && predicate(e.data));
    if (found) return Promise.resolve(found);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        // Distinguish "the node never emitted it" from "this client's stream
        // is dead": a healthy stream shows recent traffic, a dead one shows a
        // stale lastEvent and a non-open readyState.
        const sinceLast = lastEventAt ? `${Math.round((Date.now() - lastEventAt) / 1000)}s ago` : 'never';
        reject(new Error(`Timeout after ${timeout}ms waiting for event: ${name} (${ip} stream readyState=${eventSource?.readyState}, lastEvent=${sinceLast}, buffered=${eventBuffer.length})`));
      }, timeout);

      function handler(entry) {
        if (entry.id > afterId && predicate(entry.data)) {
          cleanup();
          resolve(entry);
        }
      }

      function settle() {
        cleanup();
        reject(new Error(`Event stream for ${ip} disconnected while waiting for event: ${name}`));
      }

      function cleanup() {
        clearTimeout(timer);
        emitter.removeListener(name, handler);
        pendingWaits.delete(settle);
      }

      pendingWaits.add(settle);
      emitter.on(name, handler);
    });
  }

  function getLastEventId() {
    if (eventBuffer.length === 0) return 0;
    return eventBuffer[eventBuffer.length - 1].id;
  }

  return {
    ip,
    url,
    num: nodeNum,
    get,
    getAuthed,
    post,
    connectEventStream,
    disconnectEventStream,
    waitForEvent,
    getLastEventId,
    getEventBuffer: () => [...eventBuffer],
    getVersion: () => get('/flux/version'),
    getPeers: () => get('/flux/connectedpeers', { noCache: true }),
    getIncomingPeers: () => get('/flux/incomingconnections', { noCache: true }),
    getNodeStatus: () => get('/daemon/getzelnodestatus'),
    getBlockchainInfo: () => get('/daemon/getblockchaininfo'),
    getExplorerHeight: () => get('/explorer/scannedheight'),
    isExplorerSynced: () => get('/explorer/issynced'),
    getFluxInfo: () => get('/flux/info'),
    getDOSState: () => get('/flux/dosstate', { noCache: true }),
    setDOSState: (dosState, dosMessage, zelidauth) =>
      post('/flux/dosstate', { dosState, dosMessage }, { zelidauth }),
    getAppLocations: (name) => get(`/apps/location/${name}`),
    getAllAppLocations: () => get('/apps/locations'),
    getPermanentMessages: () => get('/apps/permanentmessages'),
    getTempMessages: (hash) => get(`/apps/temporarymessages/${hash}`),
    getAppSpecs: (name) => get(`/apps/appspecifications/${name}`),
    getInstalledApps: () => get('/apps/installedapps'),
    getRunningApps: () => get('/apps/runningapps'),
    getLoginPhrase: () => get('/id/loginphrase'),
    verifyLogin: (body) => post('/id/verifylogin', body, { 'Content-Type': 'text/plain' }),
    // Trigger a real local install on THIS node. The endpoint streams install
    // progress as concatenated JSON chunks (not a single JSON doc), so drain the
    // body as text; resolves when the install stream ends. Confirm completion via
    // the app:installed event (waitForAppInstalled).
    installAppLocally: async (appname, zelidauth) => {
      const res = await fetch(`${url}/apps/installapplocally/${appname}`, { headers: { zelidauth } });
      return res.text();
    },
    // Remove an app on THIS node (GET /apps/appremove/:app/:force?). force=true sets
    // the operator-force path (escalates an in-flight graceful drain). The endpoint
    // streams status text then ends, so drain it as text; the returned promise
    // resolves when the removal finishes — a suite holds a drain window by NOT
    // awaiting yet (like appendBackupTask).
    removeApp: async (appname, { force = false, zelidauth } = {}) => {
      const path = force ? `/apps/appremove/${appname}/true` : `/apps/appremove/${appname}`;
      const res = await fetch(`${url}${path}`, { headers: { zelidauth } });
      return res.text();
    },
    // Backup/restore drive the whole-app lease (B1). The endpoints stream chunked
    // progress and the returned promise resolves when the task FINISHES - so a
    // suite holds the lease window by simply not awaiting yet.
    appendBackupTask: async (appname, components, zelidauth) => {
      const res = await fetch(`${url}/apps/appendbackuptask`, {
        method: 'POST',
        headers: { zelidauth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appname, backup: components.map((component) => ({ component, backup: true })) }),
      });
      return res.text();
    },
    appendRestoreTask: async (appname, restore, type, zelidauth) => {
      const res = await fetch(`${url}/apps/appendrestoretask`, {
        method: 'POST',
        headers: { zelidauth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appname, restore, type }),
      });
      return res.text();
    },
  };
}

export function allNodes(count = 16) {
  return Array.from({ length: count }, (_, i) => nodeClient(i + 1));
}
