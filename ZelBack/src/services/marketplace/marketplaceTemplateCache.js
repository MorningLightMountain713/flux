const config = require('config');
const dbHelper = require('../dbHelper');
const serviceHelper = require('../serviceHelper');
const log = require('../../lib/log');

// Local cache of v9 marketplace templates fetched from the marketplace v2 API.
// Template versions are immutable (one doc per uuid+templateVersion), so the
// cache only ever grows and never goes stale. A warm cache makes registration
// verification independent of the marketplace API being reachable.

function marketplaceDb() {
  return dbHelper.databaseConnection().db(config.database.marketplace.database);
}

function templatesCollection() {
  return config.database.marketplace.collections.templates;
}

function v2Url(path) {
  return `${config.marketplace.apiBaseUrl}/api/v2/marketplace${path}`;
}

async function cacheTemplate(template) {
  if (!template || !template.uuid || typeof template.templateVersion !== 'number') return;
  await dbHelper.updateOneInDatabase(
    marketplaceDb(),
    templatesCollection(),
    { uuid: template.uuid, templateVersion: template.templateVersion },
    { $set: template },
    { upsert: true },
  );
}

/**
 * Bootstrap the cache from the marketplace v2 API on first run. Once populated
 * we skip (versions are immutable; the cache only grows). Best-effort: a failure
 * is logged, not fatal — the cache-miss fetch in getTemplate covers any gaps.
 */
async function bootstrapCache() {
  try {
    const existing = await dbHelper.findOneInDatabase(marketplaceDb(), templatesCollection(), {}, {});
    if (existing) {
      log.info('marketplaceTemplateCache - already populated, skipping bootstrap');
      return;
    }
    const response = await serviceHelper.axiosGet(v2Url('/templates/all'), { timeout: 30000 });
    const templates = response && response.data && response.data.data;
    if (!Array.isArray(templates) || templates.length === 0) {
      log.warn('marketplaceTemplateCache - bootstrap returned no templates');
      return;
    }
    for (const t of templates) {
      // eslint-disable-next-line no-await-in-loop
      await cacheTemplate(t);
    }
    log.info(`marketplaceTemplateCache - bootstrapped ${templates.length} templates`);
  } catch (error) {
    log.error(`marketplaceTemplateCache - bootstrap failed: ${error.message || error}`);
  }
}

/**
 * Resolve a marketplace template by uuid + version. Cache hit -> cached doc.
 * Cache miss -> fetch that specific (immutable) version from the v2 API and
 * cache it. If the API is unreachable or the version is missing, throw — the
 * caller hard-rejects the registration rather than silently accepting it.
 *
 * @param {string} uuid
 * @param {number} templateVersion
 * @returns {Promise<object>} the template document
 */
async function getTemplate(uuid, templateVersion) {
  const cached = await dbHelper.findOneInDatabase(
    marketplaceDb(), templatesCollection(), { uuid, templateVersion }, { _id: 0 },
  );
  if (cached) return cached;

  let response;
  try {
    response = await serviceHelper.axiosGet(v2Url(`/template/${uuid}/${templateVersion}`), { timeout: 15000 });
  } catch (error) {
    throw new Error(`Marketplace template ${uuid} v${templateVersion} not available, try again later`);
  }
  const template = response && response.data && response.data.data;
  if (!template || !template.uuid) {
    throw new Error(`Marketplace template ${uuid} v${templateVersion} not found`);
  }
  await cacheTemplate(template);
  return template;
}

module.exports = { bootstrapCache, getTemplate, cacheTemplate };
