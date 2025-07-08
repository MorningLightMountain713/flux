const { FluxAppSpecComponentBase } = require('../fluxAppSpecComponentBase');

/**
 * @typedef {Object} ComponentOptions
 * @property {string?} description
 * @property {string?} imageAuth
 * @property {Array<string>?} imageCmd
 * @property {string?} volumeMountPoint
 * @property { Array<string>?} envVars
 * @property { Array<string>?} domains
 * @property { Array<string>?} externalPorts
 * @property { Array<string>?} internalPorts
 *
 */

/**
 * @typedef {Object} FluxAppSpecComponentV8Options
 * @property {string?} raw
 * @property {string?} name
 * @property {string?} description
 * @property {string?} imageRef
 * @property {number?} cpu
 * @property {number?} ram
 * @property {number?} hdd
 * @property {ComponentOptions} options
 */

class FluxAppSpecComponentV8 extends FluxAppSpecComponentBase {
  static mandatoryProperties = ['name', 'imageRef', 'cpu', 'memory', 'storage'];

  static frontendPropertyMap = {
    name: 'name',
    description: 'description',
    imageRef: 'repotag',
    imageAuth: 'repoauth',
    imageCmd: 'commands',
    externalPorts: 'ports',
    internalPorts: 'containerPorts',
    volumeMountPoint: 'containerData',
    envVars: 'environmentParameters',
    domains: 'domains',
    cpu: 'cpu',
    memory: 'ram',
    disk: 'hdd',
  };

  static propValidators = {
    name: (input) => this.validateString(input, { minLen: 2, maxLen: 256 }),
    description: (input) => this.validateString(input, { minLen: 2, maxLen: 256 }),
    imageRef: (input) => this.validateString(input, { minLen: 3, maxLen: 256 }),
    cpu: (input) => this.validateNumber(input, { maxDecimals: 2 }),
    memory: (input) => this.validateNumber(input, { snapToExponent: 2 }),
    disk: (input) => this.validateNumber(input, { maxDecimals: 0 }),
    internalPorts: (input) => this.validateArray(input, {
      memberValidator: (memberInput) => this.validateNumber(memberInput, {
        minValue: 1,
        maxValue: 65535,
      }),
    }),
    externalPorts: (input) => this.validateArray(input, {
      memberValidator: (memberInput) => this.validateNumber(memberInput, {
        minValue: 1,
        maxValue: 65535,
      }),
    }),
    envVars: (input) => this.validateArray(input, {
      maxLen: 16,
      memberValidator: (memberInput) => this.validateString(memberInput, {
        minLength: 3,
        maxLength: 256,
      }),
    }),
    commands: (input) => this.validateArray(input, {
      maxLen: 16,
      memberValidator: (memberInput) => this.validateString(memberInput, {
        minLength: 3,
        maxLength: 256,
      }),
    }),
    imageCmd: (input) => this.validateArray(input, {
      maxLen: 16,
      memberValidator: (memberInput) => this.validateString(memberInput, {
        minLength: 3,
        maxLength: 256,
      }),
    }),
    volumeMountPoint: (input) => this.validateString(input, { minLen: 2, maxLen: 256 }),
    imageAuth: (input) => this.validateString(input, { minLen: 2, maxLen: 256 }),
    domains: (input) => this.validateArray(input, {
      maxLen: 16,
      memberValidator: (memberInput) => this.validateString(memberInput, {
        minLength: 3,
        maxLength: 256,
      }),
    }),
  };

  /**
   * This is ugly. We only have to do this because the frontend passes arrays as strings
   *
   * @param {Object} blob
   */
  static hydrate(blob) {
    const parsed = {};

    // eslint-disable-next-line no-restricted-syntax
    for (const [key, value] of Object.entries(blob)) {
      if (value.startsWith('[') && value.endsWith(']')) {
        parsed[key] = this.parseJson(value);
      } else {
        parsed[key] = value;
      }
    }

    return parsed;
  }

