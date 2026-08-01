const config = require('config');
const { AsyncLock } = require('./asyncLock');
const log = require('../../lib/log');

// Registry limits come in two shapes and they want opposite treatment.
//
// Docker Hub and GHCR are COUNT-capped or uncapped - Hub allows 100 manifest
// GETs per 6h anonymously, 200 authenticated, per IPv4. Nothing is gained by
// spacing those requests out; what matters is how many you make. Concurrency
// there is free, and serialising is pure latency.
//
// ECR Public is the only true per-second RATE limit (1/s anonymous, 10/s
// authenticated). It is the reason a hardcoded one-second sleep sat in the
// verifier's per-architecture loop, charged to every registry including the two
// that do not need it.
//
// So: a concurrency semaphore everywhere, a token bucket only where a rate cap
// actually exists.
const DEFAULT_POLICIES = {
  'docker.io': { concurrency: 8, ratePerSec: null, burst: null },
  'ghcr.io': { concurrency: 12, ratePerSec: null, burst: null },
  'public.ecr.aws': { concurrency: 1, ratePerSec: 1, authedRatePerSec: 10, burst: 1 },
  'amazonaws.com': { concurrency: 4, ratePerSec: 10, burst: 10 },
  'azurecr.io': { concurrency: 4, ratePerSec: 10, burst: 10 },
};

// An unrecognised registry is overwhelmingly a self-hosted one, and CNCF
// Distribution - what nearly all of them run - has NO request rate limiting of
// any kind; the config exposes no such option, and anyone wanting it has to put
// a reverse proxy in front. So a registry that publishes no limit almost
// certainly has none, and inventing a per-second cap here would throttle
// infrastructure the app owner runs for themselves, usually serving this one
// node. Politeness comes from the concurrency bound; pacing is reserved for
// registries that publish an actual rate, and for anyone who does limit us the
// 429 cooldown below is the correct and self-correcting answer.
const DEFAULT_POLICY = { concurrency: 2, ratePerSec: null, burst: null };

// What to assume when a 429 arrives with no Retry-After and no reset header.
// Deliberately minutes, not hours: a cooldown is a could-not-ask answer that
// expires with the registry's own window, and caching it for hours turns a
// transient throttle into a self-inflicted outage for that image on this node.
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

// A registry that says "wait 6 hours" gets believed only this far. Past this we
// are better off re-asking and being refused again than sitting on a number a
// misconfigured proxy handed us.
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

const NS_PER_MS = 1_000_000n;

// provider key -> { lock, tokens, lastRefillNs, cooldownUntilNs, budget }
const providers = new Map();

function governorConfig() {
  return config.fluxapps.registryGovernor ?? {};
}

/**
 * Fold a registry host onto the key its policy is written against. Docker Hub
 * answers to three names, and the cloud registries are per-account subdomains
 * of one suffix, so an exact-match table alone would silently drop every real
 * caller onto the conservative default.
 */
function normalizeProvider(provider) {
  if (typeof provider !== 'string' || !provider) return 'unknown';

  const host = provider.toLowerCase().split(':')[0];

  if (host === 'docker.io' || host === 'registry-1.docker.io' || host === 'index.docker.io') {
    return 'docker.io';
  }
  if (host === 'public.ecr.aws') return 'public.ecr.aws';
  if (host.endsWith('.amazonaws.com')) return 'amazonaws.com';
  if (host.endsWith('.azurecr.io')) return 'azurecr.io';
  if (host === 'ghcr.io') return 'ghcr.io';

  return host;
}

/**
 * @param {string} provider registry host, normalized or not
 * @param {boolean} [authed] whether the caller carries credentials
 * @returns {{concurrency: number, ratePerSec: number|null, burst: number|null}}
 */
function policyFor(provider, authed = false) {
  const key = normalizeProvider(provider);
  const overrides = governorConfig().policies ?? {};
  const base = overrides[key] ?? DEFAULT_POLICIES[key] ?? DEFAULT_POLICY;

  // Credentials raise the ceiling where a registry publishes a higher authed
  // rate; they never lower it.
  const ratePerSec = authed && base.authedRatePerSec ? base.authedRatePerSec : base.ratePerSec ?? null;

  return {
    concurrency: base.concurrency,
    ratePerSec,
    burst: base.burst ?? ratePerSec,
  };
}

