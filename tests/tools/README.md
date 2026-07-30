# Test tools

Diagnostics that are not themselves tests. They live outside `tests/unit`, so
the mocha glob (`tests/unit/**/*.test.js`) does not pick them up.

## `price-oracle.js`

Prices every spec in the on-chain corpus, plus the synthetic v9 fixtures,
through all four public pricing entry points — the two display quotes in
`appSpecHelpers` and the two consensus fees in `messageVerifier` — and writes
the numbers to JSON.

```bash
node tests/tools/price-oracle.js before.json
# ...make the change...
node tests/tools/price-oracle.js after.json
node tests/tools/price-oracle.js --compare before.json after.json
```

`--compare` exits non-zero if any price moved.

Run it around any change that touches pricing, especially one that moves code
between modules. A green unit suite is not sufficient evidence there: proxyquire
ignores a stub key that no longer matches a require, so tests can keep passing
while quietly exercising different code. This compares actual prices instead.

Every seam it stubs is a module singleton rather than a rewired import, which is
what lets the same script run unchanged on both sides of a refactor — it only
ever calls the four exported entry points.

Needs a `flux-spec` checkout for the corpus. Defaults to a sibling of this repo;
override with `FLUX_SPEC_DIR`.

## `stale-proxyquire-stubs.js`

Reports proxyquire stub keys naming a module the target never requires.

```bash
node tests/tools/stale-proxyquire-stubs.js
node tests/tools/stale-proxyquire-stubs.js --strict   # exit 1 if any found
```

proxyquire silently ignores an unmatched key. The stub then reads as coverage
and does nothing, and when a refactor moves code between modules every key
pointing at the old location goes quiet without a single test turning red.

A hit is not automatically a bug — it means the stub is inert. Either the module
genuinely stopped using that dependency, in which case delete the key, or the
test meant to stub something it is now missing, in which case fix the key. Read
the module before deciding which.

The repo is not clean under this check; it currently reports 53 keys across 21
files, all pre-existing. Read each one before acting: a stub line can hold more
than one key, and only some of them stale. `--strict` is there for the day that reaches zero.
