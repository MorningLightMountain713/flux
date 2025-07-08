// const dbHelper = require("../dbHelper");

const { FluxAppSpecBase } = require('../fluxAppSpecBase');
const { FluxAppSpecComponentV7 } = require('./fluxAppSpecComponentV7');

/**
 * @typedef {Object} FluxAppSpecV7Options
 * @property {string?} name
 * @property {string?} specOwner
 * @property {string?} description
 * @property {number?} instanceCount
 * @property {Array<FluxAppSpecComponentV7>} components
 *
 * @property {boolean?} staticIp
 * @property {number?} expireBlocks
 * @property {Array<string>?} emailContacts
 * @property {Array<string>?} geoLocation
 * @property {Array<string>?} installNodes
 */

class FluxAppSpecV7 extends FluxAppSpecBase {
  static version = 7;

  static mandatoryProperties = [
    'name',
    'specOwner',
    'description',
    'instanceCount',
    'components',
  ];

  static propertyMap = {
    name: 'name',
    specOwner: 'owner',
    description: 'description',
    instanceCount: 'instances',
    components: 'compose',
    staticIp: 'staticip',
    emailContacts: 'contacts',
    geoLocation: 'geolocation',
    installNodes: 'nodes',
    expireBlocks: 'expire',
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
    installNodes: (input) => this.validateArray(input, {
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
  };

  static validateComponent(input) {
    const component = FluxAppSpecComponentV7.fromBlob(input);

    if (!component.viable) {
      return new Error(
        `Component missing mandatory properties: ${component.missingProperties}`,
      );
    }

    return component;
  }

  static fromBlob(blob) {
    const serialized = this.validateBlob(blob);

    if (!serialized) return new FluxAppSpecV7();

    const { version } = blob;

    if (version && Number(version) !== FluxAppSpecV7.version) {
      return new FluxAppSpecV7();
    }

    const parsed = { raw: serialized };

    // eslint-disable-next-line no-restricted-syntax
    for (const [prop, formatter] of Object.entries(this.propValidators)) {
      const key = this.propertyMap[prop];
      if (blob.hasOwn(key) && blob[key] !== undefined) {
        const value = formatter(blob[key]);

        if (!(value instanceof Error)) parsed[prop] = value;
      }
    }

    return new FluxAppSpecV7(parsed);
  }

  /**
   * @param {FluxAppSpecV7Options} options
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
    this.installNodes = options.installNodes || [];
    this.staticIp = options.staticIp || false;
    this.expireBlocks = options.expireBlocks || 22000;
  }

  get formatted() {
    const formatted = {
      version: FluxAppSpecV7.version,
      name: this.name,
      description: this.description,
      owner: this.specOwner,
      compose: this.components.map((comp) => comp.formatted),
      instances: this.instanceCount,
      contacts: this.emailContacts,
      geolocation: this.geoLocation,
      expire: this.expireBlocks,
      nodes: this.installNodes,
      staticip: this.staticIp,
    };

    return formatted;
  }
}

module.exports = { FluxAppSpecV7 };

if (require.main === module) {
  // eslint-disable-next-line global-require
  const util = require('node:util');

  const specRaw = {
    version: 7,
    name: 'test',
    description: 'tst',
    owner: '1ECC8hg91C8u3Hg5JFnzL9ZSgBP78fwRv9',
    compose: [
      {
        name: 'hns',
        description: 'hns',
        repotag: 'wirewrex/flux-mini-fdm:flux',
        ports: [80, 443, 8080],
        domains: ['', '', ''],
        environmentParameters: [
          'DNS_SERVER_ADDRESS=https://varo.domains/api',
          'APP_NAME=radiusraid',
          'APP_PORT=36025',
          'DOMAIN=radiusraid.fluxos',
          'CERT=self',
          'FRONTEND_HEALTH_INTERVAL=1',
          'BACKEND_HEALTH_INTERVAL=90',
        ],
        commands: [],
        containerPorts: [80, 443, 8080],
        containerData: 's:/etc/nginx/certs',
        cpu: 0.5,
        ram: 500,
        hdd: 2,
        tiered: false,
        secrets:
          '-----BEGIN PGP MESSAGE-----\n'
          + '\n'
          + 'wV4D6mskXDC1VCISAQdAJblAPKKGoNWmeTn1f6Cz5Z5mZAS1tRGQMJg1mkgR\n'
          + 'Hj8woaBoxZfBlr82+zOyFO/PHsyGFTxtq6nGMFqYqGlJON0oUAojN+i3fGY/\n'
          + 'o6KRy2BuwV4DIQjou+KIbE4SAQdAADeQjZcXBP5B4hO/t4C2VbgmtCboa3wD\n'
          + '6FaY8AKiz0swfyGAompyBJ3zAEDluexeFKK/r+yfh/zKd+VDmU7U0osGcV/j\n'
          + 'ONF8Kk/H2p2VNsoDwV4DiiYPyUUfk0ASAQdABxRZBv6a/d5aMH8p5aViO2Sn\n'
          + 'qKpf3XrV/MliiLvp2n4wO/+ryAVn2hTZ/bsyZ6SNPnanUQgRu7fIouYphngw\n'
          + 'dPHOxlibcEWEnqiTHibc1djbwV4DkGvPGUJ5geYSAQdAk4kc2rxugexas7Se\n'
          + 'D+esrkPAfRlf4qtlYCB+FPzIOxEw5e61ZyPdHXdJVlgTYRBBOduDtNEsJ4Uj\n'
          + 'pbFz5UNnrVWBDOIZH2EPXeootXXOv/1lwV4Dg3VrpxVVk9ESAQdAi7cT+YjK\n'
          + 'JsxsI6ePPV77p8FrWDhJc1Skj3fgRRL+j3Mwex0K6vD9ntSXbk8OoaPw+4H+\n'
          + 'e1/XFXl02JcRZ0AEsw34ol60Y2KS7HHTCuW3a7JVwV4D25W+/+WcopUSAQdA\n'
          + 'x91ginwdqOm65y4WNbbePmPJ9wivPG8jVbUrfjWurhgwf15S+pTPrzWKpyG/\n'
          + '1YiXHjcP6ttdchP3ZwdOjccnHj5L81beuxCbiO58UbfLuhRVwV4Douz1Matb\n'
          + '1rISAQdA2Y+XFur5Pq+agUc344p1cF6gN011Y9PCX0h9Lml+DkAwNqE3g6eB\n'
          + 'f/Rx++eHiky+i7P26NVAhin3ZQ11Xy3x8sn5OTpQ9QQbaGEMWyPdLjsewV4D\n'
          + 'Wth77XD61XsSAQdACGqX/zNcquEGa7iVBZvmqoT3H0XOahtGw2xQlMEUEXgw\n'
          + 'GqlbKKXtQbGkt+VCr+VzIW/GIFVuPiZs6jXo52BbewLg3z7hHrN14MKQqMaG\n'
          + 'yThq0mgBIm2v1sdikkV+VyrCuMOJtnwGZaVwKgC6/Lj8Dt+7ir2/37NRlDAi\n'
          + 'nMKcOcjjZ21pPUpCdMZOmg9fSoIaKliaSbxTcLPGFxBwa5yYlHqYXAPFGz3Z\n'
          + 'iCUxrDwGLNJpM9A5+aqg2n1iBA==\n'
          + '=BPQ0\n'
          + '-----END PGP MESSAGE-----\n',
        repoauth: '',
      },
    ],
    instances: 3,
    contacts: [],
    geolocation: [],
    expire: 22000,
    nodes: [
      '38.88.125.124',
      '65.109.29.157',
      '168.119.138.140',
      '65.109.29.206',
      '144.76.199.15',
      '65.108.72.251',
      '38.88.125.52',
      '94.130.141.124',
    ],
    staticip: false,
  };

  const spec = FluxAppSpecV7.fromBlob(specRaw);

  if (!spec) process.exit();
  console.log(util.inspect(spec, { colors: true }));
  console.log('----');

  spec.components.forEach((component) => {
    console.log('COERSED COMPONENT', component.coersed);
    console.log('COERSED PROPS', component.coersedProps);
  });
  console.log('----');
  specRaw.compose.forEach((component) => {
    const verifiedLoose = FluxAppSpecComponentV7.verify(component, {
      strict: false,
    });
    const verifiedStrict = FluxAppSpecComponentV7.verify(component);
    console.log('LOOSE', verifiedLoose, 'STRICT', verifiedStrict);
  });
  console.log('----');
  console.log('VIABLE', spec.viable);
  console.log('COERSED APP SPEC:', spec.coersed);
  console.log(util.inspect(spec.coersedProps, { colors: true, depth: null }));
  console.log('----');
  console.log(util.inspect(spec.formatted, { colors: true, depth: null }));
  console.log('----');
  console.log(spec.serialized);
}
