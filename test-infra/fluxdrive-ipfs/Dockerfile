# FluxDrive's blob store in the harness: the kubo FluxDrive runs, alone on a
# private network nothing else can join (setup.sh).
FROM ipfs/kubo:v0.41.0

# The daemon refuses to start without a swarm key rather than join the public network.
ENV LIBP2P_FORCE_PNET=1

COPY --chown=ipfs:users setup.sh /container-init.d/setup.sh
RUN chmod +x /container-init.d/setup.sh

CMD ["daemon", "--enable-gc", "--migrate=true", "--agent-version-suffix=docker"]
