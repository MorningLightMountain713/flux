// A node refuses a request for a capability that is down with the capability
// gate's answer: HTTP 503, the v1 error envelope named ServiceUnavailable, a
// Retry-After, and a message that names the capability. The refusal is the
// node's own statement of what it is waiting on, so a submission waits on
// exactly that: it is sent again while the gate refuses and the budget lasts,
// and the gate's message is the error when the budget runs out. Any other
// answer, a handler's error included, is returned untouched.

export const GATE_NAME = 'ServiceUnavailable';

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The capability gate's refusal carried by a response, or null.
 * @param {number} status
 * @param {string} text the body
 * @returns {{message: string}|null}
 */
export function gateRefusal(status, text) {
  if (status !== 503) return null;
  try {
    const body = JSON.parse(text);
    return body?.data?.name === GATE_NAME ? body.data : null;
  } catch {
    return null;
  }
}

/**
 * fetch() against a gated route: resent while the node's capability gate
 * refuses, up to `timeout`. Resolves with the first answer that is not the
 * gate's, as a Response the caller reads as usual.
 *
 * @param {string} url
 * @param {RequestInit} init reusable across sends (a FormData or string body)
 * @param {{timeout?: number, maxPauseMs?: number, fetchImpl?: Function, sleep?: Function}} [opts]
 * @returns {Promise<Response>}
 */
export async function submitToNode(url, init, {
  timeout = 60000, maxPauseMs = 1000, fetchImpl = fetch, sleep = defaultSleep,
} = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchImpl(url, init);
    if (res.status !== 503) return res;
    // eslint-disable-next-line no-await-in-loop
    const text = await res.text();
    const refusal = gateRefusal(res.status, text);
    if (!refusal) return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${url} refused for ${timeout}ms: ${refusal.message}`);
    const retryAfterMs = Number(res.headers.get('retry-after')) * 1000;
    const pause = Math.min(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : maxPauseMs, maxPauseMs, left);
    // eslint-disable-next-line no-await-in-loop
    await sleep(pause);
  }
}
