# flux-spec pairing for the test harness

flux-spec is not published to npm yet, so `package.json` consumes it as a
path dependency (`file:../flux-spec/packages/*`) from a **vendored** copy at
the repo root. That copy exists twice at test time — on the host for the
runner, and baked into the node image at build time — and neither one
records which commit it is. This directory declares the flux-spec commit
this branch pairs with, and the harness refuses to boot a fleet unless both
copies match it.

The machinery dies when flux-spec publishes to npm; a version range in
`package.json` is the same contract, enforced by the registry instead.

## Files

- `pin` — the full commit hash of the paired flux-spec. Bump it in the same
  commit that starts calling a newer spec API, and re-vendor.

  Also bump it when flux-spec changes BEHAVIOUR the harness depends on, not only
  when it grows surface FluxOS calls. A tightened wire door is the case: the pinned
  copy keeps accepting documents the unit suite has started refusing, so a fleet
  proves something the unit tests no longer claim, and neither run is wrong about
  itself. Bumping is not free — re-vendor and boot a fleet, because the harness's
  own fixtures have to satisfy whatever got tightened.
- `vendor.sh` — exports the pinned tree into `<repo>/flux-spec` (gitignored)
  with `git archive`, stamps `.vendored-ref`, and runs the workspace
  install. Skips when the vendor already matches the pin; `--force`
  re-vendors. The clone lives outside the repo tree
  (`~/.cache/flux-e2e/flux-spec`) so no `.git` or `node_modules` enters the
  node-image build context.

## Workflow

```
# after cloning, or whenever the pin changes:
bash test-infra/flux-spec/vendor.sh
docker build -f test-infra/Dockerfile.fluxos -t flux-e2e-fluxos-01 .
```

The clone is over ssh (private repo) — run with your agent forwarded. The
image rebuild is not optional: the image bakes its own copy, and skipping it
leaves the containers on the old spec while the host runner looks correct.

## How the pairing is enforced

`createTestEnv` calls `assertFluxSpecVendorCurrent()` before the boot lock,
the network, or any container, and throws with the exact command to run
unless:

```
pin  ==  <repo>/flux-spec/.vendored-ref  ==  the same file inside the node image
```

The stamp rides inside the vendor directory, so `COPY flux-spec /flux-spec`
carries it into the image with no build-arg to remember.

This guard exists because the failure it replaces is unrecognisable: a
lagging vendor surfaces as the reconciler spamming `<name> is not a
function`, deferring every cycle, with containers stuck `Created` — and
only in suites that install something, so a green run of the logging or
boot suites proves nothing about it.

## Overrides

- `FLUX_SPEC_REPO` — clone URL (default
  `git@github.com:MorningLightMountain713/flux-spec.git`)
- `FLUX_SPEC_SRC` — checkout location
