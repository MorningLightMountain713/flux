# mesh-etcd-reactor — a consensus cluster on the Flux mesh, no orchestrator

A complete, minimal etcd cluster as a mesh app: three members with stable
ordinal identities, SRV-discovered peers, self-service joins, and a
six-line reactor that keeps etcd's member list converged to the mesh's
membership level. Everything etcd-specific lives in this image's entrypoint —
the platform ships no operator.

The full API this example programs against: [`docs/mesh.md`](../../mesh.md).

## The spec

```jsonc
{
  "version": 9,
  "name": "myetcd",
  "instances": 3,
  "network": { "mesh": true },
  "components": {
    "etcd": {
      "image": "your-registry/mesh-etcd-reactor:v1",
      "meshPorts": {
        "etcd-server": { "containerPort": 2380 },
        "etcd-client": { "containerPort": 2379 }
      }
      // no published ports: the cluster talks only inside the overlay
    }
  }
}
```

## How the pieces map

| Mesh surface | etcd use |
|---|---|
| `FLUX_MESH_SELF` (`etcd-1`) | `--name` — the member's etcd name IS its mesh name |
| `FLUX_MESH_SELF_FQDN` | `--initial-advertise-peer-urls` / `--advertise-client-urls` — always the name, never an address |
| `FLUX_MESH_ORDINAL = 0` | who bootstraps: ordinal 0 founds the cluster, everyone else joins |
| SRV `_etcd-client._tcp.etcd.<app>.mesh.flux` | finding live client endpoints to join through |
| `/mesh/membership` long-poll | the reactor: remove departed members, promote caught-up learners |

## Lifecycle walkthrough

1. **First boot, ordinal 0**: founds a one-member cluster
   (`--initial-cluster-state new`, initial cluster = itself).
2. **First boot, other ordinals**: ask an existing member to add them as a
   **learner** (non-voting — a failed join can never cost quorum), start with
   the member list that call returns, and get promoted by the reactor once
   caught up.
3. **Restart with data**: the data dir carries the member identity — start
   and rejoin, nothing to do.
4. **Replacement** (the node died; Flux respawned the instance elsewhere):
   the replacement inherits the dead member's ordinal — same name, empty
   disk. The reactor on a surviving member removes the dead etcd member id;
   the replacement then joins as a learner under the same name and catches
   up via the protocol. No human, no operator.
5. **Ungraceful departure with no replacement**: the reactor's next level
   read no longer lists the member; the lowest live ordinal removes it.
   The cluster keeps quorum throughout — the removal restores fault
   tolerance, it never restores availability (that was never lost).

## Honest limits

This is an example, not a hardened image: no TLS between members (the
overlay is already encrypted node-to-node, but etcd peer TLS is still good
practice), no backup schedule, and `jq` + `etcdctl` are assumed present in
the image. Quorum loss (majority permanently gone) is restore-from-snapshot
territory — see the rules section of `docs/mesh.md`.
