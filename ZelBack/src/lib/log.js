const fs = require('fs');
const path = require('path');
const config = require('config');
const pino = require('pino');

// One sink: pino emitting NDJSON. Where systemd runs us it connects stdout
// to the journal and sets JOURNAL_STREAM — journald then owns storage,
// rotation, and querying (journalctl -u fluxos). Everywhere else (legacy
// nodes, dev, tests, the harness containers) a single size-rolled file
// beside the checkout keeps logs readable without a supervisor capturing
// stdout, and `logConsole: true` additionally mirrors NDJSON to stdout
// (the harness log collectors read container stdout; humans pipe through
// `pino-pretty`). The admin log endpoints read whichever sink is active —
// see sinkInfo().
const underJournald = Boolean(process.env.JOURNAL_STREAM);
const LEGACY_LOG_PATH = path.join(__dirname, '../../../fluxos.log');

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
// FLUX_LOG_LEVEL outranks config so a node can boot straight into debug;
// an unknown value falls back rather than crashing the logger.
const configuredLevel = process.env.FLUX_LOG_LEVEL || config.logLevel || 'info';
const level = LEVELS.includes(configuredLevel) ? configuredLevel : 'info';

function buildLogger() {
  const options = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
  };

  if (underJournald) {
    return pino(options, pino.destination(1));
  }

  const targets = [{
    target: 'pino-roll',
    options: {
      file: LEGACY_LOG_PATH, size: '25m', limit: { count: 1 }, mkdir: true,
    },
    level,
  }];
  if (config.logConsole) {
    targets.push({ target: 'pino/file', options: { destination: 1 }, level });
  }
  return pino(options, pino.transport({ targets }));
}

const root = buildLogger();

// The pre-pino API took one free-form argument: a string, an Error, or any
// object. Preserve that contract — strings pass through, Errors ride the
// err serializer (stack preserved, message as msg), anything else becomes
// structured fields on the line.
function dispatch(logger, lvl, args) {
  if (args instanceof Error) {
    logger[lvl]({ err: args }, args.message);
  } else if (typeof args === 'string') {
    logger[lvl](args);
  } else if (args && typeof args === 'object') {
    // An object logged without a message renders as an empty msg in every
    // viewer. Stringify it (truncated) into msg so the line reads and greps;
    // the fields still ride the line in full.
    let msg;
    try {
      msg = JSON.stringify(args);
    } catch {
      msg = String(args);
    }
    if (msg.length > 512) msg = `${msg.slice(0, 512)}...`;
    logger[lvl](args, msg);
  } else {
    logger[lvl](String(args));
  }
}

function facade(logger) {
  return {
    error: (args) => dispatch(logger, 'error', args),
    warn: (args) => dispatch(logger, 'warn', args),
    info: (args) => dispatch(logger, 'info', args),
    debug: (args) => dispatch(logger, 'debug', args),
    // Subsystems adopt bindings incrementally: log.child({ mod: 'appSpawner' }).
    child: (bindings) => facade(logger.child(bindings || {})),
  };
}

/**
 * The rolling file pino-roll is currently writing (it numbers its files:
 * fluxos.1.log, fluxos.2.log, …). Null under journald or before the first
 * line is written.
 * @returns {string|null}
 */
function currentLogFile() {
  if (underJournald) return null;
  const dir = path.dirname(LEGACY_LOG_PATH);
  let newest = null;
  let newestN = -1;
  for (const name of fs.readdirSync(dir)) {
    const m = /^fluxos\.(\d+)\.log$/.exec(name);
    if (m && Number(m[1]) > newestN) {
      newestN = Number(m[1]);
      newest = path.join(dir, name);
    }
  }
  return newest;
}

module.exports = {
  ...facade(root),
  /**
   * Which sink this process logs to, for the admin log endpoints: journald
   * (query via journalctl) or the newest legacy rolling file.
   * @returns {{journald: boolean, file: string|null}}
   */
  sinkInfo: () => ({ journald: underJournald, file: currentLogFile() }),
  /**
   * Changes the root logger's level for this process (not persisted - a restart
   * returns to the configured level). Loggers minted with child() before the
   * change keep their own level.
   * @param {string} newLevel One of fatal, error, warn, info, debug, trace
   * @returns {boolean} false when newLevel is not a known level
   */
  setLevel: (newLevel) => {
    if (!LEVELS.includes(newLevel)) return false;
    root.level = newLevel;
    return true;
  },
  /** @returns {string} The root logger's current level. */
  getLevel: () => root.level,
};
