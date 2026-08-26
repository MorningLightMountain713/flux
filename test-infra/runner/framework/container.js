import { throwIfInfraDead, sleepUnlessInfraDead } from './infra-death.js';

import { execFile } from 'node:child_process';
import { NotPresentError } from './errors.js';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Pause/unpause a HOST-level testcontainer (registry, stubs) via the host docker
// CLI - testcontainers has no pause API. A paused container models a real
// service outage faithfully: its DNS alias stays registered and TCP connects
// black-hole, unlike stop(), which deregisters the alias and turns the failure
// into a DNS miss that FluxOS's resolver then negative-caches past the outage.
export async function pauseHostContainer(startedContainer) {
  await execFileAsync('docker', ['pause', startedContainer.getId()]);
}

export async function unpauseHostContainer(startedContainer) {
  await execFileAsync('docker', ['unpause', startedContainer.getId()]);
}

export async function execInContainer(container, command) {
  const args = Array.isArray(command) ? command : ['sh', '-c', command];
  const result = await container.exec(args);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, output: result.output };
}

// Move a node to a different address on the fleet network: the new one goes on,
// the old one comes off.
//
// This is what an address change IS, and doing it for real is what makes the rest
// of the fixture honest. Its peers then find it unreachable at the old address
// because it genuinely is not there - no packet filter simulating it, and nothing
// hidden from the node list, so they still recognise it as the sender of the
// fluxipchanged broadcast that follows.
//
// The timing matters and is measured. A probe to an address that is gone fails
// with EHOSTUNREACH at ~3.1s (ARP gives up), NOT a hang - so a peer's own probe
// budget of 5s sees a failure rather than a timeout, and it answers the asking
// node inside that node's 7s budget. Those margins are why this works where
// dropping packets did not: a dropped probe burns the full 5s, and the answer
// then arrives after the asker has already given up, which reads as "I could not
// ask" rather than "you are unreachable" - a different branch entirely, and one
// that never consults benchmark.
//
// @param {object} container The node's container.
// @param {string} to Bare address to move to, inside the fleet's own /24.
// @param {string} from Bare address to give up.
export async function moveNodeAddress(container, to, from, { prefix = 24, iface = 'eth0' } = {}) {
  const add = await execInContainer(container, `ip addr add ${to}/${prefix} dev ${iface}`);
  if (add.exitCode !== 0 && !/File exists/i.test(add.output || '')) {
    throw new Error(`moveNodeAddress: could not add ${to}/${prefix} to ${iface}: ${add.output}`);
  }
  const del = await execInContainer(container, `ip addr del ${from}/${prefix} dev ${iface}`);
  if (del.exitCode !== 0 && !/Cannot assign|not exist/i.test(del.output || '')) {
    throw new Error(`moveNodeAddress: could not remove ${from}/${prefix} from ${iface}: ${del.output}`);
  }
  return to;
}

// Make a node unreachable to the named peers, without taking it off the network.
//
// The node keeps its address, its list entry and its outbound connections; what
// stops is inbound traffic to its API port FROM those peers. That is what a node
// whose address has moved looks like from the outside - still listed where it was,
// no longer answering there - and it is the state that makes a peer's availability
// probe fail, which is what a node needs before it will ask benchmark whether its
// address changed.
//
// REJECT rather than DROP, and the difference decides whether this works at all.
// A peer asked whether it can reach this node probes it and answers within the
// asker's own timeout budget. Dropped packets blackhole, so that probe burns its
// full timeout and the peer answers too late - the asker times out on the PEER and
// reads "I could not ask" instead of "I am unreachable", which retries without ever
// consulting benchmark. Refusing fails the probe instantly, so the answer arrives
// in time and says what it is meant to say.
//
// Named peers rather than the subnet: the runner reaches the node from the docker
// gateway on that same /24, so a blanket rule would cut off the very client doing
// the asserting.
//
// @param {object} container The node's container.
// @param {string[]} peerIps Bare addresses whose traffic to drop.
// @param {number} apiPort The node's API port.
export async function blockPeerAccess(container, peerIps, apiPort) {
  for (const peerIp of peerIps) {
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(container, `iptables -I INPUT -p tcp --dport ${apiPort} -s ${peerIp} -j REJECT --reject-with tcp-reset`);
    if (r.exitCode !== 0) {
      throw new Error(`blockPeerAccess: could not drop ${peerIp} -> :${apiPort}: ${r.output}`);
    }
  }
  return peerIps;
}

// Undo blockPeerAccess. Tolerates a rule that is already gone so teardown after a
// failed test cannot fail in its own right.
export async function unblockPeerAccess(container, peerIps, apiPort) {
  for (const peerIp of peerIps) {
    // eslint-disable-next-line no-await-in-loop
    await execInContainer(container, `iptables -D INPUT -p tcp --dport ${apiPort} -s ${peerIp} -j REJECT --reject-with tcp-reset`);
  }
}

