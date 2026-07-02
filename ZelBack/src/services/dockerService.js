const config = require('config');
const stream = require('stream');
const Docker = require('dockerode');
const path = require('path');
const serviceHelper = require('./serviceHelper');
const deviceHelper = require('./deviceHelper');
const hostStorageCapability = require('./utils/hostStorageCapability');
const generalService = require('./generalService');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const log = require('../lib/log');
const { extractIp } = require('./utils/socketAddressUtils');
const { obtainPayloadFromStorage } = require('./utils/fluxStorageRefs');
const cpuBurstHelper = require('./utils/cpuBurstHelper');
const shutdownPlan = require('./appLifecycle/shutdownPlan');


const operationRegistry = require('./utils/operationRegistry');

const fluxDirPath = process.env.FLUXOS_PATH || path.join(process.env.HOME, 'zelflux');
// ToDo: Fix all the string concatenation in this file and use path.join()
const appsFolderPath = process.env.FLUX_APPS_FOLDER || path.join(fluxDirPath, 'ZelApps');
// eslint-disable-next-line no-unused-vars
const appsFolder = `${appsFolderPath}/`;

const docker = new Docker();

/**
 * Creates a docker container object with a given ID.
 *
 * @param {string} id
 *
 * @returns {object} docker container object
 */
function getDockerContainerHandle(id) {
  const dockerContainer = docker.getContainer(id);
  return dockerContainer;
}

/**
 * Generates an app identifier based on app name.
 *
 * @param {string} appName
 * @returns {string} app identifier
 */
function getAppIdentifier(appName) {
  // this id is used for volumes, docker names so we know it really belongs to flux
  if (appName.startsWith('flux')) {
    return appName;
  }
  return `flux${appName}`;
}

/**
 * Inverse of getAppIdentifier: strips the flux namespace prefix to recover
 * the bare component identifier (`{component}_{app}`, or `{app}` for v1-3) used
 * by app/component specs. Idempotent on an already-bare identifier. Consumers
 * whose canonical form is the bare identifier (e.g. the reconciler) normalise
 * inbound ids through this, mirroring how docker callers normalise through
 * getAppIdentifier.
 *
 * Note: like getAppIdentifier this is not perfectly invertible — a component
 * literally named `flux...` is ambiguous — but that is the existing
 * limitation of the prefix-as-marker convention, not new here.
 *
 * @param {string} idOrName
 * @returns {string} bare identifier
 */
function getBaseAppName(idOrName) {
  if (idOrName.startsWith('flux')) return idOrName.slice(4);
  return idOrName;
}

/**
 * Generates an app docker name based on app name
 *
 * @param {string} appName
 * @returns {string} app docker name id
 */
function getDockerName(idOrName) {
  const name = getAppIdentifier(idOrName);
  return name.startsWith('/') ? name.substring(1) : name;
}

function getAppDockerNameIdentifier(appName) {
  // this id is used for volumes, docker names so we know it reall belongs to flux
  const name = getAppIdentifier(appName);
  if (name.startsWith('/')) {
    return name;
  }
  return `/${name}`;
}

/**
 * Creates a docker network object.
 *
 * @param {object} options:
 *      Name: string;
        CheckDuplicate?: boolean | undefined;
        Driver?: string | undefined;
        Internal?: boolean | undefined;
        Attachable?: boolean | undefined;
        Ingress?: boolean | undefined;
        IPAM?: IPAM | undefined;
        EnableIPv6?: boolean | undefined;
        Options?: { [option: string]: string } | undefined;
        Labels?: { [label: string]: string } | undefined;

        abortSignal?: AbortSignal;
 * @returns {object} Network
 */
async function dockerCreateNetwork(options) {
  const network = await docker.createNetwork(options);
  return network;
}

/**
 * Removes docker network.
 *
 * @param {object} netw - Network object
 *
 * @returns {Buffer}
 */
async function dockerRemoveNetwork(netw) {
  const network = await netw.remove();
  return network;
}

/**
 * Returns inspect network object.
 *
 * @param {object} netw - Network object
 *
 * @returns {object} ispect network object
 */
async function dockerNetworkInspect(netw) {
  const network = await netw.inspect();
  return network;
}

/**
 * Returns a list of containers.
 *
 * @param {bool} [all] - defaults to false; By default only running containers are shown
 * @param {number} [limit] - Return this number of most recently created containers, including non-running ones.
 * @param {bool} [size] - Return the size of container as fields SizeRw and SizeRootFs.
 * @param {string} [filter] Filters to process on the container list, encoded as JSON

 * @returns {array} containers list
 */
async function dockerListContainers(all, limit, size, filter) {
  const options = {
    all,
    limit,
    size,
    filter,
  };
  const containers = await docker.listContainers(options);
  return containers;
}

/**
 * Returns a list of images on the server.
 *
 * @returns {array} images list
 */
async function dockerListImages() {
  const containers = await docker.listImages();
  return containers;
}

/**
 * Look up a Docker container by name or ID.
 * Returns a dockerode container handle, or null if not found.
 *
 * @param {string} identifier - Container name or ID
 * @param {object} [options]
 * @param {string} [options.identifierType='name'] - 'name' or 'id'
 * @returns {Promise<object|null>} dockerode container handle or null
 */
async function getDockerContainer(identifier, options = {}) {
  const identifierType = options.identifierType || 'name';
  const containers = await dockerListContainers(true);
  const match = identifierType === 'id'
    ? containers.find((c) => c.Id === identifier)
    : containers.find((c) => c.Names[0] === getAppDockerNameIdentifier(identifier));
  if (!match) return null;
  return docker.getContainer(match.Id);
}

/**
 * Returns low-level information about a container, or null if not found.
 *
 * @param {string} idOrName
 * @param {object} [options]
 * @param {string} [options.identifierType='name'] - 'name' or 'id'; remaining
 *   options are passed to inspect
 * @returns {Promise<object|null>}
 */
async function dockerContainerInspect(idOrName, options = {}) {
  const { identifierType, ...inspectOptions } = options;
  const dockerContainer = await getDockerContainer(idOrName, { identifierType });
  if (!dockerContainer) return null;
  const response = await dockerContainer.inspect(inspectOptions);
  return response;
}

/**
 * Returns a sample of container’s resource usage statistics.
 *
 * @param {string} idOrName
 * @returns docker container statistics
 */
async function dockerContainerStats(idOrName) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) return null;
  const response = await dockerContainer.stats({ stream: false });
  return response;
}

/**
 * Take stats from docker container and follow progress of the stream.
 * @param {string} repoTag Docker Hub repo/image tag.
 * @param {object} res Response.
 * @param {function} callback Callback.
 */
async function dockerContainerStatsStream(idOrName, req, res, callback) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) {
    callback(new Error(`Container ${idOrName} not found`));
    return;
  }

  dockerContainer.stats(idOrName, (err, mystream) => {
    function onFinished(error, output) {
      if (error) {
        callback(err);
      } else {
        callback(null, output);
      }
      mystream.destroy();
    }
    function onProgress(event) {
      if (res) {
        res.write(serviceHelper.ensureString(event));
        if (res.flush) res.flush();
      }
      log.info(event);
    }
    if (err) {
      callback(err);
    } else {
      docker.modem.followProgress(mystream, onFinished, onProgress);
    }
    req.on('close', () => {
      mystream.destroy();
    });
  });
}

/**
 * Returns changes on a container’s filesystem.
 *
 * @param {string} idOrName
 * @returns  docker container changes
 */
