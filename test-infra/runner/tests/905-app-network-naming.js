// weight: heavy
import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import { createTestEnv } from '../framework/test-env.js';
import { bootAndPeer } from '../framework/reconciler-suite.js';
import { registerEncryptedV9App } from '../framework/content-helper.js';
import { queueAppTx, advanceBlocks } from '../framework/daemon-control.js';
import { waitFor, waitForAppInstalled } from '../framework/wait.js';
import { getAppContainerStatus, execInContainer, requireAppContainerName } from '../framework/container.js';
import { pushBusybox } from '../framework/registry-helper.js';
import { REGISTRY_REPO_HOST, getSubnetConfig } from '../framework/subnet-config.js';

const subnet = getSubnetConfig();
const nodeIp = (num) => subnet.nodeIp(num);

// What one app calls another (APP_NETWORK_NAMING.md). A container's docker name is
// built from the app's minted identity, which does not exist when a spec is written
// and changes on re-registration, so it can never be the address an author writes.
// These four names can be, and this suite is the proof that each resolves to exactly
// the container it names, on a real fleet, for both app shapes:
//
//   <component>                      any instance, for siblings inside one app
//   <replica>.<component>            one replica, inside one app
//   <component>.<appname>            any instance, from another app
//   <replica>.<component>.<appname>  one replica, from another app
//
// The rule the whole scheme rests on is that a container attached to ANOTHER app's
// network claims only the qualified forms there — so linking two apps that both have
// a `web` cannot make either one's short name ambiguous. Unit tests cannot prove
// that: it is a property of docker's resolver, of alias scoping, and of which network
// a container was created on. Hence a fleet.
//
// Every reply is the answering container's HOSTNAME, so an assertion names the
// container that actually answered rather than merely proving something did.
//
// nodes:3, minOutgoing/minIncoming 1, arcane so the policy grant opens
// appRelationships (bit 24) and its networkSharing child and nodes accept encrypted
// v9 apps. Everything is pinned to node 1 — the naming is node-local, and co-locating
// the pair is what puts a shared network under test at all. Port slice: 31290-31294.

const HOST_IDX = 0;

