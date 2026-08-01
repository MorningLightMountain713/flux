const config = require('config');
const natUpnp = require('@runonflux/nat-upnp');
const { Device } = require('@runonflux/nat-upnp/build/src/nat-upnp/device');
const serviceHelper = require('./serviceHelper');
const messageHelper = require('./messageHelper');
const verificationHelper = require('./verificationHelper');

const log = require('../lib/log');

let client = null;

/**
 * The UPnP client, built on first use.
 *
 * Not constructed at import: the Ssdp constructor inside it opens one UDP socket
 * per non-internal address for multicast discovery, and this module is pulled in
 * transitively (benchmarkService -> fluxNetworkHelper -> dockerService) by
 * effectively every process, whether or not that process ever speaks UPnP. On a
 * dev machine with VPN tunnels that was 16 sockets opened for nothing.
 *
 * The gateway override has to be applied here rather than beside the import, or a
 * lazily-built client would silently skip it and talk to a discovered gateway
 * instead of the configured one.
 * @returns {object} the nat-upnp client
 */
function getClient() {
  if (client) return client;

  client = new natUpnp.Client();

  if (config.upnp.gatewayUrl) {
    const { gatewayUrl } = config.upnp;
    const nodeIp = config.upnp.nodeIp || '127.0.0.1';
    client.getGateway = async () => ({
      gateway: new Device(gatewayUrl),
      address: nodeIp,
    });
  }

  return client;
}

// Whether the last verify/refresh succeeded. Diagnostics only — it answers "is UPnP
// working right now", never "should this node use UPnP", which is a declared setting.
let upnpHealthy = false;

/**
 * Whether this node is configured to map its ports via UPnP.
 *
 * The operator's declaration, not the result of a probe. Deriving it from a probe
 * meant any node behind a UPnP-capable router silently became a UPnP node — and then
 * every app install depended on the router accepting a mapping for each app port.
 *
 * Legacy configs predating the `upnp` key fall back to the old inference. That is not
 * a rare path: FluxOS's own config template had no `upnp` key, so every rewrite it
 * ever did deleted the one flux-configd wrote.
 * @returns {boolean} True when this node should map ports via UPnP.
 */
function isUPNP() {
  const { initial } = globalThis.userconfig;
  if (typeof initial.upnp === 'boolean') return initial.upnp;
  return Boolean(
    (initial.apiport && Number(initial.apiport) !== config.server.apiport) || initial.routerIP,
  );
}

/**
 * Whether UPnP was working as of the last verify or refresh.
 * @returns {boolean}
 */
function isUPNPHealthy() {
  return upnpHealthy;
}

/**
 * To check if a firewall is active.
 * @returns {Promise<boolean>} True if a firewall is active. Otherwise false.
 */
async function isFirewallActive() {
  // ufw not being installed is the most likely failure, so it is not logged as an error
  const { error, stdout } = await serviceHelper.runCommand('ufw', {
    runAsRoot: true,
    logError: false,
    params: ['status'],
  });
  if (error) return false;
  return serviceHelper.ensureString(stdout).includes('Status: active');
}

/**
 * To adjust a firewall to allow comms between host and router.
 */
