const { FluxAppSpecComponentBase } = require("../fluxAppSpecComponentBase");

/**
 * @typedef {Object} ComponentOptions
 * @property {string?} description
 * @property {string?} encryptedImageAuth
 * @property {Array<string>?} imageCmd
 * @property {string?} volumeMountPoint
 * @property { Array<string>?} envVars
 * @property { Array<string>?} domains
 * @property { Array<string>?} externalPorts
 * @property { Array<string>?} internalPorts
 *
 */

/**
 * strict: No properties can be coersed, order must be correct, no extra properties
 * loose: As long as the required properties are present, it's all good
 * maintainOrder: Properties can be coersed, but the order must be correct
 * @typedef {('strict' | 'loose' | 'maintainOrder')} verifyModeType
 *

/**
 * @typedef {Object} FluxAppSpecComponentV7Options
 * @property {string?} raw
 * @property {string?} name
 * @property {string?} description
 * @property {string?} imageRef
 * @property {number?} cpu
 * @property {number?} memory
 * @property {number?} disk
 * @property {boolean?} tieredResources
 * @property {string?} encryptedSecrets
 * @property {number?} cpuCumulus
 * @property {number?} memoryCumulus
 * @property {number?} diskCumulus
 * @property {number?} cpuNimbus
 * @property {number?} memoryNimbus
 * @property {number?} diskNimbus
 * @property {number?} cpuStratus
 * @property {number?} memoryStratus
 * @property {number?} diskStratus
 * @property {ComponentOptions} options
 */

class FluxAppSpecComponentV7 extends FluxAppSpecComponentBase {
  static mandatoryProperties = ["name", "imageRef", "cpu", "memory", "storage"];

  static frontendPropertyMap = {
    name: "name",
    description: "description",
    imageRef: "repotag",
    encryptedImageAuth: "repoauth",
    imageCmd: "commands",
    externalPorts: "ports",
    internalPorts: "containerPorts",
    volumeMountPoint: "containerData",
    envVars: "environmentParameters",
    domains: "domains",
    cpu: "cpu",
    memory: "ram",
    disk: "hdd",
    tieredResources: "tiered",
    encryptedSecrets: "secrets",
    cpuCumulus: "cpubasic",
    cpuNimbus: "cpusuper",
    cpuStratus: "cpubamf",
    memoryCumulus: "rambasic",
    memoryNimbus: "ramsuper",
    memoryStratus: "rambamf",
    diskCumulus: "hddbasic",
    diskNimbus: "hddsuper",
    diskStratus: "hddbamf",
  };

