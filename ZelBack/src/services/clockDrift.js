'use strict';

const log = require('../lib/log');
const serviceHelper = require('./serviceHelper');
const messageHelper = require('./messageHelper');

// NTP source detected once at first call, then reused
let ntpSource = null; // 'chrony' | 'timesyncd' | 'none'

function resetNtpSource() { ntpSource = null; }

/**
 * Detects which NTP source is available on this node.
 * @returns {Promise<string>} 'chrony', 'timesyncd', or 'none'
 */
async function detectNtpSource() {
  if (ntpSource !== null) return ntpSource;

  const { error: chronyError } = await serviceHelper.runCommand('chronyc', {
    params: ['tracking'],
    timeout: 5000,
    logError: false,
  });
  if (!chronyError) {
    ntpSource = 'chrony';
    log.info('NTP source detected: chrony');
    return ntpSource;
  }

  const { error: timedError } = await serviceHelper.runCommand('timedatectl', {
    params: ['timesync-status'],
    timeout: 5000,
    logError: false,
  });
  if (!timedError) {
    ntpSource = 'timesyncd';
    log.info('NTP source detected: timesyncd');
    return ntpSource;
  }

  ntpSource = 'none';
  log.info('NTP source detected: none');
  return ntpSource;
}

/**
 * Parses chrony offset from `chronyc tracking` output.
 * @param {string} stdout
 * @returns {number|null} offset in seconds
 */
function parseChronyOffset(stdout) {
  // "System time : 0.000001234 seconds slow of NTP time"
  const match = stdout.match(/System time\s*:\s*([\d.]+)\s+seconds\s+(slow|fast)/);
  if (!match) return null;
  return parseFloat(match[1]) * (match[2] === 'slow' ? -1 : 1);
}

/**
 * Parses timesyncd offset from `timedatectl timesync-status` output.
 * @param {string} stdout
 * @returns {number|null} offset in seconds
 */
function parseTimesyncOffset(stdout) {
  // "Offset: +1.234ms" or "Offset: -567us"
  const match = stdout.match(/Offset\s*:\s*([+-]?[\d.]+)(us|ms|s)/);
  if (!match) return null;
  let offset = parseFloat(match[1]);
  if (match[2] === 'us') offset /= 1e6;
  else if (match[2] === 'ms') offset /= 1e3;
  return offset;
}

/**
 * Gets NTP clock drift from the detected source.
 * @returns {Promise<{source: string, offset: number|null, time: number}>}
 */
async function getClockDrift() {
  const source = await detectNtpSource();
  const time = Math.floor(Date.now() / 1000);

  if (source === 'chrony') {
    const { error, stdout } = await serviceHelper.runCommand('chronyc', {
      params: ['tracking'],
      timeout: 5000,
      logError: false,
    });
    if (!error && stdout) {
      const offset = parseChronyOffset(stdout);
      if (offset !== null) return { source, offset, time };
    }
  } else if (source === 'timesyncd') {
    const { error, stdout } = await serviceHelper.runCommand('timedatectl', {
      params: ['timesync-status'],
      timeout: 5000,
      logError: false,
    });
    if (!error && stdout) {
      const offset = parseTimesyncOffset(stdout);
      if (offset !== null) return { source, offset, time };
    }
  }

  return { source, offset: null, time };
}

// Cached NTP clock offset in milliseconds. Refreshed every 5 minutes.
let localClockOffsetMs = null;
let clockOffsetInterval = null;

/**
 * Refresh the cached NTP clock offset from the system NTP source.
 */
async function refreshClockOffset() {
  try {
    const { offset } = await getClockDrift();
    localClockOffsetMs = offset !== null ? Math.round(offset * 1000) : null;
  } catch (e) {
    log.error(`Failed to refresh clock offset: ${e.message}`);
  }
}

/**
 * Start the clock offset cache. Call once during node startup.
 */
async function initClockOffsetCache() {
  await refreshClockOffset();
  if (!clockOffsetInterval) {
    clockOffsetInterval = setInterval(refreshClockOffset, 5 * 60 * 1000);
  }
}

/**
 * Returns the cached local NTP clock offset in milliseconds, or null if unavailable.
 * @returns {number|null}
 */
function getLocalClockOffsetMs() {
  return localClockOffsetMs;
}

/**
 * API handler for clock drift endpoint.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function clockDrift(req, res) {
  try {
    const data = await getClockDrift();
    const message = messageHelper.createDataMessage(data);
    return res ? res.json(message) : message;
  } catch (error) {
    log.error(error);
    const message = messageHelper.createErrorMessage('Error obtaining clock drift');
    return res ? res.json(message) : message;
  }
}

module.exports = {
  clockDrift,
  getClockDrift,
  getLocalClockOffsetMs,
  initClockOffsetCache,
  parseChronyOffset,
  parseTimesyncOffset,
  resetNtpSource,
};
