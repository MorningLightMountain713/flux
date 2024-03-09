const pino = require('pino');
const util = require('util')
const path = require('path')

// const logController = require('./logController')


// const log = logController.getLogger();
const homeDir = path.join(__dirname, '../../../');
const levels = ["debug", "info", "error"];

// levels.forEach((level) => {
//   const filePath = path.join(homeDir, `${level}.log`);
//   logController.addLoggerTransport("file", { level, filePath });
// });

const targets = levels.map((level) => {
  const destination = path.join(homeDir, `${level}.log`);
  return { level, target: 'pino/file', options: { destination } }
})

// const transports = pino.transport({
//   targets: [{
//     level: 'info',
//     target: 'pino/file'
//   }, {
//     level: 'trace',
//     target: 'pino/file',
//     options: { destination: '/path/to/store/logs' }
//   }]
// })

fileLogs = pino(pino.transport({ targets }))


// const transport = pino.transport({
//   level: 'debug',
//   target: 'pino-pretty',
//   options: {
//     crlf: true
//     // destination: 1
//     // translateTime: 'yyyy-mm-dd HH:MM:ss:L',
//   }
// })

// const log = pino(transport);

// module.exports = log

// https://en.m.wikipedia.org/wiki/ANSI_escape_code#Colors
const colors = {
  error: "\x1b[91m", // bright red
  warn: "\x1b[33m", // yellow
  info: '\x1b[32m', // green
  debug: "\x1b36m", // cyan
  reset: "\x1b[0m"
};

const logger = (logType) => {
  return (...args) => {
    const time = new Date().toISOString()
    const output = util.formatWithOptions({ colors: true }, time, `${colors[logType]}${logType}${colors['reset']}:`, ...args)
    const flushed = process.stdout.write(output.replace(/\n/g, '\r\n') + '\r\n');
    if (!flushed) {
      process.exit()
    }
    fileLogs[logType](...args)
  }
}

module.exports = {
  info: logger('info'),
  debug: logger('debug'),
  error: logger('error'),
  warn: logger('warn'),
};