  static propValidators = {
    name: (input) => this.validateString(input, { minLen: 2, maxLen: 256 }),
    description: (input) =>
      this.validateString(input, { minLen: 2, maxLen: 256 }),
    imageRef: (input) => this.validateString(input, { minLen: 3, maxLen: 256 }),
    cpu: (input) => this.validateNumber(input, { maxDecimals: 2 }),
    memory: (input) => this.validateNumber(input, { snapToExponent: 2 }),
    disk: (input) => this.validateNumber(input, { maxDecimals: 0 }),
    internalPorts: (input) =>
      this.validateArray(input, {
        memberValidator: (input) =>
          this.validateNumber(input, {
            minValue: 1,
            maxValue: 65535,
          }),
      }),
    externalPorts: (input) =>
      this.validateArray(input, {
        memberValidator: (input) =>
          this.validateNumber(input, {
            minValue: 1,
            maxValue: 65535,
          }),
      }),
    envVars: (input) =>
      this.validateArray(input, {
        maxLen: 16,
        memberValidator: (input) =>
          this.validateString(input, {
            minLength: 3,
            maxLength: 256,
          }),
      }),
    commands: (input) =>
      this.validateArray(input, {
        maxLen: 16,
        memberValidator: (input) =>
          this.validateString(input, {
            minLength: 3,
            maxLength: 256,
          }),
      }),
    imageCmd: (input) =>
      this.validateArray(input, {
        maxLen: 16,
        memberValidator: (input) =>
          this.validateString(input, {
            minLength: 3,
            maxLength: 256,
          }),
      }),
    volumeMountPoint: (input) =>
      this.validateString(input, { minLen: 2, maxLen: 256 }),
    encryptedImageAuth: (input) =>
      this.validateString(input, {
        patterns: [
          /^-----BEGIN PGP MESSAGE-----/,
          /-----END PGP MESSAGE-----\n?$/,
        ],
      }),
    domains: (input) =>
      this.validateArray(input, {
        maxLen: 16,
        memberValidator: (input) =>
          this.validateString(input, {
            minLength: 3,
            maxLength: 256,
          }),
      }),
    tieredResources: (input) => this.validateBoolean(input),
    encryptedSecrets: (input) =>
      this.validateString(input, {
        patterns: [
          /^-----BEGIN PGP MESSAGE-----/,
          /-----END PGP MESSAGE-----\n?$/,
        ],
      }),
    cpuCumulus: (input) => this.validateNumber(input, { maxDecimals: 2 }),
    cpuNimbus: (input) => this.validateNumber(input, { maxDecimals: 2 }),
    cpuStratus: (input) => this.validateNumber(input, { maxDecimals: 2 }),
    memoryCumulus: (input) => this.validateNumber(input, { snapToExponent: 2 }),
    memoryNimbus: (input) => this.validateNumber(input, { snapToExponent: 2 }),
    memoryStratus: (input) => this.validateNumber(input, { snapToExponent: 2 }),
    diskCumulus: (input) => this.validateNumber(input, { maxDecimals: 0 }),
    diskNimbus: (input) => this.validateNumber(input, { maxDecimals: 0 }),
    diskStratus: (input) => this.validateNumber(input, { maxDecimals: 0 }),
  };

  /**
   *
   * @param {Object|string} blob Data to be parsed (and coersed) into component
   * @returns {FluxAppSpecComponentV7}
   */
  static fromBlob(blob) {
    const serialized = this.validateBlob(blob);

    if (!serialized) return new FluxAppSpecComponentV7();

    const parsed = { raw: serialized };

    for (const [prop, formatter] of Object.entries(this.propValidators)) {
      const key = this.frontendPropertyMap[prop];
      if (blob.hasOwnProperty(key) && blob[key] !== undefined) {
        const value = formatter(blob[key]);

        if (!(value instanceof Error)) parsed[prop] = value;
      }
    }

    // the internal ports needs to match the external ports. The internal ports
    // have priority. I.e. if there are only 3 internal ports and 5 external,
    // the last 2 external will be trimmed. If external ports are missing, or there
    // are less external ports than internal, random external ports will be generated.

    // If there are no internal ports and external ports, we strip the external.

    if (!("internalPorts" in parsed)) {
      parsed.externalPorts = [];
      return new FluxAppSpecComponentV7(parsed);
    }

    const { internalPorts, externalPorts } = parsed;
    const internalPortsCount = internalPorts.length;

    if (!externalPorts) {
      parsed.externalPorts = this.generateRandomPorts({
        count: internalPortsCount,
      });
    } else if (internalPortsCount > externalPorts.length) {
      const missingCount = internalPortsCount - externalPorts.length;
      const newPorts = this.generateRandomPorts({
        count: missingCount,
        excluded: externalPorts,
      });
      parsed.externalPorts = externalPorts.concat(newPorts);
    } else if (externalPorts.length > internalPortsCount) {
      const slicedPorts = externalPorts.slice(0, internalPortsCount);
      parsed.externalPorts = slicedPorts;
    }

    return new FluxAppSpecComponentV7(parsed);
  }

