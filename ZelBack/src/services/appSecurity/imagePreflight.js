const config = require('config');
const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const transportHelper = require('../utils/transportHelper');
const { ImageVerifier } = require('../utils/imageVerifier');
const { getSpec } = require('../utils/specLibs');
const imageManager = require('./imageManager');
const jobRegistry = require('../utils/jobRegistry');
const operationsController = require('../appManagement/operationsController');
const log = require('../../lib/log');

// Mirrors flux-spec's imageFit BYTES_PER_GB (decimal GB, matching registry
// manifest sums and docker inspect .Size). The fit VERDICT is flux-spec's own
// imageFitsRootFs so it can never disagree with the registration gate; this
// constant only turns the same byte figure into the whole-GB number an owner
// has to declare.
const BYTES_PER_GB = 1e9;

// The AAD type that separates a sealed preflight from a sealed registration or
// update: the same per-app transport key opens all three, and binding the type
// stops a captured envelope of one being replayed as another.
const PREFLIGHT_AAD_TYPE = 'fluxapppreflight';

const queue = [];
let running = null;

function preflightMaxComponents() {
  return config.fluxapps.preflightMaxComponents ?? 10;
}

function preflightEnvelopeMaxAgeMs() {
  return config.fluxapps.preflightEnvelopeMaxAgeMs ?? 5 * 60 * 1000;
}

function preflightMaxQueuedJobs() {
  return config.fluxapps.preflightMaxQueuedJobs ?? 4;
}

/**
 * Freshness of a client-supplied envelope timestamp.
 *
 * Deliberately wall-clock (`Date.now()`) where the codebase otherwise uses the
 * monotonic clock: this compares OUR clock against a timestamp the caller
 * generated on THEIRS, which a monotonic reading cannot express. The tolerance
 * is two-sided so a client running slightly fast is not refused.
 */
function envelopeIsFresh(timestamp) {
  return Math.abs(Date.now() - timestamp) <= preflightEnvelopeMaxAgeMs();
}

function assertSealedEnvelopeFields(body) {
  const { name, owner, contentHash } = body;
  for (const [field, value] of [['name', name], ['owner', owner], ['contentHash', contentHash]]) {
    if (typeof value !== 'string' || !value) {
      throw new Error(`Sealed preflight requires a non-empty ${field}`);
    }
  }
  if (typeof body.timestamp !== 'number' || !Number.isFinite(body.timestamp)) {
    throw new Error('Sealed preflight requires a numeric timestamp');
  }
  if (!envelopeIsFresh(body.timestamp)) {
    throw new Error('Sealed preflight timestamp is outside the accepted window');
  }
}

/**
 * The component list to measure, from either accepted form.
 *
 * Cleartext carries it directly; sealed carries it inside a transport envelope
 * opened toward this node's per-app transport key. openTransportEnvelope is
 * already the no-op on the cleartext form, so the two forms converge on one
 * shape here rather than in a branch every later step has to remember.
 */
async function resolveComponents(body) {
  if (!body.transportEncrypted) {
    if (body.name || body.owner) {
      throw new Error('name/owner belong to a sealed preflight; send components on their own to preflight in the clear');
    }
    return body.components;
  }

  assertSealedEnvelopeFields(body);

  const opened = await transportHelper.openTransportEnvelope(body, {
    contentHash: body.contentHash,
    timestamp: body.timestamp,
    type: PREFLIGHT_AAD_TYPE,
  });

  return opened ? opened.components : null;
}

/**
 * Validate the component list both forms resolve to. Every field is checked
 * here rather than trusted from the envelope: sealing proves who composed the
 * payload, not that its contents are well formed.
 *
 * @returns {Array<{name: string, image: string, imageAuth: string|null, rootFsGb: number|null}>}
 */
