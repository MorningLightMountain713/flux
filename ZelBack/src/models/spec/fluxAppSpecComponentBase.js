const { FluxAppSpecBase } = require("./fluxAppSpecBase");

class FluxAppSpecComponentBase extends FluxAppSpecBase {
  static mandatoryProperties = [];
  static frontendPropertyMap = {};
  static propValidators = {};

  static generateRandomPorts(options = {}) {
    const count = options.count || 1;
    const excluded = options.excluded ? new Set(options.excluded) : new Set();

    // memory? Could just use random but that could get tricky with excluded ports
    const allPorts = Array.from({ length: 65535 }, (v, k) => k + 1);

    // looking forward to Set.prototype.difference... lol
    const ports = new Set(allPorts.filter((x) => !excluded.has(x)));

    const randomPorts = [];

    while (randomPorts.length < count) {
      const portIndex = Math.floor(Math.random() * ports.size);
      const port = Array.from(ports)[portIndex];
      ports.delete(port);
      randomPorts.push(port);
    }

    return randomPorts;
  }

  static fromFrontendBlob(_data) {
    throw FluxAppSpecBase.notImplemented;
  }
}

module.exports = { FluxAppSpecComponentBase };