describe('app network naming: what one app calls another', function () {
  let env;
  const base = `e2enam${Date.now()}`;
  const apps = {
    // two components, so a sibling has something to address
    host: `${base}host`,
    // its own `web`, deliberately colliding with the host app's component name
    guest: `${base}guest`,
  };

  // Answers with its own hostname, which is `<replica>_<component>` — so the reply
  // identifies the exact container, and the hostname itself is under test.
  function echoHostname(imageApp, hostPort) {
    return {
      image: `${REGISTRY_REPO_HOST}/${imageApp}:v1`,
      cpu: 0.4,
      memory: 250,
      rootFsGb: 2,
      entrypoint: ['/bin/busybox', 'sh', '-c',
        'while true; do /bin/busybox nc -l -p 8080 -e /bin/busybox hostname; done'],
      ports: { echo: { containerPort: 8080, hostPort } },
    };
  }

  async function registerApp(name, { components, assignment, specOverrides }) {
    await pushBusybox(name);
    const res = await registerEncryptedV9App(env.clients[0].url, {
      name, instances: 1, assignment, specOverrides, components,
    });
    expect(res.status, `register ${name}: ${JSON.stringify(res)}`).to.equal('success');
    await queueAppTx(res.data);
  }

  // Dial a name FROM one container and return who answered. The container resolves the
  // name itself, which is the whole point — no lookup tool, no resolver assumptions.
  async function dialFrom(appName, componentName, replica, target) {
    const from = await requireAppContainerName(
      env.clients[HOST_IDX].container, appName, componentName, replica,
    );
    const { stdout } = await execInContainer(
      env.clients[HOST_IDX].container,
      `docker exec ${from} /bin/busybox nc -w 5 ${target} 8080`,
    );
    return stdout.trim();
  }

  async function waitRunning(appName, componentName, replica, label) {
    await waitFor(async () => {
      const status = await getAppContainerStatus(
        env.clients[HOST_IDX].container, appName, { replica },
      );
      return status?.status?.startsWith('Up') === true;
    }, { timeout: 300000, interval: 5000, label });
  }

  before(async function () {
    this.timeout(1500000);
    env = await createTestEnv({
      hookCtx: this,
      nodes: 3,
      tickerAutostart: false,
      arcane: true,
      configOverrides: { fluxapps: { minOutgoing: 1, minIncoming: 1 } },
    });
    await bootAndPeer(env, { minOutbound: 1, minInbound: 1, pricing: true });

    // The host app: two components, two named replicas, all on one node. Both
    // replicas of both components exist, which is what makes `web` ambiguous by
    // construction and `s1.web` the only way to name one.
    await registerApp(apps.host, {
      assignment: { targetIps: { [nodeIp(HOST_IDX + 1)]: ['s1', 's2'] } },
      components: {
        web: {
          name: 'web', description: 'host web', ...echoHostname(apps.host, 31290),
          replicaOverrides: { s2: { ports: { echo: { hostPort: 31291 } } } },
        },
        db: {
          name: 'db', description: 'host db', ...echoHostname(apps.host, 31292),
          replicaOverrides: { s2: { ports: { echo: { hostPort: 31293 } } } },
        },
      },
    });

    // The guest: its own component is ALSO called `web`, and it links to the host
    // app's network. If the scheme is wrong, one of these two shadows the other.
    await registerApp(apps.guest, {
      assignment: { targetIps: { [nodeIp(HOST_IDX + 1)]: ['g1'] } },
      specOverrides: {
        dependencies: {
          [apps.host]: { network: true, onRemove: 'detach' },
        },
      },
      components: { web: { name: 'web', description: 'guest web', ...echoHostname(apps.guest, 31294) } },
    });
    await advanceBlocks(3);

    await waitForAppInstalled(env.clients[HOST_IDX], apps.host, 600000);
    await waitForAppInstalled(env.clients[HOST_IDX], apps.guest, 600000);
    await waitRunning(apps.host, 'web', 's1', 'host web s1 running');
    await waitRunning(apps.host, 'web', 's2', 'host web s2 running');
    await waitRunning(apps.host, 'db', 's1', 'host db s1 running');
    await waitRunning(apps.guest, 'web', 'g1', 'guest web running');
  });

  it('a sibling component answers to its bare name, inside one app', async function () {
    this.timeout(300000);
    // The compose convention: `db` from `web`, no qualification, no knowledge of the
    // app's own name. Either replica may answer — both are `db`.
    const answered = await dialFrom(apps.host, 'web', 's1', 'db');
    expect(answered, 'a db replica answered the bare component name').to.be.oneOf(['s1_db', 's2_db']);
  });

  it('a replica answers to <replica>.<component>, and only that one', async function () {
    this.timeout(300000);
    expect(await dialFrom(apps.host, 'web', 's1', 's2.db'), 's2.db is s2, never s1').to.equal('s2_db');
    expect(await dialFrom(apps.host, 'web', 's1', 's1.db'), 's1.db is s1, never s2').to.equal('s1_db');
  });

  it('another app reaches it by <component>.<appname>', async function () {
    this.timeout(300000);
    // The address a spec author can write for a dependency: the guest holds only the
    // host's NAME, which is all it can know.
    const answered = await dialFrom(apps.guest, 'web', 'g1', `web.${apps.host}`);
    expect(answered, 'a host web replica answered').to.be.oneOf(['s1_web', 's2_web']);
  });

  it('another app reaches ONE replica by <replica>.<component>.<appname>', async function () {
    this.timeout(300000);
    expect(
      await dialFrom(apps.guest, 'web', 'g1', `s2.web.${apps.host}`),
      'the fully qualified name names exactly one container',
    ).to.equal('s2_web');
  });

  // The rule the scheme rests on, in both directions. Two apps, both with a `web`,
  // sharing a network: neither may capture the other's bare name.
  it('a linked app does not shadow its host\'s bare component name', async function () {
    this.timeout(300000);
    const answered = await dialFrom(apps.host, 'web', 's1', 'web');
    expect(answered, 'the host app\'s own web answers `web` on its own network')
      .to.be.oneOf(['s1_web', 's2_web']);
  });

  it('and the host does not shadow the linked app\'s bare component name', async function () {
    this.timeout(300000);
    // The guest is attached to the host's network, where two containers claim `web`.
    // Its own network is its primary attachment, so its own component still wins.
    const answered = await dialFrom(apps.guest, 'web', 'g1', 'web');
    expect(answered, 'the guest\'s own web answers `web`, not the host\'s').to.equal('g1_web');
  });
});