// A router that forwards by port alone, as seen from the node behind it: every
// call this node makes to `ports` on one of `toIps` arrives at `landsOn` instead,
// port for port. A DNAT in the node's own nat OUTPUT chain, so it moves only
// connections this node originates - traffic arriving at the node, and every
// other node's traffic, are untouched, which is exactly the half of the fault
// that makes it invisible from outside. TCP and UDP both, because syncthing
// dials QUIC on the same port as TCP.
//
// Moves new connections only. One already open to a target keeps going to it
// until it closes, as it would through a real router whose forwarding changed -
// unless `resetOpen`, which resets every TCP connection still addressed to a
// target, so the node's next call opens one through the redirect. A redirected
// connection is addressed to `landsOn` and is not reset.
//
// Returns the rules it added, for clearOutboundRedirect.
//
// @param {object} container The node's container.
// @param {{toIps: string[], ports: string, landsOn: string, resetOpen?: boolean}} redirect
//   `ports` as iptables takes it, e.g. '16127:16129'.
export async function redirectOutbound(container, {
  toIps, ports, landsOn, resetOpen = false,
}) {
  const rules = [];
  for (const toIp of toIps) {
    for (const proto of ['tcp', 'udp']) {
      const rule = `-t nat OUTPUT -p ${proto} -d ${toIp} --dport ${ports} -j DNAT --to-destination ${landsOn}`;
      // eslint-disable-next-line no-await-in-loop
      const r = await execInContainer(container, `iptables ${rule.replace(' OUTPUT', ' -A OUTPUT')}`);
      if (r.exitCode !== 0) {
        throw new Error(`redirectOutbound: could not send ${toIp}:${ports}/${proto} to ${landsOn}: ${r.output}`);
      }
      rules.push(rule);
    }
    if (resetOpen) {
      const rule = `-t filter OUTPUT -p tcp -d ${toIp} --dport ${ports} -j REJECT --reject-with tcp-reset`;
      // eslint-disable-next-line no-await-in-loop
      const r = await execInContainer(container, `iptables ${rule.replace(' OUTPUT', ' -A OUTPUT')}`);
      if (r.exitCode !== 0) throw new Error(`redirectOutbound: could not reset open connections to ${toIp}:${ports}: ${r.output}`);
      rules.push(rule);
    }
  }
  return rules;
}

// Undo redirectOutbound. Tolerates a rule that is already gone so teardown after
// a failed test cannot fail in its own right.
//
// A connection opened through the redirect goes on reaching `landsOn` after the
// rules are gone, as one open to a target went on reaching it when they went in.
// A redirect made with `resetOpen` is undone the same way: every socket still
// addressed to a target is killed, so the node's next call opens one to it.
export async function clearOutboundRedirect(container, rules) {
  for (const rule of rules) {
    // eslint-disable-next-line no-await-in-loop
    await execInContainer(container, `iptables ${rule.replace(' OUTPUT', ' -D OUTPUT')}`);
  }
  for (const rule of rules) {
    const reset = rule.match(/-d (\S+) --dport (\d+)(?::(\d+))? -j REJECT/);
    if (!reset) continue;
    const [, toIp, low, high = low] = reset;
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(container, `ss -K dst ${toIp} '( dport >= :${low} and dport <= :${high} )'`);
    if (r.exitCode !== 0) throw new Error(`clearOutboundRedirect: could not close the connections redirected from ${toIp}: ${r.output}`);
  }
}

// FluxOS stamps every container it manages with the app it belongs to, the component
// it is, and (for a named placement) its replica. Those labels are the identity of
// record — the same ones the shutdown daemon groups by — and they are the ONLY way a
// suite can find a container from an app name: container names are built from the
// app's minted identity (sha256(name‖txid) truncated), which carries no trace of the
// name and cannot be derived from anything a suite holds.
const LABEL_APP = 'io.runonflux.app';
const LABEL_COMPONENT = 'io.runonflux.component';
const LABEL_REPLICA = 'io.runonflux.replica';
const LABEL_IDENTIFIER = 'io.runonflux.identifier';

// THE READ CAN FAIL, AND SAYS SO. `2>/dev/null || echo ""` gave a broken docker
// exec the same answer as a node with no containers on it - an empty list - so
// every caller read "the app is not running" and every wait built on one spent
// its whole budget and ended reporting only that the condition never held. A
// failed read is not an observation, and the callers that poll are built to
// retry a throw; the ones that assert have no business ruling on a look they
// never took.
export async function listAppContainers(container, { all = false } = {}) {
  const flag = all ? ' -a' : '';
  const fields = ['{{.Names}}', '{{.Status}}', '{{.Image}}',
    `{{.Label "${LABEL_APP}"}}`, `{{.Label "${LABEL_COMPONENT}"}}`,
    `{{.Label "${LABEL_REPLICA}"}}`, `{{.Label "${LABEL_IDENTIFIER}"}}`].join('\t');
  const { stdout, stderr, exitCode } = await execInContainer(container,
    `docker ps${flag} --format '${fields}'`,
  );
  if (exitCode !== 0) {
    throw new Error(`docker ps in the node container failed (exit ${exitCode}): ${(stderr || stdout || '').trim()}`);
  }
  return stdout.trim().split('\n')
    .filter((line) => line && !line.includes('NAMES'))
    .map((line) => {
      const [name, status, image, app, component, replica, identifier] = line.split('\t');
      return {
        name, status, image, app: app || null, component: component || null,
        replica: replica || null, identifier: identifier || null,
      };
    })
    .filter((c) => c.name);
}

// A bare app name matches every identity of that app; naming a replica narrows to
// exactly one, which is what co-located siblings need — they share the app label and
// differ only in the replica one.
function isAppContainer(c, appName, replica) {
  if (c.app !== appName) return false;
  return replica == null || c.replica === replica;
}