  /**
   * Verifies if the passed in blob is able to be used as a v8 component. There
   * are two modes "loose", and "strict".
   *
   * Loose: Only verifies that the blob is able to be used as a component. Extra keys,
   * are removed, any non mandatory keys - the defaults are used. Any values are coersed
   * into the correct types (if possible). Keys are accepted in any order.
   *
   * Strict: Blob must match exactly the keys and values required. No values are coersed.
   * Keys must be ordered correctly, as per the spec.
   *
   * maintainOrder: Same as loose, except the keys must be in the correct order.
   * @param {*} blob
   * @param {{mode?: verifyModeType}} options
   * @returns {boolean}
   */
  static verify(blob, options = {}) {
    const mode = options.mode || "strict";

    const spec = FluxAppSpecComponentV7.fromBlob(blob);

    if (!spec) return false;

    if (mode === "strict") return spec.viable && !spec.coersed;

    if (mode === "maintainOrder") return spec.viable && !spec.reordered;

    // mode === "loose"
    return spec.viable;
  }

  /**
   *
   * @param {FluxAppSpecComponentV7Options?} options
   */
  constructor(options = {}) {
    super(options.raw);

    this.name = options.name || null;
    this.imageRef = options.imageRef || null;
    this.cpu = options.cpu || null;
    this.memory = options.memory || null;
    this.disk = options.disk || null;

    this.description = options.description || "";
    this.encryptedImageAuth = options.encryptedImageAuth || "";
    this.volumeMountPoint = options.volumeMountPoint || "/tmp";
    this.imageCmd = options.imageCmd || [];
    this.envVars = options.envVars || [];
    this.domains = options.domains || [];
    this.externalPorts = options.externalPorts || [];
    this.internalPorts = options.internalPorts || [];

    this.tieredResources = options.tieredResources || false;
    this.encryptedSecrets = options.encryptedSecrets || null;
    this.cpuCumulus = options.cpuCumulus || null;
    this.cpuNimbus = options.cpuNimbus || null;
    this.cpuStratus = options.cpuStratus || null;
    this.memoryCumulus = options.cpuCumulus || null;
    this.memoryNimbus = options.cpuNimbus || null;
    this.memoryStratus = options.cpuStratus || null;
    this.diskCumulus = options.diskCumulus || null;
    this.diskStratus = options.diskStratus || null;
    this.diskStratus = options.diskStratus || null;
  }

  get formatted() {
    const formatted = {
      name: this.name,
      description: this.description,
      repotag: this.imageRef,
      ports: this.externalPorts,
      domains: this.domains,
      environmentParameters: this.envVars,
      commands: this.imageCmd,
      containerPorts: this.internalPorts,
      containerData: this.volumeMountPoint,
      cpu: this.cpu,
      ram: this.memory,
      hdd: this.disk,
      tiered: this.tieredResources,
      secrets: this.encryptedSecrets || "",
      repoauth: this.encryptedImageAuth || "",
      ...(this.cpuCumulus && { cpubasic: this.cpuCumulus }),
      ...(this.cpuNimbus && { cpubasic: this.cpuNimbus }),
      ...(this.cpuStratus && { cpubasic: this.cpuStratus }),
      ...(this.memoryCumulus && { ramsuper: this.memoryCumulus }),
      ...(this.memoryNimbus && { ramsuper: this.memoryNimbus }),
      ...(this.memoryStratus && { ramsuper: this.memoryStratus }),
      ...(this.diskCumulus && { hddbamf: this.diskCumulus }),
      ...(this.diskNimbus && { hddbamf: this.diskNimbus }),
      ...(this.diskStratus && { hddbamf: this.diskStratus }),
    };

    return formatted;
  }
}

module.exports = { FluxAppSpecComponentV7 };

