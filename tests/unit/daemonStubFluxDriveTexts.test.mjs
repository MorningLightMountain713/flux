import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect } from 'chai';
import {
  blobUploadDigest, manifestPutDigest, slotReconcileDigest, arcaneSignedMessage,
} from '@runonflux/flux-spec';
import * as benchCrypto from '../../test-infra/daemon-stub/benchCrypto.js';

// The harness daemon stub stands in for the benchmark channel's signer, so the
// texts it signs must be the library's: every suite that uploads content runs
// through it, and FluxDrive verifies against the library's forms. The stub is an
// independent implementation on purpose; this is what keeps it honest.
const require = createRequire(import.meta.url);
const vectors = JSON.parse(fs.readFileSync(
  path.join(path.dirname(require.resolve('@runonflux/flux-spec/package.json')), 'vectors', 'fluxdrive-write-texts.json'),
  'utf8',
));

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function verifies(signatureB64, message) {
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(benchCrypto.blobUploadPubkeyB64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureB64, 'base64'));
}

describe('daemon stub: the FluxDrive texts it signs are the library\'s', () => {
  const { identity } = vectors;
  const fresh = Date.now();

  it('signs a blob upload over the library\'s text under the upload domain', () => {
    const fields = { kind: 'upload', identity, locator: 'a'.repeat(64), timestamp: fresh };
    const sig = benchCrypto.signBlobUpload(fields);
    expect(verifies(sig, arcaneSignedMessage('upload', blobUploadDigest(fields)))).to.equal(true);
    expect(verifies(sig, arcaneSignedMessage('manifest', blobUploadDigest(fields))), 'one kind never verifies as another').to.equal(false);
  });

  it('signs a manifest put over the library\'s text, naming the message or not', () => {
    for (const pendingMessageHash of [null, undefined, 'f'.repeat(64)]) {
      const fields = { kind: 'manifest', identity, version: 3, timestamp: fresh, pendingMessageHash };
      const sig = benchCrypto.signBlobUpload(fields);
      expect(verifies(sig, arcaneSignedMessage('manifest', manifestPutDigest({ ...fields, pendingMessageHash: pendingMessageHash ?? null }))), String(pendingMessageHash)).to.equal(true);
    }
  });

  it('signs a reconcile over the library\'s text, the kept list hashed sorted and each once', () => {
    for (const vector of [vectors.reconcile, vectors.reconcileCarried]) {
      const sig = benchCrypto.signBlobUpload({
        kind: 'reconcile', identity, source: vector.source, version: vector.version, keptLocators: vector.locators, pendingMessageHash: vector.pendingMessageHash,
      });
      expect(verifies(sig, arcaneSignedMessage('reconcile', vector.digest))).to.equal(true);
      expect(slotReconcileDigest({
        identity, source: vector.source, version: vector.version, keptLocators: vector.locators, pendingMessageHash: vector.pendingMessageHash,
      })).to.equal(vector.digest);
    }
  });

  it('refuses a text naming no identity, another spelling, or a malformed message hash', () => {
    for (const bad of [undefined, 'myapp', `B${'a'.repeat(52)}`, `b${'a'.repeat(51)}b`, `b${'a'.repeat(53)}`]) {
      expect(() => benchCrypto.signBlobUpload({ kind: 'upload', identity: bad, locator: 'l', timestamp: fresh }), String(bad)).to.throw(/identity invalid/);
      expect(() => benchCrypto.locatorFor({ identity: bad, contentHash: 'h' }), String(bad)).to.throw(/identity invalid/);
      expect(() => benchCrypto.contentKeyFor({ identity: bad, contentHash: 'h' }), String(bad)).to.throw(/identity invalid/);
    }
    expect(() => benchCrypto.signBlobUpload({ kind: 'manifest', identity, version: 1, timestamp: fresh, pendingMessageHash: 'nope' })).to.throw(/pendingMessageHash invalid/);
    expect(() => benchCrypto.signBlobUpload({ kind: 'reconcile', identity, source: 'slot', version: 1, keptLocators: [] })).to.throw(/keptLocators invalid/);
  });

  it('derives locators and keys by identity alone: two apps of one name and owner never share them', () => {
    const other = `b${'c'.repeat(51)}a`;
    expect(benchCrypto.locatorFor({ identity, contentHash: 'h' })).to.not.equal(benchCrypto.locatorFor({ identity: other, contentHash: 'h' }));
    expect(benchCrypto.contentKeyFor({ identity, contentHash: 'h' })).to.not.equal(benchCrypto.contentKeyFor({ identity: other, contentHash: 'h' }));
    expect(benchCrypto.locatorFor({ identity, contentHash: 'h' })).to.equal(benchCrypto.locatorFor({ identity, contentHash: 'h' }));
  });

  it('seals under the content key by identity, apart from the app-secret key, and refuses a request naming both', () => {
    const message = Buffer.from('slots').toString('base64');
    const aad = Buffer.from('aad').toString('base64');
    const byIdentity = benchCrypto.appEncrypt({ identity, message, aad });
    expect(Buffer.from(benchCrypto.appDecrypt({ identity, ...byIdentity, aad }).message, 'base64').toString()).to.equal('slots');
    // The name-and-owner key does not open what the identity sealed.
    expect(() => benchCrypto.appDecrypt({ appName: 'app', fluxID: '1owner', ...byIdentity, aad })).to.throw();
    expect(() => benchCrypto.appEncrypt({ identity, appName: 'app', message, aad })).to.throw(/AMBIGUOUS_KEY/);
    expect(() => benchCrypto.appEncrypt({ identity: 'app', message, aad })).to.throw(/identity invalid/);
  });
});