export async function isAppContainerRunning(container, appName, { replica = null } = {}) {
  const containers = await listAppContainers(container);
  return containers.some((c) => isAppContainer(c, appName, replica) && c.status?.startsWith('Up'));
}

// Every container belonging to the app on this node, across identities — the
// co-located count, which a single-container lookup cannot express.
export async function appContainersFor(container, appName, { all = false } = {}) {
  const containers = await listAppContainers(container, { all });
  return containers.filter((c) => isAppContainer(c, appName, null));
}

export async function killAppContainer(container, appName, componentName, replica = null) {
  const name = await requireAppContainerName(container, appName, componentName, replica);
  return execInContainer(container, `docker rm -f ${name}`);
}

// Remove an image from the node's LOCAL docker store. With the registry also
// down, a rebuild then has genuinely nothing to run - the state the keep-path
// (recreate-failure) tests need now that a local copy satisfies a recreate.
// -f clears the tag even while stopped containers still reference layers.
export async function removeAppImage(container, imageRef) {
  return execInContainer(container, `docker rmi -f ${imageRef}`);
}

export async function getAppContainerStatus(container, appName, { all = false, replica = null, component = null } = {}) {
  const containers = await listAppContainers(container, { all });
  return containers.find((c) => isAppContainer(c, appName, replica)
    && (component == null || c.component === component)) ?? null;
}

// The REAL docker name of one component's container, resolved through the labels.
// Container names are built from the app's minted identity, which nothing a suite holds
// can derive, so this is a lookup. Returns null when no such container exists.
async function appContainerName(container, appName, componentName, replica = null) {
  const containers = await listAppContainers(container, { all: true });
  const match = containers.find((c) => isAppContainer(c, appName, replica)
    && (componentName == null || c.component === componentName));
  return match ? match.name : null;
}

// Same, for the helpers that ACT on a container (kill, stop, exec into). Acting on an
// app that is not there is a broken assertion, not a no-op to swallow: say so.
export async function requireAppContainerName(container, appName, componentName, replica = null) {
  const name = await appContainerName(container, appName, componentName, replica);
  if (!name) {
    throw new NotPresentError(`no container on this node for app ${appName}`
      + `${componentName ? ` component ${componentName}` : ''}${replica ? ` replica ${replica}` : ''}`);
  }
  return name;
}

// The identifiers this app's containers are named from, read off the containers
// themselves. Physical artifacts — the appdata directory and its loop mount — are named
// `flux<identifier>`, which since minting contains no trace of the app's name. A
// teardown assertion therefore has to capture these WHILE the app is alive and check
// they are gone afterwards; nothing on a torn-down node can still say what to look for.
/**
 * The identifier ONE component's artifacts are named from —
 * `<component>_<identity>[_<replica>]` — read off the container's own label.
 *
 * Everything physical on the node is built from it: the container name is `flux` +
 * this, and so are the appdata directory and the syncthing folder id. None of it can
 * be spelled from the app's name, because the identity is minted at registration.
 */
export async function appComponentIdentifier(container, appName, componentName, replica = null) {
  const containers = await listAppContainers(container, { all: true });
  const match = containers.find((c) => isAppContainer(c, appName, replica)
    && (componentName == null || c.component === componentName));
  return match?.identifier ?? null;
}

/** The syncthing folder id for one component: `flux<identifier>`. */
export async function appSyncthingFolderId(container, appName, componentName, replica = null) {
  const identifier = await appComponentIdentifier(container, appName, componentName, replica);
  return identifier ? `flux${identifier}` : null;
}

export async function appComponentIdentifiers(container, appName) {
  const containers = await listAppContainers(container, { all: true });
  return containers.filter((c) => isAppContainer(c, appName, null))
    .map((c) => c.identifier).filter(Boolean);
}

// graceful stop -> the container exits 0 and stays present (not removed). Use to
// exercise restart-on-clean-exit, as opposed to killAppContainer (docker rm -f,
// which removes it -> the missing-container/recreate path).
export async function stopAppContainer(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  return execInContainer(container, `docker stop ${name}`);
}

// SIGKILL -> the container exits non-zero (137) and stays present. Use to
// exercise crash recovery / restart-on-failure.
export async function crashAppContainer(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  return execInContainer(container, `docker kill ${name}`);
}

// the actual exit code the reconciler reads from Docker (null if container absent)
export async function getAppContainerExitCode(container, appName, componentName) {
  const name = await appContainerName(container, appName, componentName);
  if (!name) return null;
  const { stdout } = await execInContainer(container,
    `docker inspect --format '{{.State.ExitCode}}' ${name} 2>/dev/null || echo ""`,
  );
  const v = stdout.trim();
  return v === '' ? null : Number(v);
}

/**
 * Bounce the inner dockerd under a running FluxOS (the dockerd-restart orphan
 * case). Kills dockerd; systemd restarts it (dockerd.service). Without --live-restore
 * this stops dockerd's containers, leaving them 'exited' for the reconnect sweep
 * to recover. Confirms dockerd actually went DOWN and came back UP, so the caller
 * can't observe a false "already ready".
 */
