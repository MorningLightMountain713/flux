const express = require('express');
const { createHash } = require('crypto');

const PORT = parseInt(process.env.STUB_PORT || '3000', 10);
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '3001', 10);

const state = {
  blockedRepositories: [],
  tamperingBlocklist: [],
  enterpriseNodes: {},
  // Per-path 200/304 tallies, so a suite can prove a node revalidated conditionally rather
  // than re-downloading. Reset with /reset or /policy-requests.
  policyRequests: {},
  // Paths made to fail, so a suite can exercise what a node does when a policy document
  // is unreachable rather than only when it is empty. Path -> HTTP status.
  failingPaths: {},
  latestRelease: { tag_name: 'v0.0.0', name: 'stub-release' },
  geolocation: {},
  moduleMinimumVersions: {},
  marketplaceApps: [],
  appsUsdPrice: null,
  // viprates shape: [0] = fiat rates array, [1] = per-coin BTC rates
  fiatRates: [[{ code: 'USD', rate: 1 }], { FLUX: 1 }],
};

function defaultGeoResponse(ip) {
  return {
    status: 'success',
    continent: 'Europe',
    continentCode: 'EU',
    country: 'Germany',
    countryCode: 'DE',
    region: 'HE',
    regionName: 'Hesse',
    lat: 50.1109,
    lon: 8.6821,
    query: ip,
    org: 'Hetzner Online GmbH',
    isp: 'Hetzner Online GmbH',
    proxy: false,
    hosting: true,
  };
}

// --- HTTP endpoint server ---

const app = express();
app.use(express.json());

// Fail any path the control plane has been told to break, before its handler runs.
app.use((req, res, next) => {
  const status = state.failingPaths[req.path];
  if (status) {
    res.status(status).send(`stub: ${req.path} forced to fail`);
    return;
  }
  next();
});

// Policy documents are served with an ETag and honour If-None-Match, because FluxOS sends
// conditional requests and a stub that always answered 200 would leave that path untested —
// a node that never gets a 304 re-downloads every document on every interval.
//
// The tag is derived from the body, so it changes exactly when the document does. Quoted and
// weak-prefixed to match what GitHub raw serves, since the node stores whatever it is handed
// and echoes it back verbatim.
function countRequest(path, status) {
  const counts = state.policyRequests[path] || { 200: 0, 304: 0 };
  counts[status] += 1;
  state.policyRequests[path] = counts;
}

function sendPolicyDocument(req, res, value) {
  const body = JSON.stringify(value);
  const etag = `W/"${createHash('sha1').update(body).digest('hex')}"`;
  res.set('ETag', etag);

  if (req.get('If-None-Match') === etag) {
    countRequest(req.path, 304);
    res.status(304).end();
    return;
  }

  countRequest(req.path, 200);
  res.type('application/json').send(body);
}

// GitHub raw content endpoints
app.get('/helpers/blockedrepositories.json', (req, res) => {
  sendPolicyDocument(req, res, state.blockedRepositories);
});

app.get('/helpers/tamperingblockednodes.json', (req, res) => {
  sendPolicyDocument(req, res, state.tamperingBlocklist);
});

app.get('/helpers/enterprisenodes.json', (req, res) => {
  sendPolicyDocument(req, res, state.enterpriseNodes);
});

// GitHub API endpoints
app.get('/repos/:owner/:repo/releases/latest', (req, res) => {
  res.json(state.latestRelease);
});

app.get('/repos/:owner/:repo', (req, res) => {
  res.json({ full_name: `${req.params.owner}/${req.params.repo}` });
});

// Geolocation: ip-api.com format (primary)
app.get('/json/:ip', (req, res) => {
  const custom = state.geolocation[req.params.ip];
  res.json({ ...defaultGeoResponse(req.params.ip), ...custom });
});

