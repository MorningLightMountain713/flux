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

// Every topic the stub can publish, and what a suite asks for to put a fleet on push.
// fluxnodestatus is absent: it carries ONE node's own deterministic-list state, and on
// the shared publisher every node would be told it is the same node. Ask for
// ALL_ZMQ_TOPICS_WITH_STATUS instead, which pairs it with the per-node publishers.
export const ALL_ZMQ_TOPICS = ['hashblock', 'hashblockheight', 'chainreorg', 'fluxnodelistdelta'];

// The whole set, own-status included. Requires perNodeZmq: a node addressed on its own
// socket is the only way this topic means anything, since its payload is about the
// receiver rather than about the chain.
export const ALL_ZMQ_TOPICS_WITH_STATUS = [...ALL_ZMQ_TOPICS, 'fluxnodestatus'];

// Per-node publisher ports. The shared publisher on 16123 stays exactly as it is — every
// suite that does not ask for per-node sockets is untouched — and node N additionally
// gets its own socket here, clear of the stub's RPC ports (16124/16224) and its control
// port (18232). Fleet-wide topics are fanned out to every socket, so a node dialling its
// own port still sees the whole chain; only own-status is addressed to one.
export const ZMQ_NODE_PORT_BASE = 17123;
export const zmqNodePort = (num) => ZMQ_NODE_PORT_BASE + Number(num);

// What a fleet publishes unless a suite asks otherwise: nothing. Every suite written
// before the stub could publish was validated against the polling path, and turning the
// whole gate over to push as a side effect of adding a publisher would mean any failure
// could be the suite or could be the switch. Suites that exercise the subscriptions ask
// for ALL_ZMQ_TOPICS; the fleet default moves once the gate has run green with it.
export const DEFAULT_ZMQ_TOPICS = [];

/**
 * Writes one node's fluxd.conf: the committed fixture, with its zmqpub keys replaced by
 * the topic set asked for.
 * @param {string} num Node number, zero-padded ('01').
 * @param {Array<string>} topics Topics this node's daemon publishes; empty for a daemon
 *   that publishes nothing, which puts every consumer on its polling path.
 * @param {string} dir Directory to render into.
 * @returns {string} Path to the rendered file.
 */
export function renderFluxdConf(num, topics, dir, port = 16123) {
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
  const published = topics.map((topic) => `zmqpub${topic}=tcp://0.0.0.0:${port}`).join('\n');

  const rendered = join(dir, `flux-${num}.conf`);
  writeFileSync(rendered, `${base}\n${published}${published ? '\n' : ''}`);
  return rendered;
}
