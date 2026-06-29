FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

EXPOSE 16140 16141

CMD ["node", "index.js"]
