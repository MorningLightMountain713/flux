const config = require('config');

// The playground's own admission arithmetic, kept separate from the session
// machinery because it is pure: a spec's totals in, a refusal reason or null out.
//
// Two independent things live here and they answer to different pressures.
//
// The CEILING bounds one session's shape. It is a filter and never a degrade -
// a spec that asks for more is refused with the numbers so its owner can see
// what to change. Running it at less would reproduce exactly the testappinstall
// failure this feature replaces: an app tested at resources nobody declared,
// where a pass proves nothing and a failure blames the wrong thing.
//
// The DUTY CYCLE bounds what the node donates over time, and it is deliberately
// identity-blind. The per-caller limit that sits beside it is fairness and
// attribution only - FluxIDs cost nothing to mint, so an identity limit stops a
// dev loop hogging a node and puts a name on the traffic, but it stops no-one
// who is trying. What actually bounds the node is that it runs one session at a
// time and two per hour whoever asks.

const MS_PER_HOUR = 3_600_000;
const NS_PER_MS = 1_000_000n;

function sessionCeiling() {
  return {
    cpu: config.fluxapps.playgroundSessionCpu ?? 2,
    memoryMb: config.fluxapps.playgroundSessionMemoryMb ?? 4096,
    rootFsGb: config.fluxapps.playgroundSessionRootFsGb ?? 10,
    imageMaxBytes: config.fluxapps.playgroundSessionImageMaxBytes ?? 2e9,
    imageTotalMaxBytes: config.fluxapps.playgroundSessionImageTotalMaxBytes ?? 6e9,
  };
}

function windowMs() {
  return config.fluxapps.playgroundWindowMs ?? MS_PER_HOUR;
}

/**
 * Whether a spec's totals fit one session, and why not when they do not.
 *
 * Swap and persistent storage are held at zero rather than budgeted. A session
 * is one copy for fifteen minutes with nothing to keep, so storage it could
 * write to is storage the node has to reclaim; swap on top of a 4 GB ceiling
 * only widens what a runaway can touch. Both are declared limits an owner can
 * read off a refusal, not silent omissions.
 *
 * @param {object} totals ResourceTotals from DeploymentSpec.resourceTotals()
 * @returns {string|null} the refusal, naming both numbers, or null when it fits
 */
function ceilingShortfall(totals) {
  // A sealed v8 spec answers "cannot tell" rather than zero. Admitting on an
  // unknown is how a ceiling silently stops being one.
  if (!totals) {
    return 'The playground cannot measure this spec\'s resources, so it cannot check them against the session ceiling. Send a spec whose resources are readable.';
  }

  const ceiling = sessionCeiling();

  // Deliberately no component-count check. The dimensions below bound what the
  // session actually costs this node, and a spec that fits them costs the same
  // whether it arrives as one component or six. Pull bandwidth is the one cost
  // component count was standing in for, and the runner bounds that directly
  // with an aggregate image budget.
  if (totals.cpu > ceiling.cpu) {
    return `The spec asks for ${totals.cpu} CPU cores; a playground session allows ${ceiling.cpu}.`;
  }
  if (totals.memoryMb > ceiling.memoryMb) {
    return `The spec asks for ${totals.memoryMb} MB of RAM; a playground session allows ${ceiling.memoryMb} MB.`;
  }
  if (totals.rootFsGb > ceiling.rootFsGb) {
    return `The spec asks for ${totals.rootFsGb} GB of rootFs; a playground session allows ${ceiling.rootFsGb} GB.`;
  }
  if (totals.swapGb > 0) {
    return `The spec asks for ${totals.swapGb} GB of swap; a playground session runs with no swap. Set swap to 0 to try it here.`;
  }
  if (totals.storageGb > 0) {
    return `The spec asks for ${totals.storageGb} GB of persistent storage; a playground session keeps nothing, so it runs with none. Set persistent storage to 0 to try it here.`;
  }

  return null;
}

/**
 * A rolling-window counter over the monotonic clock.
 *
 * Monotonic because this measures elapsed time on one machine: a wall-clock
 * counter hands back the whole window's allowance to anyone who can move the
 * node's clock, and steps backwards over an NTP correction on its own.
 */
class RollingWindow {
  constructor(limit) {
    this.limit = limit;
    this.hits = new Map();
  }

