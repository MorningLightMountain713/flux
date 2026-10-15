# The real FluxDrive API at test-infra/fluxdrive/pin (vendored into src/ by
# vendor.sh), built as its own Dockerfile builds it. The same image runs the GC
# runner with `node /harness/control.mjs` as its command.
FROM node:22-bookworm-slim
ENV NODE_ENV=production

# libcurl, tini and gosu as upstream. libfaketime for the harness clock
# (runner/framework/harness-clock.js), preloaded from a fixed path whatever the
# architecture.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libcurl4 \
       ca-certificates \
       tini \
       gosu \
       libfaketime \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(dpkg -L libfaketime | grep '/libfaketime.so.1$')" /usr/local/lib/libfaketime.so.1 \
    && test -e /usr/local/lib/libfaketime.so.1

WORKDIR /app

COPY src/package.json src/yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY src/ ./
RUN mkdir -p ./data/ipfs ./data/subscriptions \
    && chown -R node:node /app \
    && chmod +x /app/docker-entrypoint.sh

COPY control.mjs /harness/control.mjs

EXPOSE 8082 16142

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
