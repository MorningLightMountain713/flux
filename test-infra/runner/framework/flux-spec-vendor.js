// flux-spec is consumed as a VENDORED tree (`file:../flux-spec/packages/*`)
// until it publishes to npm: test-infra/flux-spec/dist on the host for the runner, and
// a copy baked into the node image at build time. Nothing about that tree
// declares which commit it is, so a vendor lagging the branch fails as a
// product mystery — the reconciler spams "<X> is not a function", defers every
// cycle, and containers sit Created forever. Suites that install nothing pass
// straight through it, so a green regression run proves nothing.
//
// `test-infra/flux-spec/pin` makes the pairing an explicit fact and this guard
// enforces it across both copies before any suite spends minutes on a fleet:
//
//   pin (committed)  ==  test-infra/flux-spec/dist/.vendored-ref  ==  the same file in the image
//
// Vendor drift means someone bumped the pin without re-vendoring; image drift
// means someone re-vendored without rebuilding (the second half of the fix
// that is easy to forget, because the host runner keeps working).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');

export const NODE_IMAGE = 'flux-e2e-fluxos-01';

// One box hosts more than one branch's harness work, and the image names are
// fixed, so a run carries its lineage in the tag. The guard has to inspect the
// image the suite will actually boot: untagged, it reads :latest and can pass a
// tagged run on another branch's bake, or fail one whose own image is current.
export const IMAGE_TAG = process.env.FLUX_E2E_TAG || 'latest';
const TAGGED_NODE_IMAGE = `${NODE_IMAGE}:${IMAGE_TAG}`;

const PIN_PATH = join(repoRoot, 'test-infra', 'flux-spec', 'pin');
const VENDOR_REF_PATH = join(repoRoot, 'test-infra', 'flux-spec', 'dist', '.vendored-ref');
const VENDOR_CMD = 'bash test-infra/flux-spec/vendor.sh';
const IMAGE_CMD = `FLUX_E2E_TAG=${IMAGE_TAG} ./test-infra/build-images.sh fluxos-01`;

const readRef = (path) => (existsSync(path) ? readFileSync(path, 'utf-8').trim() : null);

function imageVendorRef() {
  // The stamp rides inside the vendor directory, so the image's COPY of it
  // carries it into the image with no build-arg or label to remember.
  try {
    return execFileSync(
      'docker',
      ['run', '--rm', '--entrypoint', 'cat', TAGGED_NODE_IMAGE, '/flux-spec/.vendored-ref'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    // Absent image, or an image built before this machinery / from an unstamped
    // vendor. Unknowable either way — and an unknown bake is exactly what this
    // guard refuses to run on.
    return null;
  }
}

let checked = false;

/**
 * Throws unless the pin, the host vendor, and the node image all agree.
 * Memoized: the image read costs a container spawn, and the answer cannot
 * change while a suite runs.
 */
export function assertFluxSpecVendorCurrent() {
  if (checked) return;

  const pin = readRef(PIN_PATH);
  if (!pin) throw new Error(`flux-spec pin missing at ${PIN_PATH}`);
  const short = pin.slice(0, 12);

  const vendor = readRef(VENDOR_REF_PATH);
  if (!vendor) {
    throw new Error(
      `flux-spec vendor missing or unstamped (${VENDOR_REF_PATH}); pin requires ${short}.\n`
      + `  run: ${VENDOR_CMD}\n  then: ${IMAGE_CMD}`,
    );
  }
  if (vendor !== pin) {
    throw new Error(
      `flux-spec vendor is ${vendor.slice(0, 12)}, pin requires ${short}.\n`
      + `  run: ${VENDOR_CMD}\n  then: ${IMAGE_CMD}`,
    );
  }

  const image = imageVendorRef();
  if (image !== pin) {
    throw new Error(
      `node image ${TAGGED_NODE_IMAGE} baked flux-spec ${image ? image.slice(0, 12) : '(unknown)'}, `
      + `pin requires ${short}.\n  run: ${IMAGE_CMD}`,
    );
  }

  checked = true;
}
