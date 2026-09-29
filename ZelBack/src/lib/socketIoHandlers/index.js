'use strict';

const { lazyFunction } = require('../moduleLoader');

// Each namespace's connection handler, loaded on its first connection.
module.exports = {
  debug: lazyFunction('lib/socketIoHandlers/debugHandler'),
  terminal: lazyFunction('lib/socketIoHandlers/dockerTerminalHandler'),
  applogs: lazyFunction('lib/socketIoHandlers/appLogsHandler'),
};
