'use strict';

const config = require('config');
const stream = require('stream');
const Docker = require('dockerode');
const path = require('path');
const serviceHelper = require('./serviceHelper');
const deviceHelper = require('./deviceHelper');
const hostStorageCapability = require('./utils/hostStorageCapability');
const fluxNetworkHelper = require('./fluxNetworkHelper');
const log = require('../lib/log');
const { extractIp } = require('./utils/socketAddressUtils');
const { getSpec, getSpecBackend } = require('./utils/specLibs');
const { obtainPayloadFromStorage } = require('./utils/fluxStorageRefs');
const cpuBurstHelper = require('./utils/cpuBurstHelper');
const shutdownPlan = require('./appLifecycle/shutdownPlan');


const operationRegistry = require('./utils/operationRegistry');

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
 * The docker name for a bare component identifier.
 *
 * Unconditional. It used to return the input untouched when it already began
 * with `flux`, so that one function could serve both callers holding a bare
 * identifier and callers holding a docker name — deciding which it had been
 * given by sniffing the string. That made it non-injective: a component named
 * `proxy` and a component named `fluxproxy` both produced `fluxproxy_<app>`,
 * so two distinct components claimed one container name and one volume
 * directory. Prepending a constant cannot collide. Callers that already hold a
 * docker name keep it rather than passing it back through here.
 *
 * The prefix itself decides nothing any more: ownership is the identity label
 * (isManagedContainer) and identity is read off the app's row. It survives as
 * part of names that already exist, because changing those means renaming live
 * volumes.
 *
 * @param {string} identifier bare component identifier
 * @returns {string} docker name
 */
function getAppIdentifier(identifier) {
  return `flux${identifier}`;
}

/**
 * Whether a container is one FluxOS manages.
 *
 * The identity label is the authority: it is stamped at the single create
 * chokepoint, so nothing else on the daemon carries it. A name cannot stand in
 * for that — the operator shares this docker daemon and may name a container of
 * their own anything at all, including `fluxfoo`, which the name test claimed
 * as ours.
 *
 * The name test remains only for containers created before the labels shipped
 * and not recreated since; those are genuinely ours and must not be abandoned.
 * It matches `zel` as well as `flux` — the legacy fleet carries that prefix, and
 * a gate testing only `flux` walks straight past it. Retires with the label
 * backfill.
 *
 * @param {{labels: object|undefined, name: string|undefined}} container
 * @param {object} labelKeys the label schema
 * @returns {boolean}
 */
function isManagedContainer({ labels, name }, labelKeys) {
  if (labels && labels[labelKeys.IDENTIFIER]) return true;
  if (!name) return false;
  const bare = name.startsWith('/') ? name.slice(1) : name;
  return bare.startsWith('flux') || bare.startsWith('zel');
}

/**
 * The bare component identifier (`{component}_{app}`, or `{app}` for v1-3)
 * behind a docker name — the exact inverse of getAppIdentifier.
 *
 * Unconditional, because getAppIdentifier is: the caller states which form it
 * holds by choosing to call this at all. It used to strip only when the input
 * began with `flux`, which made it a guess rather than an inverse — a component
 * genuinely named `fluxproxy` has the bare identifier `fluxproxy_<app>`, which
 * begins with those four characters without carrying a prefix, so the strip
 * yielded `proxy_<app>`: a different component.
 *
 * Callers must hold a prefixed form — a docker name, a syncthing folder id or a
 * volume directory name. A caller that already holds the bare identifier must
 * not come through here; consumers keyed on the bare form (the reconciler
 * queue, appsRuntimeState) take it as given rather than normalising, because
 * `fluxproxy_<app>` is a legitimate value of both forms and no function of that
 * string alone can tell them apart.
 *
 * Both namespaces are handled: the legacy fleet's containers carry `zel`, and
 * isManagedContainer claims them, so they reach the same consumers. Testing the
 * two is not the guess the old sniff was — a name cannot begin with both, so on
 * a value known to be a docker name the branches are disjoint and exact.
 *
 * @param {string} dockerName a flux- or zel-prefixed name
 * @returns {string} bare identifier
 */
function getBaseAppName(dockerName) {
  if (dockerName.startsWith('flux')) return dockerName.slice(4);
  if (dockerName.startsWith('zel')) return dockerName.slice(3);
  return dockerName;
}

/**
 * The app a container belongs to.
 *
 * The app label states it outright and is the authority. The name is the
 * fallback for containers created before the labels shipped: those predate
 * identities being minted, so their identifier's second segment IS the app's
 * name — the one population where reading a name out of an identifier is sound.
 * A flat (v1-3) identifier carries no segment and is the app name itself.
 *
 * @param {{labels: object|undefined, name: string|undefined}} container
 * @param {object} labelKeys the label schema
 * @returns {string|null} app name, or null when the container states no name
 */