async function dockerContainerChanges(idOrName) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) return null;
  const response = await dockerContainer.changes();
  return response;
}

/**
 * To pull a Docker Hub image and follow progress of the stream.
 * @param {object} pullConfig Pulling config consisting of repoTag and optional authToken
 * @param {object} res Response.
 * @param {function} callback Callback.
 */
function dockerPullStream(pullConfig, res, callback) {
  const {
    repoTag, provider, authToken, abortSignal,
  } = pullConfig;
  const pullOptions = {};

  // fix this auth token stuff upstream
  if (authToken) {
    if (authToken.includes(':')) { // specified by username:token
      pullOptions.authconfig = {
        username: authToken.split(':')[0],
        password: authToken.split(':')[1],
      };
      if (provider) {
        pullOptions.authconfig.serveraddress = provider;
      }
    } else {
      throw new Error('Invalid login credentials for docker provided');
    }
  }
  // Abortable pull (cancel-during-install): docker-modem (>=5) threads abortSignal
  // onto the request and makes the response stream abortable, so controller.abort()
  // ends the pull and surfaces an error through followProgress's onFinished below.
  if (abortSignal) {
    pullOptions.abortSignal = abortSignal;
  }
  docker.pull(repoTag, pullOptions, (err, mystream) => {
    function onFinished(error, output) {
      if (error) {
        // Propagate the stream/abort error - NOT the (null) outer `err`, which would
        // report an aborted/failed pull as success and let the install proceed onto a
        // missing image. The abort relies on this.
        callback(error);
      } else {
        callback(null, output);
      }
    }
    function onProgress(event) {
      if (res) {
        res.write(serviceHelper.ensureString(event));
        if (res.flush) res.flush();
      }
      log.info(event);
    }
    if (err) {
      callback(err);
    } else {
      docker.modem.followProgress(mystream, onFinished, onProgress);
    }
  });
}

/**
 * Runs a command inside a running container.
 *
 * @param {object} container Docker container object
 * @param {string} cmd Command to execute
 * @param {array} env Environment variables
 * @param {object} res response object
 * @param {function} callback
 */
async function dockerContainerExec(container, cmd, env, res, callback) {
  try {
    const options = {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: cmd,
      Env: env,
      Tty: false,
    };
    const optionsExecStart = {
      Detach: false,
      Tty: false,
    };
    let resultString = '';
    const exec = await container.exec(options);
    exec.start(optionsExecStart, (err, mystream) => {
      if (err) {
        callback(err);
      }
      mystream.on('data', (data) => {
        resultString = serviceHelper.dockerBufferToString(data);
        res.write(resultString);
        if (res.flush) res.flush();
      });
      mystream.on('end', () => callback(null));
    });
  } catch (error) {
    callback(error);
  }
}

/**
 * Subscribes to logs stream.
 *
 * @param {string} idOrName
 * @param {object} res
 * @param {function} callback
 */
async function dockerContainerLogsStream(idOrName, res, callback) {
  try {
    // container ID or name
    const containers = await dockerListContainers(true);
    const myContainer = containers.find((container) => (container.Names[0] === getAppDockerNameIdentifier(idOrName) || container.Id === idOrName));
    const dockerContainer = docker.getContainer(myContainer.Id);
    const logStream = new stream.PassThrough();
    logStream.on('data', (chunk) => {
      res.write(serviceHelper.ensureString(chunk.toString('utf8')));
      if (res.flush) res.flush();
    });

    dockerContainer.logs(
      {
        follow: true,
        stdout: true,
        stderr: true,
      },
      (err, mystream) => {
        if (err) {
          callback(err);
        } else {
          try {
            dockerContainer.modem.demuxStream(mystream, logStream, logStream);
            mystream.on('end', () => {
              logStream.end();
              callback(null);
            });

            setTimeout(() => {
              mystream.destroy();
            }, 2000);
          } catch (error) {
            throw new Error('An error obtaining log data of an application has occured');
          }
        }
      },
    );
  } catch (error) {
    callback(error);
  }
}

/**
 * Returns requested number of lines of logs from the container.
 *
 * @param {string} idOrName
 * @param {number} lines
 *
 * @returns {buffer}
 */
async function dockerContainerLogs(idOrName, lines) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) return null;
  const options = {
    follow: false,
    stdout: true,
    stderr: true,
    tail: lines,
  };
  const logs = await dockerContainer.logs(options);
  return logs;
}

async function dockerContainerLogsPolling(idOrName, lineCount, sinceTimestamp, callback) {
  try {
    const dockerContainer = await getDockerContainer(idOrName);
    if (!dockerContainer) {
      if (callback) callback(new Error(`Container ${idOrName} not found`));
      return;
    }
    const logStream = new stream.PassThrough();
    let logBuffer = '';

    logStream.on('data', (chunk) => {
      logBuffer += chunk.toString('utf8');
      const lines = logBuffer.split('\n');
      logBuffer = lines.pop();
      // eslint-disable-next-line no-restricted-syntax
      for (const line of lines) {
        if (line.trim()) {
          if (callback) {
            callback(null, line);
          }
        }
      }
    });

    logStream.on('error', (error) => {
      log.error('Log stream encountered an error:', error);
      if (callback) {
        callback(error);
      }
    });

    logStream.on('end', () => {
      if (callback) {
        callback(null, 'Stream ended'); // Notify end of logs
      }
    });

    const logOptions = {
      follow: true,
      stdout: true,
      stderr: true,
      tail: lineCount,
      timestamps: true,
    };

    if (sinceTimestamp) {
      logOptions.since = new Date(sinceTimestamp).getTime() / 1000;
    }
    await new Promise((resolve, reject) => {
      // eslint-disable-next-line consistent-return
      dockerContainer.logs(logOptions, (err, mystream) => {
        if (err) {
          log.error('Error fetching logs:', err);
          if (callback) {
            callback(err);
          }
          return reject(err);
        }
        try {
          dockerContainer.modem.demuxStream(mystream, logStream, logStream);
          setTimeout(() => {
            logStream.end();
          }, 1500);
          mystream.on('end', () => {
            logStream.end();
            resolve();
          });

          mystream.on('error', (error) => {
            log.error('Stream error:', error);
            logStream.end();
            if (callback) {
              callback(error);
            }
            reject(error);
          });
        } catch (error) {
          log.error('Error during stream processing:', error);
          if (callback) {
            callback(new Error('An error occurred while processing the log stream'));
          }
          reject(error);
        }
      });
    });
  } catch (error) {
    log.error('Error in dockerContainerLogsPolling:', error);
    if (callback) {
      callback(error);
    }
    throw error;
  }
}

/**
 * Converts an IPv4 address string (e.g., "192.168.1.1") into a 32-bit integer.
 * This allows for easier calculations and comparisons.
 *
 * @param {string} ip - The IPv4 address as a string.
 * @returns {number} - The corresponding 32-bit integer representation.
 */
