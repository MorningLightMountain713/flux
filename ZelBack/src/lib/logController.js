const winston = require("winston");

const { combine, timestamp, label, printf } = winston.format;

const formatter = printf(({ level, message, label, timestamp }) => {
  return `${timestamp} [${label}] ${level}: ${message}`;
});

const colorsLogger = {
  error: "red",
  warn: "yellow"
  // info: 'cyan',
  // debug: "green"
};

winston.addColors(colorsLogger);

class FluxLogger {
  logger;
  defaultConsole;

  constructor() {
    this.logger = winston.createLogger({
      silent: !process.stdout.isTTY
    });
    this.defaultConsole = new winston.transports.Console({
      level: "info",
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    });

    this.logger.add(this.defaultConsole);
  }

  getLogger() {
    return this.logger;
  }

  addLoggerTransport(type, options = {}) {
    const level = options.logLevel || "info";

    if (type === "file") {
      // add error handling
      this.logger.add(
        new winston.transports.File({
          level: level,
          filename: options.filePath,
          format: combine(label({ label: "fluxOS" }), timestamp(), formatter)
        })
      );
    } else if (type === "console") {
      this.defaultConsole.level = level || this.defaultConsole.level;
    }
  }
}

module.exports = new FluxLogger();