export async function restartDockerd(container, { readyTimeoutMs = 40000, interval = 500 } = {}) {
  await execInContainer(container, 'kill $(pidof dockerd) 2>/dev/null || true');
  const start = Date.now();
  let sawDown = false;
  while (Date.now() - start < readyTimeoutMs) {
    // an infra death voids the run - don't spend the budget proving it
    throwIfInfraDead();
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(container, 'docker info > /dev/null 2>&1');
    const up = r.exitCode === 0;
    if (!up) sawDown = true;
    if (sawDown && up) return;
    // eslint-disable-next-line no-await-in-loop
    await sleepUnlessInfraDead(interval);
  }
  throw new Error(`restartDockerd: dockerd did not cycle down and back up within ${readyTimeoutMs}ms`);
}

// The node's FluxOS runs as the fluxos unit (test-infra/systemd/fluxos.service), which
// systemd restarts whenever its process exits. A held node is one whose unit carries a
// runtime drop-in turning the restart off: its FluxOS stays down after it exits, as a
// machine does between a shutdown and its next boot, until releaseFluxos.
const FLUXOS_HOLD = '/run/systemd/system/fluxos.service.d/hold.conf';

/**
 * The pid of the node's FluxOS process, or null while it is not running.
 * @returns {Promise<number|null>}
 */
export async function fluxosPid(container) {
  const pid = Number((await execInContainer(container, 'systemctl show -p MainPID --value fluxos')).stdout.trim());
  return pid > 0 ? pid : null;
}

async function holdFluxos(container) {
  const r = await execInContainer(container,
    `mkdir -p "$(dirname ${FLUXOS_HOLD})" && printf '[Service]\nRestart=no\n' > ${FLUXOS_HOLD} && systemctl daemon-reload`);
  if (r.exitCode !== 0) throw new Error(`holdFluxos: ${r.output}`);
}

/**
 * Restart the FluxOS process only - the `systemctl restart fluxos` case. Kills just
 * FluxOS; systemd starts it again. The inner dockerd and the running app containers
 * are NOT affected - they keep running while FluxOS's in-memory state (e.g.
 * controllerDesired) is wiped. This is distinct from restartNode (whole container ->
 * dockerd + containers restart) and restartDockerd (dockerd only). Confirms FluxOS
 * went DOWN and came back UP so the caller can't observe a false "already ready".
 */
export async function restartFluxos(container, { apiPort = 16127, readyTimeoutMs = 120000, interval = 500 } = {}) {
  // hard-kill only FluxOS (state wiped instantly)
  await execInContainer(container, 'systemctl kill --kill-whom=main -s KILL fluxos');
  const probe = `curl -sf -o /dev/null http://127.0.0.1:${apiPort}/flux/version`;
  const start = Date.now();
  let sawDown = false;
  while (Date.now() - start < readyTimeoutMs) {
    // an infra death voids the run - don't spend the budget proving it
    throwIfInfraDead();
    // eslint-disable-next-line no-await-in-loop
    const r = await execInContainer(container, probe);
    const up = r.exitCode === 0;
    if (!up) sawDown = true;
    if (sawDown && up) return;
    // eslint-disable-next-line no-await-in-loop
    await sleepUnlessInfraDead(interval);
  }
  throw new Error(`restartFluxos: FluxOS did not cycle down and back up within ${readyTimeoutMs}ms`);
}

// Set the api port a node's FluxOS takes at its next start, as an operator
// changing it does. The port is read once, when FluxOS starts: restartFluxos with
// the same apiPort brings it up there.
export async function setNodeApiPort(container, apiPort) {
  const r = await execInContainer(container, `sed -i -E 's/^( *apiport:).*,$/\\1 ${Number(apiPort)},/' /flux/config/userconfig.js && grep -q 'apiport: ${Number(apiPort)},' /flux/config/userconfig.js`);
  if (r.exitCode !== 0) throw new Error(`setNodeApiPort: could not set apiport ${apiPort}: ${r.output}`);
}

// ── "Fully gone" state inspectors ──────────────────────────────────────
// The container being absent is NOT proof an app was fully torn down: the teardown
// also removes the app's cross-app docker network and umount+rm's its loop-mounted
// appdata. These inspect the real in-node state so a suite can prove FULL removal.

// The per-app docker network FluxOS creates and (only after all components detach)
// removes. Its NAME is built from the app's minted identity, which a suite cannot
// derive — so it is found by the label FluxOS stamps on it, and returns null when the
// app has no network on this node.
export async function fluxAppNetworkName(container, appName) {
  const { stdout } = await execInContainer(container,
    `docker network ls --filter label=io.runonflux.app-network=${appName} --format '{{.Name}}' 2>/dev/null || echo ""`);
  const [name] = stdout.trim().split('\n').map((s2) => s2.trim()).filter(Boolean);
  return name ?? null;
}

// Whether a docker network of this exact name exists on the node. Takes the raw
// name, so a suite can assert about networks that deliberately do NOT follow the
// per-app convention (an unattributable one the janitor must leave alone).
export async function networkExists(container, networkName) {
  const { stdout } = await execInContainer(container,
    "docker network ls --format '{{.Name}}' 2>/dev/null || echo \"\"");
  const names = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  return names.includes(networkName);
}

// The app's docker network if it still exists on this node, else null.
export async function getAppNetwork(container, appName) {
  return fluxAppNetworkName(container, appName);
}