function containerAppName({ labels, name }, labelKeys) {
  const labelled = labels && labels[labelKeys.APP];
  if (labelled) return labelled;
  if (!name) return null;
  const bare = name.startsWith('/') ? name.slice(1) : name;
  const identifier = getBaseAppName(bare);
  return identifier.split('_')[1] || identifier;
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
    repoTag, provider, authToken, authConfig, abortSignal, stallMs, progressTap,
  } = pullConfig;
  const pullOptions = {};

  // Stall watchdog: docker streams a progress event on every layer chunk, so
  // sustained silence is the black-hole signature (a half-open socket where the
  // registry accepts and never answers) - abort the transfer and surface a
  // transient-tagged error. Total pull time is deliberately unbounded: a huge
  // image that keeps moving is legitimate work, and docker resumes completed
  // layers, so killing a live transfer on a wall clock can starve a large layer
  // forever. The caller's own abortSignal (cancel-during-install) chains into
  // the same controller and keeps its meaning - its error shape is a cancel,
  // never tagged transient.
  const stallWindowMs = stallMs ?? config.fluxapps.pullStallMs ?? 90_000;
  const stallController = new AbortController();
  let stallTimer = null;
  let settled = false;
  const done = (error, data) => {
    if (settled) return;
    settled = true;
    clearTimeout(stallTimer);
    // a failed pull is logged by the caller, which knows the install context
    if (!error) log.info(`Pull of ${repoTag} complete`);
    callback(error, data);
  };
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      const stallError = new Error(`Pull of ${repoTag} stalled: no progress for ${Math.round(stallWindowMs / 1000)}s`);
      stallError.registryErrorClass = 'transient';
      // Report first, then abort: the abort also makes docker stop retrying, and
      // any error it surfaces afterwards lands on the already-settled callback.
      done(stallError);
      stallController.abort();
    }, stallWindowMs);
    if (stallTimer.unref) stallTimer.unref();
  };

  // Preferred: an explicit { username, password } object - unambiguous for
  // passwords that contain ':' (the string form below splits on the first one).
  if (authConfig && authConfig.username && authConfig.password) {
    pullOptions.authconfig = {
      username: authConfig.username,
      password: authConfig.password,
    };
    if (provider) {
      pullOptions.authconfig.serveraddress = provider;
    }
  } else if (authToken) {
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
  // onto the request and makes the response stream abortable. The stall
  // controller is what docker sees; the caller's signal chains into it so
  // either a stall or a cancel ends the transfer.
  if (abortSignal) {
    if (abortSignal.aborted) stallController.abort();
    else abortSignal.addEventListener('abort', () => stallController.abort(), { once: true });
  }
  pullOptions.abortSignal = stallController.signal;

  log.info(`Pulling image ${repoTag}`);
  armStallTimer();
  docker.pull(repoTag, pullOptions, (err, mystream) => {
    function onFinished(error, output) {
      if (error) {
        // Propagate the stream/abort error - NOT the (null) outer `err`, which would
        // report an aborted/failed pull as success and let the install proceed onto a
        // missing image. The abort relies on this.
        done(tagIfRegistryUnreachable(error));
      } else {
        // docker reports a registry/blob failure (e.g. a CDN EOF mid-blob) as an
        // in-band {error} event and then ends the stream cleanly. followProgress
        // only fails on a socket-level error, so without this a failed pull is
        // reported as success onto a missing image.
        const errorEvent = Array.isArray(output) ? output.find((e) => e && e.error) : null;
        if (errorEvent) {
          done(tagIfRegistryUnreachable(new Error((errorEvent.errorDetail && errorEvent.errorDetail.message) || errorEvent.error)));
        } else {
          done(null, output);
        }
      }
    }
    function onProgress(event) {
      armStallTimer();
      if (res) {
        res.write(serviceHelper.ensureString(event));
        if (res.flush) res.flush();
      }
      // Optional capture hook (the image cache renders per-layer progress from
      // it); a tap failure must never break the pull itself.
      if (typeof progressTap === 'function') {
        try {
          progressTap(event);
        } catch (tapError) {
          log.warn(`dockerPullStream progressTap error: ${tapError.message}`);
        }
      }
    }
    if (err) {
      done(tagIfRegistryUnreachable(err));
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
 * Follow a container's log output.
 *
 * Returns the stream and its stop handle rather than writing anywhere itself:
 * how long to follow for, and where the bytes go, are the caller's business.
 * An HTTP endpoint pipes it to a response and stops on its own schedule; the
 * playground follows one for the length of a session.
 *
 * The returned stream ends by itself when the container goes, which for a
 * short-lived container is the normal end of the log rather than a failure.
 *
 * @param {string} idOrName
 * @param {object} [options] since / timestamps / tail, forwarded to docker
 * @returns {Promise<{stream: object, stop: function}>}
 */
async function dockerContainerLogsStream(idOrName, options = {}) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) throw new Error(`Container ${idOrName} not found`);

  const logStream = new stream.PassThrough();
  const raw = await dockerContainer.logs({
    follow: true,
    stdout: true,
    stderr: true,
    ...options,
  });

  // Docker multiplexes stdout and stderr down one connection with a per-frame
  // header; both are demuxed into the one stream because a log reader wants the
  // container's output in the order it was written, not split by descriptor.
  dockerContainer.modem.demuxStream(raw, logStream, logStream);
  raw.on('end', () => logStream.end());
  raw.on('error', (err) => logStream.destroy(err));

  return {
    stream: logStream,
    stop() {
      raw.destroy();
      logStream.end();
    },
  };
}

/**
 * Returns requested number of lines of logs from the container.
 *
 * @param {string} idOrName
 * @param {number} lines
 *
 * @returns {buffer}
 */
async function dockerContainerLogs(idOrName, lines, options = {}) {
  const dockerContainer = await getDockerContainer(idOrName);
  if (!dockerContainer) return null;
  const logOptions = {
    follow: false,
    stdout: true,
    stderr: true,
    tail: lines,
    // Both off by default, so every existing caller reads exactly as before.
    // A reader that wants to follow a log INCREMENTALLY needs them: `since`
    // bounds what comes back to what is new, and timestamps are what let the
    // caller work out where it got to for the next read. Without them the only
    // way to follow a log is to re-read the last N lines and guess which are
    // new, which loses anything that arrived faster than the poll.
    ...(options.since && { since: options.since }),
    ...(options.timestamps && { timestamps: true }),
  };
  const logs = await dockerContainer.logs(logOptions);
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
 * @param {string} [networkName] - the network to allocate within, when it is not
 *   the app's own. The network's own Containers map is the authority for what is
 *   already taken; the by-name container sweep below only ever adds addresses
 *   from other subnets, which are never candidates here.
 * @returns {Promise<string|null>} - The next available IP address, or null if no IP is available.
 */
async function getNextAvailableIPForApp(appName, networkName = `fluxDockerNetwork_${appName}`) {
  try {
    const { IPAM, Containers } = await docker.getNetwork(networkName).inspect();
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
        const containerIP = containerInfo.NetworkSettings.Networks[networkName]?.IPAMConfig?.IPv4Address;
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
 * Creates an app container. The single container-creation chokepoint: every
 * label, resource limit and network placement a flux container carries is
 * decided here, so nothing else in the tree calls docker's create.
 *
 * @param {object} deployComp - DeploymentComponent, the resolved per-component view
 * @param {object} [options]
 * @param {boolean} [options.burstEligible] stamp the CPU-burst labels
 * @param {string} [options.restartPolicy] docker restart policy name; defaults to 'no'
 * @param {string[]} [options.extraEnv] env entries appended to the component's own
 * @param {number} [options.measuredImageSizeBytes] on-disk image size, for the writable-layer cap
 * @param {string} [options.owner] FluxID stamped as runonflux.owner
 * @param {boolean} [options.requiresEncryption] stamp the shutdown-budget labels
 * @param {object} [options.labels] extra container labels merged over the standard set
 * @param {boolean} [options.publishPorts] bind the component's ports on the host; default true
 * @param {string} [options.cgroupSlice] cgroup parent; default 'flux-apps.slice'
 * @param {string[]} [options.dns] resolver chain for the container's embedded
 *   resolver. Omitted, the host's resolvers apply; a mesh component states the
 *   flux-dnsd chain so mesh names resolve.
 * @param {string} [options.networkName] the docker network to attach to, when it
 *   is not the app's own. Defaults to fluxDockerNetwork_<appName>. A playground
 *   session states it, because its network belongs to the session rather than to
 *   the app whose spec it is running — deriving it from the name would attach a
 *   guest to a paid app's network, or a paid app to the guest's.
 * @returns {Promise<object>} the created dockerode container
 */
async function appDockerCreate(deployComp, options = {}) {
  const burstEligible = options.burstEligible || false;
  const restartPolicyOverride = options.restartPolicy || null;
  const extraEnv = options.extraEnv || [];
  const measuredImageSizeBytes = options.measuredImageSizeBytes || 0;
  // The playground runs a spec with no inbound path at all: no host port is
  // bound, so no firewall hole or UPnP mapping is needed and nothing outside the
  // node can reach the container. The ports stay EXPOSED, so the component's own
  // probe and its sibling components still reach them inside the app network -
  // what is withdrawn is the binding on the host, not the port itself.
  const publishPorts = options.publishPorts !== false;
  // Which cgroup slice the container lands in. Apps get flux-apps.slice; the
  // playground passes its own so a guest's load is capped in aggregate
  // independently of the apps this node is paid to run.
  const cgroupSlice = options.cgroupSlice || 'flux-apps.slice';
  // Managed-storage host (host-swap fence + flux-apps.slice + xfs/prjquota). Cached, local check.
  const managedStorage = await hostStorageCapability.supportsManagedStorage();

  const { appName } = deployComp;
  const { identifier } = deployComp;
  const networkName = options.networkName ?? `fluxDockerNetwork_${appName}`;

  const effectiveCpu = deployComp.cpu;

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

  // json-file is the one log driver: `docker logs`, the FluxOS log
  // endpoints, and flux-telemetryd's tailer all read it. Log shipping is
  // the otlp telemetry block's job (spec-declared, identity-socket routed)
  // — never a per-container driver swap.
  const logConfig = {
    Type: 'json-file',
    Config: {
      'max-file': '1',
      'max-size': '20m',
    },
  };
  const autoAssignedIP = await getNextAvailableIPForApp(appName, networkName);

  const { LABEL_KEYS, identityLabels, shutdownBudgetLabels } = await getSpecBackend();

  const burstLabels = burstEligible
    ? {
      [LABEL_KEYS.BURST_ELIGIBLE]: 'true',
      [LABEL_KEYS.BURST_CORES]: String(effectiveCpu),
    }
    : null;
  // Identity goes on every flux container at this single create chokepoint so
  // flux-shutdownd can enumerate and stop any app. Budget labels (drain/preStop/
  // graceful timing) are added only for apps that use a graceful feature; a plain
  // app drains on the daemon's defaults. owner is provenance threaded in from
  // the orchestrator (it is not on DeploymentComponent).
  const identity = identityLabels(deployComp, {
    owner: options.owner || null,
    uuid: options.uuid || null,
  });
  const budgetLabels = options.requiresEncryption
    ? shutdownBudgetLabels(deployComp, shutdownPlan.maxDrainTimeout(deployComp))
    : null;
  // Identity is merged LAST so it always wins. A caller-supplied label that
  // happened to reuse an identity key would otherwise silently retag the
  // container as a different app, and every reader downstream believes it.
  const containerLabels = {
    ...(options.labels || {}), ...(burstLabels || {}), ...(budgetLabels || {}), ...identity,
  };
  if (burstEligible) {
    log.info(`CPU burst: marking ${identifier} as burst-eligible (cores=${effectiveCpu})`);
  }

  const restartPolicy = restartPolicyOverride || 'no';

  const nanoCpus = deployComp.toDockerNanoCpus();
  const memoryBytes = deployComp.toDockerMemoryBytes();
  const memorySwapBytes = deployComp.toDockerMemorySwapBytes();

  const containerConfig = {
    Image: deployComp.image,
    name: getAppIdentifier(identifier),
    // What the container calls itself: `<replica>_<component>`, or the bare component
    // name when unreplicated — unless the caller states an identity hostname (a mesh
    // member name, which the app reads to learn which member it is).
    Hostname: options.hostname ?? deployComp.hostname ?? deployComp.name,
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
      ...(managedStorage && { CgroupParent: cgroupSlice }),
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
      PortBindings: publishPorts ? portBindings : {},
      RestartPolicy: {
        Name: restartPolicy,
      },
      NetworkMode: networkName,
      LogConfig: logConfig,
      ExtraHosts: [`fluxnode.service:${config.server.fluxNodeServiceAddress}`],
      ...(Array.isArray(options.dns) && options.dns.length > 0 && { Dns: options.dns }),
    },
    ...((autoAssignedIP || (Array.isArray(options.networkAliases) && options.networkAliases.length > 0)) && {
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {
            ...(autoAssignedIP && {
              IPAMConfig: {
                IPv4Address: autoAssignedIP,
              },
            }),
            // Extra resolvable names on the app's network beside the container
            // name and hostname — how a mesh container whose hostname is its
            // member name stays reachable as plain `<component>`.
            ...(Array.isArray(options.networkAliases) && options.networkAliases.length > 0 && {
              Aliases: options.networkAliases,
            }),
          },
        },
      },
    }),
  };

  // XFS quota: apply StorageOpt if the backing filesystem supports it.
  // eslint-disable-next-line no-use-before-define
  const dockerInfoResp = await dockerInfo();
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

  // Platform env — one map, delivered two ways. The component's spec-derived
  // share (FLUX_APP_NAME, FLUX_REPLICA under named placement, FLUX_PORT_<name>
  // per declared port with its effective hostPort) plus the node-scoped facts
  // only the runtime knows. ${FLUX_*} references in user env values resolve
  // against the same map (validated at submission; an unresolvable token stays
  // verbatim rather than silently emptying), and every variable is appended
  // after the user's entries — docker's last-duplicate-wins makes platform
  // values authoritative.
  const { substitutePlatformEnv } = await getSpec();
  const platformEnv = deployComp.platformEnv();
  const localSocketAddr = await fluxNetworkHelper.getLocalSocketAddress();
  const nodeHostIp = localSocketAddr ? extractIp(localSocketAddr) : null;
  if (nodeHostIp) {
    platformEnv.FLUX_NODE_HOST_IP = nodeHostIp;
  } else {
    log.warn(`FLUX_NODE_HOST_IP not injected for ${identifier}: node IP not available`);
  }
  containerConfig.Env = containerConfig.Env.map((entry) => substitutePlatformEnv(entry, platformEnv));
  containerConfig.Env.push(...Object.entries(platformEnv).map(([name, value]) => `${name}=${value}`));



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
// Acquire a component-transition lease (actuating | stopping | removing) or fail
// closed. These three types are mutually exclusive on one container, so a conflicting
// transition already in flight means this one must NOT race it — it throws a structured
// ETRANSITIONHELD the caller defers on (the reconciler retries; a teardown's best-effort
// catch skips the component and keeps it owed). Fail-closed acquisition + own-lease-only
// release is what makes the lease a real lock rather than the decoupled advisory marker
// it started as.
function acquireTransitionLease(dockerName, type, reason) {
  const token = operationRegistry.acquire(dockerName, type, 'dockerService', reason);
  if (!token) {
    const held = operationRegistry.get(dockerName);
    const error = new Error(`${dockerName}: a '${held ? held.type : 'concurrent'}' container transition is in flight; deferring '${type}'`);
    error.code = 'ETRANSITIONHELD';
    throw error;
  }
  return token;
}

// A container that vanishes between a caller's state read and its docker call (an
// out-of-band `docker rm -f` mid-pass) is not a crash of the workload. Tagged
// ENOCONTAINER so a caller pacing a crash ladder treats it as "the world changed"
// (re-read actual state) instead of recording a failed run.
function containerGoneError(idOrName) {
  const error = new Error(`Container ${idOrName} not found`);
  error.code = 'ENOCONTAINER';
  return error;
}

// docker's own rejections from the same removal window: the container 404s (removal
// just finished) or docker refuses the transition while its removal is in progress.
function tagIfContainerGone(err) {
  const message = err.message || '';
  // A start that could not set up networking also comes back 404, worded as if the
  // CONTAINER were missing ("no such container - failed to set up container
  // networking: network <id> not found"). The container is right where we left it;
  // its network is what is gone. Reading that as "the world changed underneath us"
  // defers forever on a paced retry: it never records the failure, never advances
  // the backoff ladder and never fail-converges, so the app sits down silently.
  if (/failed to set up container networking|network .* not found/i.test(message)) {
    return err;
  }
  if (err.statusCode === 404 || /removal of container .* is already in progress|marked for removal|being removed/i.test(message)) {
    err.code = 'ENOCONTAINER';
  }
  return err;
}

// A pull that failed because the registry could not be REACHED - a network-path
// failure, timeout, rate limit, or registry 5xx, as the daemon or socket reports
// it - is a node-side condition, not a verdict on the image. Tagged 'transient'
// so provisioning consumers defer or fall back to a local image instead of
// failing the app; anything unrecognized stays untagged and reads permanent.
// Deliberately excludes abort/cancel shapes - a cancelled pull belongs to the
// cancel machinery, not the retry path.
const REGISTRY_TRANSIENT_TEXT = /connection refused|i\/o timeout|tls handshake timeout|no such host|timeout exceeded|context deadline exceeded|toomanyrequests|too many requests|temporary failure|connection reset|unexpected eof|service unavailable|received unexpected http status: 5\d\d/i;
const REGISTRY_TRANSIENT_CODES = ['ECONNREFUSED', 'ECONNABORTED', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'];
function tagIfRegistryUnreachable(err) {
  if (
    REGISTRY_TRANSIENT_CODES.includes(err.code)
    || err.statusCode === 429
    || (err.statusCode >= 500 && err.statusCode <= 599)
    || REGISTRY_TRANSIENT_TEXT.test(err.message || '')
  ) {
    err.registryErrorClass = 'transient';
  }
  return err;
}

async function appDockerStart(idOrName) {
  const dockerName = getDockerName(idOrName);
  // Hold 'actuating' across the start so a concurrent teardown's remove defers instead
  // of tearing the container down mid-create; released own-lease-only in finally.
  const token = acquireTransitionLease(dockerName, 'actuating', `start ${dockerName}`);
  try {
    const dockerContainer = await getDockerContainer(idOrName);
    if (!dockerContainer) throw containerGoneError(idOrName);

    try {
      await dockerContainer.start(); // may throw
    } catch (err) {
      throw tagIfContainerGone(err);
    }

    // Apply CFS burst after start — cgroup paths only exist once the container
    // is running. Eligibility was decided at appDockerCreate time and stamped
    // onto the container as labels; we just read them here. This means burst
    // is reapplied on every start path (initial install, restart, recovery)
    // without each caller having to know about burst.
    try {
      const containerInspect = await dockerContainer.inspect();
      const dockerLabels = containerInspect.Config?.Labels || {};
      const { LABEL_KEYS, readLabel } = await getSpecBackend();
      // Through readLabel: a container created before the label scheme was
      // unified carries the old key, and reading only the current one would
      // silently stop reapplying its burst for the rest of its life.
      if (readLabel(dockerLabels, LABEL_KEYS.BURST_ELIGIBLE) === 'true') {
        const cpuCores = parseFloat(readLabel(dockerLabels, LABEL_KEYS.BURST_CORES));
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
  } finally {
    operationRegistry.release(dockerName, token);
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
  // deliberate stop and the reconciler defers. Keyed on the docker name, released
  // own-lease-only when the operation settles - never by the die event: a lost event
  // (stream outage) would otherwise leak it and permanently wedge the reconciler's
  // actuation for this component. Fail-closed: if a create/start ('actuating') is in
  // flight, the stop defers rather than racing it.
  const token = acquireTransitionLease(dockerName, 'stopping', `stop ${dockerName}`);

  try {
    const opts = timeout !== undefined ? { t: timeout } : {};
    await dockerContainer.stop(opts);
  } finally {
    operationRegistry.release(dockerName, token);
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
  if (!dockerContainer) throw containerGoneError(idOrName);

  const dockerName = getDockerName(idOrName);
  // Check if container is running
  const containerInfo = await dockerContainer.inspect();
  if (!containerInfo.State.Running) {
    // Stopped -> this is really a start, so hold 'actuating' (a die here is a real
    // crash) rather than 'stopping'; a concurrent teardown's remove defers on it.
    const startToken = acquireTransitionLease(dockerName, 'actuating', `restart(start) ${dockerName}`);
    try {
      await dockerContainer.start();
    } catch (err) {
      throw tagIfContainerGone(err);
    } finally {
      operationRegistry.release(dockerName, startToken);
    }
    return `Flux App ${idOrName} was stopped, successfully started.`;
  }

  const token = acquireTransitionLease(dockerName, 'stopping', `restart ${dockerName}`);
  try {
    await dockerContainer.restart();
  } catch (err) {
    throw tagIfContainerGone(err);
  } finally {
    operationRegistry.release(dockerName, token);
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
  // same lease lifetime as appDockerStop: operation-scoped, never event-scoped, and
  // fail-closed against an in-flight 'actuating' start; released own-lease-only.
  const token = acquireTransitionLease(dockerName, 'stopping', `kill ${dockerName}`);

  try {
    await dockerContainer.kill();
  } finally {
    operationRegistry.release(dockerName, token);
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
  // Lease-free: the only caller is the teardown, which already holds this component's
  // 'removing' lease across the whole stop->remove->cleanup. Touching the registry here
  // would either conflict with that hold (acquire) or drop it (release).
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
  // Lease-free: see appDockerRemove — the teardown owns the 'removing' lease.
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
 * Inspects a docker image by id or repotag. Resolves the inspect object when the image
 * is present; rejects (statusCode 404) when it is absent. Authoritative present/absent
 * check for a single image - more reliable than scanning dockerListImages().
 *
 * @param {string} idOrName
 * @returns {Promise<object>} the docker image inspect result
 */
async function dockerImageInspect(idOrName) {
  const dockerImage = docker.getImage(idOrName);
  const info = await dockerImage.inspect();
  return info;
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
 * The live docker id of a network, or null if it is not there.
 *
 * Docker binds a container to the network's ID, not its name: a network removed
 * and recreated under the same name is a DIFFERENT network to every container
 * that was on the old one, and their recorded id keeps pointing at the dead one
 * forever. Comparing this against what a container recorded is the only way to
 * see that, since the name still matches on both sides and the container still
 * lists the network as one of its own.
 *
 * Null on any failure: a caller comparing ids must treat "cannot tell" as "no
 * evidence of a mismatch" and leave the container alone, never destroy it.
 *
 * @param {string} networkName
 * @returns {Promise<string|null>} docker network id, or null
 */
async function dockerNetworkId(networkName) {
  if (!networkName) return null;
  try {
    const info = await docker.getNetwork(networkName).inspect();
    return info?.Id ?? null;
  } catch (err) {
    return null;
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
 * Every docker network carrying a label, whatever it is named.
 *
 * The name filter above is a SUBSTRING match on a naming convention; this asks
 * who owns a network instead, which is the question a sweep or an allocator
 * actually has. Networks outside the app namespace are reachable no other way.
 *
 * @param {string} label - label key; presence is the test, not its value
 * @returns {Promise<Docker.NetworkInspectInfo[]>}
 */
async function dockerListNetworksByLabel(label) {
  return docker.listNetworks({
    filters: JSON.stringify({ label: [label] }),
  });
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
 * Returns the lowest free third octet for a new flux app network
 * (172.23.<octet>.0/24). It scans EVERY docker network's subnet (not just flux
 * ones) because docker enforces subnet uniqueness across all networks - a non-flux
 * network sitting on a 172.23.x block must be treated as used or the create would
 * fail. The optional excludeOctets lets a caller skip octets it has already lost a
 * create race on this attempt, so a bounded collision retry keeps advancing to a
 * genuinely free octet rather than re-picking the same one. Deterministic and
 * reports exhaustion definitively (null) rather than guessing.
 * @param {Set<number>} [excludeOctets] octets to treat as used (already tried/lost)
 * @returns {Promise<number|null>} lowest free octet in 1..255, or null if none free
 */
async function getFreeFluxAppNetworkOctet(excludeOctets = new Set()) {
  const networks = await docker.listNetworks();
  const used = new Set(excludeOctets);
  networks.forEach((network) => {
    const configs = (network.IPAM && network.IPAM.Config) || [];
    configs.forEach((cfg) => {
      // Any prefix length, not just /24: an octet carved into smaller subnets
      // (the playground allocates /27s inside one) is still fully spoken for,
      // and a /24 create over the top of it would fail. Matching only /24 here
      // would leave that octet looking free.
      const match = /^172\.23\.(\d{1,3})\.\d{1,3}\/\d{1,2}$/.exec((cfg && cfg.Subnet) || '');
      if (match) used.add(Number(match[1]));
    });
  });
  for (let octet = 1; octet <= 255; octet += 1) {
    if (!used.has(octet)) return octet;
  }
  return null;
}

/**
 * Creates flux application docker network if doesn't exist
 *
 * The subnet is sized by the caller rather than fixed at /24. An app gets the
 * whole octet, which is the default; the playground carves one reserved octet
 * into /27s so that a feature running one session at a time does not take
 * sixteen octets out of a pool of 255 that also has to serve maxAppsPerNode
 * apps. Both go through here, so subnet arithmetic lives in one place.
 *
 * @param {string} appname - names the network and stamps its ownership label
 * @param {number} number - third octet, from getFreeFluxAppNetworkOctet
 * @param {object} [options]
 * @param {number} [options.prefix] - prefix length; default 24 (the whole octet)
 * @param {number} [options.base] - fourth-octet offset for a sub-/24 subnet, so
 *   /27s sit at .0, .32, .64 and so on. Ignored at /24.
 * @param {string} [options.bridgeName] - explicit kernel interface name for the
 *   bridge. Left unset, docker derives br-<network id>, which is unpredictable
 *   until the network exists. The playground names its bridges so its firewall
 *   and traffic-shaping rules can be written once against a name pattern rather
 *   than rebuilt per session against whatever id docker happened to mint.
 * @param {string} [options.networkName] - the docker network name, when the
 *   caller's network is not an app's. Defaults to fluxDockerNetwork_<appname>.
 * @param {object} [options.labels] - ownership labels, replacing the app-network
 *   stamp. A network carrying a different stamp is invisible to the app debris
 *   sweep, which is the point: a playground session's network is not an app's
 *   and must not be reaped by the machinery that reclaims one.
 * @returns {object} response
 */
async function createFluxAppDockerNetwork(appname, number, options = {}) {
  const prefix = options.prefix ?? 24;
  const base = options.base ?? 0;
  const { bridgeName } = options;
  const { LABEL_KEYS } = await getSpecBackend();
  // check if fluxDockerNetwork of an appexists
  const fluxNetworkOptions = {
    Name: options.networkName ?? `fluxDockerNetwork_${appname}`,
    // Ownership stamp, same scheme as container identity labels: management
    // decisions (e.g. the reconciler disconnecting a stale membership) key on
    // this label, never on name matching.
    Labels: options.labels ?? { [LABEL_KEYS.APP_NETWORK]: appname },
    ...(bridgeName && { Options: { 'com.docker.network.bridge.name': bridgeName } }),
    IPAM: {
      Config: [{
        Subnet: `172.23.${number}.${base}/${prefix}`,
        // .0 is the network address, so the gateway is the first host in
        // whichever block this is - .1 for a /24, .33 for the /27 at .32.
        Gateway: `172.23.${number}.${base + 1}`,
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
 * @param {object} [options]
 * @param {string} [options.networkName] - the docker network name, when the
 *   caller's network is not an app's. Defaults to fluxDockerNetwork_<appname>.
 * @returns {object} response
 */
async function forceRemoveFluxAppDockerNetwork(appname, options = {}) {
  const fluxAppNetworkName = options.networkName ?? `fluxDockerNetwork_${appname}`;
  const network = docker.getNetwork(fluxAppNetworkName);

  // Check if network exists
  let networkInfo;
  try {
    networkInfo = await dockerNetworkInspect(network);
  } catch (error) {
    return `Network ${fluxAppNetworkName} already does not exist.`;
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
 * @param {string} componentIdentifier - bare component identifier
 * @param {string} networkName - target docker network name
 * @returns {Promise<void>}
 */
/**
 * The names a container should answer to on one network, from its identity labels.
 *
 * Its OWN app network gets the short forms as well; anyone else's gets the
 * app-qualified ones only, so an attached stranger cannot shadow the host app's bare
 * component names. A container without the labels (created before they shipped) gets
 * none, which is what it has today.
 *
 * @param {object} labels container labels as inspected
 * @param {string} networkName
 * @returns {Promise<string[]>}
 */
async function networkAliasesFromLabels(labels, networkName) {
  const { LABEL_KEYS, networkAliasesFor, qualifiedNetworkAliasesFor } = await getSpecBackend();
  const component = labels[LABEL_KEYS.COMPONENT];
  const appName = labels[LABEL_KEYS.APP];
  if (!component || !appName) return [];
  const replica = labels[LABEL_KEYS.REPLICA] || null;
  const parts = { component, appName, replica };
  return networkName === `fluxDockerNetwork_${appName}`
    ? networkAliasesFor(parts)
    : qualifiedNetworkAliasesFor(parts);
}

async function appDockerNetworkConnect(componentIdentifier, networkName, aliases = null) {
  // Docker callers normalise through getAppIdentifier: accept the bare
  // component identifier (web_myapp) as well as the docker name (fluxweb_myapp).
  const appId = getAppIdentifier(componentIdentifier);
  // One inspect answers both questions: is it already attached, and what should it be
  // called there. The labels are the identity of record, so the names are derived from
  // the container itself rather than threaded through every convergence sweep.
  let labels = {};
  try {
    const containerInfo = await docker.getContainer(appId).inspect();
    labels = containerInfo?.Config?.Labels || {};
    const attached = containerInfo && containerInfo.NetworkSettings && containerInfo.NetworkSettings.Networks;
    if (attached && Object.prototype.hasOwnProperty.call(attached, networkName)) {
      return;
    }
  } catch (error) {
    // Inspect failed (container not found, transient docker error). Let the
    // connect attempt below surface the real error message.
  }

  const network = docker.getNetwork(networkName);
  // Aliases are per-endpoint and are NOT remembered across a disconnect, so every
  // reattach has to state them again or the container silently loses the names other
  // apps address it by. Derived from the container's own identity labels rather than
  // threaded through each caller: reconnect runs from convergence sweeps that hold a
  // container name and nothing else.
  // Never fail an attach over addressing: a container connected without its aliases is
  // still reachable by its docker name, which is how it behaved before.
  const resolved = aliases ?? await networkAliasesFromLabels(labels, networkName)
    .catch((error) => {
      log.warn(`appDockerNetworkConnect: aliases for ${appId} on ${networkName}: ${error.message}`);
      return [];
    });
  try {
    await network.connect({
      Container: appId,
      ...(resolved.length > 0 && { EndpointConfig: { Aliases: resolved } }),
    });
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
 * @param {string} componentIdentifier - bare component identifier
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
 * Whether a docker network is a flux app network — carries the app-network
 * ownership label stamped at creation. False for a network that is gone (404):
 * nothing there is ours to manage.
 *
 * @param {string} networkName - docker network name
 * @returns {Promise<boolean>}
 */
async function isFluxAppNetwork(networkName) {
  try {
    const info = await docker.getNetwork(networkName).inspect();
    const { LABEL_KEYS } = await getSpecBackend();
    return !!(info && info.Labels
      && Object.prototype.hasOwnProperty.call(info.Labels, LABEL_KEYS.APP_NETWORK));
  } catch (error) {
    if (error.statusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether a docker network exists (any network, by name). Distinguishes a gone
 * network (404 → false) from a transient inspect failure (rethrows). Lets a
 * caller tell "the linked app's network disappeared" (a transient ordering
 * condition to defer on) from a real docker error.
 *
 * @param {string} networkName - docker network name
 * @returns {Promise<boolean>}
 */
async function fluxDockerNetworkExists(networkName) {
  try {
    await docker.getNetwork(networkName).inspect();
    return true;
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
  // The optional third segment is a replica name (co-located named replicas).
  const componentRegex = new RegExp(`^/(?:flux|zel)[a-zA-Z0-9]+_${escapeRegExp(appName)}(?:_[a-z0-9-]+)?$`);
  const { LABEL_KEYS } = await getSpecBackend();

  return (containers || []).filter((container) => {
    // Labels are the identity authority; the name regex remains for pre-label
    // containers (created before identity labels shipped, never recreated).
    if (container.Labels && container.Labels[LABEL_KEYS.APP]) {
      return container.Labels[LABEL_KEYS.APP] === appName;
    }
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

// No blanket container/network/volume prune primitive is exposed, deliberately.
// Docker's "unused" is a runtime predicate - nothing attached right now - which
// is true of every healthy app whose container is momentarily down, so a prune
// keyed on it destroys live apps' networks and containers, and then the
// anonymous volumes those containers were holding. Removal of flux objects is
// scoped by OWNERSHIP instead: appNetwork/appDockerNetwork for app networks,
// appUninstaller for an app's containers and volumes.

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
    const { LABEL_KEYS } = await getSpecBackend();
    const fluxContainers = containers.filter(
      (c) => isManagedContainer({ labels: c.Labels, name: c.Names?.[0] }, LABEL_KEYS),
    );
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
  tagIfRegistryUnreachable,
  appDockerImageRemove,
  dockerImageInspect,
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
  isManagedContainer,
  containerAppName,
  getDockerContainer,
  getDockerContainerHandle,
  getFluxDockerNetworks,
  dockerListNetworksByLabel,
  getFluxDockerNetworkPhysicalInterfaceNames,
  getFluxDockerNetworkSubnets,
  getFreeFluxAppNetworkOctet,
  migrateContainerRestartPolicies,
  pruneImages,
  removeFluxAppDockerNetwork,
  forceRemoveFluxAppDockerNetwork,
  appDockerNetworkConnect,
  appDockerNetworkDisconnect,
  isFluxAppNetwork,
  fluxDockerNetworkExists,
  getAppContainerNames,
  getAppContainerObjects,
  getAppNameByContainerIp,
  classifyContainerNetworkAttachment,
  isContainerDetachedFromNetwork,
  dockerNetworkState,
  dockerNetworkId,
  waitForDocker,
};
