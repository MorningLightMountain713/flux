// const dbHelper = require("../dbHelper");

const { FluxAppSpecV8 } = require("../../spec/v8/fluxAppSpecV8");
const { FluxBase } = require("../../fluxBase");

/**
 * @typedef {Object} FluxAppV8Options
 * @property {number?} validFromHeight
 * @property {string?} appSpecHash
 */

class FluxAppV8 extends FluxBase {
  static version = 8;

  static mandatoryProperties = ["appSpecHash", "validFromHeight"];

  static dbPropertyMap = {
    appSpecHash: "hash",
    validFromHeight: "height",
  };

  static propValidators = {
    appSpecHash: (input) =>
      this.validateString(input, {
        patterns: [/^[a-fA-F0-9]{64}$/],
      }),
    validFromHeight: (input) =>
      this.validateNumber(input, {
        minValue: 694000,
        maxDecimals: 0,
      }),
  };

  static fromBlob(blob) {
    const serialized = this.validateBlob(blob);

    if (!serialized) return new FluxAppV8();

    const { version } = blob;

    if (version && Number(version) !== FluxAppV8.version) {
      return new FluxAppV8();
    }

    const parsed = {};

    const { height, hash, ...specBlob } = blob;

    // this could be non viable
    const spec = FluxAppSpecV8.fromBlob(specBlob);

    for (const [prop, formatter] of Object.entries(this.propValidators)) {
      const key = this.dbPropertyMap[prop];
      if (blob.hasOwnProperty(key) && blob[key] !== undefined) {
        const value = formatter(blob[key]);

        if (!(value instanceof Error)) parsed[prop] = value;
      }
    }

    return new FluxAppV8(spec, parsed);
  }

  /**
   * @param {FluxAppSpecV8} appSpec
   * @param {FluxAppV8Options} options
   */
  constructor(appSpec, options = {}) {
    super();

    this.appSpec = appSpec;
    this.validFromHeight = options.validFromHeight || null;
    this.appSpecHash = options.appSpecHash || null;
  }

  get formatted() {
    const formatted = {
      ...this.appSpec.formatted,
      hash: this.appSpecHash,
      height: this.validFromHeight,
    };

    return formatted;
  }
}

module.exports = { FluxAppV8 };