async function adjustFirewallForUPNP() {
  try {
    let { routerIP } = userconfig.initial;
    routerIP = serviceHelper.ensureString(routerIP);
    if (routerIP) {
      const firewallActive = await isFirewallActive();
      if (firewallActive) {
        // Arguments are passed as a list rather than interpolated into a shell string:
        // routerIP comes from the node config, so building a command line out of it put
        // an operator-supplied value through a shell.
        const ufw = (params) => serviceHelper.runCommand('ufw', { runAsRoot: true, params });

        // standard rules for upnp
        await ufw(['insert', '1', 'allow', 'out', 'from', 'any', 'to', '239.255.255.250', 'port', '1900', 'proto', 'udp']);
        await ufw(['insert', '1', 'allow', 'from', routerIP, 'port', '1900', 'to', 'any', 'proto', 'udp']);
        await ufw(['insert', '1', 'allow', 'out', 'from', 'any', 'to', routerIP, 'proto', 'tcp']);
        await ufw(['insert', '1', 'allow', 'from', routerIP, 'to', 'any', 'proto', 'udp']);

        const fluxCommunicationPorts = config.server.allowedPorts;
        // eslint-disable-next-line no-restricted-syntax
        for (const port of fluxCommunicationPorts) {
          // create rule for hone nodes ws connections
          // eslint-disable-next-line no-await-in-loop
          await ufw(['insert', '1', 'allow', 'in', 'proto', 'tcp', 'from', 'any', 'to', routerIP, 'port', `${port}`]);
          // eslint-disable-next-line no-await-in-loop
          await ufw(['insert', '1', 'allow', 'out', 'proto', 'tcp', 'to', routerIP, 'port', `${port}`]);
          // eslint-disable-next-line no-await-in-loop
          await ufw(['insert', '1', 'allow', 'in', 'proto', 'udp', 'from', 'any', 'to', routerIP, 'port', `${port}`]);
          // eslint-disable-next-line no-await-in-loop
          await ufw(['insert', '1', 'allow', 'out', 'proto', 'udp', 'to', routerIP, 'port', `${port}`]);
          log.info(`Firewall adjusted for UPNP local connections on port ${port}`);
        }
        // delete and recreate deny rule at end
        let routerIpNetwork = `${routerIP.split('.')[0]}.${routerIP.split('.')[1]}.0.0`;
        if (routerIpNetwork === '10.0.0.0') {
          routerIpNetwork += '/8';
        } else if (routerIpNetwork === '172.16.0.0') {
          routerIpNetwork += '/12';
        } else if (routerIpNetwork === '192.168.0.0') {
          routerIpNetwork += '/16';
        } else if (routerIpNetwork === '100.64.0.0') {
          routerIpNetwork += '/10';
        } else if (routerIpNetwork === '198.18.0.0') {
          routerIpNetwork += '/15';
        } else if (routerIpNetwork === '169.254.0.0') {
          routerIpNetwork += '/16';
        }
        await ufw(['delete', 'deny', 'out', 'from', 'any', 'to', routerIpNetwork]);
        log.info('Firewall adjusted for UPNP');
      } else {
        log.info('RouterIP is set but firewall is not active. Adjusting not applied for UPNP');
      }
    }
  } catch (error) {
    log.error(error);
  }
}

/**
 * To verify that a port has UPnP (Universal Plug and Play) support.
 * @param {number} apiport Port number.
 * @returns {Promise<boolean>} True if port mappings can be set. Otherwise false.
 */
async function verifyUPNPsupport(apiport = config.server.apiport) {
  try {
    if (userconfig.initial.routerIP) {
      await adjustFirewallForUPNP();
    }
    // run test on apiport + 1
    await getClient().getPublicIp();

    await serviceHelper.delay(500);
  } catch (error) {
    log.error(error);
    log.error('VerifyUPNPsupport - Failed get public ip');
    upnpHealthy = false;
    return false;
  }
  try {
    await getClient().getGateway();

    await serviceHelper.delay(500);
  } catch (error) {
    log.error(error);
    log.error('VerifyUPNPsupport - Failed get Gateway');
    upnpHealthy = false;
    return false;
  }
  try {
    await getClient().createMapping({
      public: +apiport + 3,
      private: +apiport + 3,
      ttl: 0,
      description: 'Flux_UPNP_Mapping_Test',
    });

    await serviceHelper.delay(500);
  } catch (error) {
    log.error(error);
    log.error('VerifyUPNPsupport - Failed Create Mapping');
    upnpHealthy = false;
    return false;
  }
  try {
    await getClient().getMappings();

    await serviceHelper.delay(500);
  } catch (error) {
    log.error(error);
    log.error('VerifyUPNPsupport - Failed get Mappings');
    upnpHealthy = false;
    return false;
  }
  try {
    await getClient().removeMapping({
      public: +apiport + 3,
    });

    await serviceHelper.delay(500);
  } catch (error) {
    log.error(error);
    log.error('VerifyUPNPsupport - Failed Remove Mapping');
    upnpHealthy = false;
    return false;
  }

  upnpHealthy = true;
  return true;
}

/**
 * To set up UPnP (Universal Plug and Play) support.
 * @param {number} apiport Port number.
 * @returns {Promise<boolean>} True if port mappings can be set. Otherwise false.
 */
async function setupUPNP(apiport = config.server.apiport) {
  try {
    await getClient().createMapping({
      public: +apiport,
      private: +apiport,
      ttl: 0, // Some routers force low ttl if 0, indefinite/default is used. Flux refreshes this every 6 blocks ~ 12 minutes
      description: 'Flux_Backend_API',
    });

    await serviceHelper.delay(500);

    await getClient().createMapping({
      public: +apiport + 1,
      private: +apiport + 1,
      ttl: 0, // Some routers force low ttl if 0, indefinite/default is used. Flux refreshes this every 6 blocks ~ 12 minutes
      description: 'Flux_Backend_API_SSL',
    });

    await serviceHelper.delay(500);

    await getClient().createMapping({
      public: +apiport - 1,
      private: +apiport - 1,
      ttl: 0,
      description: 'Flux_Home_UI',
    });

    await serviceHelper.delay(500);

    await getClient().createMapping({
      public: +apiport + 2,
      private: +apiport + 2,
      ttl: 0,
      description: 'Flux_Syncthing',
    });

    await serviceHelper.delay(500);

    return true;
  } catch (error) {
    log.error(error);
    return false;
  }
}

