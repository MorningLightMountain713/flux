import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import axios from 'axios';
import { getSubnetConfig, REGISTRY_ALIAS } from './subnet-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const caCert = readFileSync(join(__dirname, '..', '..', 'fixtures', 'registry-tls', 'ca.pem'));

// The host pushes to the registry's IP (it can't resolve the Docker network alias),
// but the cert is bound to DNS:fluxregistry.test — so connect to the IP yet verify the
// cert against the alias name. Nodes pull via the alias directly. Base-independent.
const REGISTRY = `https://${getSubnetConfig().registry}:5000`;

const registryClient = axios.create({
  baseURL: REGISTRY,
  httpsAgent: new https.Agent({
    ca: caCert,
    checkServerIdentity: (host, cert) => tls.checkServerIdentity(REGISTRY_ALIAS, cert),
  }),
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

// Minimal static x86_64 ELF binary that calls sys_pause in a loop (129 bytes).
// Assembled from: _start: mov eax,34; syscall; jmp _start
// No libc, no dynamic linker, no filesystem dependencies.
const PAUSE_BINARY = Buffer.from(
  '7f454c46020101000000000000000000'
  + '02003e00010000007800400000000000'
  + '40000000000000000000000000000000'
  + '00000000400038000100000000000000'
  + '01000000050000000000000000000000'
  + '00004000000000000000400000000000'
  + '81000000000000008100000000000000'
  + '0010000000000000b8220000000f05ebf7',
  'hex',
);

function tarEntry(name, data, mode = '0100755') {
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0);
  header.write(`${mode}\0`, 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write('0000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header[156] = 48; // '0' = regular file
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const padLen = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(padLen)]);
}

function buildLayerTar(markerContent) {
  const pauseEntry = tarEntry('bin/pause', PAUSE_BINARY);
  const markerEntry = tarEntry('marker', Buffer.from(markerContent), '0100644');
  const eof = Buffer.alloc(1024);
  return zlib.gzipSync(Buffer.concat([pauseEntry, markerEntry, eof]));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function uploadBlob(repo, data) {
  const digest = `sha256:${sha256(data)}`;

  const initRes = await registryClient.post(`/v2/${repo}/blobs/uploads/`, null, {
    headers: { 'Content-Length': '0' },
    maxRedirects: 0,
    validateStatus: (s) => s === 202,
  });

  const location = initRes.headers.location;
  const separator = location.includes('?') ? '&' : '?';
  const putUrl = `${location}${separator}digest=${digest}`;

  await registryClient.put(putUrl, data, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
    },
    validateStatus: (s) => s === 201,
  });

  return digest;
}

export async function pushImage(repo, tag, markerContent = 'v1') {
  const gzippedLayer = buildLayerTar(markerContent);
  const layerDigest = await uploadBlob(repo, gzippedLayer);

  const uncompressedLayer = zlib.gunzipSync(gzippedLayer);
  const diffId = `sha256:${sha256(uncompressedLayer)}`;

  const configObj = {
    architecture: 'amd64',
    os: 'linux',
    config: { Entrypoint: ['/bin/pause'] },
    rootfs: { type: 'layers', diff_ids: [diffId] },
  };
  const configBuf = Buffer.from(JSON.stringify(configObj));
  const configDigest = await uploadBlob(repo, configBuf);

  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size: configBuf.length,
      digest: configDigest,
    },
    layers: [{
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: gzippedLayer.length,
      digest: layerDigest,
    }],
  };

  const manifestRes = await registryClient.put(
    `/v2/${repo}/manifests/${tag}`,
    JSON.stringify(manifest),
    {
      headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
      validateStatus: (s) => s === 201,
    },
  );

  return manifestRes.headers['docker-content-digest'];
}

// Path to the compiled configurable test-app binary (see test-infra/test-app).
const TEST_APP_BIN = join(__dirname, '..', '..', 'test-app', 'test-app');

// Path to the static busybox binary (see test-infra/busybox-fixture) used by
// content components a suite needs to inspect (docker exec /bin/busybox cat|stat).
const BUSYBOX_BIN = join(__dirname, '..', '..', 'busybox-fixture', 'busybox');