function ipToLong(ip) {
  // eslint-disable-next-line no-bitwise
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

/**
 * Converts a 32-bit integer back into an IPv4 address string.
 * This reverses the `ipToLong` function.
 *
 * @param {number} long - The 32-bit integer representation of an IPv4 address.
 * @returns {string} - The IPv4 address in dot-decimal format.
 */
function longToIp(long) {
  return [
    // eslint-disable-next-line no-bitwise
    (long >>> 24) & 255,
    // eslint-disable-next-line no-bitwise
    (long >>> 16) & 255,
    // eslint-disable-next-line no-bitwise
    (long >>> 8) & 255,
    // eslint-disable-next-line no-bitwise
    long & 255,
  ].join('.');
}

/**
 * Parses a CIDR subnet (e.g., "192.168.1.0/24") and extracts useful information.
 * Determines the first usable IP and the last usable IP in the subnet.
 *
 * @param {string} cidr - The subnet in CIDR notation (e.g., "192.168.1.0/24").
 * @returns {Object} - An object containing:
 *   - `firstAddress`: The first usable IP in the subnet.
 *   - `lastAddress`: The last usable IP in the subnet.
 */
function parseCidrSubnet(cidr) {
  const [ip, prefix] = cidr.split('/');
  const subnetLong = ipToLong(ip);
  const hostBits = 32 - Number(prefix);
  // eslint-disable-next-line no-bitwise
  const subnetMask = (0xFFFFFFFF << hostBits) >>> 0;
  // eslint-disable-next-line no-bitwise
  const network = subnetLong & subnetMask;
  // eslint-disable-next-line no-bitwise
  const broadcast = network | (~subnetMask >>> 0);

  return {
    firstAddress: longToIp(network + 1),
    lastAddress: longToIp(broadcast - 1),
  };
}

/**
 * Finds the next available IP address in a Docker network for a given app.
 *
 * This function inspects the Docker network associated with the app, retrieves
 * the subnet and gateway details, and determines the next free IP within the
 * subnet range. It avoids allocated IPs and the gateway address.
 *
 * @param {string} appName - The name of the application.
 * @returns {Promise<string|null>} - The next available IP address, or null if no IP is available.
 */
async function getNextAvailableIPForApp(appName) {
  try {
    const { IPAM, Containers } = await docker.getNetwork(`fluxDockerNetwork_${appName}`).inspect();
    if (!IPAM?.Config?.length) throw new Error('No IPAM configuration found');

    const { Subnet, Gateway } = IPAM.Config[0];
    log.info(`Subnet: ${Subnet}, Gateway: ${Gateway}`);

    const { firstAddress, lastAddress } = parseCidrSubnet(Subnet);
    log.info(`First usable IP: ${firstAddress}, Last usable IP: ${lastAddress}`);

    const allocatedIPs = new Set();
    if (Containers) {
      Object.values(Containers).forEach((containerInfo) => {
        const containerIP = containerInfo.IPv4Address.split('/')[0];
        if (containerIP) {
          allocatedIPs.add(containerIP);
        }
      });
    }

    const filteredContainers = await getAppContainerObjects(appName);

    // eslint-disable-next-line no-restricted-syntax
    for (const container of filteredContainers) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const containerInfo = await docker.getContainer(container.Id).inspect();
        const containerIP = containerInfo.NetworkSettings.Networks[`fluxDockerNetwork_${appName}`]?.IPAMConfig?.IPv4Address;
        if (containerIP && !allocatedIPs.has(containerIP)) {
          allocatedIPs.add(containerIP);
        }
      } catch (error) {
        log.error(`Error inspecting container ${container.Id}: ${error.message}`);
      }
    }

    if (allocatedIPs?.size) {
      log.info(`Allocated IPs: ${Array.from(allocatedIPs)}`);
    }

    const gatewayLong = ipToLong(Gateway);

    // eslint-disable-next-line no-plusplus
    for (let ipLong = ipToLong(firstAddress); ipLong <= ipToLong(lastAddress); ipLong++) {
      const ip = longToIp(ipLong);
      if (ipLong !== gatewayLong && !allocatedIPs.has(ip)) {
        log.info(`Available IP found: ${ip}`);
        return ip;
      }
    }

    log.info(`No available IP addresses found in the subnet ${Subnet}.`);
    return null;
  } catch (error) {
    log.error(`Error in getNextAvailableIPForApp: ${error.message}`);
    return null;
  }
}

/**
 * Retrieves the IP address of a running Docker container.
 *
 * @param {string} containerName - The name of the container.
 * @returns {Promise<string|null>} - The container's IP address, or null if not found.
 * @throws {Error} - If the container has no network or IP address.
 */
const getContainerIP = async (containerName) => {
  try {
    const container = await docker.getContainer(containerName).inspect();
    const networks = Object.keys(container.NetworkSettings.Networks);

    if (!Array.isArray(networks) || networks.length === 0) {
      throw new Error('No networks found for container');
    }

    const networkName = networks[0]; // Automatically selects the first network
    const ipAddressOfContainer = container.NetworkSettings.Networks[networkName].IPAddress ?? null;

    if (!ipAddressOfContainer) {
      throw new Error('No IPAddress found for container');
    }

    return ipAddressOfContainer;
  } catch (error) {
    log.error(`Failed to retrieve IP for ${containerName}: ${error.message}`);
    return null;
  }
};

/**
 * Creates an app container.
 *
 * @param {object} appSpecifications
 * @param {string} appName
 * @param {bool} isComponent
 * @returns {object}
 */
