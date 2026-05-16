FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./

# npm ci = deterministic installs from lockfile, --omit=dev = smaller image
RUN npm ci --omit=dev

COPY . .

# Don't run containers as root
USER node

# CMD is set in docker-compose (one for API, one for Worker)