  /**
   *
   * @param {Object|string} blob Data to be parsed (and coersed) into component
   * @returns {FluxAppSpecComponentV8}
   */
  static fromBlob(blob) {
    const serialized = this.validateBlob(blob);

    if (!serialized) return new FluxAppSpecComponentV8();

    const parsed = { raw: serialized };

    // eslint-disable-next-line no-restricted-syntax
    for (const [prop, formatter] of Object.entries(this.propValidators)) {
      const key = this.frontendPropertyMap[prop];
      if (blob.hasOwn(key) && blob[key] !== undefined) {
        const value = formatter(blob[key]);

        if (!(value instanceof Error)) parsed[prop] = value;
      }
    }

    // the internal ports needs to match the external ports. The internal ports
    // have priority. I.e. if there are only 3 internal ports and 5 external,
    // the last 2 external will be trimmed. If external ports are missing, or there
    // are less external ports than internal, random external ports will be generated.

    // If there are no internal ports and external ports, we strip the external.

    if (!('internalPorts' in parsed)) {
      parsed.externalPorts = [];
      return new FluxAppSpecComponentV8(parsed);
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

    return new FluxAppSpecComponentV8(parsed);
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
    const mode = options.mode || 'strict';

    const spec = FluxAppSpecComponentV8.fromBlob(blob);

    if (!spec) return false;

    if (mode === 'strict') return spec.viable && !spec.coersed;

    if (mode === 'maintainOrder') return spec.viable && !spec.reordered;

    // mode === "loose"
    return spec.viable;
  }

  /**
   *
   * @param {FluxAppSpecComponentV8Options?} options
   */
  constructor(options = {}) {
    super(options.raw);

    this.name = options.name || null;
    this.imageRef = options.imageRef || null;
    this.cpu = options.cpu || null;
    this.memory = options.memory || null;
    this.disk = options.disk || null;

    this.description = options.description || '';
    this.imageAuth = options.imageAuth || '';
    this.volumeMountPoint = options.volumeMountPoint || '/tmp';
    this.imageCmd = options.imageCmd || [];
    this.envVars = options.envVars || [];
    this.domains = options.domains || [];
    this.externalPorts = options.externalPorts || [];
    this.internalPorts = options.internalPorts || [];
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
      repoauth: this.imageAuth,
    };

    return formatted;
  }
}

module.exports = { FluxAppSpecComponentV8 };

if (require.main === module) {
  const componentRaw = {
    name: 'node',
    description: 'The Presearch node container',
    repotag: 'presearch/node:latest',
    ports: [39000, 8181, 7254],
    domains: ['gravy.train.com'],
    environmentParameters: [
      'STAKE=disconnected:oldest#flux,wallet:minimum',
      'ALLOW_DISCONNECTED_STAKE_TRANSFER_AFTER=30m',
      'TAGS=flux',
      'URL=https://home.runonflux.io',
      'F_S_ENV=https://storage.runonflux.io/v2/env/presearch',
      'REGISTRATION_CODE=194995fbb559f37e7c517d4293b66edb',
      'DESCRIPTION=',
    ],
    commands: ['/bin/runner', 'ls', '-la'],
    containerPorts: [80, 3333, 7676],
    containerData: '/app/node',
    cpu: 0.3,
    ram: 333,
    hdd: 232.3,
    repoauth: 'gravySausage:weiner123',
  };

  console.log(componentRaw);

  const component1 = FluxAppSpecComponentV8.fromBlob(componentRaw);
  const component2 = FluxAppSpecComponentV8.fromBlob(componentRaw);
  console.log('----');
  console.log(component1);
  console.log('----');
  console.log(component1.formatted);
  console.log('VIABLE', component1.viable);
  console.log('----');
  console.log(component1.serialized);
  console.log('----');
  console.log('EQUAL', component1.equal(component2));
  // console.log(FluxAppComponent.generateRandomPorts({ count: 7 }));
}