async function appDockerCreate(deployComp, options = {}) {
  const test = options.test || false;
  const burstEligible = options.burstEligible || false;
  const restartPolicyOverride = options.restartPolicy || null;
  const extraEnv = options.extraEnv || [];
  let syslogTarget = options.syslogTarget || null;
  const crossAppLogCollector = options.crossAppLogCollector || null;
  const measuredImageSizeBytes = options.measuredImageSizeBytes || 0;
  // Managed-storage host (host-swap fence + flux-apps.slice + xfs/prjquota). Cached, local check.
  const managedStorage = await hostStorageCapability.supportsManagedStorage();

  const { appName } = deployComp;
  const { identifier } = deployComp;

  const effectiveCpu = test ? 0.2 : deployComp.cpu;

  const portBindings = deployComp.toDockerPortBindings();
  const exposedPorts = deployComp.toDockerExposedPorts();

  const envParams = deployComp.toDockerEnv();
  envParams.push(...extraEnv);

  const adjustedCommands = (deployComp.cmd || []).filter((c) => c !== '--privileged');

  // Docker treats Entrypoint:[] as an explicit clear of the image's own
  // ENTRYPOINT, so only override when the component actually set one — omit the
  // key entirely otherwise (see the spread on containerConfig below).
  const entrypoint = deployComp.entrypoint || [];

  // v9 livenessProbe -> Docker HEALTHCHECK. Probe durations are seconds in the
  // spec; Config.Healthcheck wants nanoseconds. cmd is exec-form argv, so Test
  // uses CMD (not CMD-SHELL). The probe is canonical when present (all five keys
  // filled by the spec), so no defensive defaults here.
  const { livenessProbe } = deployComp;
  const healthcheck = livenessProbe
    ? {
      Test: ['CMD', ...livenessProbe.cmd],
      Interval: livenessProbe.interval * 1_000_000_000,
      Timeout: livenessProbe.timeout * 1_000_000_000,
      Retries: livenessProbe.retries,
      StartPeriod: livenessProbe.startPeriod * 1_000_000_000,
    }
    : null;

  const isSender = envParams.some((env) => env.startsWith('LOG=SEND'));
  const isCollector = envParams.some((env) => env.startsWith('LOG=COLLECT'));

  let syslogIP = null;

  if (syslogTarget && isSender) {
    syslogIP = await getContainerIP(`flux${syslogTarget}_${appName}`);
  }

  if (syslogTarget && isCollector) {
    syslogIP = await getNextAvailableIPForApp(appName);
  }

  // Cross-app LOG=SEND → LOG=COLLECT: if this is a SEND component and the app
  // has no in-spec collector, the caller resolves the collector in a linked
  // (shareWith) app and passes it here. Reachability is provided by
  // appNetworkLinker attaching this container to the linked app's docker network.
  if (!syslogTarget && isSender && crossAppLogCollector) {
    const collectorContainerName = `flux${crossAppLogCollector.collectorComponentName}_${crossAppLogCollector.linkedAppName}`;
    const linkedIP = await getContainerIP(collectorContainerName);
    if (linkedIP) {
      syslogTarget = crossAppLogCollector.collectorComponentName;
      syslogIP = linkedIP;
      log.info(`Cross-app LOG: ${appName} sender will ship to ${collectorContainerName} at ${syslogIP}`);
    } else {
      log.warn(`Cross-app LOG: collector ${collectorContainerName} not reachable; ${appName} will fall back to json-file logging`);
    }
  }

  let nodeId = null;
  let nodeSocketAddr = null;
  let labels = null;
  if (syslogTarget && syslogIP) {
    const nodeCollateralInfo = await generalService.obtainNodeCollateralInformation().catch(() => { throw new Error('Host Identifier information not available at the moment'); });
    nodeId = nodeCollateralInfo.txhash + nodeCollateralInfo.txindex;
    nodeSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
    if (!nodeSocketAddr) {
      throw new Error('Not possible to get node IP');
    }
    labels = {
      app_name: `${appName}`,
      host_id: `${nodeId}`,
      host_ip: `${nodeSocketAddr}`,
    };
  }
  log.info(`syslogTarget=${syslogTarget}, syslogIP=${syslogIP}`);

  const logConfig = syslogTarget && syslogIP
    ? {
      Type: 'gelf',
      Config: {
        'gelf-address': `udp://${syslogIP}:514`,
        'gelf-compression-type': 'none',
        tag: deployComp.name,
        labels: 'app_name,host_id,host_ip',
      },
    }
    : {
      Type: 'json-file',
      Config: {
        'max-file': '1',
        'max-size': '20m',
      },
    };
  const autoAssignedIP = await getNextAvailableIPForApp(appName);

  const burstLabels = burstEligible
    ? {
      'flux.burst.eligible': 'true',
      'flux.burst.cores': String(effectiveCpu),
    }
    : null;
  // Identity labels go on every flux container at this single create chokepoint so
  // flux-shutdownd can enumerate and stop any app. Budget labels (drain/preStop/
  // graceful timing) are added only for apps that use a graceful feature; a plain
  // app drains on the daemon's defaults. owner is provenance threaded in from the
  // orchestrator (it isn't on DeploymentComponent).
  const identityLabels = shutdownPlan.componentIdentityLabels(deployComp, options.owner || null);
  const budgetLabels = options.requiresEncryption
    ? shutdownPlan.componentBudgetLabels(deployComp)
    : null;
  const containerLabels = {
    ...identityLabels, ...(budgetLabels || {}), ...(labels || {}), ...(burstLabels || {}),
  };
  if (burstEligible) {
    log.info(`CPU burst: marking ${identifier} as burst-eligible (cores=${effectiveCpu})`);
  }

  const restartPolicy = restartPolicyOverride || 'no';

  const nanoCpus = test ? Math.round(0.2 * 1e9) : deployComp.toDockerNanoCpus();
  const memoryBytes = test ? Math.round(300 * 1024 * 1024) : deployComp.toDockerMemoryBytes();
  const memorySwapBytes = test
    ? Math.round(300 * 1024 * 1024)
    : deployComp.toDockerMemorySwapBytes();

  const containerConfig = {
    Image: deployComp.image,
    name: getAppIdentifier(identifier),
    Hostname: deployComp.name,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Cmd: adjustedCommands,
    ...(entrypoint.length > 0 && { Entrypoint: entrypoint }),
    Env: envParams,
    Tty: false,
    ExposedPorts: exposedPorts,
    ...(containerLabels && { Labels: containerLabels }),
    ...(healthcheck && { Healthcheck: healthcheck }),
    HostConfig: {
      // Place app containers in the dedicated app slice so they sit outside the
      // fenced host slices (their per-container memory.swap.max draws from the app
      // swap pool, not the host's). Only on nodes carrying the new-mechanism config.
      ...(managedStorage && { CgroupParent: 'flux-apps.slice' }),
      NanoCPUs: nanoCpus,
      Memory: memoryBytes,
      MemorySwap: memorySwapBytes,
      Mounts: deployComp.mounts,
      // tini as PID 1 (reaps zombies, forwards signals) — v9 `init`, default true.
      Init: deployComp.init,
      Ulimits: [
        {
          Name: 'nofile',
          Soft: 100000,
          Hard: 100000,
        },
      ],
      PortBindings: portBindings,
      RestartPolicy: {
        Name: restartPolicy,
      },
      NetworkMode: `fluxDockerNetwork_${appName}`,
      LogConfig: logConfig,
      ExtraHosts: [`fluxnode.service:${config.server.fluxNodeServiceAddress}`],
    },
    ...(autoAssignedIP && {
      NetworkingConfig: {
        EndpointsConfig: {
          [`fluxDockerNetwork_${appName}`]: {
            IPAMConfig: {
              IPv4Address: autoAssignedIP,
            },
          },
        },
      },
    }),
  };

  // XFS quota: apply StorageOpt if the backing filesystem supports it.
  // eslint-disable-next-line no-use-before-define
  const dockerInfoResp = await dockerInfo();
  log.info(dockerInfoResp);
  const driverStatus = dockerInfoResp.DriverStatus;
  const backingFs = driverStatus.find((status) => status[0] === 'Backing Filesystem');
  if (backingFs && backingFs[1] === 'xfs') {
    // The docker data-root is the real discriminator (not node identity): check
    // prjquota support on the filesystem docker actually reports as its root.
    const mountTarget = dockerInfoResp.DockerRootDir;
    const hasQuotaPossibility = await deviceHelper.hasQuotaOptionForMountTarget(mountTarget);
    if (hasQuotaPossibility) {
      // Cap the writable layer at the per-app budget: v9 subtracts the measured
      // image size from rootFsGb (image + writable); legacy stays flat at rootFsGb
      // (== the old hddFileSystemMinimum for v1-v8, so live apps are unchanged).
      const capGb = deployComp.writableLayerCapGb(measuredImageSizeBytes);
      containerConfig.HostConfig.StorageOpt = { size: `${capGb.toFixed(2)}G` };
    }
  }

  if (containerConfig.Env.length) {
    const fluxStorageEnv = containerConfig.Env.find((env) => env.startsWith('F_S_ENV='));
    if (fluxStorageEnv) {
      const index = containerConfig.Env.indexOf(fluxStorageEnv);
      if (index > -1) {
        containerConfig.Env.splice(index, 1);
      }
      const url = fluxStorageEnv.split('F_S_ENV=')[1];
      const envVars = await obtainPayloadFromStorage(url, appName);
      if (Array.isArray(envVars) && envVars.length < 200) {
        envVars.forEach((parameter) => {
          if (typeof parameter !== 'string' || parameter.length > 5000000) {
            throw new Error(`Environment parameters from Flux Storage ${fluxStorageEnv} are invalid`);
          } else if (parameter !== '--privileged') {
            containerConfig.Env.push(parameter);
          }
        });
      } else {
        throw new Error(`Environment parameters from Flux Storage ${fluxStorageEnv} are invalid`);
      }
    }
  }

  if (containerConfig.Cmd.length) {
    const fluxStorageCmd = containerConfig.Cmd.find((cmd) => cmd.startsWith('F_S_CMD='));
    if (fluxStorageCmd) {
      const index = containerConfig.Cmd.indexOf(fluxStorageCmd);
      if (index > -1) {
        containerConfig.Cmd.splice(index, 1);
      }
      const url = fluxStorageCmd.split('F_S_CMD=')[1];
      const cmdVars = await obtainPayloadFromStorage(url, appName);
      if (Array.isArray(cmdVars) && cmdVars.length < 200) {
        cmdVars.forEach((parameter) => {
          if (typeof parameter !== 'string' || parameter.length > 5000000) {
            throw new Error(`Commands parameters from Flux Storage ${fluxStorageCmd} are invalid`);
          } else if (parameter !== '--privileged') {
            containerConfig.Cmd.push(parameter);
          }
        });
      } else {
        throw new Error(`Commands parameters from Flux Storage ${fluxStorageCmd} are invalid`);
      }
    }
  }

  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  const nodeHostIp = localSocketAddr ? extractIp(localSocketAddr) : null;
  if (nodeHostIp) {
    containerConfig.Env.push(`FLUX_NODE_HOST_IP=${nodeHostIp}`);
  } else {
    log.warn(`FLUX_NODE_HOST_IP not injected for ${identifier}: node IP not available`);
  }
  containerConfig.Env.push(`FLUX_APP_NAME=${appName}`);



  const app = await docker.createContainer(containerConfig).catch((error) => {
    log.error(error);
    throw error;
  });

  return app;
}

