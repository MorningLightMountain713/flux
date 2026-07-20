# Dependency install scripts (`allowScripts`)

`package.json` carries an `allowScripts` field listing which dependencies
are permitted to run install lifecycle scripts (`preinstall`, `install`,
`postinstall`). This is a supply-chain control: an install script is
arbitrary code executed at `npm install` time, and the classic npm attack
is a compromised transitive dependency shipping one.

```json
"allowScripts": {
  "secp256k1": true,
  "cpu-features": true,
  "ssh2": true,
  "protobufjs": true
}
```

## Why FluxOS needs the field

In the npm release this was added against, `allowScripts` is **advisory** —
unreviewed scripts still run, and npm only prints a warning. A future npm
release will **block** them. The field is written now so that flip is a
non-event.

It matters more here than in a typical project because FluxOS installs
dependencies **unattended on production nodes**: the node watchdog runs
`npm install --omit=dev` against the FluxOS checkout as part of auto-update,
then restarts the service. Nobody is watching that install.

The failure mode under blocking is not a crash, which is what makes it
worth pre-empting. Of the four packages below, only `secp256k1@5.0.1`
ships a prebuilt binary; the rest **compile their native code in the
install script** and each falls back deliberately when that fails:

- `secp256k1@3.8.1` (via `bitcoinjs-message`) falls back to a pure-JS
  implementation — its own install script says so
- `cpu-features` is an optional dependency of `ssh2`
- `ssh2`'s crypto binding is optional; it logs and continues

So a blocked install would boot normally and run **signature verification
in pure JS instead of native**, fleet-wide, with no error and nothing in
the logs identifying the cause. `bitcoinjs-message` sits on the app-message
verification path, which is hot. A silent performance regression is harder
to find than a crash.

## Entries are name-only, deliberately

`npm approve-scripts` writes **version-pinned** entries by default
(`secp256k1@5.0.1`), which narrow approval to the exact version reviewed.
That is the safer default for most projects and the wrong one here: a
pinned entry goes stale the moment a dependency version changes, and a
version change is precisely when the watchdog runs an unattended install.
The approval would lapse at the worst possible moment.

Use `--no-allow-scripts-pin` so entries survive version bumps:

```bash
npm approve-scripts --no-allow-scripts-pin <pkg>
```

The trade is real — a compromised *future* version of an approved package
inherits the approval. It is accepted because the alternative fails
unattended across the fleet, and because the packages below are narrow,
long-standing, and their scripts do one comprehensible thing.

## What was reviewed

| package | script | what it does |
|---|---|---|
| `secp256k1@5.0.1` | `node-gyp-build \|\| exit 0` | uses a prebuilt binary if one matches the platform, else compiles; tolerates total failure |
| `secp256k1@3.8.1` | `npm run rebuild \|\| echo …` | `node-gyp rebuild`, with an explicit pure-JS fallback message |
| `cpu-features@0.0.10` | `node buildcheck.js > buildcheck.gypi && node-gyp rebuild` | writes a local gyp config from a build probe, then compiles |
| `ssh2@1.17.0` | `node install.js` | `node-gyp rebuild` for an *optional* crypto binding; logs and `exit 0` on failure |
| `protobufjs@7.x` | `node scripts/postinstall` | reads two `package.json` files and prints a version-range warning to stderr; writes nothing |

None fetch anything at install time. All arrive via `dockerode` (ssh2,
cpu-features, protobufjs) or the crypto path (secp256k1,
bitcoinjs-message).

`fsevents` is **intentionally absent**. It is a darwin-only optional
dependency reached through `nodemon`, so it never installs on a Linux
node. Leaving it off the list keeps it visible on npm's pending list as a
reviewed-and-declined package rather than an approval nobody can justify
later.

## Adding a dependency

If a new dependency ships install scripts, npm will list it as pending:

```bash
npm approve-scripts --allow-scripts-pending    # read-only: what needs review
```

**Read the script before approving it.** Open
`node_modules/<pkg>/<script>` and check what it actually does — a build
step is fine, anything that fetches from the network or writes outside its
own package directory is not.

```bash
npm approve-scripts --no-allow-scripts-pin <pkg>   # after reviewing
npm deny-scripts <pkg>                             # if it should never run
```

Do **not** use `npm approve-scripts --all`, and do not set
`dangerously-allow-all-scripts`. Both defeat the control entirely: they
approve whatever happens to be installed, which is exactly the case the
field exists to catch.
