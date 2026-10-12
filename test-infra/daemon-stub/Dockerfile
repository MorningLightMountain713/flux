FROM node:20-slim

# The harness clock (runner/framework/harness-clock.js): a suite that shares one
# preloads this library from a fixed path, whatever the architecture.
RUN apt-get update && apt-get install -y --no-install-recommends libfaketime \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(dpkg -L libfaketime | grep '/libfaketime.so.1$')" /usr/local/lib/libfaketime.so.1 \
    && test -e /usr/local/lib/libfaketime.so.1

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js benchCrypto.js benchCertificates.js zmqEncoders.js ./

EXPOSE 16123 16124 16224 18232

CMD ["node", "index.js"]
