const https = require('node:https');
const serviceHelper = require('../serviceHelper');
const registryGovernor = require('./registryGovernor');
const {
  guardedLookup, isBlockedAddressLiteral, BLOCKED_ADDRESS_CODE,
} = require('./urlSecurity');

/**
 * Docker Architecture
 * @typedef {"amd64" | "arm64"} Architecture
 */

const gzipLayerMediaTypes = [
  'application/vnd.docker.image.rootfs.diff.tar.gzip',
  'application/vnd.oci.image.layer.v1.tar+gzip',
];

const zstdLayerMediaTypes = [
  'application/vnd.oci.image.layer.v1.tar+zstd',
];

// RFC 1952 stores the decompressed length in the final four bytes of a gzip
// stream, modulo 2^32.
const gzipIsizeBytes = 4;
const gzipIsizeModulus = 2 ** 32;
// deflate cannot expand more than 1032:1, so a layer compressed below
// modulus/1032 (~4.16 MB) cannot have reached the modulus and its trailer is exact.
const maxDeflateExpansion = 1032;
// A decompressed layer smaller than its compressed form is implausible for a tar
// of file contents; below this ratio the trailer must have wrapped.
const minPlausibleExpansion = 0.98;
// Above this ratio the next wrap candidate stops being a realistic layer, so the
// measurement is unambiguous. Within it, both candidates are possible.
const maxPlausibleExpansion = 6;

// RFC 8878: magic, Frame_Header_Descriptor, Window_Descriptor, up to a 4-byte
// Dictionary_ID and up to an 8-byte Frame_Content_Size.
const zstdMagic = 0xfd2fb528;
const zstdFrameHeaderBytes = 18;

// A registry that ignores Range answers 200 with the whole layer. Cap the read so
// such a response is aborted after a few bytes instead of pulling a blob.
const maxBlobRangeBytes = 64;

/**
 * Resolve a gzip ISIZE trailer into a decompressed byte count, correcting for the
 * modulus. The true size is `raw + k * 2^32`; the smallest k giving a plausible
 * expansion is a safe lower bound, never below the raw trailer. When the candidate
 * after it is also plausible the layer is ambiguous and both are returned — the
 * lower bound to report, the next candidate as the figure a declaration must clear.
 *
 * @param {number} rawIsize value read from the trailer
 * @param {number} compressedBytes the layer's size as the manifest reports it
 * @returns {{bytes: number, nextCandidateBytes: number}}
 */
function resolveGzipIsize(rawIsize, compressedBytes) {
  if (compressedBytes < gzipIsizeModulus / maxDeflateExpansion) {
    return { bytes: rawIsize, nextCandidateBytes: rawIsize };
  }

  let bytes = rawIsize;
  while (bytes / compressedBytes < minPlausibleExpansion) {
    bytes += gzipIsizeModulus;
  }

  const nextCandidate = bytes + gzipIsizeModulus;
  const ambiguous = nextCandidate / compressedBytes <= maxPlausibleExpansion;

  return { bytes, nextCandidateBytes: ambiguous ? nextCandidate : bytes };
}

/**
 * Read Frame_Content_Size from a zstd frame header (RFC 8878). The value is a
 * 64-bit exact count — no modulus, so none of the gzip wrap arithmetic applies —
 * but the field is optional: a streaming compressor may omit it, and a blob that
 * does not open with a zstd frame cannot be read at all. Both read as unmeasured.
 *
 * @param {Buffer} header the first bytes of the blob
 * @returns {number|null} null when the size is absent or the header is unreadable
 */
function parseZstdFrameContentSize(header) {
  if (header.length < 5 || header.readUInt32LE(0) !== zstdMagic) return null;

  const descriptor = header.readUInt8(4);
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = Boolean(descriptor & 0x20);
  const dictionaryIdFlag = descriptor & 0x03;

  // Flag 0 means one byte for a single-segment frame and no field otherwise;
  // flags 1-3 mean 2, 4 and 8 bytes.
  const fieldBytes = contentSizeFlag === 0 ? Number(singleSegment) : 2 ** contentSizeFlag;
  if (!fieldBytes) return null;

  const dictionaryIdBytes = dictionaryIdFlag === 3 ? 4 : dictionaryIdFlag;
  const offset = 5 + (singleSegment ? 0 : 1) + dictionaryIdBytes;
  if (header.length < offset + fieldBytes) return null;

  switch (fieldBytes) {
    case 1:
      return header.readUInt8(offset);
    // The 2-byte form stores the size minus 256.
    case 2:
      return header.readUInt16LE(offset) + 256;
    case 4:
      return header.readUInt32LE(offset);
    default:
      return Number(header.readBigUInt64LE(offset));
  }
}

