// const dbHelper = require("../dbHelper");

const { FluxAppSpecBase } = require('../fluxAppSpecBase');
const { FluxAppSpecComponentV8 } = require('./fluxAppSpecComponentV8');

/**
 * @typedef {Object} FluxAppSpecV8Options
 * @property {string?} name
 * @property {string?} specOwner
 * @property {string?} description
 * @property {number?} instanceCount
 * @property {Array<FluxAppSpecComponentV8>} components
 *
 * @property {boolean?} staticIp
 * @property {number?} expireBlocks
 * @property {Array<string>?} emailContacts
 * @property {Array<string>?} geoLocation
 * @property {Array<string>?} preferredNodes
 * @property {string?} encryptedProps
 */

/**
 * @typedef {Object} FormattedAppSpec
 * @property {string?} name
 * @property {string?} description
 * @property {string?} owner
 * @property {Array<Object>} compose
 * @property {number?} instances
 * @property {Array<string>?} contacts
 * @property {Array<string>?} geolocation
 * @property {number?} expire
 * @property {Array<string>?} nodes
 * @property {boolean?} staticip
 */

class FluxAppSpecV8 extends FluxAppSpecBase {
  static version = 8;

  static mandatoryProperties = [
    'name',
    'specOwner',
    'description',
    'instanceCount',
    'components',
  ];

  static frontendPropertyMap = {
    name: 'name',
    specOwner: 'owner',
    description: 'description',
    instanceCount: 'instances',
    components: 'compose',
    staticIp: 'staticip',
    emailContacts: 'contacts',
    geoLocation: 'geolocation',
    preferredNodes: 'nodes',
    expireBlocks: 'expire',
    encryptedProps: 'enterprise',
  };

  static propValidators = {
    name: (input) => this.validateString(input, { minLen: 3, maxLen: 256 }),
    specOwner: (input) => this.validateString(input, {
      patterns: [/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/, /^0x[a-f0-9A-F]{40}$/],
    }),
    description: (input) => this.validateString(input, { minLen: 3, maxLen: 256 }),
    instanceCount: (input) => this.validateNumber(input, { minValue: 3, maxValue: 100 }),
    components: (input) => this.validateArray(input, {
      memberValidator: (memberInput) => this.validateComponent(memberInput),
    }),
    staticIp: (input) => this.validateBoolean(input),
    emailContacts: (input) => this.validateArray(input, {
      memberValidator: (memberInput) => this.validateString(memberInput, {
        patterns: [
          /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
        ],
      }),
    }),
    geoLocation: (input) => this.validateArray(input, {
      memberValidator: (memberInput) => this.validateString(memberInput),
    }),
    preferredNodes: (input) => this.validateArray(input, {
      memberValidator: (memberInput) => this.validateString(memberInput, {
        patterns: [
          /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
        ],
      }),
    }),
    expireBlocks: (input) => this.validateNumber(input, {
      minValue: 22000,
      maxValue: 264000,
      maxDecimals: 0,
    }),
    encryptedProps: (input) => this.validateString(input, { minLen: 128 }),
  };

  static validateComponent(input) {
    const component = FluxAppSpecComponentV8.fromBlob(input);

    if (!component.viable) {
      return new Error(
        `Component missing mandatory properties: ${component.missingProperties}`,
      );
    }

    return component;
  }

  static fromBlob(blob) {
    const serialized = this.validateBlob(blob);

    if (!serialized) return new FluxAppSpecV8();

    const { version } = blob;

    if (version && Number(version) !== FluxAppSpecV8.version) {
      return new FluxAppSpecV8();
    }

    const parsed = { raw: serialized };

    // eslint-disable-next-line no-restricted-syntax
    for (const [prop, formatter] of Object.entries(this.propValidators)) {
      const key = this.frontendPropertyMap[prop];
      if (blob.hasOwn(key) && blob[key] !== undefined) {
        const value = formatter(blob[key]);

        if (!(value instanceof Error)) parsed[prop] = value;
      }
    }

    return new FluxAppSpecV8(parsed);
  }

  /**
   * @type {Array<FluxAppSpecComponentV8>}
   */
  #decryptedComponents = [];

  /**
   * @type {Array<string>}
   */
  #decryptedEmailContacts = [];

  /**
   * @param {FluxAppSpecV8Options} options
   */
  constructor(options = {}) {
    super(options.raw);

    this.name = options.name || null;
    this.specOwner = options.specOwner || null;
    this.description = options.description || null;
    this.instanceCount = options.instanceCount || null;
    this.components = options.components || null;

    this.emailContacts = options.emailContacts || [];
    this.geoLocation = options.geoLocation || [];
    this.preferredNodes = options.preferredNodes || [];
    this.staticIp = options.staticIp || false;
    this.expireBlocks = options.expireBlocks || 22000;

    this.encryptedProps = options.encryptedProps || null;
  }

  get isEnterprise() {
    return Boolean(this.encryptedProps);
  }

  get decrypted() {
    return Boolean(this.#decryptedComponents.length);
  }

  /**
   * @return {FormattedAppSpec}
   */
  get formatted() {
    const formatted = {
      version: FluxAppSpecV8.version,
      name: this.name,
      description: this.description,
      owner: this.specOwner,
      compose: this.components,
      instances: this.instanceCount,
      contacts: this.emailContacts,
      geolocation: this.geoLocation,
      expire: this.expireBlocks,
      nodes: this.preferredNodes,
      staticip: this.staticIp,
      enterprise: this.encryptedProps,
    };

    return formatted;
  }

  /**
   * @returns {FormattedAppSpec | null}
   */
  get decryptedFormatted() {
    if (!this.decrypted) return null;

    const formatted = {
      version: FluxAppSpecV8.version,
      name: this.name,
      description: this.description,
      owner: this.specOwner,
      compose: this.#decryptedComponents.map((comp) => comp.formatted),
      instances: this.instanceCount,
      contacts: this.#decryptedEmailContacts,
      geolocation: this.geoLocation,
      expire: this.expireBlocks,
      nodes: this.preferredNodes,
      staticip: this.staticIp,
    };

    return formatted;
  }

  get serializedDecrypted() {
    // in the future just change this to sort recursively

    const { ...asObject } = this.formattedDecrypted;

    return FluxAppSpecBase.serializeJson(asObject);
  }

  /**
   * @param {number} blockHeight
   * @returns {boolean} If decryption was successful
   */
  async decrypt(blockHeight) {
    if (!this.isEnterprise) return false;
    if (!blockHeight) return false;

    const decryptedProps = await FluxAppSpecV8.decryptProperties(
      this.encryptedProps,
      this.name,
      blockHeight,
      this.specOwner,
    );

    if (!decryptedProps) return false;

    const { contacts, compose: componentsBlob } = decryptedProps;

    // components and contacts need further processing as the frontend
    // passes stringified data
    this.#decryptedEmailContacts.push(...FluxAppSpecV8.parseJson(contacts));

    componentsBlob.forEach((blob) => {
      const hydrated = FluxAppSpecComponentV8.hydrate(blob);
      const component = FluxAppSpecComponentV8.fromBlob(hydrated);
      this.#decryptedComponents.push(component);
    });

    return true;
  }
}

module.exports = { FluxAppSpecV8 };