/**
 * Updates the CPU limits of a Docker container.
 *
 * @param {string} idOrName - The ID or name of the Docker container.
 * @param {number} nanoCpus - The CPU limit in nanoCPUs (1 CPU = 1,000,000,000 nanoCPUs).
 * @returns {Promise<string>} message
 */
async function appDockerUpdateCpu(idOrName, nanoCpus) {
  try {
    const dockerContainer = await getDockerContainer(idOrName);
    if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);

    // Update the container's CPU resources
    await dockerContainer.update({
      NanoCpus: nanoCpus,
    });

    return `Flux App ${idOrName} successfully updated with ${nanoCpus / 1e9} CPUs.`;
  } catch (error) {
    log.error(error);
    throw new Error(`Failed to update CPU resources for ${idOrName}: ${error.message}`);
  }
}

/**
 * Starts app's docker.
 *
 * @param {string} idOrName
 * @returns {string} message
 */
async function appDockerStart(idOrName) {
  try {
    const dockerContainer = await getDockerContainer(idOrName);
    if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);

    operationRegistry.release(getDockerName(idOrName));
    await dockerContainer.start(); // may throw

    // Apply CFS burst after start — cgroup paths only exist once the container
    // is running. Eligibility was decided at appDockerCreate time and stamped
    // onto the container as labels; we just read them here. This means burst
    // is reapplied on every start path (initial install, restart, recovery)
    // without each caller having to know about burst.
    try {
      const containerInspect = await dockerContainer.inspect();
      const dockerLabels = containerInspect.Config?.Labels || {};
      if (dockerLabels['flux.burst.eligible'] === 'true') {
        const cpuCores = parseFloat(dockerLabels['flux.burst.cores']);
        const pid = containerInspect.State?.Pid;
        if (pid && cpuCores > 0) {
          await cpuBurstHelper.applyBurst(pid, cpuCores, idOrName);
        } else {
          log.warn(`CPU burst: ${idOrName} marked eligible but pid/cores missing (pid=${pid}, cores=${cpuCores})`);
        }
      }
    } catch (burstError) {
      // Burst is best-effort — do not fail container start
      log.warn(`CPU burst: failed to configure burst for ${idOrName}: ${burstError.message}`);
    }

    return `Flux App ${idOrName} successfully started.`;
  } catch (error) {
    log.error(error);
    throw error;
  }
}

/**
 * Stops app's docker.
 *
 * @param {string} idOrName
 * @param {number} [timeout] Seconds to wait before Docker sends SIGKILL. Uses Docker default (~10s) when omitted.
 * @returns {string} message
 */
async function appDockerStop(idOrName, timeout) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);

  // Check if container is running before attempting to stop
  const containerInfo = await dockerContainer.inspect();
  if (!containerInfo.State.Running) {
    return `Flux App ${idOrName} is already stopped.`;
  }

  const dockerName = getDockerName(idOrName);
  // The component-scoped 'stopping' lease is held for the duration of the stop
  // (legitimately hours under a graceful shutdown) so the die handler swallows the
  // deliberate stop and the reconciler defers. Keyed on the docker name. Released
  // when the operation settles - never by the die event: a lost event (stream
  // outage) would otherwise leak it and permanently wedge the reconciler's
  // actuation for this component.
  operationRegistry.acquire(dockerName, 'stopping', 'dockerService', `stop ${dockerName}`);

  try {
    const opts = timeout !== undefined ? { t: timeout } : {};
    await dockerContainer.stop(opts);
  } finally {
    operationRegistry.release(dockerName);
  }
  return `Flux App ${idOrName} successfully stopped.`;
}

/**
 * Restarts app's docker.
 * If the container is stopped, it will be started instead of restarted.
 *
 * @param {string} idOrName
 * @returns {string} message
 */
async function appDockerRestart(idOrName) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);

  // Check if container is running
  const containerInfo = await dockerContainer.inspect();
  if (!containerInfo.State.Running) {
    // If stopped, start it instead of restarting
    operationRegistry.release(getDockerName(idOrName));
    await dockerContainer.start();
    return `Flux App ${idOrName} was stopped, successfully started.`;
  }

  const dockerName = getDockerName(idOrName);
  operationRegistry.acquire(dockerName, 'stopping', 'dockerService', `restart ${dockerName}`);
  try {
    await dockerContainer.restart();
  } finally {
    operationRegistry.release(dockerName);
  }
  return `Flux App ${idOrName} successfully restarted.`;
}

/**
 * Kills app's docker.
 *
 * @param {string} idOrName
 * @returns {string} message
 */
async function appDockerKill(idOrName) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);

  const dockerName = getDockerName(idOrName);
  // same lease lifetime as appDockerStop: operation-scoped, never event-scoped
  operationRegistry.acquire(dockerName, 'stopping', 'dockerService', `kill ${dockerName}`);

  try {
    await dockerContainer.kill();
  } finally {
    operationRegistry.release(dockerName);
  }
  return `Flux App ${idOrName} successfully killed.`;
}

/**
 * Sends an explicit unix signal to an app's container (e.g. SIGHUP to reload
 * config after a content slot update). Distinct from appDockerKill, which is a
 * SIGKILL termination: this is a benign in-container reload, so it takes no
 * operation-registry lease — it doesn't change the container's run-state.
 *
 * @param {string} idOrName
 * @param {string} signal - e.g. 'SIGHUP', 'SIGUSR1', 'SIGUSR2'
 * @returns {string} message
 */
async function appDockerSignal(idOrName, signal) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);

  await dockerContainer.kill({ signal });
  return `Flux App ${idOrName} successfully signalled ${signal}.`;
}

/**
 * Removes app's docker.
 *
 * @param {string} idOrName
 * @returns {string} message
 */
async function appDockerRemove(idOrName) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);
  operationRegistry.release(getDockerName(idOrName));
  await dockerContainer.remove();
  return `Flux App ${idOrName} successfully removed.`;
}

/**
 * Force removes app's docker container (even if running).
 *
 * @param {string} idOrName
 * @param {boolean} removeVolumes - Also remove anonymous volumes
 * @returns {string} message
 */
