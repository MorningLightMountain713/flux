import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const confFixturesDir = join(__dirname, '..', '..', 'fixtures', 'conf');

// A node decides PER TOPIC whether to take the daemon's push stream or to poll for
// itself, and it decides it from these keys in fluxd's own config file
// (daemonSubscriptionService.isTopicAvailable). The topic set is therefore per node and
// per suite, which one committed fixture cannot express: the conf is rendered from the
// fixture at boot and bind-mounted over it, leaving FLUXD_CONFIG_PATH untouched.
//
// hashblock is not a topic anything subscribes to. It is the key that answers "does
// this daemon do zmq at all" for the node's own reporting, and it is written alongside
// the rest on a real node, so the default set carries it too.
export const ZMQ_CONF_TOPICS = ['hashblock', 'hashblockheight', 'chainreorg', 'fluxnodelistdelta', 'fluxnodestatus'];

// fluxnodestatus is left out of the default: it carries ONE node's own
// deterministic-list state, and the harness runs a single daemon stub for the whole
// fleet, so publishing it would tell every node it is the same node. A suite that wants
// that path asks for it — in practice on a one-node fleet — and drives it with
// daemon-control's publishZmq.
export const DEFAULT_ZMQ_TOPICS = ['hashblock', 'hashblockheight', 'chainreorg', 'fluxnodelistdelta'];

/**
 * Writes one node's fluxd.conf: the committed fixture, with its zmqpub keys replaced by
 * the topic set asked for.
 * @param {string} num Node number, zero-padded ('01').
 * @param {Array<string>} topics Topics this node's daemon publishes; empty for a daemon
 *   that publishes nothing, which puts every consumer on its polling path.
 * @param {string} dir Directory to render into.
 * @returns {string} Path to the rendered file.
 */
export function renderFluxdConf(num, topics, dir) {
  const unknown = topics.filter((topic) => !ZMQ_CONF_TOPICS.includes(topic));
  if (unknown.length) {
    throw new Error(`Unknown zmq topic(s) ${unknown.join(', ')} — expected from ${ZMQ_CONF_TOPICS.join(', ')}`);
  }

  const fixture = readFileSync(join(confFixturesDir, `flux-${num}.conf`), 'utf-8');
  const base = fixture
    .split('\n')
    .filter((line) => !line.trim().startsWith('zmqpub'))
    .join('\n')
    .trimEnd();
  // The address is where the publisher binds, which is every interface of the daemon
  // stub's container. The address a node dials comes from its own config
  // (daemon.host + daemon.zmqport), not from here — this file only says which topics
  // exist.
  const published = topics.map((topic) => `zmqpub${topic}=tcp://0.0.0.0:16123`).join('\n');

  const rendered = join(dir, `flux-${num}.conf`);
  writeFileSync(rendered, `${base}\n${published}${published ? '\n' : ''}`);
  return rendered;
}
