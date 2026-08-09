// The mesh operator surface: the /apps/mesh/... handlers. The window (status)
// is readable by the app's owner and above — it is their app's connectivity;
// the levers (forced renewal, authority rotation, refuse-set edits) mutate
// trust surfaces and are admin/fluxteam only. Handlers parse, authorize and
// respond; every decision they expose was made elsewhere — the reconciler's
// retained pass, the certificate files, the refuse set. No lever converges
// anything itself: each changes an input and pokes the reconciler, which
// remains the sole actuator.
const path = require('node:path');

const log = require('../../lib/log');
const messageHelper = require('../messageHelper');
const verificationHelper = require('../verificationHelper');
const generalService = require('../generalService');
const appsRepository = require('../appDatabase/appsRepository');
const deploymentProvider = require('../appRuntime/deploymentProvider');
const { resolveInstantiatedSpec } = require('../utils/specCutover');
const peerNotification = require('../appMessaging/peerNotification');

const meshDerivation = require('./meshDerivation');
const meshCertificates = require('./meshCertificates');
const meshRefuseSet = require('./meshRefuseSet');
const meshPorts = require('./meshPorts');
const meshNamespace = require('./meshNamespace');
const meshSsh = require('./meshSsh');
const meshReconciler = require('./meshReconciler');

/**
 * Resolve a request's app name to its mesh identity. Throws on an app that is
 * not installed here; a non-mesh app resolves with meshEnabled false so the
 * status handler can answer honestly instead of erroring.
 */
async function resolveMeshApp(appnameRaw) {
  if (typeof appnameRaw !== 'string' || appnameRaw === '') {
    throw new Error('No application name specified');
  }
  const appName = deploymentProvider.appNameFromRequest(appnameRaw);
  const inst = await appsRepository.getInstalledApp(appName);
  if (!inst) {
    throw new Error('Application not found');
  }
  const view = await resolveInstantiatedSpec(inst);
  const meshEnabled = view?.network?.mesh === true;
  if (!meshEnabled) {
    return { appName, meshEnabled: false };
  }
  if (!inst.uuid || !inst.identity) {
    throw new Error(`${appName} is mesh-enabled but carries no registration uuid`);
  }
  const collateral = await generalService.obtainNodeCollateralInformation();
  return {
    appName,
    meshEnabled: true,
    identity: inst.identity,
    ref: {
      instance: inst.identity,
      appUuid: inst.uuid,
      outpoint: meshDerivation.canonicalOutpoint(collateral.txhash, collateral.txindex),
    },
  };
}

const certSummary = (details) => (details ? {
  name: details.name,
  fingerprint: details.fingerprint,
  issuer: details.issuer || null,
  notAfter: details.notAfter instanceof Date ? details.notAfter.toISOString() : details.notAfter,
} : null);

/**
 * The converge trigger every lever ends on: the lever changed an input; the
 * reconciler owns making it true.
 */
function convergeSoon(context) {
  meshReconciler.reconcileAllMeshApps().catch((error) => {
    log.error(`meshOperator - converge after ${context} failed: ${error.message}`);
  });
}

/**
 * Rebroadcast so peers hear a changed authority bundle now rather than on the
 * hourly cycle.
 */
function rebroadcastSoon(context) {
  peerNotification.checkAndNotifyPeersOfRunningApps().catch((error) => {
    log.error(`meshOperator - rebroadcast after ${context} failed: ${error.message}`);
  });
}

/**
 * GET /apps/mesh/status/:appname — the app's mesh state on THIS node: the
 * retained outcome of the last reconcile pass (members, rejections with
 * reasons, detector verdict), the refuse set, the transport port, and the
 * certificate lifecycle. App owner and above.
 */
async function meshAppStatusAPI(req, res) {
  try {
    const appname = req.params.appname ?? req.query.appname;
    if (typeof appname !== 'string' || appname === '') {
      throw new Error('No application name specified');
    }
    // Authorization first, against the name alone — resolving before the
    // check would let an unauthorized caller probe which apps exist here.
    const appName = deploymentProvider.appNameFromRequest(appname);
    const authorized = await verificationHelper.verifyPrivilege('appownerabove', req, appName);
    if (!authorized) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      return res ? res.json(errMessage) : errMessage;
    }
    const resolved = await resolveMeshApp(appname);
    if (!resolved.meshEnabled) {
      const response = messageHelper.createDataMessage({ meshEnabled: false });
      return res ? res.json(response) : response;
    }
    const { identity } = resolved;
    const dir = meshCertificates.meshAppDir(identity);
    const status = {
      meshEnabled: true,
      identity,
      port: await meshPorts.getPort(identity),
      refused: [...await meshRefuseSet.refusedOutpoints(identity)].sort(),
      unitActive: await meshNamespace.meshUnits.nebulaActive(identity),
      certificates: {
        authority: certSummary(await meshCertificates.certificateDetails(path.join(dir, 'ca.crt'))),
        // Non-null while an authority rotation is in progress.
        successor: certSummary(await meshCertificates.certificateDetails(path.join(dir, 'ca-successor.crt'))),
        host: certSummary(await meshCertificates.certificateDetails(path.join(dir, 'host.crt'))),
        // Non-null while a renewal is parked, ageing toward deployment.
        parkedRenewal: certSummary(await meshCertificates.certificateDetails(path.join(dir, 'host-next.crt'))),
      },
      lastPass: meshReconciler.lastPassStatus(resolved.appName),
    };
    const response = messageHelper.createDataMessage(status);
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    return res ? res.json(errorResponse) : errorResponse;
  }
}

