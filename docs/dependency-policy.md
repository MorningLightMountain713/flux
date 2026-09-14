# Dependency policy — what pins FluxOS, and why

FluxOS cannot take "the latest version" as a default. Two constraints decide
what a dependency may be, and neither is visible from `npm outdated`:

1. **The Node floor** — the oldest Node in the fleet, because FluxOS installs
   its own dependencies on production nodes.
2. **CommonJS** — FluxOS is `require()` end to end, and a growing number of
   packages now ship ESM only.

A bump that ignores either installs cleanly, passes locally, and breaks on
nodes. This document is the reference for both, and for the packages currently
held back by them.

## 1. The Node floor

`package.json` declares `engines.node`, and that is the single source of truth:

```json
"engines": { "node": ">=20.8.0" }
```

**It is a fleet fact, not a preference.** The watchdog runs
`npm install --omit=dev` against the FluxOS checkout as part of auto-update and
restarts the service, unattended. A package whose `engines.node` excludes a
node's version does not fail there — npm prints a warning nobody reads, the
install succeeds, and the break surfaces later as a missing API or a syntax
error, on whichever nodes are oldest.

### What the fleet actually runs

Sampled across 6,313 nodes:

| Node | nodes | |
|---|---|---|
| 16.18.0 – 16.20.2 | 19 | below `engines.node`; running an older FluxOS |
| **20.8.0** | **87** | **the floor** |
| 20.9.0 | 255 | |
| 20.20.2 | 3 | |
| 22.x | 21 | |
| 24.x | 5,832 | 24.14.1 alone is 5,810 |
| unknown | 96 | |

92% of the fleet is on 24.x, and that is exactly why the floor has to be
written down: nothing about day-to-day work puts the 87 nodes on 20.8.0 in
front of you.

### Enforcement

`npm run check:engines` (`scripts/check-runtime-engines.js`) fails if any
package in the **shipped** tree declares an `engines.node` that excludes the
floor. It runs in CI before the suite.

It reads the floor from `package.json`, so raising the floor is one edit — but
raising it is a fleet decision, and `engines.node`, both CI workflows and the
node image move together.

**Dev dependencies are deliberately exempt.** They never reach a node;
`--omit=dev` is what the watchdog installs. Holding the whole toolchain to the
oldest node in the fleet costs real versions for no safety. `mocha@11` is the
live example: every 11.x release declares `^18.18.0 || ^20.9.0 || >=21.1.0`, so
it formally refuses 20.8.0 while CI runs it there without trouble.

### Why the CI Node pin is not this check

Both workflows pin Node to `20.8.0` rather than a floating `20.x`, so the suite
runs on what the oldest node runs. That pin is worth keeping, but it is a
**proxy**: it only catches an incompatibility the tests happen to exercise, and
it silently constrains dev tooling that never ships. `check:engines` states the
real invariant directly, and cannot be satisfied by accident.

Note the pin's own comment calls 20.8.0 "the oldest Node in the fleet". The
table above shows 19 nodes below it. Nothing in CI covers those.

## 2. CommonJS

FluxOS is CommonJS — `require()` throughout `ZelBack/` and `tests/`. A package
whose latest major ships ESM only cannot be bumped; taking it is a port of
every consumer, not a version change.

**Check before bumping**, because `"type": "module"` alone does not settle it —
what matters is whether the `exports` map offers a `require` condition:

```sh
npm view <pkg>@<version> exports --json      # look for a "require" condition
```

### Held at their current major for this reason

| package | latest | why held |
|---|---|---|
| `mocha` | 12.x | no `require` condition |
| `chai` | 6.x | no `require` condition — every test does `require('chai')` |
| `chai-as-promised` | 8.x | as `chai` |
| `@babel/core`, `@babel/preset-env`, `@babel/eslint-parser` | 8.x | no `require` condition |
| `archiver` | 8.x | no `require` condition, and it ships |
| `inquirer` | 14.x | no `require` condition, and it ships |
| `uuid` | 14.x | no `require` condition |

### The interop trap, which is worse than a hard failure

A package can keep a CJS entry point and still change what that entry
**returns**, usually to an ESM-interop wrapper. Two live in the tree:

```js
const { TTLCache } = require('@isaacs/ttlcache');   // v1 exported the class itself
const bs58check = require('bs58check').default;     // v4 exports { default: {...} }
```

Neither produced a failing test. Both crashed the run at load, which mocha
reports as `Exception during run` with **no failure count at all** — so a bump
that breaks this way looks nothing like a test failure. When a bump yields no
counts, read the first lines of the output, not the summary.

## 3. Held for other reasons

| package | held at | why |
|---|---|---|
| `express` | 4.x | `router.js` uses the express 4 routing API. Also: express 5 path syntax (`/x{/:id}`) **registers on express 4 without throwing and matches nothing** |
| `@types/express` | 4.x | tracks `express` |
| `mongodb` | 6.x | 7 needs Node >= 20.19.0 |
| `config` | 3.x | 5 needs Node >= 20.11.0 |
| `espree` | 9.x | 11 needs Node >= 20.19.0, and CI runs 20.8.0 |
| `google-auth-library` | 10.x | 11 needs Node >= 22 |

The four Node-floor entries are the ones to revisit first if the floor moves —
each is a straight bump once the fleet clears their threshold.

## 4. Transitive pins we do not control

`@runonflux/nat-upnp@1.0.2` pins `axios@0.26.1` and `fast-xml-parser@4.5.6`
inside its own tree. 1.0.2 is the latest published, so there is no version to
pull; it needs a release of that package. Those nested copies are not what any
current Dependabot alert is about — every alert has been against a direct
dependency — but they are years behind.

## 5. Reading a Dependabot alert

Every alert reports `manifest_path: package.json`, **including alerts for
transitive copies**, because that is the root manifest. So the path says
nothing about whether the vulnerable package is a direct dependency.

Compare the advisory's `vulnerable_version_range` against what is actually
resolved instead:

```sh
gh api repos/RunOnFlux/flux/dependabot/alerts --paginate \
  -q '.[] | select(.state=="open")
      | [.dependency.package.name, .security_advisory.severity,
         .security_vulnerability.vulnerable_version_range,
         .security_vulnerability.first_patched_version.identifier] | @tsv'
```

An alert can also outlive its dependency: `morgan` was alerted while absent
from the lockfile entirely.
