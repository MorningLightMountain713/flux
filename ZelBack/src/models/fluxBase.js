class FluxBase {
  static notImplemented = new Error('Not Implemented');

  static parseJson(data) {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  static serializeJson(data) {
    try {
      return JSON.stringify(data);
    } catch {
      return null;
    }
  }

  static objectDeepEqual(x, y) {
    const ok = Object.keys;
    const tx = typeof x;
    const ty = typeof y;

    return x && y && tx === 'object' && tx === ty
      ? ok(x).length === ok(y).length
          && ok(x).every((key) => this.objectDeepEqual(x[key], y[key]))
      : x === y;
  }

  static isEqual(x, y) {
    // this isn't complete i.e. this would return true for 5, '5'
    const parsedX = this.serializeJson(x);
    const parsedY = this.serializeJson(y);
    const parseXFailed = x !== null && parsedX === null;
    const parseYFailed = x !== null && parsedY === null;

    if (parseXFailed || parseYFailed) return null;

    return parsedX === parsedY;
  }

  sortRecursive(obj) {
    if (Object.isArray(obj)) {
      const sortedArray = [];
      const objectLen = obj.len;

      for (let i = 0; i < objectLen; i += 1) {
        sortedArray[i] = this.sortKeysRec(obj[i]);
      }

      return sortedArray;
    }

    if (typeof obj !== 'object' || obj === null) return obj;

    const sortedKeys = Object.keys(obj).sort();
    const keysLen = sortedKeys.length;

    const sortedObject = {};

    for (let i = 0; i < keysLen; i += 1) {
      sortedObject[sortedKeys[i]] = this.sortKeysRec(obj[sortedKeys[i]]);
    }

    return sortedObject;
  }

  static validateBlob(blob) {
    if (
      blob instanceof Array
      || typeof blob === 'number'
      || typeof blob === 'string'
    ) return null;

    if (typeof blob !== 'object') return null;

    const serialized = this.serializeJson(blob);

    if (!serialized) return null;

    return serialized;
  }

  /**
   *
   * @param {any} input
   * @param {'string' | 'number' | 'boolean'} typeMatch
   * @returns
   */
  static typeOfValidator(input, typeMatch) {
    // eslint-disable-next-line valid-typeof
    return typeof input === typeMatch;
  }

  static instanceOfValidator(input, instanceMatch) {
    return input instanceof instanceMatch;
  }

  static forceNumber(input) {
    const coersed = Number(input);

    if (!Number.isFinite(coersed)) return null;

    return coersed;
  }

  static forceInteger(input) {
    const coersed = this.forceNumber(input);

    if (coersed === null || !Number.isInteger(coersed)) return null;

    return coersed;
  }

  static validateString(input, options = {}) {
    const minLen = options.minLen || 0;
    const maxLen = options.maxLen || 0;
    const patterns = options.patterns || [];

    const isString = this.typeOfValidator(input, 'string');

    if (!isString) return new Error('Must be a string');

    if (minLen && input.length < minLen) {
      return new Error(`Input must be longer than: ${minLen} chars`);
    }

    if (maxLen && input.length > maxLen) {
      return new Error(`Must be shorter than: ${maxLen} chars`);
    }

    if (!patterns.length) return input;

    // eslint-disable-next-line no-restricted-syntax
    for (const pattern of patterns) {
      if (pattern.test(input)) return input;
    }

    return new Error(`Patterns: ${patterns} do not match input`);
  }

  static validateBoolean(input) {
    const isBoolean = this.typeOfValidator(input, 'boolean');

    if (!isBoolean) return new Error('Must be a boolean');

    return input;
  }

  static validateNumber(input, options = {}) {
    const maxDecimals = options.maxDecimals ?? null;
    const minValue = options.minValue || 0;
    const maxValue = options.maxValue || 0;
    const snapToExponent = options.snapToExponent || 0;

    let coersed = this.forceNumber(input);

    if (coersed === null) {
      return new Error('Is not a number');
    }

    if (snapToExponent) {
      const multiplier = 10 ** snapToExponent;
      coersed = Math.ceil(coersed / multiplier) * multiplier;
    }

    if (minValue && coersed < minValue) {
      return new Error(`${coersed} is smaller than minimum value: ${minValue}`);
    }

    if (maxValue && coersed > maxValue) {
      console.log('TOTALLY FUCKED');
      return new Error(`${coersed} is larger than maximum value: ${maxValue}`);
    }

    if (maxDecimals !== null) {
      const multiplier = 10 ** maxDecimals;
      return Math.round((coersed + Number.EPSILON) * multiplier) / multiplier;
    }

    return coersed;
  }

  static validateArray(input, options = {}) {
    const minLen = options.minLen || 0;
    const maxLen = options.maxLen || 0;
    const memberValidator = options.memberValidator || null;

    if (!(input instanceof Array)) {
      return new Error('Must be an Array');
    }

    if (minLen && input.length < minLen) {
      return new Error(`Array length less than minimum: ${minLen}`);
    }

    if (maxLen && input.length > maxLen) {
      return new Error(`Array greater less than maximum: ${maxLen}`);
    }

    if (!memberValidator) return input;

    if (typeof memberValidator !== 'function') {
      return new Error('memberValidator must be a function');
    }

    const parsed = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const member of input) {
      const value = memberValidator(member);

      if (value instanceof Error) return value;

      parsed.push(value);
    }

    return parsed;
  }
}

module.exports = { FluxBase };
