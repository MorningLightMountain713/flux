#!/bin/sh
# One etcd member of a mesh app, named by the mesh identity FluxOS gives the
# container. On a first start etcd reads ETCD_INITIAL_CLUSTER and
# ETCD_INITIAL_CLUSTER_STATE from the environment; a member with data keeps
# the peers it stored and ignores them.
exec /usr/local/bin/etcd \
  --name "$FLUX_MESH_SELF" \
  --data-dir /data/etcd \
  --listen-peer-urls http://0.0.0.0:2380 \
  --listen-client-urls http://0.0.0.0:2379 \
  --initial-advertise-peer-urls "http://$FLUX_MESH_SELF_FQDN:2380" \
  --advertise-client-urls "http://$FLUX_MESH_SELF_FQDN:2379"
