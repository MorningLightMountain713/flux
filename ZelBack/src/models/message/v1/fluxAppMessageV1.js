// const dbHelper = require("../dbHelper");

const crypto = require('node:crypto');

const zeltrezjs = require('zeltrezjs');
const bitcoinMessage = require('bitcoinjs-message');
const ethereumHelper = require('../ethereumHelper');

const { FluxAppSpec } = require('../../spec/fluxAppSpec');
const { FluxAppMessageBase } = require('../fluxAppMessageBase');

/**
 * @typedef {import('../../spec/v7/fluxAppSpecV7').FluxAppSpecV7} FluxAppSpecV7
 * @typedef {import('../../spec/v8/fluxAppSpecV8').FluxAppSpecV8} FluxAppSpecV8
 * @typedef {(FluxAppSpecV8|FluxAppSpecV7)} FluxAppSpecType
 */

/**
 * @typedef {Object} FluxAppMessageV1Options
 * @property {string?} messageType
 * @property {FluxAppSpecType?} appSpec
 * @property {string?} appSpecHash
 * @property {string?} ownerSignature
 * @property {string?} txId
 * @property {number?} validFromHeight
 * @property {number?} appValue In Satoshis
 */

class FluxAppMessageV1 extends FluxAppMessageBase {
  static version = 1;

  #ethereumSigningEpoch = 1688947200000;

  static mandatoryProperties = ['messageType', 'version', 'appSpec'];

  static dbPropertyMap = {
    messageType: 'type',
    version: 'version',
    appSpec: 'appSpecifications',
    appSpecHash: 'hash',
    timestamp: 'timestamp',
    ownerSignature: 'signature',
    txId: 'txid',
    validFromHeight: 'height',
    appValue: 'valueSat',
  };

  static propValidators = {
    messageType: (input) => this.validateString(input, {
      patterns: [/^fluxapp(?:register|update)$/],
    }),
    version: (input) => this.validateNumber((input, { minValue: 1, maxDecimals: 0 })),
    appSpec: (input) => this.validateAppSpec(input),
    appSpecHash: (input) => this.validateString(input, {
      patterns: [/^[a-fA-F0-9]{64}$/],
    }),
    timestamp: (input) => this.validateNumber(input, { minValue: 0 }),
    ownerSignature: (input) => this.validateString(input, {
      patterns: [/^[0-9a-zA-Z/+=]{88}$/, /^0x[0-9a-fA-F]{130}/],
    }),
    txId: (input) => this.validateString(input, { patterns: [/^[0-9a-fA-f]{64}$/] }),
    validFromHeight: (input) => this.validateNumber(input, {
      minValue: 694000,
      maxDecimals: 0,
    }),
    appValue: (input) => this.validateNumber(input, { maxDecimals: 0 }),
  };

  static validateAppSpec(specBlob) {
    const spec = FluxAppSpec.fromBlob(specBlob);

    if (!spec.viable) {
      return new Error(
        `App Spec missing mandatory properties: ${spec.missingProperties}`,
      );
    }

    return spec;
  }

  static fromBlob(blob) {
    const serialized = this.validateBlob(blob);

    if (!serialized) return new FluxAppMessageV1();

    const { version } = blob;

    if (version && Number(version) !== FluxAppMessageV1.version) {
      return new FluxAppMessageV1();
    }

    const parsed = {};

    // eslint-disable-next-line no-restricted-syntax
    for (const [prop, formatter] of Object.entries(this.propValidators)) {
      const key = this.dbPropertyMap[prop];
      if (blob.hasOwn(key) && blob[key] !== undefined) {
        const value = formatter(blob[key]);

        if (!(value instanceof Error)) parsed[prop] = value;
      }
    }

    return new FluxAppMessageV1(parsed);
  }

  /**
   * @param {FluxAppMessageV1Options} options
   */
  constructor(options = {}) {
    super();

    this.messageType = options.messageType || null;
    this.appSpec = options.appSpec || null;

    this.appSpecHash = options.appSpecHash || null;
    this.timestamp = options.timestamp || null;
    this.ownerSignature = options.ownerSignature || null;
    this.txId = options.txId || null;
    this.validFromHeight = options.validFromHeight || null;
    this.appValue = options.appValue || null;
  }

