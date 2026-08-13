# The Flux mesh — the app developer's API

Setting `network.mesh: true` on a v9 app gives every instance of that app a
private encrypted overlay network across all the nodes that run it, with
DNS-based service discovery, stable member identities, and a membership API.
The point of the mesh is that clustered software — databases, consensus
stores, gossip systems — runs on Flux **without an orchestrator in front**:
the mesh provides discovery and identity; your image provides the
cluster-specific commands, usually as a few lines of its entrypoint.

This document is the complete surface an app developer programs against.

## Table of Contents

1. [Enabling the mesh](#enabling-the-mesh)
2. [What every mesh container gets](#what-every-mesh-container-gets)
3. [DNS — names and discovery](#dns--names-and-discovery)
4. [meshPorts — SRV-advertised cluster ports](#meshports--srv-advertised-cluster-ports)
5. [Ordinal slots — stable member identity](#ordinal-slots--stable-member-identity)
6. [The membership level API](#the-membership-level-api)
7. [The founder ask — founding exactly once](#the-founder-ask--founding-exactly-once)
8. [Gossip vs consensus — what your software needs](#gossip-vs-consensus--what-your-software-needs)
9. [Rules that keep your cluster safe](#rules-that-keep-your-cluster-safe)

---

## Enabling the mesh

```jsonc
{
  "version": 9,
  "instances": 3,
  "network": { "mesh": true },
  "components": {
    "db": {
      // published ports work as always; meshPorts are the mesh addition (§4)
      "ports":     { "metrics": { "containerPort": 8080, "hostPort": 33001 } },
      "meshPorts": { "db-server": { "containerPort": 7001 } }
    }
  }
}
```

Mesh apps run on ArcaneOS nodes only. Every instance of the app peers with
every other instance over an encrypted overlay; the overlay firewall is
port-any **between members**, so members reach each other's ports without
publishing them. Nothing outside the app can reach the overlay, and apps
cannot reach each other's overlays — isolation is enforced at the
certificate, firewall, and DNS layers.

---

## What every mesh container gets

Environment, set at container creation and **fixed for the container's
lifetime**:

| Variable | Example | Meaning |
|---|---|---|
| `FLUX_MESH_APP` | `myblog` | the app name |
| `FLUX_MESH_SELF` | `db-1` | this member's canonical name (see [slots](#ordinal-slots--stable-member-identity)) |
| `FLUX_MESH_SELF_FQDN` | `db-1.myblog.mesh.flux` | the name to ADVERTISE — the one stable mesh-wide identifier |
| `FLUX_MESH_ORDINAL` | `1` | the raw slot number (absent on a standby) |
| `FLUX_MESH_SELF_IP` | `10.127.0.7` | this container's own presented address (node-local — see the rules) |

The container's **hostname is the member name** (`db-1`) — the Kubernetes
StatefulSet convention, so images that derive their identity from their own
hostname work unchanged. The **component name stays resolvable locally**
(`db`) as a network alias on the app's private docker network, exactly as it
is for non-mesh apps — sibling components on the same node keep reaching each
other by component name.

The container's DNS chain has the mesh resolver first, so mesh names below
resolve from inside the container with no configuration.

---

## DNS — names and discovery

| Name | Answer |
|---|---|
| `<component>.<app>.mesh.flux` | every member of that component (A records) |
| `<component>-<ordinal>.<app>.mesh.flux` | that one member — the canonical, stable form |
| `<component>-<nodeid>.<app>.mesh.flux` | that one member, by node hash (standbys and debugging) |
| `_<service>._<proto>.<component>.<app>.mesh.flux` | SRV: one record per slot-holder — `0 0 <port> <ordinal-fqdn>` |
| `self.mesh.flux` | the calling container's own address |
| reverse (PTR) | the canonical member name for a presented address |

Two properties matter more than the table:

- **DNS answers membership, never liveness.** Every admitted member is in
  every answer, whether its container is up this second or not. Your cluster
  software's own failure detector owns liveness — that is what it is for, and
  hiding a down member from discovery is what breaks bootstrap and rejoin
  (the reason Kubernetes has `publishNotReadyAddresses`).
- **Answers are scoped to the calling app.** Another app's names simply do
  not exist in your view.

Answers carry a 5-second TTL and multi-member answers are shuffled per
response.

---

## meshPorts — SRV-advertised cluster ports

Cluster software listens on ports owners never publish (etcd 2380, Galera
4567). Declare them as `meshPorts` — a name and a `containerPort`, **no
hostPort** — and the name becomes the SRV service label:

```jsonc
"meshPorts": {
  "etcd-server": { "containerPort": 2380 },
  "etcd-client": { "containerPort": 2379, "protocol": "tcp" }
}
```

`_etcd-server._tcp.etcd.<app>.mesh.flux` then answers one SRV record per
slot-holding member carrying port 2380 and the member's ordinal FQDN. Port
selection: exact match of the service label against the mesh-port names,
else — when the component declares exactly one mesh port — that port
whatever the label was. `_udp` queries match only `"protocol": "udp"` ports.

Names are IANA-style service labels (lowercase alphanumeric and hyphens, max
15 chars) — the same convention as Kubernetes named ports, so
`etcd --discovery-srv`, `mongodb+srv://`, and every SRV-consuming client wire
up unchanged.

---

## Ordinal slots — stable member identity

Consensus software needs member names that are **knowable ahead of time** and
**survive replacement**: `db-0`, `db-1`, `db-2`. The mesh assigns each app
instance a slot in `0..instances-1` automatically — no coordinator; each
member claims the lowest vacant slot and the network arbitrates
deterministically. What you can rely on:

- With N instances you get exactly the names `db-0 … db-(N-1)`. Write them in
  configs before deploying anything.
- A member's slot **never changes while it lives**. It is echoed across
  FluxOS restarts, never re-elected.
- When a member dies and is replaced on another node, **the replacement
  inherits the vacated slot** — `db-1` comes back as `db-1`. A member keyed
  by hostname (MongoDB replica sets) rejoins with **zero reconfiguration**:
  the replacement comes up empty under a name already in the config and
  initial-syncs.
- A dead member that returns after being replaced **cannot take its number
  back** — it becomes a *standby*: a full mesh member, reachable by its
  nodeid name, holding no slot and absent from SRV answers. The SRV answer is
  therefore **exactly the named cluster set** — never more than `instances`
  records, even while extra instances transiently exist. That is what makes
  `--discovery-srv`-style bootstrap safe on a network that over-provisions.
- Identity is fixed per container: if a member's slot changes (a standby
  promoted into a vacancy), FluxOS **recreates the container** under the new
  identity rather than mutating a running one. Boot-time identity is always
  trustworthy.

The **ordinal-0 convention**: when your software needs a single bootstrap
actor and re-running the bootstrap against an already-formed cluster is
harmless (`rs.initiate` errors out cleanly on a member that already carries
a config), gate it on `FLUX_MESH_ORDINAL = 0`. One member answers to each
ordinal in the steady state — but slots are network-arbitrated, so two
freshly-born instances can *transiently* both believe they hold one. That
is why the convention is only for **idempotent** bootstrap. When founding
must happen at most once ever — `etcd --initial-cluster-state new`,
anything that mints a new world — gate it on the
[founder ask](#the-founder-ask--founding-exactly-once) instead, which a
quorum arbitrates.

---

## The membership level API

`GET http://fluxnode.service:16101/mesh/membership` answers the calling
app's current membership — a **level** with a strictly-increasing
`generation` — and long-polls for change via `?waitAfter=<generation>`.
Full reference: [flux-node-service.md](flux-node-service.md#get-meshmembership).

The reactor pattern it enables — read the level, converge your cluster to
it, wait for the level to move:

```sh
gen=0
while true; do
  level=$(wget -qO- "http://fluxnode.service:16101/mesh/membership?waitAfter=$gen&timeoutS=300")
  gen=$(echo "$level" | jq .data.generation)
  # missing from your cluster → add (as a learner where supported)
  # departed from the level   → remove
done
```

No transition can be missed: you converge toward the current membership,
which is the correct semantics for cluster reconfiguration anyway. A complete
working consensus example lives in
[`docs/examples/mesh-etcd-reactor/`](examples/mesh-etcd-reactor/).

---

## The founder ask — founding exactly once

Some bootstrap actions are not idempotent: `etcd --initial-cluster-state
new` creates a cluster every time it runs, and a second creation is a fork,
not an error. For those, "am I ordinal 0?" is not a strong enough question —
slot arbitration is gossip, and gossip can transiently answer twice. The
founder ask is the strong form:

```
POST http://fluxnode.service:16101/mesh/founder
```

The node answers for the calling container — scoped by source address like
everything on this port, so each component of each app has its own
independent founder question — after taking a quorum-arbitrated, write-once
founding grant on the container's behalf:

| answer | meaning | your move |
|---|---|---|
| `yes` | this member founds — recorded durably, by quorum | run the bootstrap action |
| `no` | another member founded | join it |
| `wait` | not knowable yet (record still syncing, no quorum reachable) | retry; `retryAfterMs` hints when |

Properties you can build on:

- **At most one member is ever told `yes` per component** — arbitrated by a
  quorum of nodes, not by a probe or a timing race, and durable across
  restarts, replacements and partitions.
- **`yes` is idempotent for the founder.** A crash between the ask and the
  bootstrap action does not wedge the app: the recorded founder is told
  `yes` again on its next boot. The flip side is the wipe-and-rejoin rule
  (see [the rules](#rules-that-keep-your-cluster-safe)) — `yes` means "you
  are the recorded founder", never "the world is empty".
- **`wait` is honest.** A freshly provisioned node that has not yet synced
  the app's founding record answers `wait`, not a guess. Keep asking until
  the answer is `yes` or `no`.

One wget in an entrypoint:

```sh
until answer=$(wget -qO- --post-data='' http://fluxnode.service:16101/mesh/founder \
  | jq -r .data.answer) && [ "$answer" != wait ]; do sleep 5; done
```

The [etcd example](examples/mesh-etcd-reactor/) uses exactly this branch.

---

## Gossip vs consensus — what your software needs

| | Gossip / self-managed (Cassandra, Consul, Redis Cluster, RabbitMQ, Elasticsearch, CockroachDB…) | Consensus / explicit membership (etcd, MongoDB replica sets, Kafka KRaft, Vault) |
|---|---|---|
| Discovery | the A-group name (`db.<app>.mesh.flux`) as the seed list | SRV (`--discovery-srv`, `mongodb+srv`) for bootstrap |
| Identity | node-id names are fine | ordinals — write `db-0…db-N` into the config |
| Membership changes | the protocol absorbs them — **nothing to do** | react via the membership API (add learner / remove) — a few lines of entrypoint |
| Bootstrap | point at the seed name | the founder ask names who initiates; others join |

Gossip systems need nothing beyond the group name. Consensus systems need
the ordinals plus, if you want automatic member add/remove, the reactor loop
above — the mesh gives the signal and the stable identity, your image runs
the service-specific command.

---

## Rules that keep your cluster safe

- **Advertise names, never addresses.** The `10.127.x` addresses are
  **node-local**: two nodes may present the same peer differently. The FQDN
  is the only mesh-wide identifier. Never write a presented IP into a config
  file, a cluster registry, or a database — resolve names at use time.
- **Never put a consensus data directory in a syncthing-replicated volume.**
  File-level replication of a live Raft/replica-set data dir corrupts it.
  Recovery for a replaced member is the protocol's own catch-up (learner
  sync, initial sync) — which the stable identity above makes automatic or
  one command.
- **A wiped member rejoins — it never re-founds.** Founding creates the
  world once; a member that lost its disk while any other member survives
  must come back as a joiner (learner sync, initial sync), even when it is
  the recorded founder and the founder ask still answers it `yes`. The ask
  records who founded; it cannot know whether your data outlived you — that
  branch belongs to your entrypoint: peers answering ⇒ join them; nothing
  answering anywhere and `yes` in hand ⇒ this is the world's first boot.
- **Quorum loss is yours to recover.** If a majority of a consensus cluster
  is permanently gone, that is restore-from-backup territory — the mesh
  keeps the survivors reachable and the names stable, but no layer (not the
  mesh, not Kubernetes) can conjure a quorum back. The restore flow's last
  step is the app owner's generation re-roll (one signed record, submitted
  through the Flux API), after which the founder ask answers `yes` exactly
  once again — to whichever member bootstraps the restored world.
- Public ports (`ports` with `hostPort`) and mesh ports are orthogonal — a
  port may be both published and mesh-advertised, but the names live in one
  namespace per component.
