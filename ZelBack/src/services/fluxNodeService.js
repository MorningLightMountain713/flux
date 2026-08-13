'use strict';

/**
 * Service that will be available to all docker apps on the network to get Host information
 * Host Public IP
 * Host Unique Identifier
 * Host Geolocation
 */

const config = require('config');
const log = require('../lib/log');
const messageHelper = require('./messageHelper');
const geolocationService = require('./geolocationService');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const { extractIp } = require('./utils/socketAddressUtils');
const generalService = require('./generalService');
const dockerService = require('./dockerService');
const benchmarkService = require('./benchmarkService');
const meshSnapshot = require('./appMesh/meshSnapshot');
const foundingService = require('./appMesh/foundingService');

const express = require('express');

let server = null;

// Long-poll bounds for /mesh/membership: the hang is capped so a dead client
// cannot park a request forever, and a timed-out poll still answers the
// current level (generation unchanged = "nothing happened", itself an answer).
const MEMBERSHIP_WAIT_DEFAULT_S = 60;
const MEMBERSHIP_WAIT_MAX_S = 600;

async function getHostInfo(req, res) {
  try {
    const app = await dockerService.getAppNameByContainerIp(req.socket.remoteAddress);
    if (!app) {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    } else {
      const hostInfo = {};
      hostInfo.appName = app;
      const nodeCollateralInfo = await generalService.obtainNodeCollateralInformation().catch(() => { throw new Error('Host Identifier information not available at the moment'); });
      hostInfo.id = nodeCollateralInfo.txhash + nodeCollateralInfo.txindex;
      const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
      if (localSocketAddr) {
        hostInfo.ip = extractIp(localSocketAddr);
        const nodeGeo = await geolocationService.getNodeGeolocation();
        if (nodeGeo) {
          delete nodeGeo.ip;
          delete nodeGeo.org;
          hostInfo.geo = nodeGeo;
        } else {
          throw new Error('Geolocation information not available at the moment');
        }
      } else {
        throw new Error('Host IP information not available at the moment');
      }

      const validTiers = ['CUMULUS', 'NIMBUS', 'STRATUS'];
      let benchData = null;

      const benchmarkResponse = await benchmarkService.getBenchmarks();
      if (benchmarkResponse.status === 'success' && benchmarkResponse.data && validTiers.includes(benchmarkResponse.data.status)) {
        benchData = benchmarkResponse.data;
      } else {
        // Fallback to database if call failed or status is not a valid tier
        log.info('Benchmark call failed or status not a valid tier, fetching from database');
        const dbBenchmark = await benchmarkService.getBenchmarkFromDb();
        if (dbBenchmark.benchmark) {
          benchData = dbBenchmark.benchmark;
        }
      }

      if (benchData) {
        hostInfo.benchmark = {
          vcores: benchData.cores,
          ram: benchData.ram,
          disk: benchData.disk,
          diskwritespeed: benchData.diskwritespeed,
          eps: benchData.eps,
          download_speed: benchData.download_speed,
          upload_speed: benchData.upload_speed,
        };
        if (benchData.eps_singlethread !== undefined) {
          hostInfo.benchmark.eps_singlethread = benchData.eps_singlethread;
        }
      } else {
        throw new Error('Benchmark information is not available at the moment');
      }

      const message = messageHelper.createDataMessage(hostInfo);
      res.json(message);
    }
  } catch (error) {
    log.error(`getHostInfo: ${error}`);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * The canonical member name: the ordinal form for a slot-holder (its
 * advertised identity), the nodeid form for a standby. Mirrors the resolver.
 */
function memberName(member) {
  return Number.isInteger(member.ordinal)
    ? `${member.component}-${member.ordinal}`
    : `${member.component}-${member.nodeId}`;
}

/**
 * The caller's app entry in the snapshot, scoped by source address exactly as
 * flux-dnsd scopes DNS: the containers table maps a container's bridge
 * address to (app, component), and that is the tenant boundary — one app can
 * never read another's membership. Null when the caller is not a mesh app
 * container this node knows.
 */
function scopeByCaller(snapshot, remoteAddress) {
  // Express hands v4-mapped addresses as ::ffff:172.23.0.2.
  const callerIp = (remoteAddress ?? '').replace(/^::ffff:/, '');
  for (const app of snapshot?.apps ?? []) {
    const container = (app.containers ?? []).find((c) => c.sourceIp === callerIp);
    if (container) return { app, component: container.component };
  }
  return null;
}

/**
 * GET /mesh/membership — the mesh membership LEVEL for the calling app, and
 * the long-poll that makes polling it cheap.
 *
 * The contract is level-based, never an event stream: membership is the
 * snapshot (durable, strictly-increasing generation), and a reactor
 * converges its cluster to the level, then waits for the generation to move.
 * Join/leave is the reactor's own set-difference against what it last acted
 * on — transitions are not carried, so none can be lost, across FluxOS
 * restarts included.
 *
 * Query: waitAfter — the generation the caller last saw; the request parks
 * until the generation differs (a generation AHEAD of current answers
 * immediately: a lost ledger restarts generations and a reactor must never
 * wedge on a stale cursor). timeoutS caps the park; a timed-out poll answers
 * the current level with the generation unchanged.
 *
 * Members carry identity only — the canonical name and its FQDN, never an
 * address: addressing is DNS's job, and the presented IPv4 is node-local, so
 * handing it out here would invite an app to persist exactly the thing it
 * must never persist.
 */
async function getMeshMembership(req, res) {
  try {
    let snapshot = await meshSnapshot.readCurrentSnapshot();
    let scoped = scopeByCaller(snapshot, req.socket.remoteAddress);
    if (!scoped) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }

    const waitAfter = Number.parseInt(req.query.waitAfter, 10);
    if (Number.isInteger(waitAfter) && waitAfter >= 0) {
      const timeoutS = Math.min(
        Math.max(Number.parseInt(req.query.timeoutS, 10) || MEMBERSHIP_WAIT_DEFAULT_S, 1),
        MEMBERSHIP_WAIT_MAX_S,
      );
      await meshSnapshot.waitForGeneration(waitAfter, timeoutS * 1000);
      snapshot = await meshSnapshot.readCurrentSnapshot();
      scoped = scopeByCaller(snapshot, req.socket.remoteAddress);
      if (!scoped) {
        // The caller's app left the mesh while it waited.
        res.json(messageHelper.errUnauthorizedMessage());
        return;
      }
    }

    const { app, component } = scoped;
    const withNames = (member) => ({
      component: member.component,
      member: memberName(member),
      ordinal: Number.isInteger(member.ordinal) ? member.ordinal : null,
      fqdn: `${memberName(member)}.${app.name}.mesh.flux`,
    });
    const self = (app.members ?? [])
      .find((m) => m.nodeId === snapshot.nodeId && m.component === component);
    const message = messageHelper.createDataMessage({
      generation: snapshot.generation,
      app: app.name,
      self: self ? withNames(self) : null,
      members: (app.members ?? []).map(withNames),
    });
    res.json(message);
  } catch (error) {
    log.error(`getMeshMembership: ${error}`);
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
  }
}

/**
 * POST /mesh/founder — one component's "may I found?", answered
 * yes-once/no/wait. Scoped by source address exactly as membership is: the
 * caller's container decides which app and component ask, so one app can
 * never found — or probe — another's registers. The node acquires the
 * founding grant on the container's behalf; the container never sees a
 * committee, an epoch, or a basis.
 */
async function postMeshFounder(req, res) {
  try {
    const snapshot = await meshSnapshot.readCurrentSnapshot();
    const scoped = scopeByCaller(snapshot, req.socket.remoteAddress);
    if (!scoped) {
      res.json(messageHelper.errUnauthorizedMessage());
      return;
    }
    const reply = await foundingService.founderAsk(scoped.app.name, scoped.component);
    res.json(messageHelper.createDataMessage(reply));
  } catch (error) {
    log.error(`postMeshFounder: ${error}`);
    res.json(messageHelper.createErrorMessage(error.message || error, error.name, error.code));
  }
}

function handleError(middleware, req, res, next) {
  // eslint-disable-next-line consistent-return
  middleware(req, res, (err) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      res.statusMessage = err.message;
      return res.sendStatus(400);
    }
    if (err) {
      log.error(err);
      return res.sendStatus(400);
    }

    next();
  });
}

function start() {
  if (server) return;

  const app = express();
  app.use((req, res, next) => {
    handleError(express.json(), req, res, next);
  });
  app.get('/hostinfo', getHostInfo);
  app.get('/mesh/membership', getMeshMembership);
  app.post('/mesh/founder', postMeshFounder);
  app.all('*', (_, res) => res.status(404).end());

  const bindAddress = config.server.fluxNodeServiceAddress;
  server = app.listen(16101, bindAddress, () => {
    log.info(`Server listening on port: 16101 address: ${bindAddress}`);
  });
}

function stop() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  start,
  stop,
  // exposed for tests
  getMeshMembership,
  postMeshFounder,
};
