# Dockerfile
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install libraries
RUN npm install

# Bundle app source
COPY . .

# We don't specify CMD here because we will override it 
# in docker-compose (one for API, one for Worker)