// ── Network-detach synthesis (the network-heal suite) ─────────────────
// A live `docker network disconnect` leaves the container RUNNING with
// NetworkMode still naming its network but no endpoint on it - the stale-
// endpoint state the reconciler's network-detach heal exists for.

export async function disconnectAppNetwork(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  const network = await fluxAppNetworkName(container, appName);
  return execInContainer(container, `docker network disconnect ${network} ${name}`);
}

export async function connectAppNetwork(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  const network = await fluxAppNetworkName(container, appName);
  return execInContainer(container, `docker network connect ${network} ${name}`);
}

// The subnet of the app's docker network - capture BEFORE pruning it, so a
// restore recreates the network the recreated container's static IP fits into.
export async function getAppNetworkSubnet(container, appName) {
  const network = await fluxAppNetworkName(container, appName);
  if (!network) return null;
  const { stdout } = await execInContainer(container,
    `docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' ${network} 2>/dev/null || echo ""`);
  return stdout.trim() || null;
}

/**
 * Stop an app container and prune its network in ONE exec, and say whether that took.
 *
 * The "stopped container with no network" state is one the product actively repairs:
 * a component whose controllerDesired is `running` is restarted as soon as the
 * reconciler sees it stop, and the crash-backoff ladder starts at 0ms. Stopping from
 * the runner and then removing the network in a second call leaves a full round trip
 * for a pass to land in, and when it does, `docker network rm` fails with
 * `has active endpoints` — which does NOT mean a slow endpoint teardown. It means the
 * container is UP again. Measured: at the moment of a failing rm the container read
 * `Up 8 seconds`, and docker (24.0.7 and 29.3.1 alike) empties EndpointID the instant
 * a container stops, so there is no teardown lag to wait out.
 *
 * Both halves therefore go to the node in a single command, leaving no round trip
 * between them. The caller still has to check: this is a transient state being
 * sampled, not a stable one being set, so a lost race is reported rather than hidden.
 *
 * @returns {Promise<{ok: boolean, output: string}>} ok when the network is gone.
 */
export async function stopAndPruneAppNetwork(container, appName, componentName) {
  const name = await requireAppContainerName(container, appName, componentName);
  const network = await fluxAppNetworkName(container, appName);
  if (!network) return { ok: true, output: 'no network present' };
  const res = await execInContainer(container,
    `docker stop ${name} >/dev/null 2>&1; docker network rm ${network}`);
  return { ok: res.exitCode === 0, output: (res.output ?? '').trim() };
}

export async function removeAppNetworkRaw(container, appName) {
  const network = await fluxAppNetworkName(container, appName);
  return execInContainer(container, `docker network rm ${network}`);
}

// Create a network under an exact name - for the networks a suite needs docker to
// hold that FluxOS would never mint itself.
export async function createNetworkNamed(container, networkName, subnet) {
  const subnetFlag = subnet ? ` --subnet ${subnet}` : '';
  return execInContainer(container, `docker network create${subnetFlag} ${networkName}`);
}

// Recreates the network a suite just destroyed, under the SAME name it had — the
// caller captured it while the app was alive, because the name is built from the
// app's identity and nothing on the node can restate it once the network is gone.
export async function createAppNetworkRaw(container, networkName, subnet) {
  return createNetworkNamed(container, networkName, subnet);
}

// Docker's container ID: survives nothing - a recreate mints a new one - so ID
// equality across a window proves the container was never touched.
// The container's docker id, which is what distinguishes a container that was
// REPLACED from one that was merely restarted: a redeploy removes and recreates,
// so the id changes, while a restart keeps it. Status and image name are equal
// either way, so neither can tell the two apart. null if the container is absent.
export async function getAppContainerId(container, appName, componentName) {
  const name = await appContainerName(container, appName, componentName);
  if (!name) return null;
  const { stdout } = await execInContainer(container,
    `docker inspect --format '{{.Id}}' ${name} 2>/dev/null || echo ""`);
  return stdout.trim() || null;
}

// Whether the container holds an endpoint (with an IP) on its OWN app network -
// the same fact dockerService.classifyContainerNetworkAttachment reads.
export async function getAppContainerAttachment(container, appName, componentName) {
  const net = await fluxAppNetworkName(container, appName);
  if (!net) return { attached: false, ip: null };
  const name = await appContainerName(container, appName, componentName);
  if (!name) return { attached: false, ip: null };
  const { stdout } = await execInContainer(container,
    `docker inspect --format '{{with index .NetworkSettings.Networks "${net}"}}{{.IPAddress}}{{end}}' ${name} 2>/dev/null || echo ""`);
  const ip = stdout.trim();
  return { attached: !!ip, ip: ip || null };
}

// The node's flux appdata root (harness FLUX_APPS_FOLDER). Per-component appdata lives at
// <root>/flux<identifier>, loop-mounted then umount+rm -rf'd by the teardown.
const APPDATA_ROOT = '/mnt/appdata/flux-apps';

