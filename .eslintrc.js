module.exports = {
  root: true,
  env: {
    // so we get BigInt etc
    es2020: true,
    commonjs: true,
    node: true,
    mocha: true,
  },
  globals: {
    userconfig: true,
  },
  extends: [
    'eslint:recommended',
  ],
  // The rules below include import/* ones, which only exist while this plugin is
  // registered — without it every file fails with "Definition for rule ... was not
  // found" before a single real rule runs.
  plugins: ['import', 'unicorn'],
  rules: {
    // ONE WAY TO WRITE A NUMBER. A duration or a size past four digits is
    // read by counting zeros otherwise, and 86400000 and 8640000 differ by a
    // glance. Autofixable, so this is enforced rather than asked for.
    //
    // It reaches ports and the uint16 ceiling as well, which read wrongly with
    // separators - so those are not written out any more: 65535 is MAX_PORT in
    // socketAddressUtils, and the API port is DEFAULT_API_PORT beside it. No
    // per-site exemptions, because an exemption is where the next one hides.
    // Decimal only. A hex or binary literal is almost always a value copied
    // verbatim from a spec, a reference implementation or a wire format, and
    // grouping it makes it HARDER to check against its source - 0x9e3779b9 is
    // recognisable, 0x9e3779b9 is not, and 0x100000000 grouped from the right
    // leaves a dangling digit. Left alone unless someone deliberately writes a
    // separator in one, in which case the grouping is made consistent.
    'unicorn/numeric-separators-style': ['error', {
      onlyIfContainsSeparator: false,
      number: { minimumDigits: 5, groupLength: 3 },
      binary: { onlyIfContainsSeparator: true, groupLength: 4 },
      octal: { onlyIfContainsSeparator: true, groupLength: 4 },
      hexadecimal: { onlyIfContainsSeparator: true, groupLength: 2 },
    }],
    'max-len': [
      'error',
      {
        code: 300,
        ignoreUrls: true,
        ignoreTrailingComments: true,
      },
    ],
    // Two spaces, and enforced: the repo carried no indent rule at all, so a
    // mis-indented block read as intentional to every reader and to CI alike.
    indent: ['error', 2, { SwitchCase: 1 }],
    'no-console': 'off',
    'linebreak-style': [
      'error',
      'unix',
    ],
    'prefer-destructuring': ['error', { object: true, array: false }],
    'import/no-extraneous-dependencies': ['error', {
      devDependencies: true, optionalDependencies: true, peerDependencies: false,
    }],
    camelcase: ['error', { properties: 'never', ignoreDestructuring: true, ignoreImports: true }],
    'import/extensions': ['error', 'ignorePackages', { js: 'never' }],
    'import/order': 'off',
  },
  parser: '@babel/eslint-parser',
  parserOptions: {
    requireConfigFile: false,
    ecmaVersion: 2020,
    // The package has no "type": "module", so everything here is CommonJS
    // unless a subtree says otherwise — ZelBack and tests are require() end to
    // end. Declaring 'module' told eslint these files were already strict, which
    // silenced the `strict` rule across the whole repo and made the linter
    // assert something Node does not do: a CommonJS module is sloppy, so
    // `delete` on a frozen object silently does nothing rather than throwing.
    // test-infra and the e2e support file are genuinely ESM and say so below.
    sourceType: 'script',
  },
  settings: {
    'import/resolver': {
      node: {
        extensions: [
          '.js',
          '.jsx',
        ],
      },
    },
  },
  overrides: [
    {
      files: [
        '**/__tests__/*.{j,t}s?(x)',
      ],
      env: {
        mocha: true,
      },
    },
    {
      // test-infra is ESM ("type": "module" in the runner), and ESM requires the
      // file extension on a relative import — drop it and node throws
      // ERR_MODULE_NOT_FOUND at startup. The repo-wide `js: 'never'` is correct
      // for ZelBack, which is CommonJS and does not need one, but it is
      // unsatisfiable here: every file in the tree violated it, so the errors
      // were permanent noise that trained everyone to skip past them. Inverted
      // rather than silenced, so a genuinely missing extension still fails.
      files: ['test-infra/**/*.js'],
      rules: {
        'import/extensions': ['error', 'ignorePackages', { js: 'always' }],
      },
    },
    {
      // test-infra's runner declares "type": "module", so these really are ES
      // modules — parsed as such, and strict by definition. It is the only ESM
      // subtree eslint sees; tests/e2e/support/index.js is also ESM but sits
      // under an ignore pattern, so it never reaches the parser.
      files: ['test-infra/**/*.js'],
      parserOptions: { sourceType: 'module' },
    },
    {
      // The daemon stub is CommonJS - it has no "type": "module" and runs in its own
      // container image. require() resolves without the extension, so the ESM rule
      // above does not apply to it.
      files: ['test-infra/daemon-stub/**/*.js'],
      rules: {
        'import/extensions': ['error', 'ignorePackages', { js: 'never' }],
      },
    },
  ],
};
