#!/bin/sh
# etcd on the Flux mesh: identity from the mesh env, peers from SRV, joins
# self-service, membership converged by the reactor loop at the bottom.
# Requires in the image: etcd, etcdctl, jq, wget (busybox wget is fine).
set -eu

APP="$FLUX_MESH_APP"
SELF="$FLUX_MESH_SELF"                 # e.g. etcd-1 — the member's etcd name
SELF_FQDN="$FLUX_MESH_SELF_FQDN"       # the ONLY thing we ever advertise
DATA_DIR="${ETCD_DATA_DIR:-/dat/etcd}"
MEMBERSHIP="http://fluxnode.service:16101/mesh/membership"
PEER_URL="http://$SELF_FQDN:2380"
CLIENT_URL="http://$SELF_FQDN:2379"

# A standby holds no ordinal: it is a full mesh member but NOT part of the
# named cluster set. It idles; when Flux promotes it into a vacant slot the
# container is recreated with the new identity and takes the branches below.
if [ -z "${FLUX_MESH_ORDINAL:-}" ]; then
  echo "standby member $SELF: not in the named set; idling"
  exec sleep infinity
fi

# Live client endpoints, via the level API (names, resolved at use time).
client_endpoints() {
  wget -qO- "$MEMBERSHIP" \
    | jq -r '.data.members[] | select(.ordinal != null) | .fqdn' \
    | sed 's/.*/http:\/\/&:2379/' | paste -sd, -
}

start_etcd() {
  exec_state="$1"; initial_cluster="$2"
  etcd --name "$SELF" \
    --data-dir "$DATA_DIR" \
    --listen-peer-urls http://0.0.0.0:2380 \
    --listen-client-urls http://0.0.0.0:2379 \
    --initial-advertise-peer-urls "$PEER_URL" \
    --advertise-client-urls "$CLIENT_URL" \
    --initial-cluster-state "$exec_state" \
    --initial-cluster "$initial_cluster" \
    --strict-reconfig-check &
  ETCD_PID=$!
}

if [ -d "$DATA_DIR/member" ]; then
  # Restart with data: the data dir carries the raft identity — just rejoin.
  start_etcd existing "$SELF=$PEER_URL"
elif [ "$FLUX_MESH_ORDINAL" = "0" ] && ! wget -qO- "http://etcd-1.$APP.mesh.flux:2379/version" >/dev/null 2>&1; then
  # Ordinal 0, no cluster answering: found it. Exactly one member can take
  # this branch — the ordinal-0 convention is what makes bootstrap a non-race.
  start_etcd new "$SELF=$PEER_URL"
else
  # Fresh member (first boot, or a replacement that inherited this ordinal
  # with an empty disk): join SELF-SERVICE as a LEARNER through the existing
  # quorum — non-voting, so a failed join can never cost quorum. If the old
  # holder of this name is still on the member list (we replaced a dead
  # node), remove it first: same name, but its raft identity died with its
  # disk. Retry until the quorum answers.
  until endpoints=$(client_endpoints) && [ -n "$endpoints" ]; do sleep 5; done
  until out=$(etcdctl --endpoints "$endpoints" member list -w json 2>/dev/null); do sleep 5; done
  stale=$(echo "$out" | jq -r ".members[] | select(.name == \"$SELF\") | .ID")
  [ -n "$stale" ] && etcdctl --endpoints "$endpoints" member remove "$(printf '%x' "$stale")"
  until add=$(etcdctl --endpoints "$endpoints" member add "$SELF" --learner --peer-urls "$PEER_URL" -w json); do sleep 5; done
  # The add answers the initial cluster the newcomer must start with.
  initial=$(echo "$add" | jq -r '[.members[] | "\(.name // "'"$SELF"'")=\(.peerURLs[0])"] | join(",")')
  start_etcd existing "$initial"
fi

# ── The reactor ──────────────────────────────────────────────────────────
# Converge etcd's member list to the mesh membership LEVEL, forever:
#   - a learner that caught up → promote (any member may);
#   - an etcd member no longer in the level → remove — but only the lowest
#     live ordinal acts, so removals never race.
# The long-poll parks until membership changes; a timeout answers the
# unchanged level and the loop just goes around.
gen=0
while true; do
  level=$(wget -qO- "$MEMBERSHIP?waitAfter=$gen&timeoutS=300") || { sleep 5; continue; }
  gen=$(echo "$level" | jq '.data.generation')
  named=$(echo "$level" | jq -r '.data.members[] | select(.ordinal != null) | .member')

  etcdctl member list -w json 2>/dev/null | jq -r '.members[] | "\(.ID) \(.name) \(.isLearner // false)"' \
  | while read -r id member is_learner; do
      hexid=$(printf '%x' "$id")
      if [ "$is_learner" = "true" ]; then
        etcdctl member promote "$hexid" 2>/dev/null || true   # succeeds once caught up
      fi
      if ! echo "$named" | grep -qx "$member" \
        && [ "$FLUX_MESH_ORDINAL" = "$(echo "$named" | sed 's/.*-//' | sort -n | head -1)" ]; then
        echo "reactor: $member left the membership; removing"
        etcdctl member remove "$hexid" || true
      fi
    done
done