// Path to the compiled OTLP receiver fixture (see test-infra/otlp-receiver) —
// the collector component for the real-telemetryd e2e suite.
const OTLP_RECEIVER_BIN = join(__dirname, '..', '..', 'otlp-receiver', 'otlp-receiver');

// Path to the compiled tls-echo fixture (see test-infra/tls-echo) — an HTTPS
// server that reads its certificate from FLUX_TLS_CERT_PATH/KEY_PATH and re-reads
// it on SIGHUP. test-app cannot serve TLS, so this is the app on the far side of
// the platform-managed backend-TLS hop.
const TLS_ECHO_BIN = join(__dirname, '..', '..', 'tls-echo', 'tls-echo');

function buildBinaryLayerTar(binPath, binName, markerContent) {
  if (!existsSync(binPath)) {
    throw new Error(`fixture binary not found at ${binPath}. Build it once (see the matching test-infra/<fixture>/build.sh)`);
  }
  const binEntry = tarEntry(`bin/${binName}`, readFileSync(binPath));
  const markerEntry = tarEntry('marker', Buffer.from(markerContent), '0100644');
  const eof = Buffer.alloc(1024);
  return zlib.gzipSync(Buffer.concat([binEntry, markerEntry, eof]));
}

// Push the OTLP receiver fixture image (entrypoint /bin/otlp-receiver). It
// accepts OTLP/HTTP posts and logs one OTLP-RECV line per request to stdout;
// behaviour is driven by environmentParameters (RECEIVER_PORT, MARK1, MARK2)
// — see test-infra/otlp-receiver/receiver.c.
export async function pushOtlpReceiver(repo, tag = 'v1', markerContent = 'otlpreceiver') {
  const gzippedLayer = buildBinaryLayerTar(OTLP_RECEIVER_BIN, 'otlp-receiver', markerContent);
  const layerDigest = await uploadBlob(repo, gzippedLayer);

  const uncompressedLayer = zlib.gunzipSync(gzippedLayer);
  const diffId = `sha256:${sha256(uncompressedLayer)}`;

  const configObj = {
    architecture: 'amd64',
    os: 'linux',
    config: { Entrypoint: ['/bin/otlp-receiver'] },
    rootfs: { type: 'layers', diff_ids: [diffId] },
  };
  const configBuf = Buffer.from(JSON.stringify(configObj));
  const configDigest = await uploadBlob(repo, configBuf);

  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size: configBuf.length,
      digest: configDigest,
    },
    layers: [{
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: gzippedLayer.length,
      digest: layerDigest,
    }],
  };

  const manifestRes = await registryClient.put(
    `/v2/${repo}/manifests/${tag}`,
    JSON.stringify(manifest),
    {
      headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
      validateStatus: (s) => s === 201,
    },
  );

  return manifestRes.headers['docker-content-digest'];
}

// Push the tls-echo image (entrypoint /bin/tls-echo). Serves HTTPS from the
// certificate the platform delivers, and answers every request with that
// certificate's SHA-256 fingerprint in X-Tls-Echo, so a caller can tell which
// certificate served it without inspecting the handshake. PORT is set from the
// app spec's environmentParameters.
export async function pushTlsEcho(repo, tag = 'v1', markerContent = 'tlsecho') {
  const gzippedLayer = buildBinaryLayerTar(TLS_ECHO_BIN, 'tls-echo', markerContent);
  const layerDigest = await uploadBlob(repo, gzippedLayer);

  const uncompressedLayer = zlib.gunzipSync(gzippedLayer);
  const diffId = `sha256:${sha256(uncompressedLayer)}`;

  const configObj = {
    architecture: 'amd64',
    os: 'linux',
    config: { Entrypoint: ['/bin/tls-echo'] },
    rootfs: { type: 'layers', diff_ids: [diffId] },
  };
  const configBuf = Buffer.from(JSON.stringify(configObj));
  const configDigest = await uploadBlob(repo, configBuf);

  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size: configBuf.length,
      digest: configDigest,
    },
    layers: [{
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: gzippedLayer.length,
      digest: layerDigest,
    }],
  };

  const manifestRes = await registryClient.put(
    `/v2/${repo}/manifests/${tag}`,
    JSON.stringify(manifest),
    {
      headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
      validateStatus: (s) => s === 201,
    },
  );

  return manifestRes.headers['docker-content-digest'];
}