function validateComponents(components) {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error('No components to preflight');
  }
  const max = preflightMaxComponents();
  if (components.length > max) {
    throw new Error(`Too many components to preflight: ${components.length}, maximum ${max}`);
  }

  const seen = new Set();
  return components.map((component, index) => {
    if (!component || typeof component !== 'object') {
      throw new Error(`Invalid component at index ${index}`);
    }

    // Required, and unique: results are keyed by name because the sealed form
    // deliberately does not echo the image back — echoing it in the clear would
    // undo what sealing the request just bought.
    const { name } = component;
    if (typeof name !== 'string' || !name) {
      throw new Error(`Component at index ${index} needs a name`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate component name: ${name}`);
    }
    seen.add(name);

    const parsed = ImageVerifier.parseImageReference(component.image);
    if (parsed.error) {
      throw new Error(`Component '${name}': ${parsed.error}`);
    }

    const { rootFsGb } = component;
    if (rootFsGb !== undefined && rootFsGb !== null) {
      if (typeof rootFsGb !== 'number' || !Number.isFinite(rootFsGb) || rootFsGb <= 0) {
        throw new Error(`Component '${name}': rootFsGb must be a positive number`);
      }
    }

    const { imageAuth } = component;
    if (imageAuth !== undefined && imageAuth !== null && typeof imageAuth !== 'string') {
      throw new Error(`Component '${name}': imageAuth must be a string`);
    }

    return {
      name,
      image: component.image,
      imageAuth: imageAuth || null,
      rootFsGb: rootFsGb ?? null,
    };
  });
}

/**
 * The rootFs half of one component's answer: whether the image fits the
 * declared budget, the smallest declaration that would, and what is left over
 * for the writable layer.
 *
 * Follows the registration gate branch for branch, so an owner who acts on this
 * answer cannot then be refused by it. Measured: judged on the CLEARANCE figure,
 * which is the lower bound unless a gzip size record wrapped ambiguously.
 * Unmeasured: the gate still refuses when the COMPRESSED sum alone overruns the
 * budget, so that refusal is reported here too — but a compressed size that fits
 * proves nothing about the decompressed one, so it yields no verdict rather than
 * a pass. An absent answer reads as absent, never as approval.
 */
async function rootFsVerdict(declaredRootFsGb, clearanceBytes, compressedBytes) {
  const verdict = {
    rootFsGb: declaredRootFsGb,
    fits: null,
    minimumRootFsGb: null,
    writableHeadroomBytes: null,
  };

  const { imageFitsRootFs } = await getSpec();

  if (!clearanceBytes) {
    if (compressedBytes && declaredRootFsGb != null
      && !imageFitsRootFs(declaredRootFsGb, compressedBytes)) {
      verdict.fits = false;
      // The compressed sum is a lower bound on the decompressed size, so this is
      // the smallest declaration that could pass — not necessarily one that will.
      verdict.minimumRootFsGb = Math.ceil(compressedBytes / BYTES_PER_GB);
    }
    return verdict;
  }

  verdict.minimumRootFsGb = Math.ceil(clearanceBytes / BYTES_PER_GB);

  if (declaredRootFsGb == null) return verdict;

  verdict.fits = imageFitsRootFs(declaredRootFsGb, clearanceBytes);
  verdict.writableHeadroomBytes = declaredRootFsGb * BYTES_PER_GB - clearanceBytes;

  return verdict;
}

/**
 * Measure one component. Never throws: a registry that is down, credentials
 * that are wrong or an image that does not exist are this component's ANSWER,
 * not the end of the job — one bad component must not blank the facts for the
 * rest, which is the whole reason this is not the registration verify.
 */
async function measureComponent(component) {
  try {
    const result = await imageManager.verifyRepository(component.image, {
      repoauth: component.imageAuth,
      appName: component.name,
    });

    const decompressedBytes = result.decompressedSizeBytes;
    const clearanceBytes = result.decompressedSizeClearanceBytes;

    return {
      status: 'ok',
      error: null,
      errorClass: null,
      architectures: result.supportedArchitectures,
      compressedBytes: result.imageSizeBytes,
      // 0 means unmeasured — a layer whose size record could not be read leaves
      // the whole image unmeasured rather than partly counted.
      decompressedBytes,
      measured: Boolean(decompressedBytes),
      // A gzip size record that wrapped with more than one plausible answer: the
      // image is at least decompressedBytes and may be as large as the clearance
      // figure, and only the larger is safe to declare against.
      ambiguous: clearanceBytes > decompressedBytes,
      clearanceBytes,
      ...(await rootFsVerdict(component.rootFsGb, clearanceBytes, result.imageSizeBytes)),
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message || String(error),
      // Transient means the registry could not be asked, not that the image is
      // bad — the caller should retry rather than change their spec.
      errorClass: error.registryErrorClass ?? 'permanent',
      architectures: [],
      compressedBytes: 0,
      decompressedBytes: 0,
      measured: false,
      ambiguous: false,
      clearanceBytes: 0,
      rootFsGb: component.rootFsGb,
      fits: null,
      minimumRootFsGb: null,
      writableHeadroomBytes: null,
    };
  }
}

/**
 * Measure a job's components.
 *
 * Fanned out, because pacing is the registry governor's job and not this
 * function's: it holds a concurrency slot per registry host and a rate budget
 * only where one is actually published, so components no longer have to queue
 * behind each other to stay polite. A preflight costs the slowest component
 * rather than the sum of them, and a component whose registry is cooling is
 * refused with a number instead of blocking the rest of the job.
 *
 * measureComponent never rejects, so every component lands a result.
 */
async function runJob(job) {
  await Promise.all(job.components.map(async (component) => {
    const result = await measureComponent(component);
    job.results[component.name] = result;
    job.completed += 1;
    jobRegistry.touch(job.id);
  }));
  job.measuredAt = Date.now();
  jobRegistry.succeed(job.id);
}

/**
 * Run one job at a time, node-wide. The queue depth caps how much registry
 * traffic a caller can commit this node to, and serialising the jobs themselves
 * means the node's outbound rate never exceeds one component's worth of
 * requests no matter how many callers are waiting.
 */
async function pump() {
  if (running || queue.length === 0) return;
  running = queue.shift();
  try {
    await runJob(running);
  } catch (error) {
    jobRegistry.fail(running.id, error);
  } finally {
    running = null;
    pump();
  }
}

function jobsFor(sourceIp) {
  let count = queue.filter((job) => job.sourceIp === sourceIp).length;
  if (running && running.sourceIp === sourceIp) count += 1;
  return count;
}

/**
 * Accept a preflight request and answer it in the background.
 *
 * Validation runs here, before a job exists, so a malformed request is refused
 * outright rather than becoming a job that fails a poll later.
 *
 * @param {object} body - parsed request body (cleartext or sealed form)
 * @param {string|null} sourceIp - the OBSERVED socket peer, never a header
 * @returns {Promise<{jobId: string, statusUrl: string}>}
 */
async function submitPreflight(body, sourceIp) {
  const parsed = serviceHelper.ensureObject(body);
  const components = validateComponents(await resolveComponents(parsed));

  if (queue.length + (running ? 1 : 0) >= preflightMaxQueuedJobs()) {
    const busy = new Error('This node is already measuring as many preflights as it accepts at once. Try another node.');
    busy.kind = 'busy';
    throw busy;
  }
  // One in flight per caller. Identity here is fairness, not defence — the
  // node-wide serialisation above is what bounds the work — so the observed
  // socket peer is enough and no header is consulted.
  if (sourceIp && jobsFor(sourceIp) > 0) {
    const busy = new Error('A preflight from this address is already in progress');
    busy.kind = 'busy';
    throw busy;
  }

  const job = {
    sourceIp,
    components,
    results: {},
    completed: 0,
    measuredAt: null,
  };
  // The registry owns the envelope - status, timing, retention, the error shape
  // and the poll URL - so a preflight is polled exactly like every other
  // operation. This module keeps only what is specific to measuring images, and
  // hands the registry a reader for it.
  const handle = jobRegistry.start({
    kind: 'imagepreflight',
    detail: () => preflightDetail(job),
  });
  job.id = handle.jobId;

  queue.push(job);
  pump();

  return handle;
}

/**
 * The measuring-specific half of an operation's status: how far through the
 * components it is, and what each one answered. The registry supplies
 * everything around it - status, timing, errors, retention.
 *
 * The image reference is never echoed — results are keyed by component name, so
 * a sealed request's images stay inside the envelope.
 */
function preflightDetail(job) {
  return {
    completed: job.completed,
    total: job.components.length,
    measuredAt: job.measuredAt,
    components: job.results,
  };
}

/**
 * A job's public view, through the shared operation registry.
 * @returns {object|null} null when the job is unknown or has aged out
 */
function getPreflight(jobId) {
  if (typeof jobId !== 'string' || !jobId) throw new Error('Missing jobId');
  return jobRegistry.get(jobId);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function submitPreflightAPI(req, res) {
  try {
    const sourceIp = (req.socket && req.socket.remoteAddress)
      ? req.socket.remoteAddress.replace(/^::ffff:/, '')
      : null;
    const handle = await submitPreflight(req.body ?? {}, sourceIp);
    return operationsController.accepted(res, handle);
  } catch (error) {
    if (error.kind === 'busy') {
      return res.status(503).json(messageHelper.createErrorMessage(error.message));
    }
    log.warn(`imagePreflight: ${error.message}`);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    return res.json(errorResponse);
  }
}

module.exports = {
  submitPreflight,
  submitPreflightAPI,
  getPreflight,
};
