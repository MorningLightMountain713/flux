import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function getLogs(containerId, { since, tail } = {}) {
  const args = ['logs'];
  if (since) args.push('--since', since);
  if (tail) args.push('--tail', String(tail));
  args.push(containerId);

  const { stdout, stderr } = await execFileAsync('docker', args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout + stderr;
}

/**
 * A regex safe to reuse across many `.test()` calls.
 *
 * `g` (and `y`) make a regex stateful: `.test()` resumes from `lastIndex` and resets it
 * only on a miss, so testing a run of identical lines matches every second one and a
 * count comes back roughly half of what it should be. Filtering line by line wants a
 * fresh match each time, so those flags are dropped.
 *
 * @param {string|RegExp} pattern Caller's pattern.
 * @returns {RegExp} The same match, without match position carried between calls.
 */
export function statelessRegex(pattern) {
  if (!(pattern instanceof RegExp)) return new RegExp(pattern);
  const flags = pattern.flags.replace(/[gy]/g, '');
  return flags === pattern.flags ? pattern : new RegExp(pattern.source, flags);
}

export async function grepLogs(containerId, pattern, opts = {}) {
  const logs = await getLogs(containerId, opts);
  const regex = statelessRegex(pattern);
  return logs.split('\n').filter((line) => regex.test(line));
}

export async function countPattern(containerId, pattern, opts = {}) {
  const matches = await grepLogs(containerId, pattern, opts);
  return matches.length;
}

export async function hasLogLine(containerId, pattern, opts = {}) {
  const matches = await grepLogs(containerId, pattern, opts);
  return matches.length > 0;
}

export async function waitForLog(containerId, pattern, { timeout = 60000, interval = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await hasLogLine(containerId, pattern, { since: `${Math.floor(timeout / 1000) + 10}s` })) {
      return true;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timeout waiting for log pattern "${pattern}" on container ${containerId}`);
}