// Push the configurable test-app image (entrypoint /bin/test-app). Exit behaviour
// is driven at run time by the app spec's environmentParameters (EXIT_CODE,
// EXIT_AFTER_S) — see buildSeedableTestApp and test-infra/test-app/test-app.c.
export async function pushTestApp(repo, tag = 'v1', markerContent = 'testapp') {
  const gzippedLayer = buildBinaryLayerTar(TEST_APP_BIN, 'test-app', markerContent);
  const layerDigest = await uploadBlob(repo, gzippedLayer);

  const uncompressedLayer = zlib.gunzipSync(gzippedLayer);
  const diffId = `sha256:${sha256(uncompressedLayer)}`;

  const configObj = {
    architecture: 'amd64',
    os: 'linux',
    config: { Entrypoint: ['/bin/test-app'] },
    rootfs: { type: 'layers', diff_ids: [diffId] },
  };
  const configBuf = Buffer.from(JSON.stringify(configObj));
  const configDigest = await uploadBlob(repo, configBuf);

  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size: configBuf.length,
      digest: configDigest,
    },
    layers: [{
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: gzippedLayer.length,
      digest: layerDigest,
    }],
  };

  const manifestRes = await registryClient.put(
    `/v2/${repo}/manifests/${tag}`,
    JSON.stringify(manifest),
    {
      headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
      validateStatus: (s) => s === 201,
    },
  );

  return manifestRes.headers['docker-content-digest'];
}

// Push a static-busybox image (entrypoint sleeps so the container stays up). Used
// as a content component image when a suite must inspect injected files in-container
// (cat/stat/inode) — the freestanding pause/test-app images have no coreutils.
export async function pushBusybox(repo, tag = 'v1', markerContent = 'busybox') {
  const gzippedLayer = buildBinaryLayerTar(BUSYBOX_BIN, 'busybox', markerContent);
  const layerDigest = await uploadBlob(repo, gzippedLayer);

  const uncompressedLayer = zlib.gunzipSync(gzippedLayer);
  const diffId = `sha256:${sha256(uncompressedLayer)}`;

  const configObj = {
    architecture: 'amd64',
    os: 'linux',
    config: { Entrypoint: ['/bin/busybox', 'sleep', '2147483647'] },
    rootfs: { type: 'layers', diff_ids: [diffId] },
  };
  const configBuf = Buffer.from(JSON.stringify(configObj));
  const configDigest = await uploadBlob(repo, configBuf);

  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size: configBuf.length,
      digest: configDigest,
    },
    layers: [{
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: gzippedLayer.length,
      digest: layerDigest,
    }],
  };

  const manifestRes = await registryClient.put(
    `/v2/${repo}/manifests/${tag}`,
    JSON.stringify(manifest),
    {
      headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
      validateStatus: (s) => s === 201,
    },
  );

  return manifestRes.headers['docker-content-digest'];
}

export async function pushUpdatedImage(repo, tag) {
  const marker = `updated-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  return pushImage(repo, tag, marker);
}

export async function pushBrokenImage(repo, tag) {
  const gzippedLayer = buildLayerTar('broken');
  const layerDigest = await uploadBlob(repo, gzippedLayer);

  const uncompressedLayer = zlib.gunzipSync(gzippedLayer);
  const diffId = `sha256:${sha256(uncompressedLayer)}`;

  const configObj = {
    architecture: 'amd64',
    os: 'linux',
    config: { Entrypoint: ['/nonexistent'] },
    rootfs: { type: 'layers', diff_ids: [diffId] },
  };
  const configBuf = Buffer.from(JSON.stringify(configObj));
  const configDigest = await uploadBlob(repo, configBuf);

  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: {
      mediaType: 'application/vnd.docker.container.image.v1+json',
      size: configBuf.length,
      digest: configDigest,
    },
    layers: [{
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: gzippedLayer.length,
      digest: layerDigest,
    }],
  };

  const manifestRes = await registryClient.put(
    `/v2/${repo}/manifests/${tag}`,
    JSON.stringify(manifest),
    {
      headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
      validateStatus: (s) => s === 201,
    },
  );

  return manifestRes.headers['docker-content-digest'];
}
