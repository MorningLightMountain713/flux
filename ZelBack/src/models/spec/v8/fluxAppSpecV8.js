// const dbHelper = require("../dbHelper");

const { FluxAppSpecBase } = require("../fluxAppSpecBase");
const { FluxAppSpecComponentV8 } = require("./fluxAppSpecComponentV8");

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
    "name",
    "specOwner",
    "description",
    "instanceCount",
    "components",
  ];

  static frontendPropertyMap = {
    name: "name",
    specOwner: "owner",
    description: "description",
    instanceCount: "instances",
    components: "compose",
    staticIp: "staticip",
    emailContacts: "contacts",
    geoLocation: "geolocation",
    preferredNodes: "nodes",
    expireBlocks: "expire",
    encryptedProps: "enterprise",
  };

  static propValidators = {
    name: (input) => this.validateString(input, { minLen: 3, maxLen: 256 }),
    specOwner: (input) =>
      this.validateString(input, {
        patterns: [/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/, /^0x[a-f0-9A-F]{40}$/],
      }),
    description: (input) =>
      this.validateString(input, { minLen: 3, maxLen: 256 }),
    instanceCount: (input) =>
      this.validateNumber(input, { minValue: 3, maxValue: 100 }),
    components: (input) =>
      this.validateArray(input, {
        memberValidator: (input) => this.validateComponent(input),
      }),
    staticIp: (input) => this.validateBoolean(input),
    emailContacts: (input) =>
      this.validateArray(input, {
        memberValidator: (input) =>
          this.validateString(input, {
            patterns: [
              /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|.(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
            ],
          }),
      }),
    geoLocation: (input) =>
      this.validateArray(input, {
        memberValidator: (input) => this.validateString(input),
      }),
    preferredNodes: (input) =>
      this.validateArray(input, {
        memberValidator: (input) =>
          this.validateString(input, {
            patterns: [
              /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
            ],
          }),
      }),
    expireBlocks: (input) =>
      this.validateNumber(input, {
        minValue: 22000,
        maxValue: 264000,
        maxDecimals: 0,
      }),
    enterprise: (input) => this.validateString(input, { minLen: 128 }),
  };

  static validateComponent(input) {
    const component = FluxAppSpecComponentV8.fromBlob(input);

    if (!component.viable) {
      return new Error(
        `Component missing mandatory properties: ${component.missingProperties}`
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

    for (const [prop, formatter] of Object.entries(this.propValidators)) {
      const key = this.frontendPropertyMap[prop];
      if (blob.hasOwnProperty(key) && blob[key] !== undefined) {
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

  /**
   * @return {FormattedAppSpec}
   */
  get formatted() {
    const formatted = {
      version: FluxAppSpecV8.version,
      name: this.name,
      description: this.description,
      owner: this.specOwner,
      compose: this.components.map((comp) => comp.formatted),
      instances: this.instanceCount,
      contacts: this.emailContacts,
      geolocation: this.geoLocation,
      expire: this.expireBlocks,
      nodes: this.preferredNodes,
      staticip: this.staticIp,
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

  /**
   * @param {number} blockHeight
   * @returns {boolean} If decryption was successful
   */
  async decrypt(blockHeight) {
    // this is ugly

    if (!this.isEnterprise) return false;

    // const blockHeight = this.getblockHeight();

    if (!blockHeight) return false;

    const decryptedProps = await this.decryptProperties(
      this.enterprise,
      this.name,
      blockHeight,
      this.specOwner
    );

    if (!decryptedProps) return false;

    const { contacts, compose: componentsBlob } = decryptedProps;

    this.#decryptedEmailContacts.push(...contacts);

    // components need further processing as the frontend passes stringified data
    componentsBlob.forEach((blob) => {
      const parsed = FluxAppSpecComponentV8.hydrate(blob);
      const component = FluxAppSpecComponentV8.fromBlob(parsed);
      this.#decryptedComponents.push(component);
    });
  }
}

module.exports = { FluxAppSpecV8 };