// Still-present appdata artifacts for an app: live loop mounts and/or leftover
// directories under the appdata root. Both empty => the volume is fully torn down
// (unmounted AND removed).
//
// Keyed on the app's component IDENTIFIERS, which the caller captures while the app is
// alive (appComponentIdentifiers). The directories are named `flux<identifier>`, built
// from the app's minted identity, so only an identifier finds them; the app's name
// appears nowhere in the path.
export async function getAppVolumeArtifacts(container, appName, { identifiers } = {}) {
  if (!Array.isArray(identifiers)) {
    throw new Error(`getAppVolumeArtifacts(${appName}) needs the app's component identifiers, `
      + 'captured with appComponentIdentifiers() while the app was still installed: appdata '
      + 'directories are named from the app identity and never from its name');
  }
  const lines = (out) => out.trim().split('\n').map((x) => x.trim()).filter(Boolean);
  const mounts = [];
  const dirs = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const identifier of identifiers) {
    // eslint-disable-next-line no-await-in-loop
    const { stdout: m } = await execInContainer(container,
      `mount 2>/dev/null | grep -F '${APPDATA_ROOT}/' | grep -F 'flux${identifier}' || true`);
    // eslint-disable-next-line no-await-in-loop
    const { stdout: d } = await execInContainer(container,
      `ls -1 ${APPDATA_ROOT} 2>/dev/null | grep -F 'flux${identifier}' || true`);
    mounts.push(...lines(m));
    dirs.push(...lines(d));
  }
  return { mounts, dirs };
}

// True when NOTHING of the app remains on this node: no container, no docker network,
// no appdata mount or directory. The single "fully torn down" predicate.
//
// The identifiers are what make the volume half real, so they are required — see
// getAppVolumeArtifacts. Capture them before the teardown that is under test.
export async function isAppFullyGone(container, appName, { identifiers } = {}) {
  if (await getAppContainerStatus(container, appName, { all: true })) return false;
  if (await getAppNetwork(container, appName)) return false;
  const { mounts, dirs } = await getAppVolumeArtifacts(container, appName, { identifiers });
  return mounts.length === 0 && dirs.length === 0;
}

// ── Content bind-mount inspectors ──────────────────────────────────────
// Read/stat a path INSIDE an app container (the node is the DinD host, so this is
// `docker exec <appContainer> ...`). Inspected components run the static-busybox
// fixture (registry-helper.pushBusybox) — the harness's other fixtures (/bin/pause,
// /bin/test-app) are freestanding with no coreutils — so commands go via /bin/busybox.

export { appContainerName };

export async function readFileInContainer(container, appName, componentName, path) {
  const name = await appContainerName(container, appName, componentName);
  // An absent container reads as a failed exec, so a suite asserting on exitCode gets a
  // failure rather than an exception.
  if (!name) return { content: '', exitCode: 1 };
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} /bin/busybox cat ${path}`);
  return { content: stdout, exitCode };
}

// Owner/perms of an injected file as the node wrote them. Injected content defaults
// to root:root 0444; data/appdata/component dirs stay 777.
export async function statFileInContainer(container, appName, componentName, path) {
  const name = await requireAppContainerName(container, appName, componentName);
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} /bin/busybox stat -c '%u %g %a' ${path}`);
  const [uid, gid, mode] = stdout.trim().split(/\s+/);
  return { uid, gid, mode, exitCode };
}

// The inode of a path inside the container — for the atomic-swap check (a managed
// atomic delivery changes the inode under /io.runonflux/; an in-place single-file
// bind keeps the same inode). Returns null when absent.
export async function inodeInContainer(container, appName, componentName, path) {
  const name = await appContainerName(container, appName, componentName);
  if (!name) return null;
  const { stdout, exitCode } = await execInContainer(container, `docker exec ${name} /bin/busybox stat -c '%i' ${path} 2>/dev/null || echo ""`);
  const v = stdout.trim();
  return exitCode === 0 && v !== '' ? Number(v) : null;
}

// ROOT gate: confirm the FluxOS process runs as uid 0 and root file ops (the
// chown root:root + chmod 0444 every injected content write does) succeed on the
// appdata volume. Run in the first content suite's boot before any content assertion;
// if the node isn't root in the DinD container, every injected write fails silently.
export async function assertNodeRunsAsRoot(container) {
  const uidRes = await execInContainer(container, "awk '/^Uid:/{print $2}' /proc/\"$(cat /tmp/fluxos.pid)\"/status 2>/dev/null || echo unknown");
  const probe = await execInContainer(container, 'f=/mnt/appdata/.e2e-roottest; touch "$f" && chown root:root "$f" && chmod 0444 "$f" && stat -c \'%u %g %a\' "$f"; rc=$?; rm -f "$f"; exit $rc');
  return { fluxosUid: uidRes.stdout.trim(), rootOpsOk: probe.exitCode === 0, statLine: probe.stdout.trim() };
}

export async function getContainerImageDigest(container, appName, componentName) {
  const containerName = await appContainerName(container, appName, componentName);
  if (!containerName) return null;
  const { stdout } = await execInContainer(container,
    `docker image inspect $(docker inspect --format '{{.Image}}' ${containerName}) --format '{{index .RepoDigests 0}}'`,
  );
  const match = stdout.trim().match(/@(sha256:[a-f0-9]+)$/);
  return match ? match[1] : null;
}