async function authorizedAdminLever(req, res) {
  const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
  if (!authorized) {
    const errMessage = messageHelper.errUnauthorizedMessage();
    if (res) res.json(errMessage);
    return null;
  }
  const resolved = await resolveMeshApp(req.body?.appname);
  if (!resolved.meshEnabled) {
    throw new Error(`${resolved.appName} is not a mesh app`);
  }
  return resolved;
}

/**
 * POST /apps/mesh/renewcertificate {appname} — sign and deploy a fresh host
 * certificate now, reload a running nebula, and read back which certificate
 * the daemon actually serves. Admin/fluxteam.
 */
async function meshRenewCertificateAPI(req, res) {
  try {
    const resolved = await authorizedAdminLever(req, res);
    if (!resolved) return null;
    const { identity, ref } = resolved;
    await meshCertificates.forceHostCertificateRenewal(ref);
    const onDisk = await meshCertificates.certificateDetails(
      path.join(meshCertificates.meshAppDir(identity), 'host.crt'),
    );
    const active = await meshNamespace.meshUnits.nebulaActive(identity);
    let verified = null;
    if (active) {
      await meshNamespace.meshUnits.reloadNebula(identity);
      const live = await meshSsh.printOwnCert(identity).catch(() => null);
      verified = Boolean(live && onDisk && live.fingerprint === onDisk.fingerprint);
      if (!verified) {
        log.error(`meshOperator - ${resolved.appName}: nebula still serves the previous certificate after a forced renewal`);
      }
    }
    const response = messageHelper.createDataMessage({
      renewed: true,
      fingerprint: onDisk?.fingerprint ?? null,
      reloaded: active,
      verified,
    });
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * POST /apps/mesh/rotationbegin {appname} — mint the successor authority.
 * From here the bundle and broadcast carry both; peers must hold both before
 * adopt. Admin/fluxteam.
 */
async function meshRotationBeginAPI(req, res) {
  try {
    const resolved = await authorizedAdminLever(req, res);
    if (!resolved) return null;
    await meshCertificates.beginAuthorityRotation(resolved.ref);
    convergeSoon(`rotation begin for ${resolved.appName}`);
    rebroadcastSoon(`rotation begin for ${resolved.appName}`);
    const response = messageHelper.createDataMessage({ rotation: 'begun' });
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * POST /apps/mesh/rotationadopt {appname} — re-sign the host certificate
 * under the successor. The replacement ages and deploys through the sweep.
 * Admin/fluxteam.
 */
async function meshRotationAdoptAPI(req, res) {
  try {
    const resolved = await authorizedAdminLever(req, res);
    if (!resolved) return null;
    await meshCertificates.adoptSuccessorAuthority(resolved.ref);
    convergeSoon(`rotation adopt for ${resolved.appName}`);
    const response = messageHelper.createDataMessage({ rotation: 'adopted' });
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * POST /apps/mesh/rotationconclude {appname} — retire the incumbent. Refused
 * (by the certificate layer) until the deployed host certificate cites the
 * successor. Admin/fluxteam.
 */
async function meshRotationConcludeAPI(req, res) {
  try {
    const resolved = await authorizedAdminLever(req, res);
    if (!resolved) return null;
    await meshCertificates.concludeAuthorityRotation(resolved.identity);
    convergeSoon(`rotation conclude for ${resolved.appName}`);
    rebroadcastSoon(`rotation conclude for ${resolved.appName}`);
    const response = messageHelper.createDataMessage({ rotation: 'concluded' });
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * POST /apps/mesh/refuse {appname, outpoint} — manual eviction: refuse the
 * outpoint ahead of (or instead of) the detector. Admin/fluxteam.
 */
async function meshRefuseAPI(req, res) {
  try {
    const resolved = await authorizedAdminLever(req, res);
    if (!resolved) return null;
    const outpoint = req.body?.outpoint;
    await meshRefuseSet.refuseOutpoint(resolved.identity, outpoint);
    convergeSoon(`refusal of ${outpoint} for ${resolved.appName}`);
    const response = messageHelper.createDataMessage({ refused: outpoint });
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    return res ? res.json(errorResponse) : errorResponse;
  }
}

/**
 * POST /apps/mesh/unrefuse {appname, outpoint} — undo an eviction; the next
 * pass re-admits the outpoint if it still qualifies. Admin/fluxteam.
 */
async function meshUnrefuseAPI(req, res) {
  try {
    const resolved = await authorizedAdminLever(req, res);
    if (!resolved) return null;
    const outpoint = req.body?.outpoint;
    await meshRefuseSet.removeRefusedOutpoint(resolved.identity, outpoint);
    convergeSoon(`unrefusal of ${outpoint} for ${resolved.appName}`);
    const response = messageHelper.createDataMessage({ unrefused: outpoint });
    return res ? res.json(response) : response;
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(error.message || error, error.name, error.code);
    return res ? res.json(errorResponse) : errorResponse;
  }
}

module.exports = {
  meshAppStatusAPI,
  meshRenewCertificateAPI,
  meshRotationBeginAPI,
  meshRotationAdoptAPI,
  meshRotationConcludeAPI,
  meshRefuseAPI,
  meshUnrefuseAPI,
};