  prune(key, nowNs, spanNs) {
    const kept = (this.hits.get(key) ?? []).filter((at) => nowNs - at < spanNs);
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  /** Drop expired entries for every key, so an idle node does not hold them. */
  sweep() {
    const nowNs = process.hrtime.bigint();
    const spanNs = BigInt(windowMs()) * NS_PER_MS;
    for (const key of [...this.hits.keys()]) this.prune(key, nowNs, spanNs);
  }

  /**
   * Take one slot if the window has room.
   * @returns {{allowed: boolean, used: number, limit: number, retryAfterMs: number}}
   */
  consume(key) {
    const nowNs = process.hrtime.bigint();
    const spanNs = BigInt(windowMs()) * NS_PER_MS;
    const kept = this.prune(key, nowNs, spanNs);

    if (kept.length >= this.limit) {
      // The oldest hit is what has to age out before the next slot exists, so
      // this is a real number the caller can wait rather than a guess.
      const oldest = kept[0];
      return {
        allowed: false,
        used: kept.length,
        limit: this.limit,
        retryAfterMs: Number((spanNs - (nowNs - oldest)) / NS_PER_MS),
      };
    }

    kept.push(nowNs);
    this.hits.set(key, kept);
    return {
      allowed: true, used: kept.length, limit: this.limit, retryAfterMs: 0,
    };
  }

  /**
   * Hand back the most recent slot taken for a key.
   *
   * Only for a slot that was taken speculatively and whose session then never
   * ran - a later check refused it, so the node did none of the work the slot
   * was meant to pay for. Never for a session that started: one that fails at
   * its own image or probe has already cost the node the pull and the start.
   */
  refund(key) {
    const kept = this.hits.get(key);
    if (!kept || !kept.length) return;
    kept.pop();
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
  }

  reset() {
    this.hits.clear();
  }
}

// A slot is spent when a session is ACCEPTED, not when it finishes, and is never
// handed back. Otherwise a caller whose sessions fail fast pays nothing for the
// work the node already did pulling and starting their image.
const nodeWindow = new RollingWindow(config.fluxapps.playgroundNodeSessionsPerHour ?? 2);
const callerWindow = new RollingWindow(config.fluxapps.playgroundCallerSessionsPerHour ?? 3);

const NODE_KEY = 'node';

/**
 * The caller a per-identity limit is charged to. Keyed on the FluxID AND the
 * caller's address because each is weak alone: FluxIDs are free to mint, and an
 * address is one request from elsewhere away from being a different caller.
 *
 * The address is the RESOLVED one (ingressCapture.resolveClientIp), which reads
 * the forwarding header only when the connection came from one of the balancers
 * in config.fdmAddresses. A caller still cannot reset their own limit with it:
 * connecting directly makes the peer unrecognised and the header is ignored
 * outright, and going through a balancer means the balancer appends what it saw
 * after anything they wrote, which is the entry this reads.
 */
function callerKey(fluxId, sourceIp) {
  return `${fluxId}|${sourceIp ?? ''}`;
}

/**
 * Charge a session against both windows.
 *
 * The node window is taken FIRST and the caller window is only charged if the
 * node had room. Charging the caller for a session the node then refuses would
 * spend their allowance on work that never happened.
 *
 * @returns {{allowed: boolean, scope: string|null, retryAfterMs: number, message: string|null}}
 */
function consumeSessionSlot(fluxId, sourceIp) {
  const node = nodeWindow.consume(NODE_KEY);
  if (!node.allowed) {
    return {
      allowed: false,
      scope: 'node',
      retryAfterMs: node.retryAfterMs,
      message: `This node has run its ${node.limit} playground sessions for the hour. Try another node.`,
    };
  }

  const caller = callerWindow.consume(callerKey(fluxId, sourceIp));
  if (!caller.allowed) {
    // The node slot just taken is given back: the session is not going to run,
    // and the node did no work for it.
    nodeWindow.refund(NODE_KEY);
    return {
      allowed: false,
      scope: 'caller',
      retryAfterMs: caller.retryAfterMs,
      message: `You have run your ${caller.limit} playground sessions for the hour. Try another node, or wait.`,
    };
  }

  return {
    allowed: true, scope: null, retryAfterMs: 0, message: null,
  };
}

/** Test seam: drop every counter. */
function reset() {
  nodeWindow.reset();
  callerWindow.reset();
}

module.exports = {
  RollingWindow,
  sessionCeiling,
  ceilingShortfall,
  callerKey,
  consumeSessionSlot,
  reset,
};
