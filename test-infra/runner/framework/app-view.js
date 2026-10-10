// One app as each node of a fleet holds it: its registry row, its installed
// record and its container. A row and a record each carry the hash of the
// message they stand on, which is what a suite compares across nodes.
import { execInContainer, getAppContainerId, getAppContainerStatus } from './container.js';
import { waitFor } from './wait.js';

/**
 * @param {object} env - the test environment
 * @param {string} name - the app's name
 * @param {{component?: string, timeout?: number}} [options] - the component a
 *   container read names (the app's name for a v8 app, `web` for the harness's
 *   v9 apps), and how long a convergence wait is given
 */
export function appView(env, name, { component = name, timeout = 240000 } = {}) {
  // The node's registry row, from the route that carries the row's hash.
  async function listedOn(index) {
    const res = await fetch(`${env.clients[index].url}/apps/globalappsspecifications?appname=${encodeURIComponent(name)}`);
    const body = await res.json();
    return body.status === 'success' && Array.isArray(body.data) ? body.data[0] ?? null : null;
  }

  async function installedOn(index) {
    const res = await env.clients[index].getInstalledApps();
    if (res.status !== 'success') return null;
    return (res.data ?? []).find((a) => a.name === name) ?? null;
  }

  // The component's container on a node: its id, which a recreate changes, when
  // it last started, which a restart changes, and whether it runs.
  async function containerOn(index) {
    const { container } = env.clients[index];
    const status = await getAppContainerStatus(container, name).catch(() => null);
    const id = await getAppContainerId(container, name, component).catch(() => null);
    let startedAt = null;
    if (status?.name) {
      const { stdout } = await execInContainer(container, `docker inspect --format '{{.State.StartedAt}}' ${status.name}`);
      startedAt = stdout.trim() || null;
    }
    return {
      id, startedAt, running: Boolean(status?.status?.startsWith('Up')), status: status?.status ?? null,
    };
  }

  async function runningCount() {
    const states = await Promise.all(env.clients.map((c, i) => (c ? containerOn(i).catch(() => null) : null)));
    return states.filter((s) => s?.running).length;
  }

  async function installedEverywhere(hash, indices, label) {
    await waitFor(async () => {
      const held = await Promise.all(indices.map((i) => installedOn(i)));
      return held.every((app) => app?.hash === hash);
    }, { timeout, interval: 3000, label: `${name}: ${label}` });
  }

  async function listedEverywhere(hash, indices, label) {
    await waitFor(async () => {
      const rows = await Promise.all(indices.map((i) => listedOn(i)));
      return rows.every((row) => row?.hash === hash);
    }, { timeout, interval: 3000, label: `${name}: ${label}` });
  }

  return {
    listedOn, installedOn, containerOn, runningCount, installedEverywhere, listedEverywhere,
  };
}