if (require.main === module) {
  const componentRaw = {
    name: "hns",
    description: "hns",
    repotag: "wirewrex/flux-mini-fdm:flux",
    ports: [80, 443, 8080],
    domains: ["", "", ""],
    environmentParameters: [
      "DNS_SERVER_ADDRESS=https://varo.domains/api",
      "APP_NAME=radiusraid",
      "APP_PORT=36025",
      "DOMAIN=radiusraid.fluxos",
      "CERT=self",
      "FRONTEND_HEALTH_INTERVAL=1",
      "BACKEND_HEALTH_INTERVAL=90",
    ],
    commands: [],
    containerPorts: [80, 443, 8080],
    containerData: "s:/etc/nginx/certs",
    cpu: 0.5,
    ram: 500,
    hdd: 2,
    tiered: false,
    secrets:
      "-----BEGIN PGP MESSAGE-----\n" +
      "\n" +
      "wV4D6mskXDC1VCISAQdAJblAPKKGoNWmeTn1f6Cz5Z5mZAS1tRGQMJg1mkgR\n" +
      "Hj8woaBoxZfBlr82+zOyFO/PHsyGFTxtq6nGMFqYqGlJON0oUAojN+i3fGY/\n" +
      "o6KRy2BuwV4DIQjou+KIbE4SAQdAADeQjZcXBP5B4hO/t4C2VbgmtCboa3wD\n" +
      "6FaY8AKiz0swfyGAompyBJ3zAEDluexeFKK/r+yfh/zKd+VDmU7U0osGcV/j\n" +
      "ONF8Kk/H2p2VNsoDwV4DiiYPyUUfk0ASAQdABxRZBv6a/d5aMH8p5aViO2Sn\n" +
      "qKpf3XrV/MliiLvp2n4wO/+ryAVn2hTZ/bsyZ6SNPnanUQgRu7fIouYphngw\n" +
      "dPHOxlibcEWEnqiTHibc1djbwV4DkGvPGUJ5geYSAQdAk4kc2rxugexas7Se\n" +
      "D+esrkPAfRlf4qtlYCB+FPzIOxEw5e61ZyPdHXdJVlgTYRBBOduDtNEsJ4Uj\n" +
      "pbFz5UNnrVWBDOIZH2EPXeootXXOv/1lwV4Dg3VrpxVVk9ESAQdAi7cT+YjK\n" +
      "JsxsI6ePPV87p8FrWDhJc1Skj3fgRRL+j3Mwex0K6vD9ntSXbk8OoaPw+4H+\n" +
      "e1/XFXl02JcRZ0AEsw34ol60Y2KS7HHTCuW3a7JVwV4D25W+/+WcopUSAQdA\n" +
      "x91ginwdqOm65y4WNbbePmPJ9wivPG8jVbUrfjWurhgwf15S+pTPrzWKpyG/\n" +
      "1YiXHjcP6ttdchP3ZwdOjccnHj5L81beuxCbiO58UbfLuhRVwV4Douz1Matb\n" +
      "1rISAQdA2Y+XFur5Pq+agUc344p1cF6gN011Y9PCX0h9Lml+DkAwNqE3g6eB\n" +
      "f/Rx++eHiky+i7P26NVAhin3ZQ11Xy3x8sn5OTpQ9QQbaGEMWyPdLjsewV4D\n" +
      "Wth77XD61XsSAQdACGqX/zNcquEGa7iVBZvmqoT3H0XOahtGw2xQlMEUEXgw\n" +
      "GqlbKKXtQbGkt+VCr+VzIW/GIFVuPiZs6jXo52BbewLg3z7hHrN14MKQqMaG\n" +
      "yThq0mgBIm2v1sdikkV+VyrCuMOJtnwGZaVwKgC6/Lj8Dt+7ir2/37NRlDAi\n" +
      "nMKcOcjjZ21pPUpCdMZOmg9fSoIaKliaSbxTcLPGFxBwa5yYlHqYXAPFGz3Z\n" +
      "iCUxrDwGLNJpM9A5+aqg2n1iBA==\n" +
      "=BPQ0\n" +
      "-----END PGP MESSAGE-----\n",
    repoauth: "",
  };

  console.log(componentRaw);

  const component1 = FluxAppSpecComponentV7.fromBlob(componentRaw);
  const component2 = FluxAppSpecComponentV7.fromBlob(componentRaw);
  console.log("----");
  console.log(component1);
  console.log("----");
  console.log(component1.formatted);
  console.log("VIABLE", component1.viable);
  console.log("----");
  console.log(component1.serialized);
  console.log("----");
  console.log("EQUAL", component1.equal(component2));
  // console.log(FluxAppComponent.generateRandomPorts({ count: 7 }));
}
