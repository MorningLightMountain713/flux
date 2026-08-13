#!/bin/sh
# etcd on the Flux mesh: identity from the mesh env, peers from SRV, joins
# self-service, membership converged by the reactor loop at the bottom.
# Requires in the image: etcd, etcdctl, jq, wget (busybox wget is fine).
set -eu

SELF="$FLUX_MESH_SELF"                 # e.g. etcd-1 — the member's etcd name
SELF_FQDN="$FLUX_MESH_SELF_FQDN"       # the ONLY thing we ever advertise
DATA_DIR="${ETCD_DATA_DIR:-/dat/etcd}"
MEMBERSHIP="http://fluxnode.service:16101/mesh/membership"
FOUNDER="http://fluxnode.service:16101/mesh/founder"
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

# Whether any OTHER named member's etcd answers. Decision support for the
# founder branch below, run only by the one member holding the founder
# grant — never the arbiter of who founds.
peers_alive() {
  wget -qO- "$MEMBERSHIP" \
    | jq -r --arg self "$SELF" \
        '.data.members[] | select(.ordinal != null and .member != $self) | .fqdn' \
    | while read -r peer; do
        if wget -qO- -T 3 "http://$peer:2379/version" >/dev/null 2>&1; then
          echo up
          break
        fi
      done | grep -q up
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
else
  # Empty disk: ask the node whether THIS member founds. The answer comes
  # from a quorum-arbitrated, write-once founding grant — at most one yes
  # per component, ever — so creating the cluster cannot race, whatever the
  # slot gossip transiently believes. wait means not knowable yet; keep
  # asking. etcd's cluster creation is NOT idempotent, which is exactly why
  # this branch gates on the grant and not on the ordinal alone.
  until answer=$(wget -qO- --post-data='' "$FOUNDER" | jq -r '.data.answer') \
    && { [ "$answer" = yes ] || [ "$answer" = no ]; }; do sleep 5; done

  if [ "$answer" = yes ] && ! peers_alive; then
    # Told yes with nothing answering anywhere: the world's first boot.
    start_etcd new "$SELF=$PEER_URL"
  else
    # Join SELF-SERVICE as a LEARNER through the existing quorum —
    # non-voting, so a failed join can never cost quorum. This is the no
    # branch, and ALSO the wiped founder: yes with living peers means we
    # founded once and lost the disk, and a wiped member rejoins, never
    # re-founds. If the old holder of this name is still on the member list
    # (we replaced a dead node), remove it first: same name, but its raft
    # identity died with its disk. Retry until the quorum answers.
    until endpoints=$(client_endpoints) && [ -n "$endpoints" ]; do sleep 5; done
    until out=$(etcdctl --endpoints "$endpoints" member list -w json 2>/dev/null); do sleep 5; done
    stale=$(echo "$out" | jq -r ".members[] | select(.name == \"$SELF\") | .ID")
    [ -n "$stale" ] && etcdctl --endpoints "$endpoints" member remove "$(printf '%x' "$stale")"
    until add=$(etcdctl --endpoints "$endpoints" member add "$SELF" --learner --peer-urls "$PEER_URL" -w json); do sleep 5; done
    # The add answers the initial cluster the newcomer must start with.
    initial=$(echo "$add" | jq -r '[.members[] | "\(.name // "'"$SELF"'")=\(.peerURLs[0])"] | join(",")')
    start_etcd existing "$initial"
  fi
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