async function appDockerForceRemove(idOrName, removeVolumes = true) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);
  operationRegistry.release(getDockerName(idOrName));
  await dockerContainer.remove({ force: true, v: removeVolumes });
  return `Flux App ${idOrName} successfully force removed.`;
}

/**
 * Removes app's docker image.
 *
 * @param {string} idOrName
 * @returns {string} message
 */
async function appDockerImageRemove(idOrName) {
  // container ID or name
  const dockerImage = docker.getImage(idOrName);
  await dockerImage.remove();
  return `Flux App ${idOrName} image successfully removed.`;
}

/**
 * Reads a container's network attachment against its own configured NetworkMode.
 *
 * A Flux app component container is created with NetworkMode =
 * fluxDockerNetwork_<app> and a matching endpoint in NetworkSettings.Networks
 * (see appDockerCreate). A start that fails "programming external connectivity"
 * - e.g. a host-port bind conflict during a restart after an unclean reboot -
 * can leave libnetwork holding a stale endpoint for that container: the next
 * `docker start` then brings the task up attached to NO network at all.
 * NetworkMode still names the network, but NetworkSettings.Networks no longer
 * carries it (or carries it without an IP). Such a container runs with no IP, no
 * embedded DNS (it cannot resolve sibling components by name) and no published
 * ports, and a plain start never repairs it - only a recreate, which allocates a
 * fresh endpoint, clears the stale state. This pure classifier over a Docker
 * inspect object surfaces that condition so callers (the reconciler, which
 * already holds the inspect) can detect and heal it.
 *
 * @param {object} info - a Docker container inspect object
 * @returns {{managed: boolean, running: boolean, networkMode: (string|null), attached: boolean}}
 *   managed  - NetworkMode is a fluxDockerNetwork_* (we own its networking)
 *   running  - the container task is running
 *   attached - the NetworkMode network is present in Networks with an IP
 */
function classifyContainerNetworkAttachment(info) {
  const networkMode = info && info.HostConfig ? info.HostConfig.NetworkMode || null : null;
  const running = !!(info && info.State && info.State.Running);
  const managed = typeof networkMode === 'string' && networkMode.startsWith('fluxDockerNetwork_');
  let attached = false;
  if (managed) {
    const networks = (info && info.NetworkSettings && info.NetworkSettings.Networks) || {};
    const endpoint = networks[networkMode];
    attached = !!(endpoint && endpoint.IPAddress);
  }
  return {
    managed, running, networkMode, attached,
  };
}

/**
 * Whether a container is running but not attached to its own managed network -
 * the unrecoverable-by-restart state described in classifyContainerNetworkAttachment.
 * A non-managed (host/none/bridge) container is never considered detached.
 *
 * @param {{managed: boolean, running: boolean, attached: boolean}} attachment
 * @returns {boolean}
 */
function isContainerDetachedFromNetwork(attachment) {
  if (!attachment) return false;
  return !!(attachment.managed && attachment.running && !attachment.attached);
}

/**
 * Reads whether a docker network is present, by name. Used to distinguish a
 * stale endpoint (network present, container not attached - recreatable) from a
 * pruned network (network gone - a recreate would fail on a missing NetworkMode).
 *
 * A failed inspect is ambiguous - the network may be genuinely gone, or the one
 * call may have failed while docker is fine - and the caller acts destructively
 * on the answer, so absence is never inferred from an error. On an inspect
 * failure we probe the daemon with a list call and use its ANSWER, not just its
 * success (the same pattern the reconciler's dockerActual uses):
 *   - list throws          -> 'unknown'  (docker is unhappy: the caller defers)
 *   - the network IS listed -> 'exists'  (the inspect failure was transient)
 *   - NOT listed            -> 'absent'  (docker itself confirms absence)
 *
 * @param {string} networkName
 * @returns {Promise<'exists'|'absent'|'unknown'>}
 */
async function dockerNetworkState(networkName) {
  if (!networkName) return 'absent';
  try {
    await docker.getNetwork(networkName).inspect();
    return 'exists';
  } catch (err) {
    let networks;
    try {
      networks = await docker.listNetworks();
    } catch (probeErr) {
      return 'unknown';
    }
    return networks.some((n) => n.Name === networkName) ? 'exists' : 'absent';
  }
}

/**
 * Measured on-disk size of a pulled image, in bytes (docker inspect .Size). Used
 * to size the per-app writable-layer (StorageOpt) cap. Returns 0 if unavailable so
 * callers fall back to the full rootFsGb budget rather than fail.
 * @param {string} idOrName image id or repo:tag
 * @returns {Promise<number>} on-disk image size in bytes
 */
async function appDockerImageSize(idOrName) {
  try {
    const info = await docker.getImage(idOrName).inspect();
    return info.Size || 0;
  } catch (error) {
    log.warn(`appDockerImageSize - could not inspect ${idOrName}: ${error.message}`);
    return 0;
  }
}

/**
 * Pauses app's docker.
 *
 * @param {string} idOrName
 * @returns {string} message
 */
async function appDockerPause(idOrName) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);
  await dockerContainer.pause();
  return `Flux App ${idOrName} successfully paused.`;
}

/**
 * Unpauses app's docker.
 *
 * @param {string} idOrName
 * @returns {string} message
 */
async function appDockerUnpause(idOrName) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);
  await dockerContainer.unpause();
  return `Flux App ${idOrName} successfully unpaused.`;
}

/**
 * Returns app's docker's active processes.
 *
 * @param {string} idOrName
 * @returns {string} message
 */
async function appDockerTop(idOrName) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) return null;
  const processes = await dockerContainer.top();
  return processes;
}

/**
 * Creates flux docker network if doesn't exist
 * OBSOLETE
 * @returns {object} response
 */
async function createFluxDockerNetwork() {
  // check if fluxDockerNetwork exists
  const fluxNetworkOptions = {
    Name: 'fluxDockerNetwork',
    IPAM: {
      Config: [{
        Subnet: '172.23.0.0/24',
        Gateway: '172.23.0.1',
      }],
    },
  };
  let fluxNetworkExists = true;
  const network = docker.getNetwork(fluxNetworkOptions.Name);
  await dockerNetworkInspect(network).catch(() => {
    fluxNetworkExists = false;
  });
  let response;
  // create or check docker network
  if (!fluxNetworkExists) {
    response = await dockerCreateNetwork(fluxNetworkOptions);
  } else {
    response = 'Flux Network already exists.';
  }
  return response;
}

/**
 *
 * @returns {Promise<Docker.NetworkInspectInfo[]>}
 */
async function getFluxDockerNetworks() {
  const fluxNetworks = await docker.listNetworks({
    filters: JSON.stringify({
      name: ['fluxDockerNetwork'],
    }),
  });

  return fluxNetworks;
}

/**
 *
 * @returns {Promise<string[]>}
 */
async function getFluxDockerNetworkPhysicalInterfaceNames() {
  const fluxNetworks = await getFluxDockerNetworks();

  const interfaceNames = fluxNetworks.map((network) => {
    // the physical interface name is br-<first 12 chars of Id>
    const intName = `br-${network.Id.slice(0, 12)}`;
    return intName;
  });

  return interfaceNames;
}

/**
 *
 * @returns {Promise<string[]>}
 */
async function getFluxDockerNetworkSubnets() {
  const fluxNetworks = await getFluxDockerNetworks();
  const subnets = fluxNetworks.map((network) => network.IPAM.Config[0].Subnet);
  return subnets;
}