  get formatted() {
    const formatted = {
      type: this.messageType,
      version: FluxAppMessageV1.version,
      appSpecifications: this.appSpec.formatted,
      hash: this.appSpecHash,
      timestamp: this.timestamp,
      signature: this.ownerSignature,
      txid: this.txId,
      height: this.validFromHeight,
      valueSat: this.appValue,
    };

    return formatted;
  }

  get signaturePayload() {
    return (
      this.messageType
      + FluxAppMessageV1.version
      + this.appSpec.serialized
      + this.timestamp
    );
  }

  get hashPayload() {
    return this.signaturePayload + this.ownerSignature;
  }

  #generateSha256Hash() {
    const hash = crypto.createHash('sha256').update(this.hashPayload);
    return hash.digest('hex');
  }

  verifySha256Hash() {
    console.log('PAYLOAD', this.hashPayload);
    console.log('----');
    console.log(this.#generateSha256Hash());
    return this.appSpecHash === this.#generateSha256Hash();
  }

  verifySignature() {
    const address = this.appSpec.specOwner;
    const signature = this.ownerSignature;
    const message = this.signaturePayload;
    const timestamp = this.timestamp || 0;

    // log
    if (!address || !message || !signature) return false;

    // ethereum
    if (timestamp > this.#ethereumSigningEpoch && address.startsWith('0x')) {
      const signer = ethereumHelper.recoverSigner(message, signature);
      const valid = signer.toLowerCase() === address.toLowerCase();

      return valid;
    }

    // bitcoin
    if (address.length > 36) {
      const pubkeyHash = '00';
      const sigAddress = zeltrezjs.address.pubKeyToAddr(address, pubkeyHash);
      const valid = bitcoinMessage.verify(message, sigAddress, signature);

      return valid;
    }

    return false;
  }
}

module.exports = { FluxAppMessageV1 };

if (require.main === module) {
  // eslint-disable-next-line global-require
  const util = require('node:util');

  const messageRaw = {
    type: 'fluxappupdate',
    version: 1,
    appSpecifications: {
      version: 7,
      name: 'Avax',
      description: 'Avax Node',
      owner: '0x6825236c90738bD64b106160c3EEd79E772b48e5',
      compose: [
        {
          name: 'Avax',
          description: '',
          repotag: 'avaplatform/avalanchego:latest',
          ports: [9650, 9651],
          domains: ['', ''],
          environmentParameters: [],
          commands: [
            '/avalanchego/build/avalanchego',
            '--config-file=/root/.avalanchego/configs/node.json',
          ],
          containerPorts: [9650, 9651],
          containerData: '/root/.avalanchego',
          cpu: 2,
          ram: 8000,
          hdd: 300,
          tiered: false,
          secrets: '',
          repoauth: '',
        },
      ],
      instances: 3,
      contacts: [],
      geolocation: [],
      expire: 22438,
      nodes: [],
      staticip: true,
    },
    hash: '6f3305313b479473a0267ea7f4288e7bc27f281e295c1ebb8081ee794fc1507c',
    timestamp: 1740335729499,
    signature:
      '0x18c7b57f832dfb4d18b5ea24833a7a4eb94c1fd2b1c1040b03b49c53c4f206c40c57f18db26e09d02be61ceacfb2bee2adf91e99132cd0ae3436da2e256cb1dc1c',
    txid: '785a593e05209ddd892890e900e0c110a487ae96af6bc3c801430a8e06a49097',
    height: 1845999,
    valueSat: 2000000,
  };

  const message = FluxAppMessageV1.fromBlob(messageRaw);
  console.log(util.inspect(message, { colors: true }));
  console.log('====');
  console.log(util.inspect(message.formatted, { colors: true, depth: null }));
  console.log('====');
  console.log('SPEC COERSED', message.appSpec.coersed);
  console.log('====');
  console.log('coersedProps', message.appSpec.coersedProps);
  console.log('HASH VERIFIED', message.verifySha256Hash());
  console.log('SIG VERIFIED', message.verifySignature());
}
