FROM node:20-alpine
WORKDIR /app
COPY bin ./bin
COPY lib ./lib
COPY package.json .
WORKDIR /work
ENTRYPOINT ["node", "/app/bin/sift.js"]