/**
 * Creates flux application docker network if doesn't exist
 *
 * @returns {object} response
 */
async function createFluxAppDockerNetwork(appname, number) {
  // check if fluxDockerNetwork of an appexists
  const fluxNetworkOptions = {
    Name: `fluxDockerNetwork_${appname}`,
    // Ownership stamp, same scheme as container identity labels: management
    // decisions (e.g. the reconciler disconnecting a stale membership) key on
    // this label, never on name matching.
    Labels: { 'runonflux.app-network': appname },
    IPAM: {
      Config: [{
        Subnet: `172.23.${number}.0/24`,
        Gateway: `172.23.${number}.1`,
      }],
    },
  };
  let fluxNetworkExists = true;
  const network = docker.getNetwork(fluxNetworkOptions.Name);
  await dockerNetworkInspect(network).catch(() => {
    fluxNetworkExists = false;
  });
  let response;
  // create or check docker network
  if (!fluxNetworkExists) {
    response = await dockerCreateNetwork(fluxNetworkOptions);
  } else {
    response = `Flux App Network of ${appname} already exists.`;
  }
  return response;
}

/**
 * Removes flux application docker network if exists
 *
 * @returns {object} response
 */
async function removeFluxAppDockerNetwork(appname) {
  // check if fluxDockerNetwork of an app exists
  const fluxAppNetworkName = `fluxDockerNetwork_${appname}`;
  let fluxNetworkExists = true;
  const network = docker.getNetwork(fluxAppNetworkName);
  await dockerNetworkInspect(network).catch(() => {
    fluxNetworkExists = false;
  });
  let response;
  // remove docker network
  if (fluxNetworkExists) {
    response = await dockerRemoveNetwork(network);
  } else {
    response = `Flux App Network of ${appname} already does not exist.`;
  }
  return response;
}

/**
 * Force removes flux application docker network by disconnecting all endpoints first
 *
 * @param {string} appname - Application name
 * @returns {object} response
 */
async function forceRemoveFluxAppDockerNetwork(appname) {
  // eslint-disable-next-line no-shadow, global-require
  const log = require('../lib/log');
  const fluxAppNetworkName = `fluxDockerNetwork_${appname}`;
  const network = docker.getNetwork(fluxAppNetworkName);

  // Check if network exists
  let networkInfo;
  try {
    networkInfo = await dockerNetworkInspect(network);
  } catch (error) {
    return `Flux App Network of ${appname} already does not exist.`;
  }

  // Disconnect all containers from the network
  if (networkInfo.Containers) {
    const containerIds = Object.keys(networkInfo.Containers);
    if (containerIds.length > 0) {
      log.info(`Force disconnecting ${containerIds.length} container(s) from network ${fluxAppNetworkName}`);

      // Disconnect each container
      // eslint-disable-next-line no-restricted-syntax
      for (const containerId of containerIds) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await network.disconnect({ Container: containerId, Force: true });
          log.info(`Disconnected container ${containerId} from network ${fluxAppNetworkName}`);
        } catch (error) {
          log.warn(`Failed to disconnect container ${containerId}: ${error.message}`);
        }
      }
    }
  }

  // Now try to remove the network
  try {
    const response = await dockerRemoveNetwork(network);
    log.info(`Successfully removed network ${fluxAppNetworkName}`);
    return response;
  } catch (error) {
    log.error(`Failed to remove network ${fluxAppNetworkName} after disconnecting endpoints: ${error.message}`);
    throw error;
  }
}

/**
 * Connects a container to an existing docker network. Idempotent — if the
 * container is already attached to the network this resolves without error.
 *
 * Strategy: inspect the container's NetworkSettings.Networks and return early
 * if the network is already present. Falls back to a narrow string-match catch
 * only for the connect race window (another caller wired the container between
 * our inspect and connect). The previous blanket 403 catch is gone — 403 is
 * overloaded by docker for unrelated failure modes (e.g. forbidden swarm-scoped
 * operations) and was silently masking them.
 *
 * @param {string} componentIdentifier - bare component identifier or docker name
 * @param {string} networkName - target docker network name
 * @returns {Promise<void>}
 */
async function appDockerNetworkConnect(componentIdentifier, networkName) {
  // Docker callers normalise through getAppIdentifier: accept the bare
  // component identifier (web_myapp) as well as the docker name (fluxweb_myapp).
  const appId = getAppIdentifier(componentIdentifier);
  try {
    const containerInfo = await docker.getContainer(appId).inspect();
    const attached = containerInfo && containerInfo.NetworkSettings && containerInfo.NetworkSettings.Networks;
    if (attached && Object.prototype.hasOwnProperty.call(attached, networkName)) {
      return;
    }
  } catch (error) {
    // Inspect failed (container not found, transient docker error). Let the
    // connect attempt below surface the real error message.
  }

  const network = docker.getNetwork(networkName);
  try {
    await network.connect({ Container: appId });
  } catch (error) {
    if (/already exists in network|already connected/i.test(error.message || '')) {
      return;
    }
    throw error;
  }
}

/**
 * Disconnects a container from a docker network. Idempotent — a container
 * not attached to the network (or already gone) resolves without error.
 *
 * Same strategy as appDockerNetworkConnect: inspect and return early when
 * there is nothing to do, then disconnect and let real errors throw. 404 is
 * structured (dockerode statusCode: the container or network is gone —
 * nothing to disconnect); the one string match left covers the disconnect
 * race window only ("is not connected" arrives as a 500, indistinguishable
 * by status from a real server error).
 *
 * @param {string} componentIdentifier - bare component identifier or docker name
 * @param {string} networkName - docker network name
 * @returns {Promise<void>}
 */
async function appDockerNetworkDisconnect(componentIdentifier, networkName) {
  const appId = getAppIdentifier(componentIdentifier);
  try {
    const containerInfo = await docker.getContainer(appId).inspect();
    const attached = containerInfo && containerInfo.NetworkSettings && containerInfo.NetworkSettings.Networks;
    if (!attached || !Object.prototype.hasOwnProperty.call(attached, networkName)) {
      return;
    }
  } catch (error) {
    if (error.statusCode === 404) {
      return;
    }
    // Transient inspect failure: fall through and let the disconnect attempt
    // surface the real error.
  }

  const network = docker.getNetwork(networkName);
  try {
    await network.disconnect({ Container: appId });
  } catch (error) {
    if (error.statusCode === 404 || /is not connected/i.test(error.message || '')) {
      return;
    }
    throw error;
  }
}

/**
 * Whether a docker network is a flux app network — carries the
 * runonflux.app-network ownership label stamped at creation. False for a
 * network that is gone (404): nothing there is ours to manage.
 *
 * @param {string} networkName - docker network name
 * @returns {Promise<boolean>}
 */
