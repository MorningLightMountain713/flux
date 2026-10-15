#!/bin/sh
# Runs after `ipfs init`, before the daemon. A swarm key drawn fresh for this
# container, and no bootstrap peers: the node can reach no other IPFS node.
set -ex
printf '/key/swarm/psk/1.0.0/\n/base16/\n%s\n' "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" > "$IPFS_PATH/swarm.key"
ipfs bootstrap rm all
ipfs config profile apply server
# AutoConf fetches mainnet configuration at startup and refuses a private network;
# with it off, every setting left at 'auto' is cleared, and routing is off: the
# API reads and writes this node only.
ipfs config --json AutoConf.Enabled false
ipfs config Routing.Type none
ipfs config --json DNS.Resolvers '{}'
ipfs config --json Routing.DelegatedRouters '[]'
ipfs config --json Ipns.DelegatedPublishers '[]'
# Neither runs on a private network.
ipfs config --json AutoTLS.Enabled false
ipfs config --json Swarm.Transports.Network.Websocket false
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