/**
 * To create mappings for UPnP (Universal Plug and Play) port.
 * @param {number} port Port number.
 * @param {string} description Port description.
 * @returns {Promise<boolean>} True if port mappings can be created for both TCP (Transmission Control Protocol) and UDP (User Datagram Protocol) protocols. Otherwise false.
 */
async function mapUpnpPort(port, description) {
  try {
    await getClient().createMapping({
      public: port,
      private: port,
      ttl: 0,
      protocol: 'TCP',
      description,
    });

    await serviceHelper.delay(500);

    await getClient().createMapping({
      public: port,
      private: port,
      ttl: 0,
      protocol: 'UDP',
      description,
    });

    await serviceHelper.delay(500);

    return true;
  } catch (error) {
    log.error(error);
    return false;
  }
}

/**
 * To remove TCP (Transmission Control Protocol) and UDP (User Datagram Protocol) port mappings from UPnP (Universal Plug and Play) port.
 * @param {number} port Port number.
 * @returns {Promise<boolean>} True if port mappings have been removed for both TCP (Transmission Control Protocol) and UDP (User Datagram Protocol) protocols. Otherwise false.
 */
async function removeMapUpnpPort(port) {
  try {
    await getClient().removeMapping({
      public: port,
      protocol: 'TCP',
    });

    await serviceHelper.delay(500);

    await getClient().removeMapping({
      public: port,
      protocol: 'UDP',
    });

    await serviceHelper.delay(500);

    return true;
  } catch (error) {
    log.error(error);
    return false;
  }
}

/**
 * To map a specified port and show a message if successfully mapped. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {Promise<object>} res Response.
 */
async function mapPortApi(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (authorized) {
      let { port } = req.params;
      port = port || req.query.port;
      if (port === undefined || port === null) {
        throw new Error('No Port address specified.');
      }
      if (!serviceHelper.validPort(port)) {
        throw new Error('Port must be a whole number between 1 and 65535');
      }
      port = serviceHelper.ensureNumber(port);
      await getClient().createMapping({
        public: port,
        private: port,
        ttl: 0,
        protocol: 'TCP',
        description: 'Flux_manual_entry',
      });

      await getClient().createMapping({
        public: port,
        private: port,
        ttl: 0,
        protocol: 'UDP',
        description: 'Flux_manual_entry',
      });
      const message = messageHelper.createSuccessMessage('Port mapped');
      res.json(message);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To unmap a specified port and show a message if successfully unmapped. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {Promise<object>} res Response.
 */
async function removeMapPortApi(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (authorized) {
      let { port } = req.params;
      port = port || req.query.port;
      if (port === undefined || port === null) {
        throw new Error('No Port address specified.');
      }
      if (!serviceHelper.validPort(port)) {
        throw new Error('Port must be a whole number between 1 and 65535');
      }
      port = serviceHelper.ensureNumber(port);
      await getClient().removeMapping({
        public: port,
        protocol: 'TCP',
      });
      await getClient().removeMapping({
        public: port,
        protocol: 'UDP',
      });
      const message = messageHelper.createSuccessMessage('Port unmapped');
      res.json(message);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To show a message with mappings. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {Promise<object>} res Response.
 */
async function getMapApi(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (authorized) {
      const map = await getClient().getMappings();
      const message = messageHelper.createDataMessage(map);
      res.json(message);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To show a message with IP address. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {Promise<object>} res Response.
 */
async function getIpApi(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (authorized) {
      const ip = await getClient().getPublicIp();
      const message = messageHelper.createDataMessage(ip);
      res.json(message);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

/**
 * To show a message with gateway address. Only accessible by admins and Flux team members.
 * @param {import('express').Request} req
 * @param {Promise<object>} res Response.
 */
async function getGatewayApi(req, res) {
  try {
    const authorized = await verificationHelper.verifyPrivilege('adminandfluxteam', req);
    if (authorized) {
      const gateway = await getClient().getGateway();
      const message = messageHelper.createDataMessage(gateway);
      res.json(message);
    } else {
      const errMessage = messageHelper.errUnauthorizedMessage();
      res.json(errMessage);
    }
  } catch (error) {
    log.error(error);
    const errorResponse = messageHelper.createErrorMessage(
      error.message || error,
      error.name,
      error.code,
    );
    res.json(errorResponse);
  }
}

module.exports = {
  isUPNP,
  isUPNPHealthy,
  verifyUPNPsupport,
  setupUPNP,
  mapUpnpPort,
  removeMapUpnpPort,
  mapPortApi,
  removeMapPortApi,
  getMapApi,
  getIpApi,
  getGatewayApi,
  adjustFirewallForUPNP,
};