// Geolocation: stats.runonflux.io format (fallback)
app.get('/fluxlocation/:ip', (req, res) => {
  const { ip } = req.params;
  const custom = state.geolocation[ip];
  const geo = { ...defaultGeoResponse(ip), ...custom };
  res.json({
    status: 'success',
    data: {
      ip,
      continent: geo.continent,
      continentCode: geo.continentCode,
      country: geo.country,
      countryCode: geo.countryCode,
      region: geo.region,
      regionName: geo.regionName,
      lat: geo.lat,
      lon: geo.lon,
      org: geo.org,
      static: !geo.proxy && geo.hosting,
      dataCenter: geo.hosting,
    },
  });
});

// Flux stats service: module minimum versions (systemService package monitor)
app.get('/getmodulesminimumversions', (req, res) => {
  res.json({ status: 'success', data: state.moduleMinimumVersions });
});

// Flux stats service: marketplace apps (pricing multiplier, user-blocked-repo exemption)
app.get('/marketplace/listapps', (req, res) => {
  res.json({ status: 'success', data: state.marketplaceApps });
});

app.get('/marketplace/listdevapps', (req, res) => {
  res.json({ status: 'success', data: state.marketplaceApps });
});

// Flux stats service: USD pricing tiers. The default error envelope makes the
// consumer fall back to config.fluxapps.usdprice - deterministic per node config.
app.get('/apps/getappspecsusdprice', (req, res) => {
  if (state.appsUsdPrice) res.json({ status: 'success', data: state.appsUsdPrice });
  else res.json({ status: 'error' });
});

// viprates fiat rates
app.get('/rates', (req, res) => {
  res.json(state.fiatRates);
});

// --- Control API ---

const control = express();
control.use(express.json());

control.get('/state', (req, res) => {
  res.json(state);
});

control.post('/blocked-repos', (req, res) => {
  state.blockedRepositories = req.body;
  res.json({ ok: true });
});

control.post('/enterprise-nodes', (req, res) => {
  state.enterpriseNodes = req.body;
  res.json({ ok: true });
});

// Clear the 200/304 tallies without disturbing anything else, so a suite can count the
// requests one restart makes rather than every request since boot.
control.post('/policy-requests', (req, res) => {
  state.policyRequests = {};
  res.json({ ok: true });
});

// { "/helpers/blockedrepositories.json": 503 } — or {} to stop failing everything.
control.post('/failing-paths', (req, res) => {
  state.failingPaths = req.body;
  res.json({ ok: true });
});

control.post('/tampering-blocklist', (req, res) => {
  state.tamperingBlocklist = req.body;
  res.json({ ok: true });
});

control.post('/latest-release', (req, res) => {
  state.latestRelease = req.body;
  res.json({ ok: true });
});

control.post('/geolocation/:ip', (req, res) => {
  state.geolocation[req.params.ip] = req.body;
  res.json({ ok: true });
});

control.delete('/geolocation/:ip', (req, res) => {
  delete state.geolocation[req.params.ip];
  res.json({ ok: true });
});

control.post('/module-versions', (req, res) => {
  state.moduleMinimumVersions = req.body;
  res.json({ ok: true });
});

control.post('/marketplace-apps', (req, res) => {
  state.marketplaceApps = req.body;
  res.json({ ok: true });
});

control.post('/usd-prices', (req, res) => {
  state.appsUsdPrice = req.body;
  res.json({ ok: true });
});

control.post('/fiat-rates', (req, res) => {
  state.fiatRates = req.body;
  res.json({ ok: true });
});

control.post('/reset', (req, res) => {
  state.blockedRepositories = [];
  state.tamperingBlocklist = [];
  state.enterpriseNodes = {};
  state.failingPaths = {};
  state.policyRequests = {};
  state.latestRelease = { tag_name: 'v0.0.0', name: 'stub-release' };
  state.geolocation = {};
  state.moduleMinimumVersions = {};
  state.marketplaceApps = [];
  state.appsUsdPrice = null;
  state.fiatRates = [[{ code: 'USD', rate: 1 }], { FLUX: 1 }];
  res.json({ ok: true });
});

control.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`External HTTP stub listening on port ${PORT}`);
});

control.listen(CONTROL_PORT, () => {
  console.log(`External HTTP stub control API on port ${CONTROL_PORT}`);
});