class ImageVerifier {
  static defaultDockerRegistry = 'registry-1.docker.io';

  // End-anchored and digest-aware so a match describes the whole reference:
  // [HOST[:PORT]/][NAMESPACE/]REPOSITORY[:TAG][@DIGEST]. The `d` flag exposes
  // match indices so consumers can locate the tag without re-scanning.
  // The name separator is `[-]+` (one or more), NOT `[-]*` — an empty-matchable
  // separator inside the outer `*` is a classic (a+)+ ReDoS: it lets a long
  // alphanumeric run be partitioned exponentially many ways, which catastrophically
  // backtracks against the end anchor (a 64-char hash once hung the event loop).
  // `[-]+` matches the same valid names (greedy [a-z0-9]+ already covers the
  // no-separator case) and matches the Docker reference grammar.
  static imagePattern = /^(?:(?<provider>(?:(?:[\w-]+(?:\.[\w-]+)+)(?::\d+)?)|[\w]+:\d+)\/)?\/?(?<namespace>(?:(?:[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)\/){0,2})(?<repository>[a-z0-9-_.]+\/{0,1}[a-z0-9-_.]+)(?::(?<tag>[\w][\w.-]{0,127}))?(?:@(?<digest>[a-z0-9]+:[0-9a-f]+))?$/d;

  static wwwAuthHeaderPattern = /(?<scheme>Bearer|Basic)\s+realm="(?<realm>[^"]+)"(?:,\s*service="(?<service>[^"]+)")?(?:,\s*scope="(?<scope>[^"]+)")?/;

  static supportedMediaTypes = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
  ];


  /**
   * Parse www-authenticate header
   * @param {string} authHeader # www-auth header
   * @returns {object} Object of parsed header - {realm, service, scope}
   */
  static parseAuthHeader(header) {
    const match = ImageVerifier.wwwAuthHeaderPattern.exec(header);

    if (!match) return null;

    return { ...match.groups };
  }

  /**
   * The rate-limit facts a registry attaches to a response, normalized to the
   * few names the registries actually use. Absent fields stay absent rather
   * than becoming nulls, so a caller can tell "the registry said nothing" from
   * "the registry said zero".
   *
   * @param {object} headers
   * @returns {object} zero or more of retryAfter, rateLimitReset, rateLimitRemaining, rateLimitSource
   */
  static rateLimitMeta(headers = {}) {
    const meta = {};
    if (!headers) return meta;

    const retryAfter = Number(headers['retry-after']);
    if (Number.isFinite(retryAfter)) meta.retryAfter = retryAfter;

    const reset = Number(headers['ratelimit-reset'] ?? headers['x-ratelimit-reset']);
    if (Number.isFinite(reset)) meta.rateLimitReset = reset;

    const remaining = headers['ratelimit-remaining'] ?? headers['x-ratelimit-remaining'];
    if (remaining !== undefined) meta.rateLimitRemaining = String(remaining);

    const source = headers['docker-ratelimit-source'];
    if (source !== undefined) meta.rateLimitSource = String(source);

    return meta;
  }

  #abortController = new AbortController();

  #axiosInstance = null;

  #evaluationErrorDetail = '';

  #lookupErrorDetail = '';

  #parseErrorDetail = '';

  #lookupErrorMeta = null; // Stores { httpStatus, errorCode, errorType }

  #architectureSupported = false;

  #supportedArchitectures = [];

  #imageSizeBytes = 0;

  #decompressedSizeBytes = 0;

  #decompressedSizeClearanceBytes = 0;

  #decompressedSizeMeasured = true;

  authConfigured = false;

  authVerified = false;

  evaluated = false;

  ambiguous = false;

  credentials = null;

  provider = null;

  namespace = null;

  repository = null;

  tag = null;

  /**
   * @param {string} imageTag
   * @param {{credentials?: string, architecture?: Architecture, architectureSet?: Array<Architecture>}} options
   */
  constructor(imageTag, options = {}) {
    if (typeof imageTag !== 'string') {
      this.#parseErrorDetail = 'Invalid Docker Image Tag';
      return;
    }

    this.rawImageTag = imageTag;

    this.architecture = options.architecture || 'amd64';
    this.architectureSet = options.architectureSet || ['amd64', 'arm64'];
    this.maxImageSize = options.maxImageSize || 2_000_000_000; // 2Gb
    // How long this verifier will wait on the governor before giving up. null
    // (the default) waits: background work - the spawner, the installer, a
    // preflight job - has nowhere better to be. A caller holding an HTTP request
    // open must set it, or a cooling registry becomes a hung request.
    this.governorTimeoutMs = options.governorTimeoutMs ?? null;

    if (options.credentials) this.addCredentials(options.credentials);

    this.#parseDockerTag();

    // A host that is already an address never reaches the Agent's lookup — Node
    // resolves nothing when there is nothing to resolve — so the literal case is
    // refused here, before any request exists. Hostnames are handled at connect
    // time, where a name that resolves private cannot slip past a stale check.
    if (!this.parseError && isBlockedAddressLiteral(String(this.provider).split(':')[0])) {
      this.#lookupErrorDetail = `Refused: ${this.rawImageTag} points at a private or reserved address`;
      this.#lookupErrorMeta = {
        httpStatus: null,
        errorCode: BLOCKED_ADDRESS_CODE,
        errorType: 'invalid_format',
      };
      return;
    }

    if (!this.parseError) this.#createAxiosInstance();
  }

  get parseError() {
    return Boolean(this.#parseErrorDetail);
  }

  get lookupError() {
    return Boolean(this.#lookupErrorDetail);
  }

  get evaluationError() {
    return Boolean(this.#evaluationErrorDetail);
  }

  get error() {
    return this.parseError || this.lookupError || this.evaluationError;
  }

  get errorDetail() {
    return this.#lookupErrorDetail || this.#parseErrorDetail || this.#evaluationErrorDetail || '';
  }

  get errorMeta() {
    return this.#lookupErrorMeta;
  }

  /**
   * The transient/permanent split consumers route verdicts on: 'transient' is a
   * could-not-ask answer (network path, rate limit, registry 5xx) - retryable and
   * never the image's fault; 'permanent' is the registry's verdict on the image,
   * or a malformed tag/manifest. Anything unrecognized reads 'permanent', so an
   * unknown failure shape degrades to the strict behavior, never to endless retry.
   * @returns {'transient'|'permanent'|null} null when there is no error
   */
  get errorClass() {
    if (!this.error) return null;
    const transientTypes = ['network', 'rate_limit', 'server_error'];
    if (this.#lookupErrorMeta && transientTypes.includes(this.#lookupErrorMeta.errorType)) {
      return 'transient';
    }
    return 'permanent';
  }

  get parts() {
    const parts = [this.provider, this.namespace, this.repository, this.tag];
    return parts.filter((x) => x);
  }

  get useable() {
    // Namespace is optional (only Docker Hub uses it), so check for required fields only
    return !!this.provider && !!this.repository && !!this.tag;
  }

  /**
   * If this image can run on the Flux network.
   */
  get verified() {
    return this.evaluated && !this.error && this.useable;
  }

  /**
   * If this image can run on this Fluxnode.
   */
  get supported() {
    return this.verified && this.#architectureSupported;
  }

  /**
   * Get all architectures supported by this image from the manifest.
   * @returns {string[]} Array of supported architectures (e.g., ['amd64', 'arm64'])
   */
  get supportedArchitectures() {
    return this.#supportedArchitectures;
  }

  /**
   * Largest compressed image size (summed layer sizes) across the evaluated
   * architectures, in bytes. 0 until a manifest is evaluated. The registry
   * reports compressed sizes, so this is a lower bound on the decompressed
   * on-disk size — good for an early rootFs-fit reject, not an authoritative one.
   * @returns {number}
   */
  get imageSizeBytes() {
    return this.#imageSizeBytes;
  }

  /**
   * Largest decompressed image size across the evaluated architectures, in bytes,
   * read from the layers' own size records (gzip trailer / zstd frame header) for
   * a handful of bytes per layer. This is the on-disk figure `rootFsGb` budgets,
   * and it is a lower bound: the tar padding it counts is real disk, and a wrapped
   * gzip trailer resolves downwards.
   *
   * 0 means unmeasured — one layer whose size cannot be read (unknown media type,
   * a registry that refuses Range, a zstd frame with no Frame_Content_Size) leaves
   * the whole image unmeasured rather than partly counted.
   * @returns {number}
   */
  get decompressedSizeBytes() {
    return this.#decompressedSizeMeasured ? this.#decompressedSizeBytes : 0;
  }

  /**
   * The decompressed figure a rootFs declaration has to clear. Equal to
   * decompressedSizeBytes unless a gzip trailer wrapped ambiguously, in which case
   * it is the next candidate up — the image is either that size or the lower bound,
   * and only clearing the larger of the two is safe. 0 when unmeasured.
   * @returns {number}
   */
  get decompressedSizeClearanceBytes() {
    return this.#decompressedSizeMeasured ? this.#decompressedSizeClearanceBytes : 0;
  }

  /**
   * Whether any measured layer's gzip trailer wrapped with more than one plausible
   * answer, making decompressedSizeBytes a lower bound rather than the size.
   * @returns {boolean}
   */
  get decompressedSizeAmbiguous() {
    return this.decompressedSizeClearanceBytes > this.decompressedSizeBytes;
  }

  #createAxiosInstance() {
    this.#axiosInstance = serviceHelper.axiosInstance({
      baseURL: `https://${this.provider}/v2/`,
      timeout: 20_000,
      signal: this.#abortController.signal,
      headers: { Accept: ImageVerifier.supportedMediaTypes.join(', ') },
      // A registry host is attacker-chosen: an image reference carries its own
      // hostname, and the reference grammar accepts `10.0.0.5:2375/x/y:t` and
      // `localhost:8080/x/y:t` as readily as a real registry. Without this the
      // node would dial whatever it was handed and report back whether the port
      // answered - an internal port scanner driven by a spec. The guard runs at
      // CONNECT time rather than as a pre-check, so a name that resolves public
      // and then private cannot slip through the gap.
      httpsAgent: new https.Agent({ lookup: guardedLookup }),
    });
  }

  /**
   * Pure, network-free parse of a docker image reference into its parts. The
   * single source of truth for splitting a reference — shared by the verifier
   * and by consumers that only need the components (e.g. tag stripping for
   * blocklist matching) without standing up a registry client.
   *
   * @param {string} rawImageTag
   * @returns {{error: string}
   *   | {provider: string, namespace: string, repository: string, tag: string|null,
   *      digest: string|null, reference: string, ambiguous: boolean}}
   *   `reference` is the name as written, minus tag and digest.
   */
  static parseImageReference(rawImageTag) {
    if (typeof rawImageTag !== 'string') {
      return { error: 'Invalid Docker Image Tag' };
    }

    if (/\s/.test(rawImageTag)) {
      return { error: `Image tag: "${rawImageTag}" should not contain space characters.` };
    }

    if (rawImageTag.startsWith('/') || rawImageTag.endsWith('/')) {
      return { error: `Image tag: "${rawImageTag}" cannot start or end with a backslash.` };
    }

    const match = ImageVerifier.imagePattern.exec(rawImageTag);

    if (match === null) {
      return { error: `Image tag: ${rawImageTag} is not in valid format [HOST[:PORT_NUMBER]/][NAMESPACE/]REPOSITORY[:TAG]` };
    }

    const {
      groups: {
        provider: matchedProvider, namespace: matchedNamespace, repository: matchedRepository, tag: matchedTag, digest: matchedDigest,
      },
    } = match;

    const provider = matchedProvider || ImageVerifier.defaultDockerRegistry;
    let namespace;
    let repository = matchedRepository;
    // Absent tag/digest are always null (never undefined or '').
    const tag = matchedTag === undefined ? null : matchedTag;
    const digest = matchedDigest === undefined ? null : matchedDigest;
    // The name as written, minus tag and digest — sliced at the repository's
    // end offset (the `d` flag), so no re-scanning and no canonicalisation.
    const [, repositoryEnd] = match.indices.groups.repository;
    const reference = rawImageTag.slice(0, repositoryEnd);
    let ambiguous;

    // Without doing a lookup against the dockerhub library, no way to know if a single string is
    // an image or a namespace
    if (matchedTag === undefined) {
      if (provider === ImageVerifier.defaultDockerRegistry) {
        // we can't tell, so we set namespace to repository if no namespace
        namespace = matchedNamespace || matchedRepository;
        repository = matchedNamespace ? matchedRepository : '';
        ambiguous = repository === '';
      } else {
        // a registry is ambiguous as you can have multiple / in both namespace and repository,
        // and we don't know how it is split, until we get a tag
        namespace = matchedNamespace;
        ambiguous = true;
      }
    } else {
      // Docker Hub uses 'library' namespace for official images, but other registries don't use default namespaces
      const isDockerHub = provider === ImageVerifier.defaultDockerRegistry;
      namespace = matchedNamespace || (isDockerHub ? 'library' : '');
      ambiguous = false;
    }

    // ToDo: update regex so we don't have to strip last namespace /
    if (namespace.slice(-1) === '/') {
      namespace = namespace.slice(0, -1);
    }

    return {
      provider, namespace, repository, tag, digest, reference, ambiguous,
    };
  }

  #parseDockerTag() {
    if (this.error) return;

    const parsed = ImageVerifier.parseImageReference(this.rawImageTag);
    if (parsed.error) {
      this.#parseErrorDetail = parsed.error;
      return;
    }

    this.provider = parsed.provider;
    this.namespace = parsed.namespace;
    this.repository = parsed.repository;
    this.tag = parsed.tag;
    this.ambiguous = parsed.ambiguous;
  }

  /**
   * To fetch an auth token from registry auth provider.
   * @param {object} authDetails Parsed www-authenticate header.
   */
  async #handleAuth(authDetails) {
    const {
      scheme, realm, service, scope,
    } = authDetails;

    // For Basic auth (AWS ECR), use credentials directly without token exchange
    if (scheme === 'Basic') {
      if (!this.credentials) {
        this.#lookupErrorDetail = 'Basic authentication required but no credentials provided';
        return;
      }

      // Set up Basic auth interceptor for all subsequent requests
      this.#axiosInstance.interceptors.request.use((config) => {
        const authString = `${this.credentials.username}:${this.credentials.password}`;
        const base64Auth = Buffer.from(authString).toString('base64');
        // eslint-disable-next-line no-param-reassign
        config.headers.Authorization = `Basic ${base64Auth}`;
        return config;
      });

      this.authConfigured = true;
      this.authVerified = false; // Not verified yet - will be tested on retry
      return;
    }

    // For Bearer auth with pre-obtained tokens (Azure ACR, Google GAR)
    // These cloud providers return OAuth tokens that should be used directly
    if (scheme === 'Bearer' && this.credentials && this.credentials.authType === 'bearer') {
      this.#axiosInstance.interceptors.request.use((config) => {
        // eslint-disable-next-line no-param-reassign
        config.headers.Authorization = `Bearer ${this.credentials.password}`;
        return config;
      });

      this.authConfigured = true;
      this.authVerified = true; // Token already verified by cloud provider
      return;
    }

    // For Bearer auth (Docker Hub, etc.), do token exchange
    const {
      data: { token },
    } = await serviceHelper
      .axiosGet(`${realm}?service=${service}&scope=${scope}`, { auth: this.credentials })
      .catch((err) => {
        const status = err?.response?.status;

        if (status === 401) {
          this.#lookupErrorDetail = `Authentication rejected for: ${this.rawImageTag}`;
          this.#lookupErrorMeta = {
            httpStatus: 401,
            errorCode: null,
            errorType: 'auth_rejected',
          };
        } else {
          this.#lookupErrorDetail = `Authentication token from ${realm} for ${scope} not available`;
          this.#lookupErrorMeta = {
            httpStatus: status || null,
            errorCode: null,
            errorType: 'auth_unavailable',
          };
        }
        return { data: { token: null } };
      });

    if (!token) return;

    this.authConfigured = true;
    this.authVerified = true; // Verified at realm endpoint
    this.#axiosInstance.interceptors.request.use((config) => {
      // eslint-disable-next-line no-param-reassign
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });
  }

  async #handleAxiosError(endpointUrl, error) {
    const connectionErrors = [
      'ECONNREFUSED',
      'ECONNABORTED',
      'ERR_CANCELED',
      'ENETUNREACH',
      'ETIMEDOUT',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
    ];

    // A refused address is not a connectivity problem: the name resolved, we
    // declined to talk to it, and no amount of retrying changes that. Classify it
    // permanent before the network branch below, or a spec pointing at a private
    // address would be retried forever as though the registry were flaky.
    const blocked = error.code === BLOCKED_ADDRESS_CODE || error.cause?.code === BLOCKED_ADDRESS_CODE;
    if (blocked) {
      this.#lookupErrorDetail = `Refused: ${this.rawImageTag} resolves to a private or reserved address`;
      this.#lookupErrorMeta = {
        httpStatus: null,
        errorCode: BLOCKED_ADDRESS_CODE,
        errorType: 'invalid_format',
      };
      return { data: null };
    }

    // A request that got no HTTP response at all is a connectivity answer, not a
    // registry verdict - route it with the coded connection errors rather than
    // letting an undefined status read as an HTTP rejection below.
    if (connectionErrors.includes(error.code) || (error.request && !error.response)) {
      this.#lookupErrorDetail = `Connection Error ${error.code}: ${this.rawImageTag} not available`;
      this.#lookupErrorMeta = {
        httpStatus: null,
        errorCode: error.code,
        errorType: 'network',
      };
      return { data: null };
    }

    const httpStatus = error.response?.status;

    if (httpStatus !== 401) {
      this.#lookupErrorDetail = `Bad HTTP Status ${httpStatus}: ${this.rawImageTag} not available`;
      this.#lookupErrorMeta = {
        httpStatus,
        errorCode: null,
        // eslint-disable-next-line no-nested-ternary
        errorType: httpStatus === 429 ? 'rate_limit' : (httpStatus >= 500 ? 'server_error' : 'http_error'),
        // What the registry said about its own limit, carried so a caller can
        // pace a retry off the registry's number instead of a fixed guess.
        ...ImageVerifier.rateLimitMeta(error.response.headers),
      };
      return { data: null };
    }

    if (this.authConfigured) {
      // This is the second 401 - we already set up auth and retried
      if (this.authVerified) {
        // Bearer: Credentials were verified at realm endpoint, so image doesn't exist
        this.#lookupErrorDetail = `Authentication failed: ${this.rawImageTag} not available or doesn't exist`;
        this.#lookupErrorMeta = {
          httpStatus: 401,
          errorCode: null,
          errorType: 'auth_failed',
        };
      } else {
        // Basic: Credentials weren't verified yet, so they must be invalid
        this.#lookupErrorDetail = `Authentication rejected for: ${this.rawImageTag}`;
        this.#lookupErrorMeta = {
          httpStatus: 401,
          errorCode: null,
          errorType: 'auth_rejected',
        };
      }
      return { data: null };
    }

    const authDetails = ImageVerifier.parseAuthHeader(
      error.response.headers['www-authenticate'],
    );

    if (!authDetails) {
      this.#lookupErrorDetail = `Malformed Auth Header: ${this.rawImageTag} not available`;
      this.#lookupErrorMeta = {
        httpStatus: 401,
        errorCode: null,
        errorType: 'auth_error',
      };
      return { data: null };
    }

    await this.#handleAuth(authDetails);

    if (!this.authConfigured) return { data: null };

    return this.#axiosInstance
      .get(endpointUrl)
      .catch((err) => this.#handleAxiosError(endpointUrl, err));
  }

  async #evaluateImageManifest(manifestIndex) {
    this.evaluated = true;

    const evaluateSingleImage = async (manifest, architecture) => {
      let size = 0;
      let arch = architecture;

      // this can happen if we ask for a manifest list, but only get a manifest. If
      // so, we need to look up the image config to get the arch.
      if (!arch) {
        const imageConfig = await this.#fetchConfig(manifest.config.digest);
        if (this.error) return;

        arch = imageConfig.architecture;
      }

      manifest.layers.forEach((layer) => {
        size += layer.size;
      });

      // Track the largest compressed image across evaluated architectures so a
      // caller can early-reject an image that cannot fit the component's rootFs.
      if (size > this.#imageSizeBytes) this.#imageSizeBytes = size;

      if (size > this.maxImageSize) {
        this.#evaluationErrorDetail = `Docker image: ${this.rawImageTag} size is over Flux limit`;
        this.#lookupErrorMeta = {
          httpStatus: null,
          errorCode: null,
          errorType: 'size_limit',
        };
      } else {
        // An image already refused on its compressed size needs no size records read.
        await this.#measureLayers(manifest.layers);
      }

      // Store architecture for single image manifests (if not already stored)
      if (arch && !this.#supportedArchitectures.includes(arch)) {
        this.#supportedArchitectures.push(arch);
      }

      if (this.architecture === arch) this.#architectureSupported = true;
    };

    const evaluateMultipleImages = async (manifest) => {
      const images = manifest.manifests.filter((m) => this.architectureSet.includes(m.platform.architecture));

      if (!images.length) {
        this.#evaluationErrorDetail = `Docker image: ${this.rawImageTag} does not have a valid architecture`;
        this.#lookupErrorMeta = {
          httpStatus: null,
          errorCode: null,
          errorType: 'unsupported_architecture',
        };
        return;
      }

      // Store all supported architectures from the manifest
      this.#supportedArchitectures = images.map((img) => img.platform.architecture);

      // The one-second wait that used to sit here was ECR Public's 1 req/s rule
      // charged to every registry, including Docker Hub and GHCR which are
      // count-capped and uncapped respectively - two seconds of pure latency per
      // multi-architecture component. The governor now paces per provider, so
      // ECR Public is still spaced correctly and nobody else pays for it.
      // eslint-disable-next-line no-restricted-syntax
      for (const image of images) {
        // eslint-disable-next-line no-await-in-loop
        const singleManifest = await this.#fetchManifest(image.digest);

        if (this.error) return;
        // eslint-disable-next-line no-await-in-loop
        await evaluateSingleImage(singleManifest, image.platform.architecture);
      }
    };

    const { mediaType } = manifestIndex;

    switch (mediaType) {
      case 'application/vnd.oci.image.index.v1+json':
        await evaluateMultipleImages(manifestIndex);
        break;
      case 'application/vnd.oci.image.manifest.v1+json':
        await evaluateSingleImage(manifestIndex);
        break;
      case 'application/vnd.docker.distribution.manifest.list.v2+json':
        await evaluateMultipleImages(manifestIndex);
        break;
      case 'application/vnd.docker.distribution.manifest.v2+json':
        await evaluateSingleImage(manifestIndex);
        break;
      default:
        this.#evaluationErrorDetail = `Unsupported Media type: ${mediaType} for: ${this.rawImage}`;
        this.#lookupErrorMeta = {
          httpStatus: null,
          errorCode: null,
          errorType: 'unsupported_media_type',
        };
    }
  }

  /**
   * Run one registry round-trip under the governor: wait for this provider's
   * concurrency slot, rate budget and any cooldown, make the request, then feed
   * the answer back so a 429 becomes a cooldown the next caller respects.
   *
   * Every request to a registry goes through here. That is what lets the pacing
   * be per-provider rather than a fixed sleep charged to all of them, and it is
   * why the caller-side sleep this replaced could be deleted.
   *
   * @param {() => Promise<any>} request
   * @returns {Promise<any>} whatever request resolves to
   */
  async #guardedRequest(request) {
    const release = await registryGovernor.acquire(this.provider, {
      authed: this.authConfigured,
      timeoutMs: this.governorTimeoutMs,
    });

    try {
      const response = await request();
      if (response && response.headers) {
        registryGovernor.recordResponse(this.provider, {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    } catch (error) {
      if (error.response) {
        registryGovernor.recordResponse(this.provider, {
          status: error.response.status,
          headers: error.response.headers,
        });
      }
      throw error;
    } finally {
      release();
    }
  }

  async #fetchManifest(digest) {
    const manifestEndpoint = this.namespace
      ? `${this.namespace}/${this.repository}/manifests/${digest}`
      : `${this.repository}/manifests/${digest}`;

    const { data: imageManifest } = await this
      .#guardedRequest(() => this.#axiosInstance.get(manifestEndpoint))
      .catch((error) => this.#handleAxiosError(manifestEndpoint, error));

    return imageManifest;
  }

  /**
   * Ranged GET of a blob's first or last few bytes. Deliberately silent: a
   * registry that refuses Range, a redirect that drops it, or a request that
   * fails leaves the layer unmeasured - it is never a verdict on the image, so it
   * must not reach the error state that decides whether the image is usable.
   *
   * @param {string} digest
   * @param {number} start first byte offset
   * @param {number} end last byte offset, inclusive
   * @returns {Promise<Buffer|null>} null unless the registry answered 206
   */
  async #fetchBlobRange(digest, start, end) {
    const blobsEndpoint = this.namespace
      ? `${this.namespace}/${this.repository}/blobs/${digest}`
      : `${this.repository}/blobs/${digest}`;

    // Governed like every other registry request - these are ranged GETs on
    // blobs, so they do not count against a manifest cap, but they are still
    // requests to the provider. The catch stays all-encompassing: a governor
    // refusal leaves the layer unmeasured exactly as a refused Range does, and
    // must not become a verdict on the image.
    const response = await this
      .#guardedRequest(() => this.#axiosInstance.get(blobsEndpoint, {
        headers: { Range: `bytes=${start}-${end}`, Accept: '*/*' },
        responseType: 'arraybuffer',
        decompress: false,
        maxContentLength: maxBlobRangeBytes,
      }))
      .catch(() => null);

    // 200 means the range was ignored and the body is the whole layer, not the
    // bytes asked for - unmeasured rather than misread.
    if (!response || response.status !== 206 || !response.data) return null;

    return Buffer.from(response.data);
  }

  /**
   * Walk one architecture's layers for their decompressed sizes and fold the totals
   * into the largest seen so far - each figure independently, because whichever
   * architecture this node runs, a rootFs declaration has to cover it. One layer
   * that cannot be read leaves the whole image unmeasured, and there is nothing
   * left to learn from the layers after it.
   *
   * @param {Array<{mediaType: string, digest: string, size: number}>} layers
   */
  async #measureLayers(layers) {
    let decompressedSize = 0;
    let clearanceSize = 0;

    for (const layer of layers) {
      const measurement = await this.#measureLayer(layer);

      if (!measurement) {
        this.#decompressedSizeMeasured = false;
        return;
      }

      decompressedSize += measurement.bytes;
      clearanceSize += measurement.nextCandidateBytes;
    }

    if (decompressedSize > this.#decompressedSizeBytes) this.#decompressedSizeBytes = decompressedSize;
    if (clearanceSize > this.#decompressedSizeClearanceBytes) this.#decompressedSizeClearanceBytes = clearanceSize;
  }

  /**
   * Decompressed size of a single layer, read from the layer's own size record:
   * gzip keeps it in the last four bytes of the stream, zstd in its frame header.
   * A layer of any other media type, or one whose record cannot be read, is
   * unmeasured.
   *
   * @param {{mediaType: string, digest: string, size: number}} layer
   * @returns {Promise<{bytes: number, nextCandidateBytes: number}|null>}
   */
  async #measureLayer(layer) {
    const compressedBytes = layer?.size;

    if (!layer?.digest || !Number.isFinite(compressedBytes) || compressedBytes <= 0) return null;

    if (gzipLayerMediaTypes.includes(layer.mediaType)) {
      if (compressedBytes <= gzipIsizeBytes) return null;

      const trailer = await this.#fetchBlobRange(
        layer.digest,
        compressedBytes - gzipIsizeBytes,
        compressedBytes - 1,
      );

      if (!trailer || trailer.length < gzipIsizeBytes) return null;

      return resolveGzipIsize(trailer.readUInt32LE(0), compressedBytes);
    }

    if (zstdLayerMediaTypes.includes(layer.mediaType)) {
      const header = await this.#fetchBlobRange(layer.digest, 0, zstdFrameHeaderBytes - 1);

      if (!header) return null;

      const contentSize = parseZstdFrameContentSize(header);

      if (contentSize === null) return null;

      return { bytes: contentSize, nextCandidateBytes: contentSize };
    }

    return null;
  }

  async #fetchConfig(digest) {
    const blobsEndpoint = this.namespace
      ? `${this.namespace}/${this.repository}/blobs/${digest}`
      : `${this.repository}/blobs/${digest}`;

    const { data: imageConfig } = await this
      .#guardedRequest(() => this.#axiosInstance.get(blobsEndpoint))
      .catch((error) => this.#handleAxiosError(blobsEndpoint, error));

    return imageConfig;
  }

  /**
   * Performs a HEAD request to get the manifest digest without downloading the full manifest.
   * @returns {Promise<string|null>} Docker-Content-Digest header value (sha256:xxx) or null on error
   */
  async fetchManifestDigestOnly() {
    if (this.error) return null;

    const manifestEndpoint = this.namespace
      ? `${this.namespace}/${this.repository}/manifests/${this.tag}`
      : `${this.repository}/manifests/${this.tag}`;

    const response = await this
      .#guardedRequest(() => this.#axiosInstance.head(manifestEndpoint))
      .catch((error) => this.#handleAxiosError(manifestEndpoint, error));

    if (!response || !response.headers) return null;

    // Docker-Content-Digest header contains the digest in format sha256:xxx
    const digest = response.headers['docker-content-digest'];
    return digest || null;
  }

  /**
   * Adds credentials to the verifier.
   * @param {string|object} credentials - Either "username:password" string or {username, password} object
   */
  addCredentials(credentials) {
    // Accept object format (preferred - avoids parsing issues with passwords containing colons)
    if (credentials && typeof credentials === 'object' && credentials.username && credentials.password) {
      this.credentials = {
        username: credentials.username,
        password: credentials.password,
        authType: credentials.type, // Preserve auth type (bearer/basic)
      };
      return;
    }

    // Accept string format (backward compatible)
    // Use indexOf + substring to handle passwords containing colons correctly
    if (credentials && typeof credentials === 'string') {
      const colonIndex = credentials.indexOf(':');
      if (colonIndex === -1) {
        this.credentials = null;
        return;
      }

      const username = credentials.substring(0, colonIndex);
      const password = credentials.substring(colonIndex + 1);
      this.credentials = username && password ? { username, password } : null;
      return;
    }

    this.credentials = null;
  }

  resetErrors() {
    this.#parseErrorDetail = null;
    this.#lookupErrorDetail = null;
    this.#evaluationErrorDetail = null;
    this.#lookupErrorMeta = null;
  }

  /**
   * Allows for descriptive errors to be throw if there are any errors present.
   * @returns {void}
   */
  throwIfError() {
    if (!this.error) return;

    const error = new Error(
      this.#parseErrorDetail
      || this.#lookupErrorDetail
      || this.#evaluationErrorDetail,
    );
    // Carry the transient/permanent split on the throw - provisioning consumers
    // route their verdicts on it (absence reads permanent). Captured before
    // resetErrors wipes the meta it derives from.
    error.registryErrorClass = this.errorClass;
    this.resetErrors();
    throw error;
  }

  /**
   * Allows for any long running axios requests to be aborted
   */
  abort() {
    this.#abortController.abort();
  }


  /**
   * Checks that the image is available for the provided architecture set, and that the image's size
   * is less that the configured maximum image size, for the provided architecture set.
   * @returns {Promise<boolean>}
   */
  async verifyImage() {
    if (this.error) return false;

    const imageManifest = await this.#fetchManifest(this.tag);

    if (!imageManifest) return false;

    if (imageManifest.schemaVersion !== 2) {
      this.#lookupErrorDetail = `Unsupported schemaVersion: ${imageManifest.schemaVersion} for: ${this.rawImageTag}`;
      this.#lookupErrorMeta = {
        httpStatus: null,
        errorCode: null,
        errorType: 'unsupported_schema',
      };
      return false;
    }

    await this.#evaluateImageManifest(imageManifest);

    return this.verified;
  }
}

module.exports = { ImageVerifier };
