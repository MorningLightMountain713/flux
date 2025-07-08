// const dbHelper = require("../dbHelper");

const { FluxBase } = require('../fluxBase');

class FluxAppMessageBase extends FluxBase {
  // eslint-disable-next-line class-methods-use-this
  hash() {
    throw FluxBase.notImplemented;
  }
}

module.exports = { FluxAppMessageBase };