// A graceful system shutdown of one node's FluxOS, as systemd performs it: the
// shutdown marker FluxOS checks for is put in place, the process is sent
// SIGTERM, and this returns once it has exited. The marker is removed again
// after the exit, so the next FluxOS on this node boots as usual.
//
// `hold` keeps the node down after the exit, as a machine stays down between a
// shutdown and its next boot; releaseFluxos brings it back. `stopSyncthingAfter`
// stops the node's own syncthing the moment FluxOS exits, which is what the OS
// does next on an Arcane node - for a node booted with syncthing: 'binary'.
//
// @returns {Promise<{pid: number, exitedAt: number}>} the process that shut down,
//   and when this saw it gone (ms)
export async function shutdownFluxosGracefully(container, {
  hold = false, stopSyncthingAfter = false, exitTimeoutMs = 120000, interval = 250,
} = {}) {
  const pid = await fluxosPid(container);
  if (!pid) throw new Error('shutdownFluxosGracefully: FluxOS is not running');
  if (hold) await holdFluxos(container);
  await execInContainer(container, 'touch /run/nologin');
  if (stopSyncthingAfter) {
    // Inside the node, so the daemon stops within a poll of the exit rather than
    // a docker exec round trip later.
    const watcher = await execInContainer(container,
      `setsid sh -c 'while kill -0 ${pid} 2>/dev/null; do sleep 0.05; done; pkill -x syncthing' >/dev/null 2>&1 </dev/null &`);
    if (watcher.exitCode !== 0) throw new Error(`shutdownFluxosGracefully: could not arm the syncthing stop: ${watcher.output}`);
  }
  const signalled = await execInContainer(container, `kill -TERM ${pid}`);
  if (signalled.exitCode !== 0) throw new Error(`shutdownFluxosGracefully: could not signal ${pid}: ${signalled.output}`);
  const start = Date.now();
  let exitedAt = null;
  try {
    while (Date.now() - start < exitTimeoutMs) {
      throwIfInfraDead();
      // eslint-disable-next-line no-await-in-loop
      const alive = await execInContainer(container, `kill -0 ${pid} 2>/dev/null`);
      if (alive.exitCode !== 0) {
        exitedAt = Date.now();
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleepUnlessInfraDead(interval);
    }
    if (exitedAt === null) throw new Error(`shutdownFluxosGracefully: FluxOS ${pid} still running ${exitTimeoutMs}ms after SIGTERM`);
    // The daemon is down too before this returns: a syncthing still exiting holds
    // its lock, and one started now cannot take it.
    while (stopSyncthingAfter && Date.now() - start < exitTimeoutMs) {
      throwIfInfraDead();
      // eslint-disable-next-line no-await-in-loop
      const running = await execInContainer(container, 'pgrep -x syncthing >/dev/null');
      if (running.exitCode !== 0) return { pid, exitedAt };
      // eslint-disable-next-line no-await-in-loop
      await sleepUnlessInfraDead(interval);
    }
    if (stopSyncthingAfter) throw new Error(`shutdownFluxosGracefully: syncthing still running ${exitTimeoutMs}ms after SIGTERM to FluxOS`);
    return { pid, exitedAt };
  } finally {
    await execInContainer(container, 'rm -f /run/nologin');
  }
}

// Bring back a node held down by shutdownFluxosGracefully({ hold: true }), and
// wait for its API to answer.
export async function releaseFluxos(container, { apiPort = 16127, readyTimeoutMs = 120000, interval = 500 } = {}) {
  const released = await execInContainer(container,
    `rm -f ${FLUXOS_HOLD} && systemctl daemon-reload && systemctl reset-failed fluxos; systemctl start fluxos`);
  if (released.exitCode !== 0) throw new Error(`releaseFluxos: ${released.output}`);
  const probe = `curl -sf -o /dev/null http://127.0.0.1:${apiPort}/flux/version`;
  const start = Date.now();
  while (Date.now() - start < readyTimeoutMs) {
    throwIfInfraDead();
    // eslint-disable-next-line no-await-in-loop
    if ((await execInContainer(container, probe)).exitCode === 0) return;
    // eslint-disable-next-line no-await-in-loop
    await sleepUnlessInfraDead(interval);
  }
  throw new Error(`releaseFluxos: FluxOS did not answer within ${readyTimeoutMs}ms`);
}

// Drop every packet between this node and each peer on one port, TCP and UDP,
// in both directions and whichever side dialled - a link that is up but carries
// nothing for that service. The syncthing port is apiport+2, and syncthing
// listens on it for both TCP and QUIC.
function trafficRules(peerIp, port) {
  return ['tcp', 'udp'].flatMap((proto) => [
    `INPUT -p ${proto} -s ${peerIp} --dport ${port} -j DROP`,
    `INPUT -p ${proto} -s ${peerIp} --sport ${port} -j DROP`,
    `OUTPUT -p ${proto} -d ${peerIp} --dport ${port} -j DROP`,
    `OUTPUT -p ${proto} -d ${peerIp} --sport ${port} -j DROP`,
  ]);
}

export async function blockTraffic(container, peerIps, port) {
  for (const peerIp of peerIps) {
    for (const rule of trafficRules(peerIp, port)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await execInContainer(container, `iptables -I ${rule}`);
      if (r.exitCode !== 0) throw new Error(`blockTraffic: could not add '${rule}': ${r.output}`);
    }
  }
  return peerIps;
}

// Undo blockTraffic. Tolerates a rule that is already gone.
export async function unblockTraffic(container, peerIps, port) {
  for (const peerIp of peerIps) {
    for (const rule of trafficRules(peerIp, port)) {
      // eslint-disable-next-line no-await-in-loop
      await execInContainer(container, `iptables -D ${rule}`);
    }
  }
}

// The IP the node's userconfig.js names as its own.
export async function configuredIpOf(container) {
  const r = await execInContainer(container, `node -p "require('/flux/config/userconfig.js').initial.ipaddress"`);
  if (r.exitCode !== 0) throw new Error(`configuredIpOf: could not read userconfig.js: ${r.output}`);
  return r.stdout.trim();
}

// A crash of one node's FluxOS: the process is killed outright, with no
// shutdown handling at all. `hold` keeps the node down afterwards, as a machine
// that lost power stays down; releaseFluxos brings it back.
export async function crashFluxos(container, { hold = false, exitTimeoutMs = 30000, interval = 250 } = {}) {
  const pid = await fluxosPid(container);
  if (!pid) throw new Error('crashFluxos: FluxOS is not running');
  if (hold) await holdFluxos(container);
  await execInContainer(container, `kill -9 ${pid}`);
  const start = Date.now();
  while (Date.now() - start < exitTimeoutMs) {
    throwIfInfraDead();
    // eslint-disable-next-line no-await-in-loop
    if ((await execInContainer(container, `kill -0 ${pid} 2>/dev/null`)).exitCode !== 0) return { pid };
    // eslint-disable-next-line no-await-in-loop
    await sleepUnlessInfraDead(interval);
  }
  throw new Error(`crashFluxos: FluxOS ${pid} still running ${exitTimeoutMs}ms after SIGKILL`);
}

// A command as a legacy node's operator runs pm2: as their account, against their pm2
// home (test-infra/systemd/pm2-fluxuser.service).
export const AS_PM2_OPERATOR = 'runuser -u fluxuser -- env PM2_HOME=/home/fluxuser/.pm2';
const PM2 = `${AS_PM2_OPERATOR} pm2`;

// The kill timeout of FluxOS's pm2 registration on a legacy node whose FluxOS
// pm2 runs (createTestEnv pm2Nodes), as the daemon holds it and as `pm2 save`
// stored it for the next boot. null where pm2 has none, which is its default.
//
// @returns {Promise<{live: number|null, saved: number|null, restarts: number}>}
export async function pm2Registration(container) {
  const jlist = await execInContainer(container, `${PM2} jlist`);
  if (jlist.exitCode !== 0) throw new Error(`pm2Registration: pm2 jlist failed: ${jlist.output}`);
  const live = JSON.parse(jlist.stdout.trim()).find((p) => p.name === 'flux');
  if (!live) throw new Error('pm2Registration: pm2 lists no process named flux');
  const dump = await execInContainer(container, 'cat /home/fluxuser/.pm2/dump.pm2 2>/dev/null || echo "[]"');
  const saved = JSON.parse(dump.stdout.trim()).find((p) => p.name === 'flux');
  return {
    live: live.pm2_env.kill_timeout ?? null,
    saved: saved?.kill_timeout ?? null,
    restarts: live.pm2_env.restart_time,
  };
}

// A system shutdown of a legacy node whose FluxOS pm2 runs (createTestEnv
// pm2Nodes): the shutdown marker FluxOS checks for is put in place and pm2
// stops FluxOS, as the OS stops pm2 on its way down. pm2 returns once FluxOS
// has exited or its kill timeout has run out, whichever is first.
// `stopSyncthingAfter` then stops the node's syncthing, as the rest of the
// shutdown does: FluxOS started it outside pm2's process tree, so pm2 leaves it.
//
// @returns {Promise<{stopMs: number}>} how long pm2 took to report FluxOS stopped
export async function shutdownFluxosUnderPm2(container, { stopSyncthingAfter = false } = {}) {
  await execInContainer(container, 'touch /run/nologin');
  try {
    const started = Date.now();
    const stopped = await execInContainer(container, `${PM2} stop flux`);
    const stopMs = Date.now() - started;
    if (stopped.exitCode !== 0) throw new Error(`shutdownFluxosUnderPm2: pm2 stop failed: ${stopped.output}`);
    if (stopSyncthingAfter) await execInContainer(container, 'pkill -KILL -x syncthing; true');
    return { stopMs };
  } finally {
    await execInContainer(container, 'rm -f /run/nologin');
  }
}

// Start FluxOS again through pm2 on a node shut down by shutdownFluxosUnderPm2,
// and wait for its API to answer.
export async function startFluxosUnderPm2(container, { apiPort = 16127, readyTimeoutMs = 180000, interval = 1000 } = {}) {
  const started = await execInContainer(container, `${PM2} start flux`);
  if (started.exitCode !== 0) throw new Error(`startFluxosUnderPm2: pm2 start failed: ${started.output}`);
  const probe = `curl -sf -o /dev/null http://127.0.0.1:${apiPort}/flux/version`;
  const start = Date.now();
  while (Date.now() - start < readyTimeoutMs) {
    throwIfInfraDead();
    // eslint-disable-next-line no-await-in-loop
    if ((await execInContainer(container, probe)).exitCode === 0) return;
    // eslint-disable-next-line no-await-in-loop
    await sleepUnlessInfraDead(interval);
  }
  throw new Error(`startFluxosUnderPm2: FluxOS did not answer within ${readyTimeoutMs}ms`);
}