async function isFluxAppNetwork(networkName) {
  try {
    const info = await docker.getNetwork(networkName).inspect();
    return !!(info && info.Labels && Object.prototype.hasOwnProperty.call(info.Labels, 'runonflux.app-network'));
  } catch (error) {
    if (error.statusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Escapes a string for safe use inside a RegExp source.
 */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the docker container summary objects (output of listContainers)
 * belonging to a given Flux app — both the modern component form
 * `flux<componentName>_<appName>` / `zel<componentName>_<appName>` and the
 * legacy single-component form `flux<appName>` / `zel<appName>`.
 *
 * Docker-listing based on purpose: the local DB blanks `compose` for enterprise
 * apps, so iterating spec.compose would miss components on non-Arcane nodes. The
 * regex anchors the `flux`/`zel` prefix so non-Flux containers cannot match.
 *
 * @param {string} appName
 * @returns {Promise<Array<object>>} container summary objects
 */
async function getAppContainerObjects(appName) {
  const containers = await dockerListContainers(true);
  const singleComponentSlashName = getAppDockerNameIdentifier(appName);
  const componentRegex = new RegExp(`^/(?:flux|zel)[a-zA-Z0-9]+_${escapeRegExp(appName)}$`);

  return (containers || []).filter((container) => {
    const names = container.Names || [];
    return names.some((name) => name === singleComponentSlashName || componentRegex.test(name));
  });
}

/**
 * Returns the docker container names (without leading slash) belonging to a
 * given Flux app. Thin wrapper around getAppContainerObjects.
 *
 * @param {string} appName
 * @returns {Promise<string[]>}
 */
async function getAppContainerNames(appName) {
  const objects = await getAppContainerObjects(appName);
  const names = [];
  objects.forEach((container) => {
    const raw = container.Names && container.Names[0];
    if (!raw) return;
    const name = raw.replace(/^\//, '');
    if (!names.includes(name)) names.push(name);
  });
  return names;
}

/**
 * Remove all unused containers. Unused contaienrs are those wich are not running
 */
async function pruneContainers() {
  return docker.pruneContainers();
}

/**
 * Remove all unused networks. Unused networks are those which are not referenced by any running containers
 */
async function pruneNetworks() {
  return docker.pruneNetworks();
}

/**
 * Remove all unused Volumes. Unused Volumes are those which are not referenced by any containers
 */
async function pruneVolumes() {
  return docker.pruneVolumes();
}

/**
 * Remove all unused Images. Unused Images are those which are not referenced by any containers
 */
async function pruneImages() {
  return docker.pruneImages();
}

/**
 * Return docker system information
 *
 * @returns {object}
 */
async function dockerInfo() {
  const info = await docker.info();
  return info;
}

/**
 * Returns the version of Docker that is running and various information about the system that Docker is running on.
 *
 * @returns {object}
 */
async function dockerVersion() {
  const version = await docker.version();
  return version;
}

/**
 * Returns docker events stream
 *
 * @param {object} options - Docker event filter options
 * @returns {object} Readable stream of Docker events
 */
async function dockerGetEvents(options = {}) {
  const events = await docker.getEvents(options);
  return events;
}

/**
 * Returns docker usage information
 *
 * @returns {object}
 */
async function dockerGetUsage() {
  const df = await docker.df();
  return df;
}

/**
 * Fix docker logs.
 * @returns {Promise<void>}
 */
async function dockerLogsFix() {
  try {
    const cwd = path.join(__dirname, '../../../helpers');
    const scriptPath = path.join(cwd, 'dockerLogsFix.sh');
    const { stdout } = await serviceHelper.runCommand(scriptPath, { cwd });

    // we do this so we don't log empty lines if there is no output
    const lines = stdout.split('\n');
    // this always has length
    if (lines.slice(-1)[0] === '') lines.pop();

    lines.forEach((line) => log.info(line));
  } catch (error) {
    log.error(error);
  }
}

async function getAppNameByContainerIp(ip) {
  const fluxNetworks = await docker.listNetworks({
    filters: JSON.stringify({
      name: ['fluxDockerNetwork'],
    }),
  });

  const fluxNetworkNames = fluxNetworks.map((n) => n.Name);

  const networkPromises = [];
  fluxNetworkNames.forEach((networkName) => {
    const dockerNetwork = docker.getNetwork(networkName);
    networkPromises.push(dockerNetwork.inspect());
  });

  const fluxNetworkData = await Promise.all(networkPromises);

  let appName = null;
  // eslint-disable-next-line no-restricted-syntax
  for (const fluxNetwork of fluxNetworkData) {
    const subnet = fluxNetwork.IPAM.Config[0].Subnet;
    if (serviceHelper.ipInSubnet(ip, subnet)) {
      appName = fluxNetwork.Name.split('_')[1];
      break;
    }
  }

  return appName;
}

async function waitForDocker() {
  const RETRY_DELAY_MS = 5000;
  const LOG_INTERVAL_MS = 60000;
  let lastLogAt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await docker.ping();
      log.info('Docker daemon connected');
      return;
    } catch (error) {
      const now = Date.now();
      if (!lastLogAt || now - lastLogAt >= LOG_INTERVAL_MS) {
        log.info(`Waiting for Docker daemon... (${error.message})`);
        lastLogAt = now;
      }
      // eslint-disable-next-line no-await-in-loop
      await serviceHelper.delay(RETRY_DELAY_MS);
    }
  }
}

async function migrateContainerRestartPolicies() {
  try {
    const containers = await dockerListContainers(true);
    if (!containers) return;
    const fluxContainers = containers.filter((c) => c.Names[0].startsWith('/flux'));
    let migrated = 0;
    for (const c of fluxContainers) {
      try {
        const container = docker.getContainer(c.Id);
        // eslint-disable-next-line no-await-in-loop
        const info = await container.inspect();
        if (info.HostConfig.RestartPolicy.Name !== 'no') {
          // eslint-disable-next-line no-await-in-loop
          await container.update({ RestartPolicy: { Name: 'no' } });
          migrated += 1;
        }
      } catch (err) {
        log.warn(`Failed to migrate restart policy for ${c.Names[0]}: ${err.message}`);
      }
    }
    if (migrated > 0) {
      log.info(`Migrated restart policy to 'no' for ${migrated} containers`);
    }
  } catch (error) {
    log.error(`Failed to migrate container restart policies: ${error.message}`);
  }
}

module.exports = {
  appDockerCreate,
  appDockerUpdateCpu,
  appDockerImageRemove,
  appDockerImageSize,
  appDockerKill,
  appDockerSignal,
  appDockerPause,
  appDockerRemove,
  appDockerForceRemove,
  appDockerRestart,
  appDockerStart,
  appDockerStop,
  appDockerTop,
  appDockerUnpause,
  createFluxAppDockerNetwork,
  createFluxDockerNetwork,
  dockerContainerChanges,
  dockerContainerExec,
  dockerContainerInspect,
  dockerContainerLogs,
  dockerContainerLogsPolling,
  dockerContainerLogsStream,
  dockerContainerStats,
  dockerContainerStatsStream,
  dockerCreateNetwork,
  dockerGetEvents,
  dockerGetUsage,
  dockerInfo,
  dockerListContainers,
  dockerListImages,
  dockerLogsFix,
  dockerNetworkInspect,
  dockerPullStream,
  dockerRemoveNetwork,
  dockerVersion,
  getAppDockerNameIdentifier,
  getAppIdentifier,
  getBaseAppName,
  getDockerContainer,
  getDockerContainerHandle,
  getFluxDockerNetworkPhysicalInterfaceNames,
  getFluxDockerNetworkSubnets,
  pruneContainers,
  pruneImages,
  pruneNetworks,
  pruneVolumes,
  removeFluxAppDockerNetwork,
  forceRemoveFluxAppDockerNetwork,
  appDockerNetworkConnect,
  appDockerNetworkDisconnect,
  isFluxAppNetwork,
  getAppContainerNames,
  getAppContainerObjects,
  getAppNameByContainerIp,
  classifyContainerNetworkAttachment,
  isContainerDetachedFromNetwork,
  dockerNetworkState,
  migrateContainerRestartPolicies,
  waitForDocker,
};
