FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js benchCrypto.js zmqEncoders.js ./

EXPOSE 16123 16124 16224 18232

CMD ["node", "index.js"]
