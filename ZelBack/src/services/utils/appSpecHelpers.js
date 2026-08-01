const messageHelper = require('../messageHelper');
const serviceHelper = require('../serviceHelper');
const daemonServiceMiscRpcs = require('../daemonService/daemonServiceMiscRpcs');
const { resolveSpec } = require('./specCutover');
const { regimeFor } = require('../pricing/pricingRegime');
const log = require('../../lib/log');

/**
 * Get app Flux on-chain price (FLUX, decimal).
 *
 * Which figure this is depends on the spec's pricing regime: for v1-v8 it is
 * the near-zero chain floor, which is not what the owner pays; for v9 it is the
 * whole price. See pricingRegime for why the two differ.
 *
 * @param {object} appSpecification - Application specification
 * @returns {Promise<number|string>} Price in FLUX (decimal)
 */
async function getAppFluxOnChainPrice(appSpecification) {
  const spec = await resolveSpec(appSpecification);
  return regimeFor(spec).onChainDisplayPrice(spec);
}

/**
 * Compute app price (USD + FLUX) for display.
 *
 * Pure business logic: takes the parsed appSpecification, returns the price
 * object, throws on error (the *Api handler formats the response). The raw
 * document is passed through alongside the resolved spec because the legacy
 * regime honours priceUSD, a marketplace field carried on the request that
 * exists on no spec class.
 *
 * @param {object} appSpecification - parsed application specification
 * @returns {Promise<{usd: number|null, flux: number, fluxDiscount: number|string, fiatMarkupBp?: number}>}
 */
async function getAppFiatAndFluxPrice(appSpecification) {
  if (!appSpecification) {
    throw new Error('Invalid application specification provided.');
  }

  const syncStatus = daemonServiceMiscRpcs.isDaemonSynced();
  if (!syncStatus.data.synced) {
    throw new Error('Daemon not yet synced.');
  }
  const spec = await resolveSpec(appSpecification);

  return regimeFor(spec).fiatAndFluxDisplayPrice(spec, appSpecification);
}

/**
 * Express handler for the fiat+flux price quote. Reads/parses the request body
 * and formats the response; delegates pricing to getAppFiatAndFluxPrice.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function getAppFiatAndFluxPriceApi(req, res) {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', async () => {
    try {
      const appSpecification = serviceHelper.ensureObject(serviceHelper.ensureObject(body));
      const price = await getAppFiatAndFluxPrice(appSpecification);
      res.json(messageHelper.createDataMessage(price));
    } catch (error) {
      log.warn(error);
      const errorResponse = messageHelper.createErrorMessage(
        error.message || error,
        error.name,
        error.code,
      );
      res.json(errorResponse);
    }
  });
}

/**
 * Express handler alias for the price quote.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function getAppPriceApi(req, res) {
  return getAppFiatAndFluxPriceApi(req, res);
}

module.exports = {
  getAppFiatAndFluxPrice,
  getAppFiatAndFluxPriceApi,
  getAppPriceApi,
  getAppFluxOnChainPrice,
};
