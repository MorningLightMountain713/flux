'use strict';

// The mesh half of the running-apps broadcast: for every installed
// mesh-enabled app whose material is ready, the fields peers need to admit
// this node into that app's overlay — the authority bundle, a voucher freshly
// minted over it, and the transport port. One anchor per broadcast; every
// voucher in it commits to that block.
//
// An app whose material is not ready (no authority yet, no secured port, a
// row without its registration uuid) is simply announced without mesh fields
// this cycle — peers keep running it, they just do not admit it to the
// overlay yet. The reconciler prepares the material; the broadcast only
// reports it. One failing app never blocks the others or the broadcast.
const log = require('../../lib/log');
const generalService = require('../generalService');
const meshCertificates = require('./meshCertificates');
const meshDerivation = require('./meshDerivation');
const meshVoucher = require('./meshVoucher');
const meshPorts = require('./meshPorts');

/**
 * The mesh fields for one broadcast cycle.
 *
 * @param {Array<{name: string, uuid: string|null, identity: string|null}>} installedSpecs
 * @param {Map<string, object>} resolvedViews cleartext spec views by app name
 * @returns {Promise<{anchor: {height: number, hash: string}|null,
 *   perApp: Map<string, {meshCa: string, meshVoucher: string, meshPort: number}>}>}
 *   anchor is null when no app has publishable mesh fields
 */
async function meshBroadcastFields(installedSpecs, resolvedViews) {
  const perApp = new Map();
  const meshApps = installedSpecs.filter(
    (inst) => resolvedViews.get(inst.name)?.network?.mesh === true,
  );
  if (meshApps.length === 0) return { anchor: null, perApp };

  let outpoint;
  let anchor;
  try {
    const collateral = await generalService.obtainNodeCollateralInformation();
    outpoint = meshDerivation.canonicalOutpoint(collateral.txhash, collateral.txindex);
    anchor = await meshVoucher.fetchVoucherAnchor();
  } catch (error) {
    log.warn(`meshBroadcast - no mesh fields this cycle: ${error.message}`);
    return { anchor: null, perApp };
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const inst of meshApps) {
    try {
      if (!inst.uuid || !inst.identity) {
        throw new Error('the app row carries no registration uuid');
      }
      // eslint-disable-next-line no-await-in-loop
      const meshPort = await meshPorts.getPort(inst.identity);
      if (!meshPort) {
        throw new Error('no transport port is secured yet');
      }
      // eslint-disable-next-line no-await-in-loop
      const meshCa = await meshCertificates.authorityBundle(inst.identity);
      // eslint-disable-next-line no-await-in-loop
      const voucher = await meshVoucher.mintVoucher({
        meshCa, appUuid: inst.uuid, outpoint, blockHash: anchor.hash,
      });
      // No ordinal rides here: an ordinal is a grant the whole fleet reads
      // off the synced record (meshOrdinals.js), never a self-assertion.
      perApp.set(inst.name, { meshCa, meshVoucher: voucher, meshPort });
    } catch (error) {
      log.warn(`meshBroadcast - ${inst.name} announced without mesh fields: ${error.message}`);
    }
  }

  return { anchor: perApp.size > 0 ? anchor : null, perApp };
}

module.exports = {
  meshBroadcastFields,
};
