const volumeService = require('../utils/volumeService');

/**
 * Resolve which app volume a request addresses.
 *
 * --- Why this exists ---
 * Every file and volume route repeated the same preamble: read `appname` and
 * `component` from params-or-query, resolve the volume, take `[0].mount`. There
 * were twelve copies and they had already drifted (some validated appname, some
 * only component). More importantly, `(app, component)` stopped naming a single
 * volume once a node could hold a co-located replica pair — one volume is
 * mounted per replica — so `[0]` silently picked a sibling. Reading files from
 * an arbitrary replica is confusing; restoring into one overwrites live data.
 *
 * Asking the question once means the identity rule is decided in a single place
 * and `?replica=` works on every route that resolves through here.
 *
 * --- What it does NOT do ---
 * No authorization. `verifyPrivilege` stays explicit in each handler: a
 * security check that every route can be seen to make is worth more than the
 * duplication it costs.
 *
 * --- Ambiguity is an error, not a guess ---
 * With no `replica` given: one volume resolves it, several do not. A co-located
 * app must be addressed by replica, and saying so beats picking. Apps that are
 * not co-located — every loose app, and every named app alone on its node —
 * keep working untouched, which is why omitting the parameter stays valid.
 */

/**
 * @param {object} req - express request
 * @param {{requireComponent?: boolean}} [opts]
 * @returns {Promise<{appname: string, component: string, replica: string|null,
 *   mount: string, volume: object}>} `volume` is the resolved row, so a caller
 *   reporting usage does not repeat the lookup to get its byte counts.
 */
async function resolveVolumeTarget(req, { requireComponent = true } = {}) {
  const appname = req.params.appname || req.query.appname || '';
  const component = req.params.component || req.query.component || '';
  const replica = req.params.replica || req.query.replica || null;

  if (!appname) throw new Error('appname parameter is mandatory');
  if (requireComponent && !component) throw new Error('component parameter is mandatory');

  // The v1-3 flat form has no component: its identifier is the bare app name.
  const volumes = await volumeService.listComponentVolumeMounts(appname, component || appname);

  if (!volumes.length) throw new Error('Application volume not found');

  if (replica !== null) {
    const match = volumes.find((volume) => volume.replica === replica);
    if (!match) {
      throw new Error(`Application volume not found for replica ${replica} (present: ${describeReplicas(volumes)})`);
    }
    return {
      appname, component, replica, mount: match.mount, volume: match,
    };
  }

  if (volumes.length > 1) {
    throw new Error(`${appname} is co-located on this node — specify which replica with ?replica= (present: ${describeReplicas(volumes)})`);
  }

  return {
    appname,
    component,
    replica: volumes[0].replica,
    mount: volumes[0].mount,
    volume: volumes[0],
  };
}

function describeReplicas(volumes) {
  return volumes.map((volume) => volume.replica ?? 'unnamed').join(', ');
}

module.exports = { resolveVolumeTarget };