function stateFor(key, policy) {
  let state = providers.get(key);
  if (!state) {
    state = {
      lock: new AsyncLock(policy.concurrency),
      tokens: policy.burst ?? 0,
      lastRefillNs: process.hrtime.bigint(),
      cooldownUntilNs: 0n,
      budget: { limit: null, remaining: null, windowSeconds: null },
    };
    providers.set(key, state);
  }
  return state;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

function busyError(message, retryAfterMs) {
  const error = new Error(message);
  // Says the registry was unavailable to ask, never that the image is bad.
  // Consumers must class it transient or a throttle becomes a verdict.
  error.code = 'REGISTRY_BUSY';
  error.registryErrorClass = 'transient';
  error.retryAfterMs = retryAfterMs;
  return error;
}

/**
 * Milliseconds left on this provider's cooldown, 0 when it is not cooling.
 * @param {string} provider
 * @returns {number}
 */
function cooldownRemaining(provider) {
  const key = normalizeProvider(provider);
  const state = providers.get(key);
  if (!state || !state.cooldownUntilNs) return 0;

  const remainingNs = state.cooldownUntilNs - process.hrtime.bigint();
  return remainingNs > 0n ? Number(remainingNs / NS_PER_MS) : 0;
}

function refillTokens(state, policy, nowNs) {
  if (!policy.ratePerSec) return;

  const elapsedMs = Number((nowNs - state.lastRefillNs) / NS_PER_MS);
  if (elapsedMs <= 0) return;

  const gained = (elapsedMs / 1000) * policy.ratePerSec;
  state.tokens = Math.min(policy.burst, state.tokens + gained);
  state.lastRefillNs = nowNs;
}

/**
 * Take a slot for one request to `provider`, waiting out any cooldown and any
 * rate budget first.
 *
 * The concurrency slot is taken LAST, after every wait that could throw, so no
 * failure path can hand back a slot that was never used. (The lock's release is
 * idempotent and slot-bound, so this is belt as well as braces.)
 *
 * @param {string} provider registry host
 * @param {object} [options]
 * @param {boolean} [options.authed] caller carries credentials
 * @param {number|null} [options.timeoutMs] give up rather than wait this long.
 *   Background work should omit it; a caller holding an HTTP request open must
 *   pass one, or a cooling registry becomes a hung request.
 * @returns {Promise<() => void>} releases this request's slot
 * @throws {Error} code REGISTRY_BUSY when a deadline is given and cannot be met
 */
async function acquire(provider, options = {}) {
  const { authed = false, timeoutMs = null } = options;

  const key = normalizeProvider(provider);
  const policy = policyFor(key, authed);
  const state = stateFor(key, policy);

  const deadlineNs = timeoutMs === null
    ? null
    : process.hrtime.bigint() + BigInt(Math.max(0, timeoutMs)) * NS_PER_MS;

  const remainingMs = () => (deadlineNs === null
    ? null
    : Math.max(0, Number((deadlineNs - process.hrtime.bigint()) / NS_PER_MS)));

  // 1. Cooldown. A caller that cannot outwait it is told now, with the number,
  //    rather than being parked until its own deadline expires.
  const cooling = cooldownRemaining(key);
  if (cooling > 0) {
    const budget = remainingMs();
    if (budget !== null && budget < cooling) {
      throw busyError(`${key} is rate limited for another ${Math.round(cooling / 1000)}s`, cooling);
    }
    await sleep(cooling);
  }

  // 2. Rate budget, where the registry actually has one.
  if (policy.ratePerSec) {
    for (;;) {
      refillTokens(state, policy, process.hrtime.bigint());
      if (state.tokens >= 1) {
        state.tokens -= 1;
        break;
      }

      const waitMs = Math.ceil(((1 - state.tokens) / policy.ratePerSec) * 1000);
      const budget = remainingMs();
      if (budget !== null && budget < waitMs) {
        throw busyError(`${key} rate budget exhausted, ${waitMs}ms until the next slot`, waitMs);
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(waitMs);
    }
  }

  // 3. Concurrency, last.
  return state.lock.acquire({ timeoutMs: remainingMs(), label: `registry:${key}` });
}

/**
 * Feed a registry's answer back to the governor. A 429 puts the provider into
 * cooldown for as long as it asked for; anything else only updates the advisory
 * budget reading.
 *
 * The budget is advisory ONLY and must never gate a request: Docker Hub's count
 * is consumed mostly by the docker daemon's own manifest GETs during pulls,
 * which never pass through here, and the cap is per-IPv4, so co-located nodes
 * behind one NAT share a number none of them can see in full.
 *
 * @param {string} provider
 * @param {{status: number, headers: object}} response
 */
function recordResponse(provider, response = {}) {
  const { status = null, headers = {} } = response;
  const key = normalizeProvider(provider);
  const state = providers.get(key);
  if (!state) return;

  // Docker Hub returns these on every valid manifest request, not only on a
  // refusal, so the budget is readable long before anything goes wrong. They
  // describe a COUNT over a window (100 per 6 hours), which is emphatically not
  // a rate: turning that into a token bucket would space us one request every
  // 3.6 minutes. It informs, it does not pace.
  const budget = parseBudgetHeaders(headers);
  if (budget.limit !== null) state.budget.limit = budget.limit;
  if (budget.remaining !== null) state.budget.remaining = budget.remaining;
  if (budget.windowSeconds !== null) state.budget.windowSeconds = budget.windowSeconds;

  if (budget.remaining !== null && budget.limit !== null
    && budget.remaining <= Math.max(1, Math.floor(budget.limit * 0.1))) {
    log.warn(
      `Registry ${key} budget nearly spent: ${budget.remaining}/${budget.limit} left`
      + `${budget.windowSeconds === null ? '' : ` in a ${budget.windowSeconds}s window`}`,
    );
  }

  if (status !== 429) return;

  const cooldownMs = cooldownFromHeaders(headers);
  state.cooldownUntilNs = process.hrtime.bigint() + BigInt(cooldownMs) * NS_PER_MS;
  log.warn(
    `Registry ${key} rate limited: holding off ${Math.round(cooldownMs / 1000)}s`
    + `${state.budget.remaining === null ? '' : ` (remaining: ${state.budget.remaining})`}`,
  );
}

/**
 * The budget a registry advertises. Docker Hub writes `100;w=21600` — a count
 * and the window it applies over — and the IETF RateLimit draft standardizes
 * the same shape, with the `X-` spellings still in the wild from the earlier
 * drafts. A bare number with no window parses fine and leaves the window null.
 *
 * @param {object} headers
 * @returns {{limit: number|null, remaining: number|null, windowSeconds: number|null}}
 */
function parseBudgetHeaders(headers = {}) {
  const read = (value) => {
    if (value === undefined || value === null) return { count: null, windowSeconds: null };
    const [rawCount, ...params] = String(value).split(';');
    const count = Number(rawCount);
    const window = params
      .map((param) => /^\s*w=(\d+)\s*$/.exec(param))
      .find(Boolean);
    return {
      count: Number.isFinite(count) ? count : null,
      windowSeconds: window ? Number(window[1]) : null,
    };
  };

  const limit = read(headers['ratelimit-limit'] ?? headers['x-ratelimit-limit']);
  const remaining = read(headers['ratelimit-remaining'] ?? headers['x-ratelimit-remaining']);

  return {
    limit: limit.count,
    remaining: remaining.count,
    windowSeconds: limit.windowSeconds ?? remaining.windowSeconds,
  };
}

/**
 * This provider's last advertised budget, for diagnostics. Advisory only — see
 * recordResponse for why it must never gate a request.
 * @param {string} provider
 * @returns {{limit: number|null, remaining: number|null, windowSeconds: number|null}|null}
 */
function budgetFor(provider) {
  const state = providers.get(normalizeProvider(provider));
  return state ? { ...state.budget } : null;
}

/**
 * How long a 429 asks us to wait: the registry's own Retry-After, else its
 * reset header, else a bounded default. Never longer than MAX_COOLDOWN_MS.
 * @param {object} headers
 * @returns {number} milliseconds
 */
function cooldownFromHeaders(headers = {}) {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_COOLDOWN_MS);
  }

  const reset = Number(headers['ratelimit-reset'] ?? headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(reset * 1000, MAX_COOLDOWN_MS);
  }

  return DEFAULT_COOLDOWN_MS;
}

/** Test seam: drop all per-provider state. */
function reset() {
  providers.clear();
}

module.exports = {
  acquire,
  recordResponse,
  cooldownRemaining,
  budgetFor,
  policyFor,
  normalizeProvider,
  reset,
};
