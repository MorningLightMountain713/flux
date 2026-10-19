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
  "protobufjs": true,
  "zeromq": false
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

The failure mode under blocking is not a crash. `secp256k1@5` ships prebuilt
binaries, so message signing and verification stay native whatever happens
to install scripts. The others **compile their native code in the install
script** and each falls back deliberately when that fails:

- `cpu-features` is an optional dependency of `ssh2`
- `ssh2`'s crypto binding is optional; it logs and continues

So a blocked install boots normally; only docker-over-SSH, which FluxOS does
not use, would lose a native binding.

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
| `cpu-features@0.0.10` | `node buildcheck.js > buildcheck.gypi && node-gyp rebuild` | writes a local gyp config from a build probe, then compiles |
| `ssh2@1.17.0` | `node install.js` | `node-gyp rebuild` for an *optional* crypto binding; logs and `exit 0` on failure |
| `protobufjs@7.x` | `node scripts/postinstall` | reads two `package.json` files and prints a version-range warning to stderr; writes nothing |

None fetch anything at install time. All arrive via `dockerode` (ssh2,
cpu-features, protobufjs) or the crypto path (secp256k1).

`zeromq@6.8.0` is **denied** (`false`). Its `install` script
(`node ./script/install.js`) only checks that a prebuilt addon loads, and
builds one from source with cmake-ts (cmake, ninja and vcpkg dependencies)
when none does. The package ships prebuilt Node-API addons for linux x64
and arm64 (glibc and musl), and its loader picks one at `require` time
without the script: on ArcaneOS (Node 24, ABI 137, which has no
exact-ABI build) it loads and opens a socket. The source build is never
wanted on a node, so the script is denied rather than approved.

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
