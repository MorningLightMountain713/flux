// const dbHelper = require("../dbHelper");

const { FluxBase } = require("../fluxBase");

class FluxAppMessageBase extends FluxBase {
  hash() {
    throw FluxBase.notImplemented;
  }
}

module.exports = { FluxAppMessageBase };
