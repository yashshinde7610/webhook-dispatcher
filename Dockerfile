# Dockerfile
FROM node:18-alpine

# 🛡️ SECURITY: Create app directory owned by the built-in
# non-root "node" user that ships with the official image.
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# 🛡️ DETERMINISM + SECURITY:
#   • npm ci  → installs exact versions from package-lock.json (reproducible builds)
#   • --omit=dev → excludes devDependencies (smaller, hardened image)
RUN npm ci --omit=dev

# Bundle app source
COPY . .

# 🛡️ LEAST PRIVILEGE: Never run containers as root.
# The "node" user (uid 1000) is provided by the base image.
USER node

# We don't specify CMD here because we will override it
# in docker-compose (one for API, one for Worker)